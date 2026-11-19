import { useEffect, useState } from 'react';
import { fmtTime, fmtTime24, useApp, useData, useNow } from '../api.js';
import { AlertState, Avatar, Empty, Icon, Loading, SessionBadge } from '../ui.jsx';

// Marking by exception: everyone is present unless the teacher taps one of these.
// Tapping the selected one again puts the student back to present.
const EXCEPTIONS = [
  { status: 'A', label: 'Absent' },
  { status: 'T', label: 'Late' },
  { status: 'L', label: 'Leave' },
];

function savedBatch(slug) {
  try {
    return Number(localStorage.getItem(`batch:${slug}`)) || null;
  } catch {
    return null;
  }
}

export default function Teacher() {
  const { api, version, toast, slug, info } = useApp();
  const { data: batches } = useData('/batches');
  const [batchId, setBatchId] = useState(() => savedBatch(slug));
  const [session, setSession] = useState(null);
  const [blocked, setBlocked] = useState(null);
  const [pending, setPending] = useState({});
  const [sending, setSending] = useState(false);
  const now = useNow();

  useEffect(() => {
    if (batches?.length && !batches.some((b) => b.id === batchId)) setBatchId(batches[0].id);
  }, [batches, batchId]);

  useEffect(() => {
    if (!batchId) return;
    try {
      localStorage.setItem(`batch:${slug}`, String(batchId));
    } catch {
      /* storage unavailable */
    }
    api
      .post(`/batches/${batchId}/today`)
      .then((s) => {
        setSession(s);
        setBlocked(null);
      })
      .catch((e) => (e.status === 409 ? setBlocked(e.message) : toast(e.message, 'bad')));
  }, [batchId, version, api, slug, toast]);

  const mark = async (student, status) => {
    // Tapping the active choice again means "present after all".
    const next = (pending[student.id] ?? student.status) === status ? 'P' : status;
    setPending((p) => ({ ...p, [student.id]: next }));
    try {
      setSession(await api.post(`/sessions/${session.id}/mark`, { studentId: student.id, status: next }));
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setPending(({ [student.id]: _, ...rest }) => rest);
    }
  };

  const send = async () => {
    setSending(true);
    try {
      setSession(await api.post(`/sessions/${session.id}/submit`));
      toast('Sent to the office');
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setSending(false);
    }
  };

  if (!batches) return <Loading height={300} />;
  if (!batches.length) {
    return (
      <Empty title={info.role === 'teacher' ? 'No batches assigned to you' : 'No batches yet'} icon="calendar">
        {info.role === 'teacher' ? 'Ask the owner to assign your batches in Settings → Team.' : <>Create a batch in <a href="#/settings/batches">Settings</a> first.</>}
      </Empty>
    );
  }

  const statusOf = (s) => pending[s.id] ?? s.status ?? 'P';
  const count = (st) => (session ? session.students.filter((s) => statusOf(s) === st).length : 0);
  const absent = count('A');
  const late = count('T');
  const leave = count('L');

  return (
    <div className="teacher">
      <div>
        <h1>Take attendance</h1>
        <p className="muted">Everyone is present unless you tap Absent, Late or Leave. Then send the list to the office.</p>
      </div>
      <div className="chips-row" role="tablist">
        {batches.map((b) => (
          <button key={b.id} role="tab" aria-selected={b.id === batchId} className={`chip-btn ${b.id === batchId ? 'active' : ''}`} onClick={() => setBatchId(b.id)}>
            {b.name} <span className="muted">· {fmtTime24(b.startTime)}</span>
          </button>
        ))}
      </div>

      {blocked && <div className="banner"><Icon name="calendar" /> {blocked}</div>}

      {session && !blocked && (
        <section className="card">
          <div className="session-head">
            <div>
              <div className="eyebrow">{session.batch.name} · {fmtTime24(session.batch.startTime)}</div>
              <h2>{session.students.length - absent - leave} of {session.students.length} in class</h2>
            </div>
            <SessionBadge session={session} now={now} />
          </div>

          <ul className="mark-list">
            {session.students.map((s) => {
              const current = statusOf(s);
              return (
                <li key={s.id} className={`mark-row ${current !== 'P' ? `is-${current}` : ''}`}>
                  <div className="who">
                    <Avatar name={s.name} />
                    <div className="mark-info">
                      <div className="roster-name ellipsis">{s.name}</div>
                      {s.alert ? (
                        <AlertState alert={s.alert} task={s.task} now={now} />
                      ) : s.note && s.source !== 'teacher' ? (
                        <div className="muted small">{s.note}</div>
                      ) : (
                        <div className="muted small">{{ P: 'Present', A: 'Absent', T: 'Late', L: 'On leave' }[current]}</div>
                      )}
                    </div>
                  </div>
                  <div className="pal" role="group" aria-label={`Exceptions for ${s.name}`}>
                    {EXCEPTIONS.map((b) => (
                      <button
                        key={b.status}
                        aria-label={`${b.label}: ${s.name}`}
                        aria-pressed={current === b.status}
                        className={`pal-btn wide s-${b.status} ${current === b.status ? 'on' : ''}`}
                        onClick={() => mark(s, b.status)}
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          {!session.students.length && <p className="muted">No students in this batch yet.</p>}

          <div className="send-bar">
            <span className="small">
              <b className="s-A">{absent} absent</b> · <b className="s-T">{late} late</b> · <b className="s-L">{leave} on leave</b>
            </span>
            {session.submittedAt ? (
              <span className="small ok-text"><Icon name="check" size={14} /> Sent {fmtTime(session.submittedAt)}</span>
            ) : (
              <button className="btn primary" onClick={send} disabled={sending || !session.students.length}>
                <Icon name="send" /> Send to office
              </button>
            )}
          </div>
          <p className="muted small" style={{ marginTop: 10 }}>
            {session.verifiedAt
              ? 'Parents have been alerted. Marking someone absent now alerts their parent right away.'
              : session.submittedAt
                ? `Parents of absent students get a WhatsApp at ${fmtTime(session.verifyDueAt)}. You can still change marks until then.`
                : `Parents are only alerted after you send the list. The office expects it by ${fmtTime(session.verifyDueAt)}.`}
          </p>
        </section>
      )}
    </div>
  );
}
