const mongoose = require('mongoose');
const { Schema } = mongoose;
const { ObjectId, Mixed } = Schema.Types;

// A deploy server running the agent
const AgentSchema = new Schema({
  name: { type: String, required: true, unique: true },
  hostname: String,
  platform: String,
  version: String,
  labels: [String],
  status: { type: String, enum: ['online', 'offline'], default: 'offline' },
  busy: { type: Boolean, default: false },
  lastSeen: Date,
  ip: String,
  stats: { load: Number, freeMem: Number, totalMem: Number },
}, { timestamps: true });

const StepSchema = new Schema({
  name: { type: String, required: true },
  script: { type: String, default: '' },
  continueOnError: { type: Boolean, default: false },
  timeoutSeconds: { type: Number, default: 0 },
}, { _id: false });

const EnvSchema = new Schema({
  key: { type: String, required: true },
  value: { type: String, default: '' },
  secret: { type: Boolean, default: false },
}, { _id: false });

const PipelineSchema = new Schema({
  name: { type: String, required: true, unique: true, trim: true },
  description: { type: String, default: '' },
  shell: { type: String, default: 'bash' },
  workingDir: { type: String, default: '' },
  steps: [StepSchema],
  env: [EnvSchema],
  targets: {
    agents: [{ type: ObjectId, ref: 'Agent' }],
    labels: [String],
  },
  webhookToken: String,
  runCount: { type: Number, default: 0 },
}, { timestamps: true });

// One execution of a pipeline (fans out to one Job per target agent)
const RunSchema = new Schema({
  pipeline: { type: ObjectId, ref: 'Pipeline', index: true },
  pipelineName: String,
  number: Number,
  status: { type: String, default: 'queued' }, // queued | running | success | failed | cancelled
  trigger: { type: { type: String }, user: String, payload: Mixed },
  spec: Mixed, // snapshot: { steps, env, secretKeys, shell, workingDir }
  startedAt: Date,
  finishedAt: Date,
}, { timestamps: true });
RunSchema.index({ createdAt: -1 });

const JobStepSchema = new Schema({
  name: String,
  status: { type: String, default: 'pending' }, // pending | running | success | failed | skipped | cancelled
  exitCode: Number,
  startedAt: Date,
  finishedAt: Date,
}, { _id: false });

// The part of a run executed on one agent
const JobSchema = new Schema({
  run: { type: ObjectId, ref: 'Run', index: true },
  pipeline: { type: ObjectId, ref: 'Pipeline' },
  agent: { type: ObjectId, ref: 'Agent', index: true },
  agentName: String,
  status: { type: String, default: 'queued', index: true },
  steps: [JobStepSchema],
  error: String,
  startedAt: Date,
  finishedAt: Date,
}, { timestamps: true });

const LogSchema = new Schema({
  job: { type: ObjectId, ref: 'Job' },
  seq: Number,
  stepIndex: Number,
  stream: String,
  data: String,
  ts: Date,
});
LogSchema.index({ job: 1, seq: 1 });

module.exports = {
  Agent: mongoose.model('Agent', AgentSchema),
  Pipeline: mongoose.model('Pipeline', PipelineSchema),
  Run: mongoose.model('Run', RunSchema),
  Job: mongoose.model('Job', JobSchema),
  Log: mongoose.model('Log', LogSchema),
};
