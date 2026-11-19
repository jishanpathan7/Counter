import { useState } from 'react';
import { fmtAgo, fmtDate, fmtPhone, fmtTime, useApp, useData, useNow } from '../api.js';
import { Avatar, Empty, Icon, Loading } from '../ui.jsx';

const OUTCOMES = [
  { id: 'leave', label: 'On leave', tone: 'warn' },
  { id: 'late', label: 'Coming late', tone: 'warn' },
  { id: 'present', label: 'Actually present', tone: 'ok' },
  { id: 'bunk', label: 'Bunk, parent told', tone: 'bad' },
  { id: 'unreachable', label: 'Unreachable', tone: '' },
];

export function TaskCard({ task, now }) {
  const { api, toast } = useApp();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const complete = async (outcome) => {
    setBusy(true);
    try {
      await api.post(`/tasks/${task.id}/complete`, { outcome, note });
      toast(`${task.studentName}: call logged`);
    } catch (e) {
      toast(e.message, 'bad');
      setBusy(false);
    }
  };
  return (
    <li className={`card task ${task.urgent ? 'urgent' : ''}`}>
      <div className="task-head">
        <div className="who" style={{ alignItems: 'flex-start' }}>
          <Avatar name={task.studentName} />
          <div>
            <div className="eyebrow">{task.urgent ? <b className="error-text">Urgent · call now</b> : task.reason} · {fmtAgo(task.createdAt, now)}</div>
            {task.urgent ? <div className="error-text small">The parent says they don't know where the child is.</div> : null}
            <h3>Call {task.parentName || 'parent'} about <a href={`#/students/${task.studentId}`} style={{ color: 'inherit' }}>{task.studentName}</a></h3>
            <div className="muted small">{task.batchName} · class at {fmtTime(task.startsAt)} · WhatsApp sent {fmtTime(task.alertSentAt)}</div>
          </div>
        </div>
        <div className="task-contact">
          <a className="btn primary" href={`tel:+${task.parentPhone}`}><Icon name="phone" /> {fmtPhone(task.parentPhone)}</a>
          <a className="btn ghost small" href={`https://wa.me/${task.parentPhone}`} target="_blank" rel="noreferrer"><Icon name="chat" /> Open WhatsApp</a>
        </div>
      </div>
      <input className="input" placeholder="Note from the call (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="outcomes">
        {OUTCOMES.map((o) => (
          <button key={o.id} className={`btn small outline ${o.tone}`} disabled={busy} onClick={() => complete(o.id)}>{o.label}</button>
        ))}
      </div>
    </li>
  );
}

export default function Tasks() {
  const [show, setShow] = useState('open');
  const { data, error } = useData(`/tasks?status=${show}`);
  const now = useNow(15000);

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Call tasks</h1>
          <p className="muted">Parents who didn't reply on WhatsApp in time. Call them, then log what you found out. The register updates itself.</p>
        </div>
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={show === 'open'} className={show === 'open' ? 'on' : ''} onClick={() => setShow('open')}>Open</button>
          <button role="tab" aria-selected={show === 'done'} className={show === 'done' ? 'on' : ''} onClick={() => setShow('done')}>Done</button>
        </div>
      </div>
      {error && <p className="error-text">{error.message}</p>}
      {!data && <Loading height={200} />}
      {data && !data.length && (
        <Empty title={show === 'open' ? 'No calls pending' : 'No completed calls yet'} icon="phone">
          {show === 'open' && 'Every absent student’s parent has replied or been called.'}
        </Empty>
      )}
      {data && show === 'open' && data.length > 0 && (
        <ul className="stack">
          {data.map((t) => <TaskCard key={t.id} task={t} now={now} />)}
        </ul>
      )}
      {data && show === 'done' && data.length > 0 && (
        <div className="card flush table-wrap">
          <table className="table">
            <thead><tr><th>Date</th><th>Student</th><th className="hide-sm">Batch</th><th>Outcome</th><th className="hide-sm">Closed</th></tr></thead>
            <tbody>
              {data.map((t) => (
                <tr key={t.id}>
                  <td className="small">{fmtDate(t.date)}</td>
                  <td><a href={`#/students/${t.studentId}`} style={{ color: 'inherit' }}>{t.studentName}</a></td>
                  <td className="small hide-sm">{t.batchName}</td>
                  <td className="small">{t.outcome}</td>
                  <td className="small hide-sm">{fmtTime(t.doneAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
