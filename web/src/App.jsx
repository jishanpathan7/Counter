import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, AppContext, instApi, navigate, setDefaultTz, useLocation } from './api.js';
import { Avatar, BrandMark, Icon, useTheme } from './ui.jsx';
import { Login, SetupWizard } from './views/Auth.jsx';
import Agency from './views/Agency.jsx';
import Dashboard from './views/Dashboard.jsx';
import Teacher from './views/Teacher.jsx';
import Students from './views/Students.jsx';
import Tasks from './views/Tasks.jsx';
import Messages from './views/Messages.jsx';
import Reports from './views/Reports.jsx';
import Settings from './views/Settings.jsx';

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'grid', roles: ['owner', 'staff'], view: Dashboard },
  { id: 'attendance', label: 'Take attendance', short: 'Attendance', icon: 'check', roles: ['owner', 'staff', 'teacher'], view: Teacher },
  { id: 'students', label: 'Students', icon: 'users', roles: ['owner', 'staff'], view: Students },
  { id: 'calls', label: 'Call tasks', short: 'Calls', icon: 'phone', roles: ['owner', 'staff'], view: Tasks },
  { id: 'whatsapp', label: 'WhatsApp', icon: 'chat', roles: ['owner', 'staff'], view: Messages },
  { id: 'reports', label: 'Reports', icon: 'chart', roles: ['owner', 'staff'], view: Reports },
  { id: 'settings', label: 'Settings', icon: 'gear', roles: ['owner'], view: Settings },
];

const ROLE_LABEL = { owner: 'Owner', staff: 'Front desk', teacher: 'Teacher' };

function Toast({ toast }) {
  if (!toast) return null;
  return <div key={toast.id} className={`toast ${toast.kind}`} role="status">{toast.msg}</div>;
}

function useToast() {
  const [toast, setToast] = useState(null);
  const show = useCallback((msg, kind = 'ok') => setToast({ msg, kind, id: Date.now() }), []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 3400);
    return () => clearTimeout(t);
  }, [toast]);
  return [toast, show];
}

