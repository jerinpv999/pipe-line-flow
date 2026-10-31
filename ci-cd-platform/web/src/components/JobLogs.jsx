import { useEffect, useMemo, useRef, useState } from 'react';
import Convert from 'ansi-to-html';
import { api } from '../api';
import { getSocket } from '../socket';
import { duration, useTicker } from '../utils';

const convert = new Convert({ escapeXml: true, newline: false, fg: '#d6dbe1', bg: '#0b0d10' });
const STEP_ICON = { pending: '○', running: '◐', success: '✓', failed: '✕', skipped: '–', cancelled: '⊘' };

function renderChunks(chunks) {
  return chunks.map((c) => {
    const html = convert.toHtml(c.data);
    if (c.stream === 'stderr') return `<span class="log-err">${html}</span>`;
    if (c.stream === 'system') return `<span class="log-sys">${html}</span>`;
    return html;
  }).join('');
}

export default function JobLogs({ job }) {
  const [chunks, setChunks] = useState([]);
  const [open, setOpen] = useState({});
  const [follow, setFollow] = useState(true);
  const seen = useRef(new Set());
  const box = useRef(null);
  useTicker(job.status === 'running');

  useEffect(() => {
    seen.current = new Set();
    setChunks([]);
    const socket = getSocket();
    let loaded = false;
    let pending = [];

    const add = (list) => {
      const fresh = list.filter((c) => !seen.current.has(c.seq));
      if (!fresh.length) return;
      fresh.forEach((c) => seen.current.add(c.seq));
      setChunks((cs) => [...cs, ...fresh].sort((a, b) => a.seq - b.seq));
    };
    const onLog = (c) => {
      if (c.jobId !== job._id) return;
      if (loaded) add([c]);
      else pending.push(c);
    };
    const subscribe = () => socket.emit('subscribe:job', job._id);

    socket.on('log', onLog);
    socket.on('connect', subscribe);
    subscribe();
    api(`/jobs/${job._id}/logs`).then((logs) => {
      loaded = true;
      add([...logs, ...pending]);
      pending = [];
    }).catch(() => { loaded = true; });

    return () => {
      socket.off('log', onLog);
      socket.off('connect', subscribe);
      socket.emit('unsubscribe:job', job._id);
    };
  }, [job._id]);

  const byStep = useMemo(() => {
    const map = new Map();
    for (const c of chunks) {
      if (!map.has(c.stepIndex)) map.set(c.stepIndex, []);
      map.get(c.stepIndex).push(c);
    }
    return map;
  }, [chunks]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [chunks, follow, open]);

  const isOpen = (i, status) => open[i] ?? (status === 'running' || status === 'failed' || status === 'cancelled');
  const setup = byStep.get(-1);

  return (
    <div className="logs">
      <div className="logs-toolbar">
        <span className="muted">Agent <b>{job.agentName}</b>{job.error ? <> · <span className="text-err">{job.error}</span></> : null}</span>
        <div className="row gap-sm">
          <button type="button" className="btn ghost sm" onClick={() => setOpen(Object.fromEntries(job.steps.map((_, i) => [i, true])))}>Expand all</button>
          <button type="button" className="btn ghost sm" onClick={() => setOpen(Object.fromEntries(job.steps.map((_, i) => [i, false])))}>Collapse all</button>
          <label className="check sm"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow</label>
        </div>
      </div>
      <div className="logs-body" ref={box} onWheel={(e) => e.deltaY < 0 && setFollow(false)}>
        {setup && <pre className="log-pre setup" dangerouslySetInnerHTML={{ __html: renderChunks(setup) }} />}
        {job.steps.map((s, i) => (
          <div key={i} className={`log-step step-${s.status}`}>
            <button type="button" className="log-step-head" onClick={() => setOpen((o) => ({ ...o, [i]: !isOpen(i, s.status) }))}>
              <span className={`step-icon ${s.status}`}>{STEP_ICON[s.status] || '○'}</span>
              <span className="step-name">{s.name}</span>
              {s.exitCode != null && s.status === 'failed' && <span className="text-err mono sm">exit {s.exitCode}</span>}
              <span className="spacer" />
              <span className="muted mono sm">{s.startedAt ? duration(s.startedAt, s.finishedAt) : s.status}</span>
              <span className="chev">{isOpen(i, s.status) ? '▾' : '▸'}</span>
            </button>
            {isOpen(i, s.status) && (
              <pre className="log-pre" dangerouslySetInnerHTML={{ __html: byStep.has(i) ? renderChunks(byStep.get(i)) : '<span class="log-sys">No output</span>' }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
