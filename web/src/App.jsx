import { useCallback, useEffect, useState } from 'react';
import { api, LiveContext, setDefaultTz } from './api.js';
import Dashboard from './views/Dashboard.jsx';
import Teacher from './views/Teacher.jsx';
import Tasks from './views/Tasks.jsx';
import Messages from './views/Messages.jsx';
import Setup from './views/Setup.jsx';

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: '▦' },
  { id: 'teacher', label: 'Teacher', icon: '✓' },
  { id: 'tasks', label: 'Call tasks', icon: '☎' },
  { id: 'messages', label: 'WhatsApp', icon: '✉' },
  { id: 'setup', label: 'Setup', icon: '⚙' },
];

function useHashTab() {
  const read = () => {
    const id = window.location.hash.replace('#/', '').split('?')[0];
    return TABS.some((t) => t.id === id) ? id : 'dashboard';
  };
  const [tab, setTab] = useState(read);
  useEffect(() => {
    const onHash = () => setTab(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return tab;
}

function Login({ onDone }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/login', { code });
      onDone();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand-mark big">✓</div>
        <h1>Attendance Alert</h1>
        <p className="muted">Enter the access code your institute gave you.</p>
        <input className="input" type="password" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="Access code" />
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary block" type="submit">Continue</button>
      </form>
    </div>
  );
}

export default function App() {
  const tab = useHashTab();
  const [info, setInfo] = useState(null);
  const [version, setVersion] = useState(0);
  const [openTasks, setOpenTasks] = useState(0);
  const [toastMsg, setToastMsg] = useState(null);
  const [connected, setConnected] = useState(true);

  const loadInfo = useCallback(() => api.get('/info').then(setInfo).catch(() => setInfo({ error: true })), []);
  useEffect(() => {
    loadInfo();
  }, [loadInfo]);

  const authed = info && !info.error && (!info.authRequired || info.authed);
  if (info?.tz) setDefaultTz(info.tz);

  // Live updates from the server.
  useEffect(() => {
    if (!authed) return undefined;
    const es = new EventSource('/api/events');
    es.onmessage = () => setVersion((v) => v + 1);
    es.onopen = () => {
      setConnected(true);
      setVersion((v) => v + 1);
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    api.get('/tasks').then((t) => setOpenTasks(t.length)).catch(() => {});
    api.get('/info').then(setInfo).catch(() => {});
  }, [authed, version]);

  const toast = useCallback((msg, kind = 'ok') => {
    setToastMsg({ msg, kind, id: Date.now() });
  }, []);
  useEffect(() => {
    if (!toastMsg) return undefined;
    const t = setTimeout(() => setToastMsg(null), 3200);
    return () => clearTimeout(t);
  }, [toastMsg]);

  if (!info) return <div className="center muted">Loading…</div>;
  if (info.error) return <div className="center error-text">Can't reach the server. Is it running?</div>;
  if (!authed) return <Login onDone={loadInfo} />;

  const View = { dashboard: Dashboard, teacher: Teacher, tasks: Tasks, messages: Messages, setup: Setup }[tab];

  return (
    <LiveContext.Provider value={{ version, info, toast }}>
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark">✓</div>
            <div>
              <div className="brand-name">{info.instituteName}</div>
              <div className="brand-sub">Attendance Alert</div>
            </div>
          </div>
          <nav className="tabs">
            {TABS.map((t) => (
              <a key={t.id} href={`#/${t.id}`} className={`tab ${tab === t.id ? 'active' : ''}`}>
                <span className="tab-icon" aria-hidden>{t.icon}</span>
                <span className="tab-label">{t.label}</span>
                {t.id === 'tasks' && openTasks > 0 && <span className="count">{openTasks}</span>}
              </a>
            ))}
          </nav>
          <div className="topbar-right">
            {info.mode === 'simulator' && <span className="chip warn" title="No WhatsApp account configured: messages go to the simulator">Simulator mode</span>}
            {info.mode === 'whatsapp' && <span className="chip ok">WhatsApp live</span>}
            <span className={`live-dot ${connected ? 'on' : ''}`} title={connected ? 'Live' : 'Reconnecting…'} />
          </div>
        </header>
        <main className="main">
          <View />
        </main>
        {toastMsg && <div key={toastMsg.id} className={`toast ${toastMsg.kind}`}>{toastMsg.msg}</div>}
      </div>
    </LiveContext.Provider>
  );
}
