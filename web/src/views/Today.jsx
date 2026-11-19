import { useState } from 'react';
import { fmtCountdown, fmtDate, fmtTime, fmtTime24, useApp, useData, useNow } from '../api.js';
import { Icon, Loading } from '../ui.jsx';
import { TaskCard } from './Tasks.jsx';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What's left to do today, as lists (shared by the front desk's Today screen and the owner's Home). */
export function dayWork(board, tasks, now) {
  const today = board.date === board.today;
  const sessions = board.sessions ?? [];
  const notSent = today ? sessions.filter((s) => !s.submittedAt && !s.verifiedAt && Date.parse(s.verifyDueAt) < now) : [];
  const upcoming = today ? sessions.filter((s) => !s.submittedAt && !s.verifiedAt && Date.parse(s.verifyDueAt) >= now) : [];
  const waiting = sessions.flatMap((s) => s.students.filter((st) => st.alert?.status === 'sent').map((st) => ({ ...st, batchName: s.batch.name })));
  const calls = [...(tasks ?? [])].sort((a, b) => Number(b.urgent) - Number(a.urgent));
  return { notSent, upcoming, waiting, calls, urgent: calls.filter((t) => t.urgent) };
}

/** One sentence: is everything OK, and if not, what needs doing. */
export function statusLine(work, board) {
  const parts = [];
  if (work.urgent.length) parts.push(`${plural(work.urgent.length, 'urgent call')}`);
  const normal = work.calls.length - work.urgent.length;
  if (normal) parts.push(`${plural(normal, 'parent')} to call`);
  if (work.notSent.length) parts.push(`${plural(work.notSent.length, 'class', 'classes')} not sent by the teacher`);
  const act = parts.length > 0;
  if (work.waiting.length) parts.push(`waiting for ${plural(work.waiting.length, 'parent')} to reply`);
  if (parts.length) {
    const text = parts.join(' · ');
    // "act": someone has to do something now. Waiting for replies alone needs nobody yet.
    return { ok: false, act, text: text[0].toUpperCase() + text.slice(1) };
  }
  if (board.holiday) return { ok: true, text: `Holiday: ${board.holiday}` };
  const done = (board.sessions ?? []).filter((s) => s.verifiedAt).length;
  if (work.upcoming.length && !done) return { ok: true, text: `Nothing to do yet. First class at ${fmtTime24(work.upcoming[0].batch.startTime)}.` };
  return { ok: true, text: done ? 'All clear: every absent student’s parent knows.' : 'All clear.' };
}

function NotSentCard({ session }) {
  const { api, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const n = session.counts.unmarked;
    if (!window.confirm(`Send ${session.batch.name} for the teacher?${n ? ` The ${plural(n, 'student')} not marked will count as present, so their parents won't be messaged.` : ''}`)) return;
    setBusy(true);
    try {
      await api.post(`/sessions/${session.id}/submit`);
      toast('Sent. Parents of absent students are being messaged.');
    } catch (e) {
      toast(e.message, 'bad');
      setBusy(false);
    }
  };
  return (
    <li className="card today-row">
      <div className="grow">
        <b>{session.batch.name}</b>
        <div className="muted small">
          Class at {fmtTime24(session.batch.startTime)} · {session.counts.A ? `${plural(session.counts.A, 'student')} marked absent so far` : 'nobody marked yet'}
        </div>
      </div>
      <a className="btn ghost small" href="#/attendance">Mark it</a>
      <button className="btn small primary" disabled={busy} onClick={send}><Icon name="send" /> Send for teacher</button>
    </li>
  );
}

export default function Today() {
  const { data: board, error } = useData('/board');
  const { data: tasks } = useData('/tasks');
  const now = useNow(1000);
  if (error) return <p className="error-text">{error.message}</p>;
  if (!board || !tasks) return <Loading height={400} />;

  const work = dayWork(board, tasks, now);
  const status = statusLine(work, board);
  const st = board.stats;

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <div className="eyebrow">Today · {fmtDate(board.date, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          {status.act ? (
            <>
              <h1 className="needs-work">To do now</h1>
              <p className="lead">{status.text}</p>
            </>
          ) : (
            <h1>{status.text}</h1>
          )}
        </div>
      </div>

      {work.calls.length > 0 && (
        <section className="stack tight">
          <h2 className="section-title"><Icon name="phone" /> Call these parents</h2>
          <ul className="stack">
            {work.calls.map((t) => <TaskCard key={t.id} task={t} now={now} />)}
          </ul>
        </section>
      )}

      {work.notSent.length > 0 && (
        <section className="stack tight">
          <h2 className="section-title"><Icon name="alert" /> Not sent by the teacher</h2>
          <p className="muted small" style={{ marginTop: -4 }}>No parent has been told about these classes yet. Mark the absent students, or send the list as it is.</p>
          <ul className="stack tight">{work.notSent.map((s) => <NotSentCard key={s.id} session={s} />)}</ul>
        </section>
      )}

      {work.waiting.length > 0 && (
        <section className="stack tight">
          <h2 className="section-title"><Icon name="chat" /> Waiting for a reply on WhatsApp</h2>
          <p className="muted small" style={{ marginTop: -4 }}>If a parent doesn't reply in time, they appear {work.calls.length ? 'in the call list above' : 'here as a call to make'}.</p>
          <ul className="card flush list">
            {work.waiting.map((s) => {
              const left = Date.parse(s.alert.replyDueAt) - now;
              return (
                <li key={`${s.id}-${s.alert.id}`} className="list-row">
                  <div className="grow">
                    <a href={`#/students/${s.id}`} className="plain"><b>{s.name}</b></a>
                    <div className="muted small">
                      {s.batchName} · {s.alert.delivery === 'read' ? 'parent has read it' : s.alert.delivery === 'delivered' ? 'delivered' : 'sent'} at {fmtTime(s.alert.sentAt)}
                    </div>
                  </div>
                  <span className={`chip ${left > 0 ? '' : 'warn'}`}>{left > 0 ? `call in ${fmtCountdown(left)}` : 'moving to calls'}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {status.ok && !board.holiday && (
        <div className="card all-clear">
          <Icon name="check" size={22} />
          <div>
            <b>Nothing needs you right now.</b>
            <div className="muted small">New calls and replies appear here by themselves.</div>
          </div>
        </div>
      )}

      {work.upcoming.length > 0 && (
        <section className="stack tight">
          <h2 className="section-title muted-title">Later today</h2>
          <ul className="card flush list">
            {work.upcoming.map((s) => (
              <li key={s.id} className="list-row">
                <span className="grow">{s.batch.name}</span>
                <span className="muted small">{fmtTime24(s.batch.startTime)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {st.alertsSent > 0 && (
        <p className="muted small">
          Done today: {plural(st.alertsSent, 'parent')} messaged, {plural(st.replied, 'reply', 'replies')} received
          {st.callsDone ? `, ${plural(st.callsDone, 'call')} made` : ''}. <a href="#/calls">Call history</a>
        </p>
      )}
    </div>
  );
}
