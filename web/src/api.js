import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
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

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
};

/** Bumps whenever the server says data changed (server-sent events). */
export const LiveContext = createContext({ version: 0, info: null, toast: () => {} });

export function useLive() {
  return useContext(LiveContext);
}

/** Fetch `path` and refetch whenever live data changes. */
export function useData(path) {
  const { version } = useLive();
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const data = await api.get(path);
      if (pathRef.current === path) setState({ data, error: null, loading: false });
    } catch (error) {
      if (pathRef.current === path) setState((s) => ({ ...s, error, loading: false }));
    }
  }, [path]);

  useEffect(() => {
    reload();
  }, [reload, version]);

  return { ...state, reload, setData: (data) => setState((s) => ({ ...s, data })) };
}

/** Current time, re-rendering every second (for countdowns). */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

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

export function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function fmtPhone(p = '') {
  if (p.startsWith('91') && p.length === 12) return `+91 ${p.slice(2, 7)} ${p.slice(7)}`;
  return `+${p}`;
}

export function fmtTime24(t) {
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${suffix}`;
}