function Picker({ me, logout }) {
  return (
    <div className="center">
      <div className="card stack" style={{ width: 'min(440px, 100%)', textAlign: 'left' }}>
        <div className="row"><BrandMark /><h2>Choose an institute</h2></div>
        {me.memberships.map((m) => (
          <button key={m.slug} className="switcher" onClick={() => navigate(`/i/${m.slug}/`)}>
            <Icon name="building" />
            <span className="grow"><b>{m.name}</b><br /><span className="muted small">{ROLE_LABEL[m.role]}{m.city ? ` · ${m.city}` : ''}</span></span>
            <Icon name="arrow" />
          </button>
        ))}
        {!me.memberships.length && <p className="muted">You're not part of any institute yet. Ask the owner to add you to their team.</p>}
        <button className="btn ghost" onClick={logout}><Icon name="logout" /> Log out</button>
      </div>
    </div>
  );
}

function InstituteApp({ slug, me, logout, theme }) {
  const { hash } = useLocation();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [version, setVersion] = useState(0);
  const [live, setLive] = useState(false);
  const [openTasks, setOpenTasks] = useState(0);
  const [toast, showToast] = useToast();
  const a = useMemo(() => instApi(slug), [slug]);

  useEffect(() => {
    setInfo(null);
    setError(null);
    a.get('/info').then(setInfo).catch(setError);
  }, [a]);

  useEffect(() => {
    if (!info) return undefined;
    setDefaultTz(info.tz);
    if (!info.realtime) {
      // Serverless hosting: no live connection, so refresh every few seconds instead.
      setLive(true);
      const t = setInterval(() => document.visibilityState === 'visible' && setVersion((v) => v + 1), 4000);
      return () => clearInterval(t);
    }
    const es = new EventSource(`/api/i/${slug}/events`);
    es.onmessage = () => setVersion((v) => v + 1);
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [info?.realtime, info?.tz, slug]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!info || info.role === 'teacher') return;
    a.get('/tasks').then((t) => setOpenTasks(t.length)).catch(() => {});
    a.get('/info').then(setInfo).catch(() => {});
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="center">
        <div className="stack" style={{ alignItems: 'center' }}>
          <h2>{error.status === 403 ? 'Access paused' : "Can't open this institute"}</h2>
          <p className="muted">{error.message}</p>
          <button className="btn ghost" onClick={() => navigate('/')}>Back</button>
        </div>
      </div>
    );
  }
  if (!info) return <div className="center muted">Loading…</div>;

  const nav = NAV.filter((n) => n.roles.includes(info.role));
  const [tabId, ...rest] = hash.split('/');
  const current = nav.find((n) => n.id === tabId) ?? nav[0];
  const View = current.view;
  const others = me.memberships.length > 1 || me.user.isAgency;

  const ctx = { slug, api: a, info, version, toast: showToast, me, route: rest, live };

  const sideNav = (
    <nav className="nav" aria-label="Main">
      {nav.map((n) => (
        <a key={n.id} href={`#/${n.id}`} className={`nav-item ${current.id === n.id ? 'active' : ''}`} aria-current={current.id === n.id ? 'page' : undefined}>
          <Icon name={n.icon} />
          {n.label}
          {n.id === 'calls' && openTasks > 0 && <span className="count">{openTasks}</span>}
        </a>
      ))}
    </nav>
  );

  return (
    <AppContext.Provider value={ctx}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <BrandMark />
            <div className="grow">
              <div className="brand-name ellipsis" title={info.institute.name}>{info.institute.name}</div>
              <div className="brand-sub">Attendance Alert</div>
            </div>
          </div>
          {others && (
            <button className="switcher" onClick={() => navigate(me.user.isAgency ? '/agency' : '/')}>
              <Icon name={me.user.isAgency ? 'building' : 'arrow'} />
              <span className="small grow">{me.user.isAgency ? 'Agency console' : 'Switch institute'}</span>
            </button>
          )}
          {sideNav}
          <div className="sidebar-foot">
            {info.institute.status === 'paused' && <span className="chip warn mode-chip">Paused</span>}
            <span className={`chip ${info.mode === 'whatsapp' ? 'ok' : 'warn'} mode-chip`} title={info.mode === 'whatsapp' ? 'Connected to WhatsApp Cloud API' : 'No WhatsApp account connected: messages go to the simulator'}>
              <span className={`live-dot ${live ? 'on' : ''}`} /> {info.mode === 'whatsapp' ? 'WhatsApp live' : 'Simulator mode'}
            </span>
            <div className="me">
              <Avatar name={me.user.name} />
              <div className="grow">
                <div className="small ellipsis"><b>{me.user.name}</b></div>
                <div className="tiny muted">{ROLE_LABEL[info.role]}</div>
              </div>
              <button className="x" onClick={theme.toggle} title="Toggle dark mode" aria-label="Toggle dark mode"><Icon name={theme.isDark ? 'sun' : 'moon'} /></button>
              <button className="x" onClick={logout} title="Log out" aria-label="Log out"><Icon name="logout" /></button>
            </div>
          </div>
        </aside>

        <div style={{ minWidth: 0 }}>
          <header className="topline">
            <BrandMark />
            <div className="grow">
              <div className="brand-name ellipsis">{info.institute.name}</div>
              <div className="tiny muted">{me.user.name} · {ROLE_LABEL[info.role]}</div>
            </div>
            <span className={`live-dot ${live ? 'on' : ''}`} />
            {others && <button className="x" onClick={() => navigate(me.user.isAgency ? '/agency' : '/')} aria-label="Switch"><Icon name="building" /></button>}
            <button className="x" onClick={theme.toggle} aria-label="Toggle dark mode"><Icon name={theme.isDark ? 'sun' : 'moon'} /></button>
            <button className="x" onClick={logout} aria-label="Log out"><Icon name="logout" /></button>
          </header>
          <main className="main">
            <View key={current.id} />
          </main>
        </div>

        {nav.length > 1 && (
          <nav className="mobilebar" aria-label="Main">
            {nav.map((n) => (
              <a key={n.id} href={`#/${n.id}`} className={current.id === n.id ? 'active' : ''}>
                <Icon name={n.icon} />
                {n.short ?? n.label}
                {n.id === 'calls' && openTasks > 0 && <span className="count">{openTasks}</span>}
              </a>
            ))}
          </nav>
        )}
      </div>
      <Toast toast={toast} />
    </AppContext.Provider>
  );
}

export default function App() {
  const { path } = useLocation();
  const [me, setMe] = useState(null);
  const [failed, setFailed] = useState(false);
  const theme = useTheme();
  const [toast, showToast] = useToast();

  const refreshMe = useCallback(() => api.get('/auth/me').then(setMe).catch(() => setFailed(true)), []);
  useEffect(() => {
    refreshMe();
  }, [refreshMe]);

  const logout = async () => {
    await api.post('/auth/logout').catch(() => {});
    navigate('/');
    refreshMe();
  };

  const instMatch = path.match(/^\/i\/([a-z0-9-]+)/);
  useEffect(() => {
    if (!me?.user || instMatch) return;
    if (!me.user.isAgency && me.memberships.length === 1) navigate(`/i/${me.memberships[0].slug}/`);
    if (me.user.isAgency && path === '/') navigate('/agency');
  }, [me, path]); // eslint-disable-line react-hooks/exhaustive-deps

  if (failed) return <div className="center error-text">Can't reach the server. Is it running?</div>;
  if (!me) return <div className="center muted">Loading…</div>;
  if (me.needsSetup) return <SetupWizard onDone={refreshMe} setupCodeRequired={me.setupCodeRequired} />;
  if (!me.user) return <Login demo={me.demo} onDone={refreshMe} />;
  if (instMatch) return <InstituteApp key={instMatch[1]} slug={instMatch[1]} me={me} logout={logout} theme={theme} />;
  if (me.user.isAgency) {
    return (
      <>
        <Agency me={me} logout={logout} theme={theme} toast={showToast} />
        <Toast toast={toast} />
      </>
    );
  }
  return <Picker me={me} logout={logout} />;
}
