import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, AppContext, instApi, navigate, setDefaultTz, useLocation } from './api.js';
import { Avatar, BrandMark, Icon, useTheme } from './ui.jsx';
import { Login, NewPin, SetupWizard } from './views/Auth.jsx';
import Agency from './views/Agency.jsx';
import Dashboard from './views/Dashboard.jsx';
import Today from './views/Today.jsx';
import Landing from './views/Landing.jsx';
import Teacher from './views/Teacher.jsx';
import Students from './views/Students.jsx';
import Tasks from './views/Tasks.jsx';
import Messages from './views/Messages.jsx';
import Reports from './views/Reports.jsx';
import Settings from './views/Settings.jsx';

// Order = importance. On phones the first four show as tabs and the rest go under "More".
// `menu` lists who sees the item in the menu; anyone in `roles` can still open it by link.
const NAV = [
  { id: 'today', label: 'Today', icon: 'clock', roles: ['owner', 'staff'], menu: ['staff'], view: Today },
  { id: 'dashboard', label: 'Home', icon: 'grid', roles: ['owner', 'staff'], menu: ['owner'], view: Dashboard },
  { id: 'attendance', label: 'Take attendance', short: 'Attendance', icon: 'check', roles: ['owner', 'staff', 'teacher'], view: Teacher },
  { id: 'calls', label: 'Calls', icon: 'phone', roles: ['owner', 'staff'], view: Tasks },
  { id: 'students', label: 'Students', icon: 'users', roles: ['owner', 'staff'], view: Students },
  { id: 'whatsapp', label: 'WhatsApp', icon: 'chat', roles: ['owner', 'staff'], view: Messages },
  { id: 'reports', label: 'Reports', icon: 'chart', roles: ['owner', 'staff'], view: Reports },
  { id: 'settings', label: 'Settings', icon: 'gear', roles: ['owner'], view: Settings },
];
const MOBILE_TABS = 4;

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

/** Trial ending or payment late: say so plainly, with a way to pay. Never shown to teachers. */
function BillingBanner({ info }) {
  const b = info.billing;
  if (!b) return null;
  const owner = info.role === 'owner';
  let text = null;
  let tone = 'warn';
  if (b.state === 'trial' && b.daysLeft != null && b.daysLeft <= 7) text = b.daysLeft ? `The free trial ends in ${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'}.` : 'The free trial ends today.';
  if (b.state === 'due') text = `Payment is ${b.daysLate} day${b.daysLate === 1 ? '' : 's'} late. Everything keeps working for now.`;
  if (b.state === 'readonly') {
    tone = 'bad';
    text = `Payment is ${b.daysLate} days overdue, so setup changes are paused. Attendance and WhatsApp alerts keep working. After 14 days the account is paused.`;
  }
  if (!text) return null;
  return (
    <div className={`banner ${tone}`} style={{ marginBottom: 16 }}>
      <Icon name="alert" />
      <span className="grow">{text} {!owner && 'Please tell the owner.'}</span>
      {owner && b.paymentLink && <a className="btn small primary" href={b.paymentLink} target="_blank" rel="noreferrer">Pay now</a>}
      {owner && <a className="btn small ghost" href="#/settings/billing">Plan & billing</a>}
    </div>
  );
}

/** Phone tab bar: the four most important places, the rest under "More" (no sideways scrolling). */
function MobileBar({ nav, current, openTasks }) {
  const [open, setOpen] = useState(false);
  const tabs = nav.length > MOBILE_TABS + 1 ? nav.slice(0, MOBILE_TABS) : nav;
  const more = nav.slice(tabs.length);
  const moreActive = more.some((n) => n.id === current.id);
  useEffect(() => setOpen(false), [current.id]);
  const item = (n) => (
    <>
      <Icon name={n.icon} />
      {n.short ?? n.label}
      {n.id === 'calls' && openTasks > 0 && <span className="count">{openTasks}</span>}
    </>
  );
  return (
    <>
      {open && <div className="more-scrim" onClick={() => setOpen(false)} />}
      {open && (
        <div className="more-sheet" role="menu">
          {more.map((n) => (
            <a key={n.id} role="menuitem" href={`#/${n.id}`} className={current.id === n.id ? 'active' : ''} onClick={() => setOpen(false)}>
              <Icon name={n.icon} /> {n.label}
            </a>
          ))}
        </div>
      )}
      <nav className="mobilebar" aria-label="Main">
        {tabs.map((n) => (
          <a key={n.id} href={`#/${n.id}`} className={current.id === n.id ? 'active' : ''} aria-current={current.id === n.id ? 'page' : undefined}>
            {item(n)}
          </a>
        ))}
        {more.length > 0 && (
          <button type="button" className={moreActive || open ? 'active' : ''} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <Icon name="more" />
            More
          </button>
        )}
      </nav>
    </>
  );
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

  const allowed = NAV.filter((n) => n.roles.includes(info.role));
  const nav = allowed.filter((n) => !n.menu || n.menu.includes(info.role));
  const [tabId, ...rest] = hash.split('/');
  const current = allowed.find((n) => n.id === tabId) ?? nav[0];
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
            <span className={`chip ${info.mode === 'whatsapp' ? 'ok' : 'warn'} mode-chip`} title={info.mode === 'whatsapp' ? 'Parents get alerts on WhatsApp' : 'WhatsApp is not connected yet: messages stay inside the app and no parent is contacted'}>
              <span className={`live-dot ${live ? 'on' : ''}`} /> {info.mode === 'whatsapp' ? 'WhatsApp live' : 'Practice mode'}
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
            <BillingBanner info={info} />
            <View key={current.id} />
          </main>
        </div>

        {nav.length > 1 && (
          <MobileBar nav={nav} current={current} openTasks={openTasks} />
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
  const [typedPin, setTypedPin] = useState(''); // kept in memory only, to prefill "current PIN" below
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
  if (!me.user && path === '/') return <Landing />;
  if (!me.user) return <Login demo={me.demo} onDone={(pin) => { setTypedPin(pin); if (path === '/login') navigate('/'); return refreshMe(); }} />;
  if (me.user.mustChangePin) {
    return <NewPin me={me} currentPin={typedPin} logout={logout} onDone={() => { setTypedPin(''); return refreshMe(); }} />;
  }
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
