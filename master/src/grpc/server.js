// gRPC server that deploy agents connect to (one bidirectional stream per agent).
const fs = require('fs');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const cfg = require('../config');
const { safeEqual } = require('../auth');
const { Agent } = require('../models');
const hub = require('./agentHub');
const dispatcher = require('../services/dispatcher');
const realtime = require('../realtime');

const packageDef = protoLoader.loadSync(cfg.protoPath, {
  keepCase: false,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDef).cicd;

function handleConnect(call) {
  const peer = call.getPeer();
  let agentId = null;
  let closed = false;
  let lastHeartbeatEmit = 0;
  // Process messages strictly in order (step updates, logs and results must not overtake each other)
  let chain = Promise.resolve();

  call.on('data', (msg) => {
    chain = chain.then(() => handleMessage(msg)).catch((err) => console.error('[grpc] handler error:', err));
  });

  async function handleMessage(msg) {
    if (closed) return;

    if (msg.payload === 'register') {
      const r = msg.register;
      if (!safeEqual(r.token, cfg.agentToken)) {
        console.warn(`[grpc] rejected agent "${r.name}" from ${peer}: bad token`);
        call.write({ registered: { ok: false, message: 'Invalid agent token' } });
        closed = true;
        call.end();
        return;
      }
      if (!r.name) {
        call.write({ registered: { ok: false, message: 'Agent name is required' } });
        closed = true;
        call.end();
        return;
      }

      const agent = await Agent.findOneAndUpdate(
        { name: r.name },
        {
          $set: {
            hostname: r.hostname,
            platform: r.platform,
            version: r.version,
            labels: r.labels || [],
            status: 'online',
            busy: false,
            lastSeen: new Date(),
            ip: peer,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      agentId = String(agent._id);

      const previous = hub.get(agentId);
      hub.set(agentId, call);
      if (previous && previous !== call) {
        try { previous.end(); } catch { /* already closed */ }
      }
      // Anything that was "running" on this agent belongs to a dead process/connection
      await dispatcher.failRunningJobs(agentId, 'Agent reconnected; the previous job was lost');

      call.write({ registered: { ok: true, agentId, message: `Welcome ${r.name}` } });
      console.log(`[grpc] agent "${r.name}" connected from ${peer}`);
      realtime.emit('agents:update', agent.toObject());
      await dispatcher.dispatchQueued(agentId);
      return;
    }

    if (!agentId) return; // must register first

    switch (msg.payload) {
      case 'heartbeat': {
        const h = msg.heartbeat;
        const agent = await Agent.findByIdAndUpdate(agentId, {
          $set: {
            lastSeen: new Date(),
            status: 'online',
            busy: !!h.busy,
            stats: { load: h.load, freeMem: h.freeMem, totalMem: h.totalMem },
          },
        }, { new: true });
        if (agent && Date.now() - lastHeartbeatEmit > 5000) {
          lastHeartbeatEmit = Date.now();
          realtime.emit('agents:update', agent.toObject());
        }
        break;
      }
      case 'log':
        dispatcher.onLog(agentId, msg.log);
        break;
      case 'step':
        await dispatcher.onStepUpdate(agentId, msg.step);
        break;
      case 'result':
        await dispatcher.onResult(agentId, msg.result);
        break;
      default:
        break;
    }
  }

  let cleaned = false;
  const cleanup = (why) => {
    if (cleaned) return;
    cleaned = true;
    closed = true;
    chain = chain.then(async () => {
      if (!agentId || !hub.remove(agentId, call)) return; // replaced by a newer connection
      console.log(`[grpc] agent ${agentId} disconnected (${why})`);
      const agent = await Agent.findByIdAndUpdate(agentId, { $set: { status: 'offline', busy: false } }, { new: true });
      if (agent) realtime.emit('agents:update', agent.toObject());
      await dispatcher.failRunningJobs(agentId, 'Agent disconnected while job was running');
    }).catch((err) => console.error('[grpc] cleanup error:', err));
  };

  call.on('end', () => {
    cleanup('stream ended');
    try { call.end(); } catch { /* ignore */ }
  });
  call.on('error', (err) => cleanup(err.details || err.message));
  call.on('cancelled', () => cleanup('cancelled'));
}

function startGrpcServer() {
  const server = new grpc.Server({
    'grpc.keepalive_time_ms': 30000,
    'grpc.keepalive_timeout_ms': 10000,
    'grpc.keepalive_permit_without_calls': 1,
    'grpc.http2.min_ping_interval_without_data_ms': 10000,
    'grpc.max_receive_message_length': 16 * 1024 * 1024,
  });
  server.addService(proto.AgentService.service, { Connect: handleConnect });

  const creds = cfg.grpcTlsCert && cfg.grpcTlsKey
    ? grpc.ServerCredentials.createSsl(null, [{
      cert_chain: fs.readFileSync(cfg.grpcTlsCert),
      private_key: fs.readFileSync(cfg.grpcTlsKey),
    }], false)
    : grpc.ServerCredentials.createInsecure();

  return new Promise((resolve, reject) => {
    server.bindAsync(`0.0.0.0:${cfg.grpcPort}`, creds, (err, port) => {
      if (err) return reject(err);
      console.log(`[grpc] agent hub listening on :${port}${cfg.grpcTlsCert ? ' (TLS)' : ''}`);
      resolve(server);
    });
  });
}

module.exports = { startGrpcServer };
