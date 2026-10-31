// Turns pipelines into runs/jobs, hands jobs to agents and records what they report back.
const mongoose = require('mongoose');
const { Agent, Pipeline, Run, Job, Log } = require('../models');
const hub = require('../grpc/agentHub');
const realtime = require('../realtime');

const TERMINAL = new Set(['success', 'failed', 'cancelled']);
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

// jobId -> { agentId, secrets: string[], seq }
const activeJobs = new Map();

// ---------- log buffering (batched inserts) ----------
let logBuffer = [];
async function flushLogs() {
  if (!logBuffer.length) return;
  const batch = logBuffer;
  logBuffer = [];
  try {
    await Log.insertMany(batch, { ordered: false });
  } catch (err) {
    console.error('[logs] flush failed:', err.message);
  }
}
setInterval(flushLogs, 500).unref();

// ---------- helpers ----------
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function sanitizeRun(run) {
  const r = run.toObject ? run.toObject() : { ...run };
  if (r.spec?.env) {
    const env = { ...r.spec.env };
    for (const k of r.spec.secretKeys || []) if (k in env) env[k] = '••••••';
    r.spec = { ...r.spec, env };
  }
  return r;
}

function maskSecrets(text, secrets) {
  let out = text;
  for (const s of secrets) if (s && s.length >= 3) out = out.split(s).join('••••••');
  return out;
}

async function resolveAgents(pipeline) {
  const or = [];
  if (pipeline.targets?.agents?.length) or.push({ _id: { $in: pipeline.targets.agents } });
  if (pipeline.targets?.labels?.length) or.push({ labels: { $in: pipeline.targets.labels } });
  if (!or.length) return [];
  return Agent.find({ $or: or }).sort({ name: 1 });
}

function computeRunStatus(jobs) {
  if (!jobs.length) return 'failed';
  if (jobs.every((j) => TERMINAL.has(j.status))) {
    if (jobs.some((j) => j.status === 'failed')) return 'failed';
    if (jobs.some((j) => j.status === 'cancelled')) return 'cancelled';
    return 'success';
  }
  return jobs.some((j) => j.status === 'running' || TERMINAL.has(j.status)) ? 'running' : 'queued';
}

async function refreshRun(runId) {
  const run = await Run.findById(runId);
  if (!run) return;
  const jobs = await Job.find({ run: runId }).select('status');
  const status = computeRunStatus(jobs);
  if (status !== 'queued' && !run.startedAt) run.startedAt = new Date();
  if (TERMINAL.has(status) && !run.finishedAt) run.finishedAt = new Date();
  if (!TERMINAL.has(status)) run.finishedAt = undefined;
  run.status = status;
  await run.save();
  realtime.emit('run:update', sanitizeRun(run));
}

function emitJob(job) {
  realtime.emit('job:update', job.toObject ? job.toObject() : job);
}

async function finishJob(job, status, error) {
  job.status = status;
  job.error = error || job.error;
  job.finishedAt = new Date();
  for (const s of job.steps) {
    if (s.status === 'pending') s.status = 'skipped';
    if (s.status === 'running') {
      s.status = status === 'cancelled' ? 'cancelled' : 'failed';
      s.finishedAt = new Date();
    }
  }
  await job.save();
  activeJobs.delete(String(job._id));
  emitJob(job);
  await refreshRun(job.run);
}

// ---------- public API ----------

/** Create a run for a pipeline and dispatch one job per target agent. */
async function triggerRun(pipelineId, trigger, envOverrides = {}) {
  const pipeline = await Pipeline.findById(pipelineId);
  if (!pipeline) throw httpError(404, 'Pipeline not found');
  if (!pipeline.steps.length) throw httpError(400, 'Pipeline has no steps');

  const agents = await resolveAgents(pipeline);
  if (!agents.length) throw httpError(400, 'Pipeline has no target agents (pick agents or labels)');

  const env = {};
  const secretKeys = [];
  for (const e of pipeline.env) {
    env[e.key] = e.value;
    if (e.secret) secretKeys.push(e.key);
  }
  for (const [k, v] of Object.entries(envOverrides || {})) {
    if (ENV_KEY.test(k)) env[k] = String(v);
  }

  const { runCount } = await Pipeline.findByIdAndUpdate(pipeline._id, { $inc: { runCount: 1 } }, { new: true });

  const run = await Run.create({
    pipeline: pipeline._id,
    pipelineName: pipeline.name,
    number: runCount,
    status: 'queued',
    trigger,
    spec: {
      steps: pipeline.steps.map((s) => ({
        name: s.name,
        script: s.script,
        continueOnError: s.continueOnError,
        timeoutSeconds: s.timeoutSeconds,
      })),
      env,
      secretKeys,
      shell: pipeline.shell || 'bash',
      workingDir: pipeline.workingDir || '',
    },
  });

  const jobs = await Job.insertMany(agents.map((a) => ({
    run: run._id,
    pipeline: pipeline._id,
    agent: a._id,
    agentName: a.name,
    status: 'queued',
    steps: pipeline.steps.map((s) => ({ name: s.name, status: 'pending' })),
  })));

  realtime.emit('run:update', sanitizeRun(run));
  for (const job of jobs) await tryDispatch(job, run);
  await refreshRun(run._id);
  return sanitizeRun(await Run.findById(run._id));
}

