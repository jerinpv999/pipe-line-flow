// CI/CD agent: install on each deploy server. Dials the master over gRPC and runs the jobs it is given.
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { Executor } = require('./executor');
const { version } = require('../package.json');

const cfg = {
  master: process.env.MASTER_ADDR || 'localhost:50051',
  token: process.env.AGENT_TOKEN || 'dev-agent-token',
  name: process.env.AGENT_NAME || os.hostname(),
  labels: (process.env.AGENT_LABELS || '').split(',').map((s) => s.trim()).filter(Boolean),
  workspace: process.env.AGENT_WORKSPACE || path.join(os.homedir(), '.cicd-agent', 'workspace'),
  tls: process.env.GRPC_TLS === 'true' || !!process.env.GRPC_TLS_CA,
  tlsCa: process.env.GRPC_TLS_CA || '',
  heartbeatMs: 10000,
};

const protoPath = process.env.PROTO_PATH || [
  path.join(__dirname, '..', 'proto', 'agent.proto'),
  path.join(__dirname, '..', '..', 'proto', 'agent.proto'),
].find((p) => fs.existsSync(p));

const packageDef = protoLoader.loadSync(protoPath, { keepCase: false, longs: Number, enums: String, defaults: true, oneofs: true });
const proto = grpc.loadPackageDefinition(packageDef).cicd;

const credentials = cfg.tls
  ? grpc.credentials.createSsl(cfg.tlsCa ? fs.readFileSync(cfg.tlsCa) : null)
  : grpc.credentials.createInsecure();

const client = new proto.AgentService(cfg.master, credentials, {
  'grpc.keepalive_time_ms': 20000,
  'grpc.keepalive_timeout_ms': 10000,
  'grpc.keepalive_permit_without_calls': 1,
  'grpc.max_receive_message_length': 16 * 1024 * 1024,
});

let stream = null;
let registered = false;
let heartbeatTimer = null;
let reconnectDelay = 1000;
let shuttingDown = false;

function send(msg) {
  if (!stream || !registered) return;
  try { stream.write(msg); } catch { /* stream closed; reconnect will follow */ }
}

const executor = new Executor(cfg, send);

function heartbeat() {
  send({
    heartbeat: {
      timestamp: Date.now(),
      load: os.loadavg()[0],
      freeMem: os.freemem(),
      totalMem: os.totalmem(),
      busy: executor.busy,
    },
  });
}

function connect() {
  console.log(`[agent] connecting to ${cfg.master} as "${cfg.name}"…`);
  const call = client.Connect();
  stream = call;
  registered = false;

  call.write({
    register: {
      token: cfg.token,
      name: cfg.name,
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()} (${os.arch()})`,
      labels: cfg.labels,
      version,
    },
  });

  call.on('data', (msg) => {
    switch (msg.payload) {
      case 'registered':
        if (!msg.registered.ok) {
          console.error(`[agent] registration rejected: ${msg.registered.message}`);
          reconnectDelay = 30000; // e.g. wrong token — don't hammer the master
          return;
        }
        registered = true;
        reconnectDelay = 1000;
        console.log(`[agent] registered (id ${msg.registered.agentId})`);
        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(heartbeat, cfg.heartbeatMs);
        heartbeat();
        break;
      case 'job':
        executor.enqueue(msg.job);
        break;
      case 'cancel':
        executor.cancel(msg.cancel.jobId);
        break;
      default:
        break;
    }
  });

  let closed = false;
  const onClose = (reason) => {
    if (closed) return;
    closed = true;
    if (stream === call) {
      stream = null;
      registered = false;
    }
    clearInterval(heartbeatTimer);
    executor.abortAll();
    if (shuttingDown) return;
    console.warn(`[agent] disconnected (${reason}); retrying in ${Math.round(reconnectDelay / 1000)}s`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };
  call.on('error', (err) => onClose(err.details || err.message));
  call.on('end', () => onClose('stream ended'));
}

function shutdown() {
  shuttingDown = true;
  console.log('[agent] shutting down');
  executor.abortAll();
  try { stream?.end(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

fs.mkdirSync(cfg.workspace, { recursive: true });
connect();
