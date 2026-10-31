import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useSocket } from '../socket';
import StatusBadge from '../components/StatusBadge';
import { duration, isActive, timeAgo, useTicker } from '../utils';

export default function Runs() {
  const [params, setParams] = useSearchParams();
  const pipeline = params.get('pipeline') || '';
  const [runs, setRuns] = useState([]);
  const [pipelines, setPipelines] = useState([]);
  const [error, setError] = useState('');
  useTicker(runs.some((r) => isActive(r.status)));

  useEffect(() => { api('/pipelines').then(setPipelines).catch(() => {}); }, []);
  useEffect(() => {
    api(`/runs?limit=100${pipeline ? `&pipeline=${pipeline}` : ''}`).then(setRuns).catch((e) => setError(e.message));
  }, [pipeline]);

  useSocket('run:update', (run) => {
    if (pipeline && run.pipeline !== pipeline) return;
    setRuns((list) => {
      const i = list.findIndex((r) => r._id === run._id);
      if (i === -1) return [run, ...list];
      const copy = [...list];
      copy[i] = run;
      return copy;
    });
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Runs</h1>
          <p className="muted">Live history of every pipeline execution</p>
        </div>
        <select value={pipeline} onChange={(e) => setParams(e.target.value ? { pipeline: e.target.value } : {})}>
          <option value="">All pipelines</option>
          {pipelines.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
        </select>
      </header>
      {error && <div className="alert error">{error}</div>}
      {runs.length === 0 ? <div className="empty"><p className="muted">No runs yet.</p></div> : (
        <div className="table-wrap">
          <table className="table clickable">
            <thead><tr><th>Status</th><th>Pipeline</th><th>Run</th><th>Trigger</th><th>Started</th><th>Duration</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r._id}>
                  <td><Link to={`/runs/${r._id}`}><StatusBadge status={r.status} /></Link></td>
                  <td><Link to={`/runs/${r._id}`}><b>{r.pipelineName}</b></Link></td>
                  <td className="mono">#{r.number}</td>
                  <td className="muted">{r.trigger?.type}{r.trigger?.user && r.trigger.type !== 'webhook' ? ` · ${r.trigger.user}` : ''}</td>
                  <td className="muted">{timeAgo(r.createdAt)}</td>
                  <td className="mono">{duration(r.startedAt, r.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
