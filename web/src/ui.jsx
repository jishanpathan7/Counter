import { useEffect, useState } from 'react';
import { colorFor, fmtCountdown, fmtTime, initials } from './api.js';

// ------------------------------------------------------------------ icons (stroke icons, 24px grid)
const PATHS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  users: 'M16 19v-1.5a3.5 3.5 0 00-3.5-3.5h-5A3.5 3.5 0 004 17.5V19M10 10.5a3.25 3.25 0 100-6.5 3.25 3.25 0 000 6.5zM20 19v-1.5a3.5 3.5 0 00-2.6-3.38M15.5 4.2a3.25 3.25 0 010 6.1',
  phone: 'M5 4h3.5l1.6 4.2-2.1 1.3a11 11 0 005.5 5.5l1.3-2.1L19 14.5V18a2 2 0 01-2 2C10 20 4 14 4 6a2 2 0 011-2z',
  chat: 'M4 18.5V6a2 2 0 012-2h12a2 2 0 012 2v9a2 2 0 01-2 2H8l-4 3.5zM8.5 9.5h7M8.5 12.5h4',
  chart: 'M4 20h16M7 16v-5M12 16V7M17 16v-8',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 01-2.1 1.2L14.7 21h-4l-.3-2.4a7 7 0 01-2.1-1.2l-1.9.7-2-3.4 1.6-1.2a7 7 0 010-2.4L4.4 9.9l2-3.4 1.9.7a7 7 0 012.1-1.2L10.7 3h4l.3 2.4a7 7 0 012.1 1.2l1.9-.7 2 3.4-1.6 1.2a7 7 0 010 2.4z',
  logout: 'M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 16l-4-4 4-4M6 12h10',
  sun: 'M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3',
  download: 'M12 4v12M7 11l5 5 5-5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  send: 'M4 12l16-8-6 16-2.5-6.5L4 12z',
  play: 'M7 5v14l11-7z',
  building: 'M4 21V5a1 1 0 011-1h9a1 1 0 011 1v16M15 9h4a1 1 0 011 1v11M3 21h18M8 8h3M8 12h3M8 16h3',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  back: 'M19 12H5M11 6l-6 6 6 6',
  calendar: 'M4 7a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2zM4 10h16M8 3v4M16 3v4',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  bolt: 'M13 3L5 13h6l-1 8 8-10h-6z',
  pause: 'M8 5v14M16 5v14',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5',
  wifi: 'M5 12.5a10 10 0 0114 0M8.5 16a5 5 0 017 0M12 19.5h.01M2 9a15 15 0 0120 0',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 20a8 8 0 0116 0',
};

export function Icon({ name, size, className = '' }) {
  return (
    <svg className={`icon ${className}`} viewBox="0 0 24 24" aria-hidden="true" style={size ? { width: size, height: size } : undefined}>
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

export function BrandMark({ big }) {
  return (
    <div className={`brand-mark ${big ? 'big' : ''}`}>
      <Icon name="check" />
    </div>
  );
}

export function Avatar({ name, lg }) {
  return (
    <div className={`avatar ${lg ? 'lg' : ''}`} style={{ background: colorFor(name) }} aria-hidden="true">
      {initials(name)}
    </div>
  );
}

// ------------------------------------------------------------------ status bits
export const STATUS_LABEL = { P: 'Present', A: 'Absent', L: 'Leave / Late' };

export function StatusPill({ status }) {
  if (!status) return <span className="pill none">Not marked</span>;
  return <span className={`pill s-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function AlertState({ alert, task, now, tz }) {
  if (!alert) return null;
  if (alert.status === 'replied') {
    return (
      <span className="alert-state ok">
        <b>Parent replied:</b> {alert.reply} · {fmtTime(alert.repliedAt, tz)}
      </span>
    );
  }
  if (alert.status === 'sent') {
    const left = Date.parse(alert.replyDueAt) - now;
    return (
      <span className="alert-state wait">
        WhatsApp sent {fmtTime(alert.sentAt, tz)} · {left > 0 ? `waiting for reply ${fmtCountdown(left)}` : 'escalating…'}
      </span>
    );
  }
  const reason = alert.status === 'failed' ? 'WhatsApp failed' : 'No reply';
  return (
    <span className="alert-state bad">
      {reason} → {task?.status === 'done' ? `called: ${task.outcome}` : 'staff call task'}
    </span>
  );
}

export function SessionBadge({ session, now, tz }) {
  if (session.verifiedAt) return <span className="chip ok">Verified · {fmtTime(session.verifiedAt, tz)}</span>;
  const toStart = Date.parse(session.startsAt) - now;
  if (toStart > 0) return <span className="chip">Starts {fmtTime(session.startsAt, tz)}</span>;
  const left = Date.parse(session.verifyDueAt) - now;
  if (!session.attendanceTaken) {
    return <span className="chip warn pulse">{left > 0 ? `Take attendance · ${fmtCountdown(left)}` : 'Attendance not taken'}</span>;
  }
  return <span className="chip live">Auto-verify in {fmtCountdown(left)}</span>;
}

export function PctBar({ pct }) {
  if (pct == null) return <span className="muted small">–</span>;
  const tone = pct < 75 ? 'bad' : pct < 85 ? 'warn' : '';
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
      <div className={`bar ${tone}`} style={{ flex: 1 }}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="num small" style={{ width: 36, textAlign: 'right' }}>{pct}%</span>
    </div>
  );
}

export function Kpi({ label, value, tone, hint }) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

export function Empty({ title, children, icon }) {
  return (
    <div className="empty">
      {icon && <div className="muted" style={{ marginBottom: 8 }}><Icon name={icon} size={28} /></div>}
      <div className="empty-title">{title}</div>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function Loading({ height = 120 }) {
  return <div className="skeleton" style={{ height }} />;
}

// ------------------------------------------------------------------ overlays
function useEscape(onClose) {
  useEffect(() => {
    const on = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
}

export function Modal({ title, onClose, children, wide }) {
  useEscape(onClose);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="x" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Drawer({ onClose, head, children }) {
  useEscape(onClose);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <div className="grow">{head}</div>
          <button className="x" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ theme
export function useTheme() {
  const read = () => {
    try {
      return localStorage.getItem('theme') || 'auto';
    } catch {
      return 'auto';
    }
  };
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);
  const isDark = theme === 'dark' || (theme === 'auto' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  return { theme, isDark, toggle: () => setTheme(isDark ? 'light' : 'dark') };
}
