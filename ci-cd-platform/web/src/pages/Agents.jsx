import { useEffect, useState } from 'react';
import { api } from '../api';
import { useSocket } from '../socket';
import { bytes, timeAgo, useTicker } from '../utils';

export default function Agents() {
  const [agents, setAgents] = useState([]);
  const [error, setError] = useState('');
  useTicker(true, 5000);

  useEffect(() => { api('/agents').then(setAgents).catch((e) => setError(e.message)); }, []);

  useSocket('agents:update', (a) => setAgents((list) => {
    const i = list.findIndex((x) => x._id === a._id);
    if (i === -1) return [...list, a].sort((x, y) => x.name.localeCompare(y.name));
    const copy = [...list];
    copy[i] = a;
    return copy;
  }));

  const remove = async (a) => {
    if (!window.confirm(`Remove agent "${a.name}"? It will re-appear if it connects again.`)) return;
    try {
      await api(`/agents/${a._id}`, { method: 'DELETE' });
      setAgents((l) => l.filter((x) => x._id !== a._id));
    } catch (e) { alert(e.message); }
  };

  const online = agents.filter((a) => a.status === 'online').length;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Agents</h1>
          <p className="muted">{online} of {agents.length} deploy servers online</p>
        </div>
      </header>
      {error && <div className="alert error">{error}</div>}

      {agents.length === 0 ? (
        <div className="empty">
          <h3>No agents yet</h3>
          <p className="muted">Install the agent on a deploy server and it will show up here automatically.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Status</th><th>Host</th><th>Labels</th><th>Load</th><th>Memory</th><th>Last seen</th><th /></tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a._id}>
                  <td><b>{a.name}</b><div className="muted sm">v{a.version}</div></td>
                  <td>
                    <span className={`dot ${a.status}`} /> {a.status}
                    {a.status === 'online' && a.busy && <span className="pill warn">busy</span>}
                  </td>
                  <td><div>{a.hostname}</div><div className="muted sm">{a.platform}</div></td>
                  <td>{(a.labels || []).map((l) => <span key={l} className="pill">{l}</span>)}</td>
                  <td className="mono">{a.stats?.load != null ? a.stats.load.toFixed(2) : '—'}</td>
                  <td className="mono sm">{a.stats?.totalMem ? `${bytes(a.stats.totalMem - a.stats.freeMem)} / ${bytes(a.stats.totalMem)}` : '—'}</td>
                  <td className="muted">{timeAgo(a.lastSeen)}</td>
                  <td>{a.status === 'offline' && <button type="button" className="btn ghost sm danger" onClick={() => remove(a)}>Remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="card">
        <h3>Connect a new server</h3>
        <p className="muted">On the deploy server (Node 18+), copy the <code>agent/</code> and <code>proto/</code> folders, then:</p>
        <pre className="code">{`cd agent && npm ci --omit=dev
MASTER_ADDR=${window.location.hostname}:50051 \\
AGENT_TOKEN=<AGENT_TOKEN from master .env> \\
AGENT_NAME=web-prod-1 \\
AGENT_LABELS=production,web \\
node src/index.js`}</pre>
        <p className="muted sm">For a permanent install use the included <code>cicd-agent.service</code> systemd unit or the agent Docker image.</p>
      </section>
    </div>
  );
}
