import { useState } from 'react';
import { api, fmtTime, fmtTime24, useData, useLive, useNow } from '../api.js';
import { AlertState, Empty, SessionBadge, StatusPill } from '../components.jsx';

function Kpi({ label, value, tone, hint }) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

function SessionCard({ session, tz, now, isToday }) {
  const { toast } = useLive();
  const [busy, setBusy] = useState(false);
  const run = async (path, msg) => {
    if (path === 'verify' && session.counts.unmarked > 0) {
      const ok = window.confirm(
        `${session.counts.unmarked} student(s) are not marked and will count as absent. Their parents get a WhatsApp alert. Continue?`,
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.post(`/sessions/${session.id}/${path}`);
      toast(msg);
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const { P, A, L, unmarked } = session.counts;

  return (
    <section className="card session">
      <div className="session-head">
        <div>
          <h2>{session.batch.name}</h2>
          <div className="muted small">Class at {fmtTime24(session.batch.startTime)}</div>
        </div>
        <SessionBadge session={session} now={now} tz={tz} />
      </div>
      <div className="mini-counts">
        <span className="s-P">P {P}</span>
        <span className="s-A">A {A}</span>
        <span className="s-L">L {L}</span>
        {unmarked > 0 && <span className="muted">Unmarked {unmarked}</span>}
      </div>
      <ul className="roster">
        {session.students.map((s) => (
          <li key={s.id} className={`roster-row ${s.alert && s.alert.status !== 'replied' && s.status === 'A' ? 'flag' : ''}`}>
            <div className="roster-main">
              <span className="roster-name">{s.name}</span>
              <StatusPill status={s.status} />
            </div>
            {(s.alert || s.note) && (
              <div className="roster-sub">
                {s.alert ? <AlertState alert={s.alert} task={s.task} now={now} tz={tz} /> : <span className="muted">{s.note}</span>}
              </div>
            )}
          </li>
        ))}
        {!session.students.length && <li className="muted small">No students yet. Add them in Setup.</li>}
      </ul>
      {isToday && !session.verifiedAt && (
        <div className="session-actions">
          <button className="btn ghost small" disabled={busy} onClick={() => run('start-now', 'Class timer started now')}>
            Start class now
          </button>
          <button className="btn small" disabled={busy} onClick={() => run('verify', 'Verified: parents of absentees alerted')}>
            Verify now &amp; alert parents
          </button>
        </div>
      )}
    </section>
  );
}

export default function Dashboard() {
  const [date, setDate] = useState('');
  const { data, error } = useData(`/board${date ? `?date=${date}` : ''}`);
  const now = useNow();

  if (error) return <p className="error-text">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const { stats, settings, tz, sessions } = data;
  const isToday = data.date === data.today;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{isToday ? 'Today' : data.date}</h1>
          <p className="muted">
            Absentees are verified {settings.verifyAfterMinutes} min after class starts. Parents who don't reply in{' '}
            {settings.replyTimeoutMinutes} min become a staff call task.
          </p>
        </div>
        <input className="input date" type="date" value={date || data.date} max={data.today} onChange={(e) => setDate(e.target.value === data.today ? '' : e.target.value)} />
      </div>

      <div className="kpis">
        <Kpi label="Present" value={stats.present} tone="ok" />
        <Kpi label="Absent" value={stats.absent} tone="bad" />
        <Kpi label="Leave / late" value={stats.leaveLate} tone="warn" />
        <Kpi label="WhatsApp alerts" value={stats.alertsSent} hint={`${stats.replied} replied · ${stats.awaitingReply} waiting`} />
        <Kpi label="Open call tasks" value={stats.openTasks} tone={stats.openTasks ? 'bad' : ''} />
        <Kpi
          label="Parent informed after"
          value={stats.avgMinutesToAlert == null ? '–' : `${stats.avgMinutesToAlert} min`}
          hint="from class start, on average"
          tone="ok"
        />
      </div>

      {sessions.length ? (
        <div className="grid">
          {sessions.map((s) => (
            <SessionCard key={s.id} session={s} tz={tz} now={now} isToday={isToday} />
          ))}
        </div>
      ) : (
        <Empty title={isToday ? 'No classes scheduled today' : 'No classes on this day'}>
          {isToday && (
            <>
              Add batches in <a href="#/setup">Setup</a>, or open a batch in the <a href="#/teacher">Teacher</a> screen to run an extra class.
            </>
          )}
        </Empty>
      )}
      {isToday && <p className="muted small">Times shown in {tz}. Now: {fmtTime(new Date(now).toISOString(), tz)}</p>}
    </div>
  );
}
