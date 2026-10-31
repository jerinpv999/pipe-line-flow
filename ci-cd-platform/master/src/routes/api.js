const crypto = require('crypto');
const express = require('express');
const { isValidObjectId } = require('mongoose');
const { Agent, Pipeline, Run, Job, Log } = require('../models');
const auth = require('../auth');
const dispatcher = require('../services/dispatcher');
const hub = require('../grpc/agentHub');

const router = express.Router();
const SHELLS = ['bash', 'sh', 'zsh', 'pwsh'];

const newToken = () => crypto.randomBytes(24).toString('hex');

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

function pickPipeline(b = {}) {
  const name = String(b.name || '').trim();
  if (!name) throw badRequest('Pipeline name is required');
  const env = (b.env || []).filter((e) => e && String(e.key || '').trim()).map((e) => {
    const key = String(e.key).trim();
    if (!dispatcher.ENV_KEY.test(key)) throw badRequest(`Invalid environment variable name: ${key}`);
    return { key, value: String(e.value ?? ''), secret: !!e.secret };
  });
  return {
    name,
    description: String(b.description || ''),
    shell: SHELLS.includes(b.shell) ? b.shell : 'bash',
    workingDir: String(b.workingDir || '').trim(),
    steps: (b.steps || []).map((s, i) => ({
      name: String(s.name || '').trim() || `Step ${i + 1}`,
      script: String(s.script || ''),
      continueOnError: !!s.continueOnError,
      timeoutSeconds: Math.max(0, parseInt(s.timeoutSeconds, 10) || 0),
    })),
    env,
    targets: {
      agents: (b.targets?.agents || []).filter(isValidObjectId),
      labels: (b.targets?.labels || []).map((s) => String(s).trim()).filter(Boolean),
    },
  };
}

// Never send secret values back to the browser
function sanitizePipeline(p, { includeToken = false } = {}) {
  const o = p.toObject ? p.toObject() : { ...p };
  o.env = (o.env || []).map((e) => (e.secret ? { ...e, value: '', hasValue: !!e.value } : e));
  if (!includeToken) delete o.webhookToken;
  return o;
}

router.param('id', (req, res, next, id) => (isValidObjectId(id) ? next() : res.status(404).json({ error: 'Not found' })));

// ---------- public ----------
router.post('/auth/login', (req, res) => {
  const token = auth.login(req.body?.username, req.body?.password);
  if (!token) return res.status(401).json({ error: 'Invalid username or password' });
  res.json({ token, user: req.body.username });
});

// Webhook trigger (e.g. from GitHub/GitLab): POST /api/hooks/:id?token=...
router.post('/hooks/:id', async (req, res) => {
  const token = req.query.token || req.get('x-cicd-token') || '';
  const p = await Pipeline.findById(req.params.id);
  if (!p || !p.webhookToken || !auth.safeEqual(token, p.webhookToken)) {
    return res.status(403).json({ error: 'Invalid pipeline or token' });
  }
  const run = await dispatcher.triggerRun(p._id, { type: 'webhook', user: 'webhook', payload: req.body || {} });
  res.status(201).json({ runId: run._id, number: run.number, status: run.status });
});

router.get('/health', (req, res) => res.json({ ok: true, agentsOnline: hub.onlineIds().length }));

// ---------- everything below requires login ----------
router.use(auth.requireAuth);

// Agents
router.get('/agents', async (req, res) => {
  res.json(await Agent.find().sort({ name: 1 }));
});

router.delete('/agents/:id', async (req, res) => {
  if (hub.isOnline(req.params.id)) return res.status(409).json({ error: 'Stop the agent before removing it' });
  await Agent.deleteOne({ _id: req.params.id });
  await Pipeline.updateMany({}, { $pull: { 'targets.agents': req.params.id } });
  res.json({ ok: true });
});

// Pipelines
router.get('/pipelines', async (req, res) => {
  const pipelines = await Pipeline.find().sort({ name: 1 });
  const lastRuns = await Run.aggregate([
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$pipeline', run: { $first: '$$ROOT' } } },
  ]);
  const byPipeline = new Map(lastRuns.map((r) => [String(r._id), r.run]));
  res.json(pipelines.map((p) => {
    const lr = byPipeline.get(String(p._id));
    return {
      ...sanitizePipeline(p),
      lastRun: lr ? { _id: lr._id, number: lr.number, status: lr.status, createdAt: lr.createdAt, finishedAt: lr.finishedAt, startedAt: lr.startedAt } : null,
    };
  }));
});

router.post('/pipelines', async (req, res) => {
  const p = await Pipeline.create({ ...pickPipeline(req.body), webhookToken: newToken() });
  res.status(201).json(sanitizePipeline(p, { includeToken: true }));
});

router.get('/pipelines/:id', async (req, res) => {
  const p = await Pipeline.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pipeline not found' });
  res.json(sanitizePipeline(p, { includeToken: true }));
});

router.put('/pipelines/:id', async (req, res) => {
  const p = await Pipeline.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pipeline not found' });
  const data = pickPipeline(req.body);
  // A secret sent back empty means "keep the stored value"
  data.env = data.env.map((e) => {
    if (e.secret && e.value === '') {
      const old = p.env.find((o) => o.key === e.key && o.secret);
      if (old) return { ...e, value: old.value };
    }
    return e;
  });
  p.set(data);
  await p.save();
  res.json(sanitizePipeline(p, { includeToken: true }));
});

router.delete('/pipelines/:id', async (req, res) => {
  const runs = await Run.find({ pipeline: req.params.id }).select('_id');
  const jobs = await Job.find({ run: { $in: runs.map((r) => r._id) } }).select('_id');
  await Log.deleteMany({ job: { $in: jobs.map((j) => j._id) } });
  await Job.deleteMany({ _id: { $in: jobs.map((j) => j._id) } });
  await Run.deleteMany({ pipeline: req.params.id });
  await Pipeline.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
});

router.post('/pipelines/:id/run', async (req, res) => {
  const run = await dispatcher.triggerRun(req.params.id, { type: 'manual', user: req.user.sub }, req.body?.env);
  res.status(201).json(run);
});

router.post('/pipelines/:id/webhook-token', async (req, res) => {
  const p = await Pipeline.findByIdAndUpdate(req.params.id, { webhookToken: newToken() }, { new: true });
  if (!p) return res.status(404).json({ error: 'Pipeline not found' });
  res.json({ webhookToken: p.webhookToken });
});

// Runs
router.get('/runs', async (req, res) => {
  const q = {};
  if (req.query.pipeline && isValidObjectId(req.query.pipeline)) q.pipeline = req.query.pipeline;
  if (req.query.status) q.status = String(req.query.status);
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
  const runs = await Run.find(q).sort({ createdAt: -1 }).limit(limit).select('-spec -trigger.payload');
  res.json(runs);
});

router.get('/runs/:id', async (req, res) => {
  const run = await Run.findById(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const jobs = await Job.find({ run: run._id }).sort({ agentName: 1 });
  res.json({ run: dispatcher.sanitizeRun(run), jobs });
});

router.post('/runs/:id/cancel', async (req, res) => {
  res.json(await dispatcher.cancelRun(req.params.id));
});

// Logs
router.get('/jobs/:id/logs', async (req, res) => {
  await dispatcher.flushLogs();
  const logs = await Log.find({ job: req.params.id }).sort({ seq: 1 }).limit(50000)
    .select('seq stepIndex stream data ts -_id').lean();
  res.json(logs);
});

module.exports = router;
