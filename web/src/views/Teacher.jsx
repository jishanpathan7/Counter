import { useEffect, useState } from 'react';
import { fmtTime24, useApp, useData, useNow } from '../api.js';
import { AlertState, Avatar, Empty, Icon, Loading, SessionBadge } from '../ui.jsx';

const BUTTONS = [
  { status: 'P', label: 'P', title: 'Present' },
  { status: 'A', label: 'A', title: 'Absent' },
  { status: 'L', label: 'L', title: 'Leave / late' },
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

  const mark = async (studentId, status) => {
    setPending((p) => ({ ...p, [studentId]: status }));
    try {
      setSession(await api.post(`/sessions/${session.id}/mark`, { studentId, status }));
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setPending(({ [studentId]: _, ...rest }) => rest);
    }
  };

  const markAllPresent = async () => {
    try {
      setSession(await api.post(`/sessions/${session.id}/mark-all`, { status: 'P' }));
      toast('Everyone marked present');
    } catch (e) {
      toast(e.message, 'bad');
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

  const marked = session ? session.students.filter((s) => s.status).length : 0;
  const total = session?.students.length ?? 0;

  return (
    <div className="teacher">
      <div>
        <h1>Take attendance</h1>
        <p className="muted">Tap P, A or L. Marks save instantly; parents of absent students get a WhatsApp after verification.</p>
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
              <h2>{marked}/{total} marked</h2>
            </div>
            <SessionBadge session={session} now={now} />
          </div>
          <div className="progress-line"><span style={{ width: `${total ? (marked / total) * 100 : 0}%` }} /></div>

          <ul className="mark-list">
            {session.students.map((s) => {
              const current = pending[s.id] ?? s.status;
              return (
                <li key={s.id} className="mark-row">
                  <div className="who">
                    <Avatar name={s.name} />
                    <div className="mark-info">
                      <div className="roster-name ellipsis">{s.name}</div>
                      {s.alert ? (
                        <AlertState alert={s.alert} task={s.task} now={now} />
                      ) : (
                        s.note && s.source !== 'teacher' && <div className="muted small">{s.note}</div>
                      )}
                    </div>
                  </div>
                  <div className="pal" role="group" aria-label={`Attendance for ${s.name}`}>
                    {BUTTONS.map((b) => (
                      <button
                        key={b.status}
                        title={b.title}
                        aria-label={`${b.title}: ${s.name}`}
                        aria-pressed={current === b.status}
                        className={`pal-btn s-${b.status} ${current === b.status ? 'on' : ''}`}
                        onClick={() => mark(s.id, b.status)}
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

          <div className="teacher-foot">
            <button className="btn ghost" onClick={markAllPresent} disabled={!session.students.length}>
              <Icon name="check" /> Mark all present
            </button>
            <span className="muted small grow">
              {session.verifiedAt
                ? 'Verified. Marking someone absent now alerts their parent right away.'
                : 'Anyone left unmarked counts as absent when verification runs.'}
            </span>
          </div>
        </section>
      )}
    </div>
  );
}
