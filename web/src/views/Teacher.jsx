import { useEffect, useState } from 'react';
import { api, fmtTime24, useData, useLive, useNow } from '../api.js';
import { AlertState, Empty, SessionBadge } from '../components.jsx';

const BUTTONS = [
  { status: 'P', label: 'P', title: 'Present' },
  { status: 'A', label: 'A', title: 'Absent' },
  { status: 'L', label: 'L', title: 'Leave / late' },
];

export default function Teacher() {
  const { version, toast } = useLive();
  const { data: batches } = useData('/batches');
  const [batchId, setBatchId] = useState(() => Number(localStorage.getItem('teacherBatch')) || null);
  const [session, setSession] = useState(null);
  const [pending, setPending] = useState({});
  const now = useNow();

  useEffect(() => {
    if (batches?.length && !batches.some((b) => b.id === batchId)) setBatchId(batches[0].id);
  }, [batches, batchId]);

  useEffect(() => {
    if (!batchId) return;
    try {
      localStorage.setItem('teacherBatch', String(batchId));
    } catch {
      /* storage may be unavailable */
    }
    api.post(`/batches/${batchId}/today`).then(setSession).catch((e) => toast(e.message, 'bad'));
  }, [batchId, version, toast]);

  const mark = async (studentId, status) => {
    setPending((p) => ({ ...p, [studentId]: status }));
    try {
      setSession(await api.post(`/sessions/${session.id}/mark`, { studentId, status }));
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setPending((p) => {
        const { [studentId]: _, ...rest } = p;
        return rest;
      });
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

  if (!batches) return <p className="muted">Loading…</p>;
  if (!batches.length) return <Empty title="No batches yet">Create a batch in <a href="#/setup">Setup</a> first.</Empty>;

  return (
    <div className="teacher">
      <div className="chips-row">
        {batches.map((b) => (
          <button key={b.id} className={`chip-btn ${b.id === batchId ? 'active' : ''}`} onClick={() => setBatchId(b.id)}>
            {b.name} <span className="muted">· {fmtTime24(b.startTime)}</span>
          </button>
        ))}
      </div>

      {session && (
        <section className="card">
          <div className="session-head">
            <div>
              <div className="eyebrow">Live · {session.batch.name} · {fmtTime24(session.batch.startTime)}</div>
              <h2>Mark attendance</h2>
            </div>
            <SessionBadge session={session} now={now} />
          </div>

          <ul className="mark-list">
            {session.students.map((s) => {
              const current = pending[s.id] ?? s.status;
              return (
                <li key={s.id} className="mark-row">
                  <div className="mark-info">
                    <div className="roster-name">{s.name}</div>
                    {s.alert ? (
                      <AlertState alert={s.alert} task={s.task} now={now} />
                    ) : (
                      s.note && s.source !== 'teacher' && <div className="muted small">{s.note}</div>
                    )}
                  </div>
                  <div className="pal" role="group" aria-label={`Attendance for ${s.name}`}>
                    {BUTTONS.map((b) => (
                      <button
                        key={b.status}
                        title={b.title}
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
              Mark all present
            </button>
            <span className="muted small">
              {session.verifiedAt
                ? 'Verified. Marking someone absent now alerts their parent right away.'
                : "Marks save as you tap. Anyone left unmarked counts as absent when verification runs."}
            </span>
          </div>
        </section>
      )}
    </div>
  );
}
