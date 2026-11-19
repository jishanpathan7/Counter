import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function client(base = '') {
  return {
    base,
    get: (p) => request('GET', base + p),
    post: (p, b = {}) => request('POST', base + p, b),
    patch: (p, b = {}) => request('PATCH', base + p, b),
    del: (p) => request('DELETE', base + p),
  };
}

/** Calls under /api (auth, agency). */
export const api = client('/api');
/** Calls for one institute. */
export const instApi = (slug) => client(`/api/i/${slug}`);

// ------------------------------------------------------------------ routing

export function navigate(path) {
  if (window.location.pathname + window.location.hash === path) return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useLocation() {
  const read = () => ({ path: window.location.pathname, hash: window.location.hash.replace(/^#\/?/, '') });
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => setLoc(read());
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('hashchange', on);
    };
  }, []);
  return loc;
}

// ------------------------------------------------------------------ live context

/** Shared by every screen inside an institute. */
export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

/** Fetch an institute path; refetch whenever the server says data changed. */
export function useData(path) {
  const { version, api: a } = useApp();
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const current = useRef(path);
  current.current = path;

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const data = await a.get(path);
      if (current.current === path) setState({ data, error: null, loading: false });
    } catch (error) {
      if (current.current === path) setState((s) => ({ ...s, error, loading: false }));
    }
  }, [path, a]);

  useEffect(() => {
    reload();
  }, [reload, version]);

  return { ...state, reload };
}

/** Current time, re-rendering on an interval (for countdowns). */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

// ------------------------------------------------------------------ formatting

let defaultTz;
/** Show times in the institute's time zone, wherever the viewer is. */
export function setDefaultTz(tz) {
  defaultTz = tz;
}

export function fmtTime(iso, tz) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz || defaultTz || undefined, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(iso))
    .toUpperCase();
}

export function fmtDate(date, opts = { day: 'numeric', month: 'short' }) {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-IN', { ...opts, timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}

export function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function fmtAgo(iso, now = Date.now()) {
  if (!iso) return 'never';
  const m = Math.round((now - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function fmtDuration(min) {
  if (min == null) return '–';
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function fmtPhone(p = '') {
  if (p.startsWith('91') && p.length === 12) return `+91 ${p.slice(2, 7)} ${p.slice(7)}`;
  return p ? `+${p}` : '';
}

export function fmtTime24(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function fmtMoney(n) {
  return `₹${Number(n || 0).toLocaleString('en-IN')}`;
}

export function initials(name = '') {
  const parts = name.replace(/^(Mr|Mrs|Ms|Dr)\.?\s+/i, '').trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

/** Stable pleasant colour per name, for avatars. */
export function colorFor(name = '') {
  const palette = ['#2e7d4f', '#1769aa', '#8e44ad', '#c0392b', '#b34700', '#0f7a65', '#2c3e50', '#7d5a2e'];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}
