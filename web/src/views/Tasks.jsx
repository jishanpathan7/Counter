import { useState } from 'react';
import { api, fmtPhone, fmtTime, useData, useLive, useNow } from '../api.js';
import { Empty } from '../components.jsx';

const OUTCOMES = [
  { id: 'leave', label: 'On leave', tone: 'warn' },
  { id: 'late', label: 'Coming late', tone: 'warn' },
  { id: 'present', label: 'Actually present', tone: 'ok' },
  { id: 'bunk', label: 'Bunk, parent told', tone: 'bad' },
  { id: 'unreachable', label: 'Unreachable', tone: '' },
];

function minutesAgo(iso, now) {
  const m = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000));
  return m < 1 ? 'just now' : `${m} min ago`;
}

function TaskCard({ task, now }) {
  const { toast } = useLive();
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
    <li className="card task">
      <div className="task-head">
        <div>
          <div className="eyebrow">{task.reason} · {minutesAgo(task.createdAt, now)}</div>
          <h3>
            Call {task.parentName || 'parent'} about {task.studentName}
          </h3>
          <div className="muted small">
            {task.batchName} · class at {fmtTime(task.startsAt)} · WhatsApp sent {fmtTime(task.alertSentAt)}
          </div>
        </div>
        <div className="task-contact">
          <a className="btn primary" href={`tel:+${task.parentPhone}`}>☎ {fmtPhone(task.parentPhone)}</a>
          <a className="btn ghost small" href={`https://wa.me/${task.parentPhone}`} target="_blank" rel="noreferrer">Open WhatsApp</a>
        </div>
      </div>
      <input className="input" placeholder="Note from the call (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="outcomes">
        {OUTCOMES.map((o) => (
          <button key={o.id} className={`btn small outline ${o.tone}`} disabled={busy} onClick={() => complete(o.id)}>
            {o.label}
          </button>
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
      <div className="page-head">
        <div>
          <h1>Call tasks</h1>
          <p className="muted">Parents who didn't reply on WhatsApp in time. Call, then log what you found out.</p>
        </div>
        <div className="seg">
          <button className={show === 'open' ? 'on' : ''} onClick={() => setShow('open')}>Open</button>
          <button className={show === 'done' ? 'on' : ''} onClick={() => setShow('done')}>Done</button>
        </div>
      </div>
      {error && <p className="error-text">{error.message}</p>}
      {data && !data.length && (
        <Empty title={show === 'open' ? 'No calls pending' : 'No completed calls yet'}>
          {show === 'open' && 'Every absent student’s parent has replied or been called.'}
        </Empty>
      )}
      {data && show === 'open' && (
        <ul className="stack">
          {data.map((t) => (
            <TaskCard key={t.id} task={t} now={now} />
          ))}
        </ul>
      )}
      {data && show === 'done' && data.length > 0 && (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Student</th>
                <th>Batch</th>
                <th>Outcome</th>
                <th>Closed</th>
              </tr>
            </thead>
            <tbody>
              {data.map((t) => (
                <tr key={t.id}>
                  <td>{t.date}</td>
                  <td>{t.studentName}</td>
                  <td>{t.batchName}</td>
                  <td>{t.outcome}</td>
                  <td>{fmtTime(t.doneAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
