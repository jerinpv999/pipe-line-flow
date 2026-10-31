import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import ShellEditor from '../components/ShellEditor';
import { setEnvKeys } from '../shellLanguage';

const STARTER = `#!/usr/bin/env bash
set -euo pipefail

echo "Deploying $CI_PIPELINE_NAME #$CI_RUN_NUMBER on $CI_AGENT_NAME"
cd "$CI_WORKSPACE"

# Type a snippet name and press Ctrl+Space, e.g. git-sync, npm-build, pm2-reload, healthcheck
`;

const newStep = (n) => ({ name: `Step ${n}`, script: 'set -euo pipefail\n\n', continueOnError: false, timeoutSeconds: 0 });

const EMPTY = {
  name: '',
  description: '',
  shell: 'bash',
  workingDir: '',
  env: [],
  targets: { agents: [], labels: [] },
  steps: [{ name: 'Deploy', script: STARTER, continueOnError: false, timeoutSeconds: 0 }],
};

export default function PipelineEdit() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const [p, setP] = useState(isNew ? EMPTY : null);
  const [labelsText, setLabelsText] = useState('');
  const [agents, setAgents] = useState([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    api('/agents').then(setAgents).catch(() => {});
    if (!isNew) {
      api(`/pipelines/${id}`).then((data) => {
        setP(data);
        setLabelsText(data.targets.labels.join(', '));
      }).catch((e) => setError(e.message));
    }
  }, [id, isNew]);

  useEffect(() => { if (p) setEnvKeys(p.env.map((e) => e.key)); }, [p]);

  const update = (patch) => { setP((cur) => ({ ...cur, ...patch })); setDirty(true); };
  const updateStep = (i, patch) => update({ steps: p.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const moveStep = (i, d) => {
    const steps = [...p.steps];
    [steps[i], steps[i + d]] = [steps[i + d], steps[i]];
    update({ steps });
  };
  const updateEnv = (i, patch) => update({ env: p.env.map((e, j) => (j === i ? { ...e, ...patch } : e)) });
  const toggleAgent = (agentId) => {
    const has = p.targets.agents.includes(agentId);
    update({ targets: { ...p.targets, agents: has ? p.targets.agents.filter((a) => a !== agentId) : [...p.targets.agents, agentId] } });
  };

  const save = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const body = {
        ...p,
        targets: { agents: p.targets.agents, labels: labelsText.split(',').map((s) => s.trim()).filter(Boolean) },
      };
      const result = isNew
        ? await api('/pipelines', { method: 'POST', body })
        : await api(`/pipelines/${id}`, { method: 'PUT', body });
      setP(result);
      setDirty(false);
      setSaved(`Saved ${new Date().toLocaleTimeString()}`);
      if (isNew) navigate(`/pipelines/${result._id}`, { replace: true });
      return result;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }, [p, labelsText, isNew, id, navigate]);

  // Ctrl/Cmd+S saves from anywhere on the page, including inside the editors
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const saveAndRun = async () => {
    const result = dirty || isNew ? await save() : p;
    if (!result) return;
    try {
      const run = await api(`/pipelines/${result._id}/run`, { method: 'POST', body: {} });
      navigate(`/runs/${run._id}`);
    } catch (e) { setError(e.message); }
  };

  const regenerateToken = async () => {
    if (!window.confirm('Generate a new webhook token? The old URL will stop working.')) return;
    const { webhookToken } = await api(`/pipelines/${id}/webhook-token`, { method: 'POST' });
    setP((cur) => ({ ...cur, webhookToken }));
  };

  const remove = async () => {
    if (!window.confirm(`Delete pipeline "${p.name}" and all its run history?`)) return;
    await api(`/pipelines/${id}`, { method: 'DELETE' });
    navigate('/pipelines');
  };

  if (!p) return <div className="page">{error ? <div className="alert error">{error}</div> : <p className="muted">Loading…</p>}</div>;

  const labelList = labelsText.split(',').map((s) => s.trim()).filter(Boolean);
  const matchedByLabel = agents.filter((a) => (a.labels || []).some((l) => labelList.includes(l)));
  const webhookUrl = !isNew && p.webhookToken ? `${window.location.origin}/api/hooks/${p._id}?token=${p.webhookToken}` : '';

  return (
    <div className="page">
      <header className="page-head sticky">
        <div>
          <div className="crumbs"><Link to="/pipelines">Pipelines</Link> /</div>
          <h1>{isNew ? 'New pipeline' : p.name || 'Untitled'}</h1>
        </div>
        <div className="row gap-sm">
          <span className="muted sm">{dirty ? 'Unsaved changes' : saved}</span>
          {!isNew && <Link className="btn ghost" to={`/runs?pipeline=${id}`}>History</Link>}
          <button type="button" className="btn" onClick={save} disabled={busy}>Save <kbd>Ctrl S</kbd></button>
          <button type="button" className="btn primary" onClick={saveAndRun} disabled={busy}>{dirty || isNew ? 'Save & run' : '▶ Run'}</button>
        </div>
      </header>
      {error && <div className="alert error">{error}</div>}

      <div className="edit-grid">
        <div className="edit-main">
          <section className="card">
            <div className="grid-2">
              <label className="field">
                <span>Name</span>
                <input value={p.name} onChange={(e) => update({ name: e.target.value })} placeholder="api-production-deploy" />
              </label>
              <label className="field">
                <span>Shell</span>
                <select value={p.shell} onChange={(e) => update({ shell: e.target.value })}>
                  <option value="bash">bash</option>
                  <option value="sh">sh</option>
                  <option value="zsh">zsh</option>
                  <option value="pwsh">PowerShell (pwsh)</option>
                </select>
              </label>
            </div>
            <label className="field">
              <span>Description</span>
              <input value={p.description} onChange={(e) => update({ description: e.target.value })} placeholder="What this pipeline does" />
            </label>
            <label className="field">
              <span>Working directory on the server <em className="muted">(optional — defaults to a workspace folder per pipeline)</em></span>
              <input className="mono" value={p.workingDir} onChange={(e) => update({ workingDir: e.target.value })} placeholder="/var/www/myapp" />
            </label>
          </section>

          <h2 className="section-title">Steps <span className="muted sm">run in order; a failing step stops the job unless "continue on error" is set</span></h2>
          {p.steps.map((s, i) => (
            <section key={i} className="card step-card">
              <div className="step-head">
                <span className="step-num">{i + 1}</span>
                <input className="step-title" value={s.name} onChange={(e) => updateStep(i, { name: e.target.value })} />
                <label className="field inline">
                  <span>Timeout (s)</span>
                  <input type="number" min="0" value={s.timeoutSeconds} onChange={(e) => updateStep(i, { timeoutSeconds: e.target.value })} title="0 = no timeout" />
                </label>
                <label className="check"><input type="checkbox" checked={s.continueOnError} onChange={(e) => updateStep(i, { continueOnError: e.target.checked })} /> Continue on error</label>
                <div className="row gap-xs">
                  <button type="button" className="icon-btn" disabled={i === 0} onClick={() => moveStep(i, -1)} title="Move up">↑</button>
                  <button type="button" className="icon-btn" disabled={i === p.steps.length - 1} onClick={() => moveStep(i, 1)} title="Move down">↓</button>
                  <button type="button" className="icon-btn danger" disabled={p.steps.length === 1} onClick={() => update({ steps: p.steps.filter((_, j) => j !== i) })} title="Delete step">✕</button>
                </div>
              </div>
              <ShellEditor value={s.script} shell={p.shell} onChange={(script) => updateStep(i, { script })} />
            </section>
          ))}
          <button type="button" className="btn ghost block dashed" onClick={() => update({ steps: [...p.steps, newStep(p.steps.length + 1)] })}>+ Add step</button>
        </div>

        <aside className="edit-side">
          <section className="card">
            <h3>Deploy to</h3>
            <p className="muted sm">The pipeline runs on every selected server, in parallel.</p>
            {agents.length === 0 && <p className="muted sm">No agents connected yet — see the Agents page.</p>}
            <div className="agent-picks">
              {agents.map((a) => (
                <label key={a._id} className={`agent-pick ${p.targets.agents.includes(a._id) ? 'on' : ''}`}>
                  <input type="checkbox" checked={p.targets.agents.includes(a._id)} onChange={() => toggleAgent(a._id)} />
                  <span className={`dot ${a.status}`} />
                  <span className="grow">{a.name}</span>
                  <span className="muted sm">{(a.labels || []).join(', ')}</span>
                </label>
              ))}
            </div>
            <label className="field">
              <span>…or every server with label</span>
              <input value={labelsText} onChange={(e) => { setLabelsText(e.target.value); setDirty(true); }} placeholder="production, web" />
            </label>
            {labelList.length > 0 && <p className="muted sm">Matches now: {matchedByLabel.map((a) => a.name).join(', ') || 'none'}</p>}
          </section>

          <section className="card">
            <h3>Environment variables</h3>
            <p className="muted sm">Available to every step as <code>$NAME</code>. Secret values are hidden and masked in logs.</p>
            {p.env.map((e, i) => (
              <div key={i} className="env-row">
                <input className="mono" placeholder="NAME" value={e.key} onChange={(ev) => updateEnv(i, { key: ev.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} />
                <input
                  className="mono"
                  type={e.secret ? 'password' : 'text'}
                  placeholder={e.secret && e.hasValue ? '•••••• (unchanged)' : 'value'}
                  value={e.value}
                  onChange={(ev) => updateEnv(i, { value: ev.target.value })}
                />
                <label className="check sm" title="Secret"><input type="checkbox" checked={!!e.secret} onChange={(ev) => updateEnv(i, { secret: ev.target.checked })} />🔒</label>
                <button type="button" className="icon-btn danger" onClick={() => update({ env: p.env.filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
            <button type="button" className="btn ghost sm" onClick={() => update({ env: [...p.env, { key: '', value: '', secret: false }] })}>+ Add variable</button>
          </section>

          {!isNew && (
            <section className="card">
              <h3>Webhook trigger</h3>
              <p className="muted sm">POST to this URL (e.g. from a GitHub/GitLab push webhook) to start a run. The body is available as <code>$CI_TRIGGER_PAYLOAD</code>.</p>
              <pre className="code wrap">{webhookUrl}</pre>
              <div className="row gap-sm">
                <button type="button" className="btn ghost sm" onClick={() => navigator.clipboard?.writeText(webhookUrl)}>Copy URL</button>
                <button type="button" className="btn ghost sm" onClick={regenerateToken}>New token</button>
              </div>
            </section>
          )}

          {!isNew && <button type="button" className="btn ghost danger block" onClick={remove}>Delete pipeline</button>}
        </aside>
      </div>
    </div>
  );
}
