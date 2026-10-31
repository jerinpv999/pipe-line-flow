// Runs pipeline jobs one at a time; each step is a shell script executed in the pipeline workspace.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';

function slug(s) {
  return String(s || 'pipeline').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'pipeline';
}

function shellCommand(shell, file) {
  switch (shell) {
    case 'pwsh': return { cmd: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-File', file], ext: '.ps1' };
    case 'sh': return { cmd: 'sh', args: [file], ext: '.sh' };
    case 'zsh': return { cmd: 'zsh', args: [file], ext: '.sh' };
    default: return { cmd: 'bash', args: ['--noprofile', '--norc', file], ext: '.sh' };
  }
}

class Executor {
  /**
   * @param {object} cfg agent config
   * @param {(msg: object) => void} send writes an AgentMessage to the master
   */
  constructor(cfg, send) {
    this.cfg = cfg;
    this.send = send;
    this.queue = [];
    this.current = null; // { jobId, proc, cancelled, aborted }
  }

  get busy() {
    return !!this.current || this.queue.length > 0;
  }

  enqueue(job) {
    console.log(`[agent] job ${job.jobId} received (${job.pipelineName}, ${job.steps.length} steps)`);
    this.queue.push(job);
    this._next();
  }

  cancel(jobId) {
    if (this.current?.jobId === jobId) {
      console.log(`[agent] cancelling job ${jobId}`);
      this.current.cancelled = true;
      this._kill(this.current.proc);
      return;
    }
    const before = this.queue.length;
    this.queue = this.queue.filter((j) => j.jobId !== jobId);
    if (this.queue.length !== before) {
      this.send({ result: { jobId, status: 'cancelled', error: 'Cancelled before start', timestamp: Date.now() } });
    }
  }

  /** Connection to master lost: the master already marked our jobs failed, so stop everything. */
  abortAll() {
    this.queue = [];
    if (this.current) {
      console.log(`[agent] aborting job ${this.current.jobId} (lost connection to master)`);
      this.current.aborted = true;
      this._kill(this.current.proc);
    }
  }

  async _next() {
    if (this.current || !this.queue.length) return;
    const job = this.queue.shift();
    this.current = { jobId: job.jobId, proc: null, cancelled: false, aborted: false };
    const ctx = this.current;
    try {
      await this._runJob(job, ctx);
    } catch (err) {
      this._log(job.jobId, -1, 'system', `Agent error: ${err.message}\n`);
      if (!ctx.aborted) this.send({ result: { jobId: job.jobId, status: 'failed', error: err.message, timestamp: Date.now() } });
    } finally {
      this.current = null;
      setImmediate(() => this._next());
    }
  }

  _log(jobId, stepIndex, stream, data) {
    this.send({ log: { jobId, stepIndex, stream, data, timestamp: Date.now() } });
  }

  _step(jobId, stepIndex, status, exitCode = 0) {
    this.send({ step: { jobId, stepIndex, status, exitCode, timestamp: Date.now() } });
  }

  async _runJob(job, ctx) {
    const workDir = job.workingDir
      ? path.resolve(job.workingDir)
      : path.join(this.cfg.workspace, slug(job.pipelineName));
    fs.mkdirSync(workDir, { recursive: true });
    this._log(job.jobId, -1, 'system', `Agent ${this.cfg.name} (${os.hostname()}) · workspace ${workDir} · shell ${job.shell || 'bash'}\n`);

    let failed = false;
    let firstError = '';

    for (let i = 0; i < job.steps.length; i++) {
      const step = job.steps[i];
      if (ctx.aborted) return;
      if (ctx.cancelled || failed) {
        this._step(job.jobId, i, 'skipped');
        continue;
      }

      this._step(job.jobId, i, 'running');
      const started = Date.now();
      const code = await this._runStep(job, i, step, workDir, ctx);
      if (ctx.aborted) return;
      const secs = ((Date.now() - started) / 1000).toFixed(1);

      if (ctx.cancelled) {
        this._log(job.jobId, i, 'system', `\nStep cancelled after ${secs}s\n`);
        this._step(job.jobId, i, 'cancelled', code);
      } else if (code === 0) {
        this._log(job.jobId, i, 'system', `\nStep finished in ${secs}s (exit 0)\n`);
        this._step(job.jobId, i, 'success', 0);
      } else {
        this._log(job.jobId, i, 'system', `\nStep failed in ${secs}s (exit ${code})${step.continueOnError ? ' — continuing (continue on error)' : ''}\n`);
        this._step(job.jobId, i, 'failed', code);
        if (!step.continueOnError) {
          failed = true;
          firstError = `Step "${step.name}" exited with code ${code}`;
        }
      }
    }

    const status = ctx.cancelled ? 'cancelled' : failed ? 'failed' : 'success';
    console.log(`[agent] job ${job.jobId} ${status}`);
    this.send({ result: { jobId: job.jobId, status, error: firstError, timestamp: Date.now() } });
  }

  _runStep(job, index, step, workDir, ctx) {
    return new Promise((resolve) => {
      const { cmd, args, ext } = shellCommand(job.shell);
      const scriptFile = path.join(os.tmpdir(), `cicd-${job.jobId}-${index}${ext}`);
      // Normalise Windows line endings so bash doesn't choke on \r
      fs.writeFileSync(scriptFile, (step.script || '').replace(/\r\n/g, '\n'), { mode: 0o700 });
      args[args.length - 1] = scriptFile;

      this._log(job.jobId, index, 'system', `▶ ${step.name}\n`);

      let proc;
      try {
        proc = spawn(cmd, args, {
          cwd: workDir,
          env: { ...process.env, ...job.env, CI_WORKSPACE: workDir, CI_STEP_NAME: step.name, CI_STEP_INDEX: String(index) },
          detached: !IS_WIN, // own process group so cancel kills child processes too
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        this._log(job.jobId, index, 'stderr', `Failed to start ${cmd}: ${err.message}\n`);
        return resolve(127);
      }
      ctx.proc = proc;

      let timer = null;
      if (step.timeoutSeconds > 0) {
        timer = setTimeout(() => {
          this._log(job.jobId, index, 'system', `\nTimed out after ${step.timeoutSeconds}s — killing\n`);
          this._kill(proc);
        }, step.timeoutSeconds * 1000);
      }

      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (d) => this._log(job.jobId, index, 'stdout', d));
      proc.stderr.on('data', (d) => this._log(job.jobId, index, 'stderr', d));

      let done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        ctx.proc = null;
        fs.rm(scriptFile, { force: true }, () => {});
        resolve(code);
      };
      proc.on('error', (err) => {
        this._log(job.jobId, index, 'stderr', `Failed to start ${cmd}: ${err.message}\n`);
        finish(127);
      });
      proc.on('close', (code, signal) => finish(code ?? (signal ? 128 + (os.constants.signals[signal] || 1) : 1)));
    });
  }

  _kill(proc) {
    if (!proc || proc.exitCode !== null) return;
    const sig = (s) => {
      try {
        if (IS_WIN) proc.kill(s);
        else process.kill(-proc.pid, s); // whole process group
      } catch { /* already gone */ }
    };
    sig('SIGTERM');
    setTimeout(() => proc.exitCode === null && sig('SIGKILL'), 5000).unref();
  }
}

module.exports = { Executor };
