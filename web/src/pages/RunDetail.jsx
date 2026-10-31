import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useSocket } from '../socket';
import StatusBadge from '../components/StatusBadge';
import JobLogs from '../components/JobLogs';
import { duration, isActive, useTicker } from '../utils';

export default function RunDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [run, setRun] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  useTicker(run && isActive(run.status));

  useEffect(() => {
    setRun(null);
    setSelected(null);
    api(`/runs/${id}`).then(({ run: r, jobs: j }) => {
      setRun(r);
      setJobs(j);
      setSelected(j[0]?._id || null);
    }).catch((e) => setError(e.message));
  }, [id]);

  useSocket('run:update', (r) => { if (r._id === id) setRun(r); });
  useSocket('job:update', (j) => {
    if (j.run !== id) return;
    setJobs((list) => list.map((x) => (x._id === j._id ? j : x)));
  });

  const cancel = async () => {
    if (!window.confirm('Cancel this run? Running steps will be killed.')) return;
    try { setRun(await api(`/runs/${id}/cancel`, { method: 'POST' })); } catch (e) { alert(e.message); }
  };
  const rerun = async () => {
    try {
      const r = await api(`/pipelines/${run.pipeline}/run`, { method: 'POST', body: {} });
      navigate(`/runs/${r._id}`);
    } catch (e) { alert(e.message); }
  };

  if (error) return <div className="page"><div className="alert error">{error}</div></div>;
  if (!run) return <div className="page"><p className="muted">Loading…</p></div>;
  const job = jobs.find((j) => j._id === selected);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="crumbs"><Link to={`/pipelines/${run.pipeline}`}>{run.pipelineName}</Link> / <Link to={`/runs?pipeline=${run.pipeline}`}>runs</Link> /</div>
          <h1 className="row gap-sm">#{run.number} <StatusBadge status={run.status} /></h1>
          <p className="muted sm">
            {run.trigger?.type === 'webhook' ? 'Triggered by webhook' : `Started by ${run.trigger?.user || 'unknown'}`}
            {' · '}{new Date(run.createdAt).toLocaleString()}
            {' · '}duration <span className="mono">{duration(run.startedAt, run.finishedAt)}</span>
          </p>
        </div>
        <div className="row gap-sm">
          {isActive(run.status) && <button type="button" className="btn danger" onClick={cancel}>Cancel</button>}
          <Link className="btn ghost" to={`/pipelines/${run.pipeline}`}>Edit pipeline</Link>
          <button type="button" className="btn primary" onClick={rerun}>↻ Run again</button>
        </div>
      </header>

      <div className="job-tabs">
        {jobs.map((j) => (
          <button type="button" key={j._id} className={`job-tab ${j._id === selected ? 'active' : ''}`} onClick={() => setSelected(j._id)}>
            <StatusBadge status={j.status} />
            <span>{j.agentName}</span>
            <span className="muted sm mono">{duration(j.startedAt, j.finishedAt)}</span>
          </button>
        ))}
      </div>
      {job?.status === 'queued' && (
        <div className="alert">Waiting for agent <b>{job.agentName}</b> to come online. The job starts as soon as it connects.</div>
      )}
      {job && <JobLogs key={job._id} job={job} />}
    </div>
  );
}