/** Send a queued job to its agent if the agent is connected. */
async function tryDispatch(job, run) {
  const agentId = String(job.agent);
  if (!hub.isOnline(agentId)) return false;

  const spec = run.spec;
  const env = {
    ...spec.env,
    CI: 'true',
    CI_RUN_ID: String(run._id),
    CI_RUN_NUMBER: String(run.number),
    CI_PIPELINE_NAME: run.pipelineName,
    CI_JOB_ID: String(job._id),
    CI_AGENT_NAME: job.agentName,
    CI_TRIGGER: run.trigger?.type || 'manual',
    CI_TRIGGERED_BY: run.trigger?.user || '',
  };
  if (run.trigger?.payload) {
    try { env.CI_TRIGGER_PAYLOAD = JSON.stringify(run.trigger.payload).slice(0, 64 * 1024); } catch { /* ignore */ }
  }

  // Claim the job atomically so it can't be dispatched twice
  const claimed = await Job.findOneAndUpdate(
    { _id: job._id, status: 'queued' },
    { $set: { status: 'running', startedAt: new Date() } },
    { new: true },
  );
  if (!claimed) return false;

  activeJobs.set(String(job._id), {
    agentId,
    secrets: (spec.secretKeys || []).map((k) => spec.env[k]).filter(Boolean),
    seq: 0,
  });

  const ok = hub.send(agentId, {
    job: {
      jobId: String(job._id),
      runId: String(run._id),
      pipelineName: run.pipelineName,
      steps: spec.steps,
      env,
      shell: spec.shell,
      workingDir: spec.workingDir,
    },
  });

  if (!ok) {
    activeJobs.delete(String(job._id));
    claimed.status = 'queued';
    claimed.startedAt = undefined;
    await claimed.save();
    return false;
  }
  emitJob(claimed);
  return true;
}

/** Called when an agent (re)connects: hand it any jobs that were waiting for it. */
async function dispatchQueued(agentId) {
  const jobs = await Job.find({ agent: agentId, status: 'queued' }).sort({ createdAt: 1 });
  for (const job of jobs) {
    const run = await Run.findById(job.run);
    if (!run) continue;
    if (await tryDispatch(job, run)) await refreshRun(run._id);
  }
}

function ownsJob(agentId, jobId) {
  const a = activeJobs.get(jobId);
  return a && a.agentId === agentId ? a : null;
}

async function onStepUpdate(agentId, u) {
  if (!ownsJob(agentId, u.jobId)) return;
  const job = await Job.findById(u.jobId);
  const step = job?.steps[u.stepIndex];
  if (!step) return;
  step.status = u.status;
  if (u.status === 'running') step.startedAt = new Date(Number(u.timestamp) || Date.now());
  else {
    step.finishedAt = new Date(Number(u.timestamp) || Date.now());
    step.exitCode = u.exitCode;
  }
  await job.save();
  emitJob(job);
}

function onLog(agentId, chunk) {
  const active = ownsJob(agentId, chunk.jobId);
  if (!active) return;
  const entry = {
    job: new mongoose.Types.ObjectId(chunk.jobId),
    seq: ++active.seq,
    stepIndex: chunk.stepIndex,
    stream: chunk.stream || 'stdout',
    data: maskSecrets(chunk.data || '', active.secrets),
    ts: new Date(Number(chunk.timestamp) || Date.now()),
  };
  logBuffer.push(entry);
  realtime.emitTo(`job:${chunk.jobId}`, 'log', {
    jobId: chunk.jobId,
    seq: entry.seq,
    stepIndex: entry.stepIndex,
    stream: entry.stream,
    data: entry.data,
    ts: entry.ts,
  });
}

async function onResult(agentId, r) {
  if (!ownsJob(agentId, r.jobId)) return;
  const job = await Job.findById(r.jobId);
  if (!job || TERMINAL.has(job.status)) return;
  const status = TERMINAL.has(r.status) ? r.status : 'failed';
  await flushLogs();
  await finishJob(job, status, r.error);
}

/** Fail jobs that were running on an agent whose connection dropped (or that re-registered). */
async function failRunningJobs(agentId, reason) {
  const jobs = await Job.find({ agent: agentId, status: 'running' });
  for (const job of jobs) await finishJob(job, 'failed', reason);
}

async function cancelRun(runId) {
  const run = await Run.findById(runId);
  if (!run) throw httpError(404, 'Run not found');
  const jobs = await Job.find({ run: runId, status: { $in: ['queued', 'running'] } });
  for (const job of jobs) {
    if (job.status === 'running') hub.send(String(job.agent), { cancel: { jobId: String(job._id) } });
    await finishJob(job, 'cancelled', 'Cancelled by user');
  }
  await refreshRun(runId);
  return sanitizeRun(await Run.findById(runId));
}

/** On master boot: everything that was "running" lost its stream. */
async function recoverOnStartup() {
  await Agent.updateMany({}, { $set: { status: 'offline', busy: false } });
  const stuck = await Job.find({ status: 'running' });
  for (const job of stuck) await finishJob(job, 'failed', 'Master restarted while job was running');
}

module.exports = {
  triggerRun,
  dispatchQueued,
  onStepUpdate,
  onLog,
  onResult,
  failRunningJobs,
  cancelRun,
  recoverOnStartup,
  sanitizeRun,
  flushLogs,
  ENV_KEY,
};
