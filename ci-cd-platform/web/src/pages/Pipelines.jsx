import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useSocket } from '../socket';
import StatusBadge from '../components/StatusBadge';
import { duration, timeAgo } from '../utils';

export default function Pipelines() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const navigate = useNavigate();

  useEffect(() => { api('/pipelines').then(setItems).catch((e) => setError(e.message)); }, []);

  useSocket('run:update', (run) => setItems((list) => list && list.map((p) => (
    p._id === run.pipeline && (!p.lastRun || run.number >= p.lastRun.number) ? { ...p, lastRun: run } : p
  ))));

  const runNow = async (p) => {
    try {
      const run = await api(`/pipelines/${p._id}/run`, { method: 'POST', body: {} });
      navigate(`/runs/${run._id}`);
    } catch (e) { alert(e.message); }
  };

  const shown = (items || []).filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Pipelines</h1>
          <p className="muted">Shell steps that run on your deploy servers</p>
        </div>
        <div className="row gap-sm">
          <input className="search" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <Link className="btn primary" to="/pipelines/new">New pipeline</Link>
        </div>
      </header>
      {error && <div className="alert error">{error}</div>}

      {items && items.length === 0 && (
        <div className="empty">
          <h3>No pipelines yet</h3>
          <p className="muted">Create one, add shell steps, pick the servers it deploys to.</p>
          <Link className="btn primary" to="/pipelines/new">Create your first pipeline</Link>
        </div>
      )}

      <div className="pipeline-list">
        {shown.map((p) => (
          <div key={p._id} className="pipeline-row">
            <div className="pipeline-main">
              <Link to={`/pipelines/${p._id}`} className="pipeline-name">{p.name}</Link>
              <div className="muted sm">
                {p.steps.length} step{p.steps.length === 1 ? '' : 's'}
                {' · '}
                {p.targets.agents.length} server{p.targets.agents.length === 1 ? '' : 's'}
                {p.targets.labels.length > 0 && <> · labels {p.targets.labels.map((l) => <span key={l} className="pill">{l}</span>)}</>}
              </div>
              {p.description && <div className="muted sm desc">{p.description}</div>}
            </div>
            <div className="pipeline-last">
              {p.lastRun ? (
                <Link to={`/runs/${p.lastRun._id}`} className="last-run">
                  <StatusBadge status={p.lastRun.status} />
                  <span className="muted sm">#{p.lastRun.number} · {timeAgo(p.lastRun.createdAt)} · {duration(p.lastRun.startedAt, p.lastRun.finishedAt)}</span>
                </Link>
              ) : <StatusBadge status={null} />}
            </div>
            <div className="row gap-sm">
              <Link className="btn ghost sm" to={`/pipelines/${p._id}`}>Edit</Link>
              <button type="button" className="btn sm" onClick={() => runNow(p)}>▶ Run</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
