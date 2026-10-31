import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { clearToken, getToken, setToken } from './api';
import { closeSocket, getSocket } from './socket';
import Login from './pages/Login';
import Agents from './pages/Agents';
import Pipelines from './pages/Pipelines';
// The editor page pulls in Monaco, so load it on demand
const PipelineEdit = lazy(() => import('./pages/PipelineEdit'));
import Runs from './pages/Runs';
import RunDetail from './pages/RunDetail';

function ConnectionDot() {
  const [connected, setConnected] = useState(getSocket().connected);
  useEffect(() => {
    const s = getSocket();
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    s.on('connect', on);
    s.on('disconnect', off);
    s.on('connect_error', off);
    return () => { s.off('connect', on); s.off('disconnect', off); s.off('connect_error', off); };
  }, []);
  return <div className="conn"><span className={`dot ${connected ? 'online' : 'offline'}`} />{connected ? 'Live' : 'Reconnecting…'}</div>;
}

export default function App() {
  const [token, setTok] = useState(getToken());

  if (!token) {
    return <Login onLogin={(t) => { setToken(t); setTok(t); }} />;
  }

  const logout = () => {
    clearToken();
    closeSocket();
    setTok(null);
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark" />Shipyard</div>
        <nav>
          <NavLink to="/pipelines">Pipelines</NavLink>
          <NavLink to="/runs">Runs</NavLink>
          <NavLink to="/agents">Agents</NavLink>
        </nav>
        <div className="sidebar-foot">
          <ConnectionDot />
          <button type="button" className="btn ghost sm block" onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="content">
        <Suspense fallback={<div className="page"><p className="muted">Loading editor…</p></div>}>
        <Routes>
          <Route path="/" element={<Navigate to="/pipelines" replace />} />
          <Route path="/pipelines" element={<Pipelines />} />
          <Route path="/pipelines/new" element={<PipelineEdit key="new" />} />
          <Route path="/pipelines/:id" element={<PipelineEdit />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="*" element={<Navigate to="/pipelines" replace />} />
        </Routes>
        </Suspense>
      </main>
    </div>
  );
}
