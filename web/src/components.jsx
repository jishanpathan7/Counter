import { fmtCountdown, fmtTime } from './api.js';

export const STATUS_LABEL = { P: 'Present', A: 'Absent', L: 'Leave / Late' };

export function StatusPill({ status }) {
  if (!status) return <span className="pill none">Not marked</span>;
  return <span className={`pill s-${status}`}>{STATUS_LABEL[status]}</span>;
}

/** What happened with the WhatsApp alert for one student. */
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
    return <span className="chip warn">{left > 0 ? `Live · take attendance (${fmtCountdown(left)})` : 'Attendance not taken'}</span>;
  }
  return <span className="chip live">Live · auto-verify in {fmtCountdown(left)}</span>;
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}
