import { useState } from 'react';
import { fmtDate, fmtDuration, fmtTime, fmtTime24, useApp, useData, useNow } from '../api.js';
import { AlertState, Empty, Icon, Kpi, Loading, SessionBadge, StatusPill } from '../ui.jsx';
import { dayWork, statusLine } from './Today.jsx';

const FEED_ICON = { start: 'play', mark: 'check', submit: 'send', verify: 'shield', alert: 'chat', reply: 'send', escalate: 'phone', call: 'phone', fail: 'alert' };

export function Timeline({ events, tz }) {
  if (!events?.length) return <p className="muted small">Nothing has happened yet.</p>;
  return (
    <ul className="timeline">
      {events.map((e, i) => (
        <li key={i}>
          <span className={`feed-dot ${e.kind}`}><Icon name={FEED_ICON[e.kind] ?? 'clock'} /></span>
          <span className="num muted small">{fmtTime(e.at, tz)}</span>
          <span>{e.text}</span>
        </li>
      ))}
    </ul>
  );
}

function SessionCard({ session, tz, now, isToday }) {
  const { api, toast, info } = useApp();
  const [busy, setBusy] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const { data: timeline } = useData(showTimeline ? `/sessions/${session.id}/timeline` : null);

  const run = async (path, msg) => {
    if (path === 'submit') {
      const ok = window.confirm(
        `Send ${session.batch.name} for the teacher? Students not marked (${session.counts.unmarked}) count as present, so their parents won't be messaged.`,
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
  const { P, A, L, T, unmarked } = session.counts;

  return (
    <section className="card session">
      <div className="session-head">
        <div className="grow">
          <h3 className="ellipsis">{session.batch.name}</h3>
          <div className="muted small">Class at {fmtTime24(session.batch.startTime)}</div>
        </div>
        <SessionBadge session={session} now={now} tz={tz} />
      </div>
      <div className="mini-counts">
        <span className="s-P">Present {P + T}</span>
        {T > 0 && <span className="s-T">Late {T}</span>}
        <span className="s-A">Absent {A}</span>
        {L > 0 && <span className="s-L">Leave {L}</span>}
        {unmarked > 0 && <span className="muted">Not marked {unmarked}</span>}
        <button className="link" style={{ marginLeft: 'auto' }} onClick={() => setShowTimeline((v) => !v)}>
          {showTimeline ? 'Hide timeline' : 'Timeline'}
        </button>
      </div>
      {showTimeline ? (
        timeline ? <Timeline events={timeline} tz={tz} /> : <Loading height={80} />
      ) : (
        <ul className="roster">
          {session.students.map((s) => (
            <li key={s.id} className={`roster-row ${s.task?.status === 'open' || (s.alert && s.alert.status === 'sent' && s.status === 'A') ? 'flag' : ''}`}>
              <div className="roster-main">
                <a className="roster-name" href={`#/students/${s.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>{s.name}</a>
                <StatusPill status={s.status} />
              </div>
              {(s.alert || (s.note && s.source !== 'teacher')) && (
                <div className="roster-sub">
                  {s.alert ? <AlertState alert={s.alert} task={s.task} now={now} tz={tz} /> : <span className="muted">{s.note}</span>}
                </div>
              )}
            </li>
          ))}
          {!session.students.length && <li className="muted small">No students yet. Add them in Students.</li>}
        </ul>
      )}
      {isToday && !session.verifiedAt && (
        <div className="session-actions">
          {info.mode === 'simulator' && (
            <button className="btn ghost small" disabled={busy} onClick={() => run('start-now', 'Class timer started now')} title="Practice mode only: pretend the class starts now">
              <Icon name="play" /> Start class now
            </button>
          )}
          {!session.submittedAt && (
            <button className="btn small" disabled={busy || !session.students.length} onClick={() => run('submit', 'Sent for the teacher')}>
              <Icon name="send" /> Send for teacher
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function Impact({ report }) {
  const a = report?.alerts;
  if (!a?.sent) return null;
  const before = a.avgMinBeforeClassEnd;
  return (
    <section className="impact">
      <div className="impact-times">
        <Icon name="clock" size={30} />
        <span>{fmtDuration(a.avgMinToAlert)}</span>
      </div>
      <div>
        <h2>Parents hear within {fmtDuration(a.avgMinToAlert)} of class starting</h2>
        <p>
          Over the last 30 days that's <b>{fmtDuration(before)} earlier</b> than waiting for class to end.{' '}
          {a.replyRate}% of parents replied on WhatsApp, in {a.avgReplyMin ?? '–'} min on average. {report.calls.bunks} bunks were caught by a phone call.
        </p>
      </div>
    </section>
  );
}

function Activity() {
  const { data } = useData('/activity');
  return (
    <section className="card">
      <div className="card-head"><h3>Live activity</h3><span className="chip info pulse">Today</span></div>
      {!data ? (
        <Loading height={160} />
      ) : data.length ? (
        <ul className="feed">
          {data.map((e, i) => (
            <li key={i}>
              <span className={`feed-dot ${e.kind}`}><Icon name={FEED_ICON[e.kind] ?? 'clock'} /></span>
              <div>
                <div className="feed-text">{e.text}</div>
                <div className="feed-meta">{fmtTime(e.at)} · {e.batch}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Nothing yet today. Events appear here as classes run.</p>
      )}
    </section>
  );
}

function NeedsAttention() {
  const { data } = useData('/students');
  const risky = (data ?? []).filter((s) => s.atRisk).sort((a, b) => (a.pct ?? 100) - (b.pct ?? 100)).slice(0, 6);
  return (
    <section className="card">
      <div className="card-head"><h3>Needs attention</h3><a className="link" href="#/students">All students</a></div>
      {!data ? (
        <Loading height={120} />
      ) : risky.length ? (
        <ul className="risk-list">
          {risky.map((s) => (
            <li key={s.id}>
              <div className="grow">
                <a href={`#/students/${s.id}`} style={{ color: 'inherit', fontWeight: 600, textDecoration: 'none' }}>{s.name}</a>
                <div className="muted tiny">{s.batchName} · {s.riskReasons.join(' · ')}</div>
              </div>
              <span className={`pill ${s.pct < 75 ? 's-A' : 's-L'}`}>{s.pct ?? '–'}%</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Nobody is missing classes regularly.</p>
      )}
    </section>
  );
}

export default function Dashboard() {
  const [date, setDate] = useState('');
  const { data, error } = useData(`/board${date ? `?date=${date}` : ''}`);
  const { data: report } = useData('/reports');
  const { data: tasks } = useData('/tasks');
  const now = useNow();

  if (error) return <p className="error-text">{error.message}</p>;
  if (!data) return <Loading height={400} />;
  const { stats, settings, tz, sessions } = data;
  const isToday = data.date === data.today;
  const status = isToday && tasks ? statusLine(dayWork(data, tasks, now), data) : null;

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <div className="eyebrow">{fmtDate(data.date, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          <h1>{!isToday ? `Attendance on ${fmtDate(data.date)}` : status ? (status.act ? 'Needs attention today' : status.text) : 'Today'}</h1>
          {status?.act && (
            <p className="lead">
              {status.text}. <a href="#/today">Open today's to-do list</a>
            </p>
          )}
          <p className="muted small">
            Parents are messaged {settings.verifyAfterMinutes} min after class starts, once the teacher sends the list. No reply in {settings.replyTimeoutMinutes} min means a phone call.
          </p>
        </div>
        <input className="input auto" type="date" value={date || data.date} max={data.today} onChange={(e) => setDate(e.target.value === data.today ? '' : e.target.value)} aria-label="Pick a date" />
      </div>

      {data.holiday && <div className="banner"><Icon name="calendar" /> Holiday: {data.holiday}. No classes and no alerts.</div>}
      {isToday && (() => {
        const late = sessions.filter((s) => !s.submittedAt && Date.parse(s.verifyDueAt) < now);
        return late.length ? (
          <div className="banner bad">
            <Icon name="alert" /> Not sent by the teacher: {late.map((s) => s.batch.name).join(', ')}. No parent has been alerted for {late.length === 1 ? 'this class' : 'these classes'} yet.
          </div>
        ) : null;
      })()}
      {isToday && <Impact report={report} />}

      <div className="dash-grid">
        <div className="stack">
          <div className="kpis four">
            <Kpi label="Present" value={stats.present} tone="ok" hint={stats.late ? `${stats.late} arrived late` : undefined} />
            <Kpi label="Absent" value={stats.absent} tone="bad" />
            <Kpi label="On leave" value={stats.leave} tone="warn" />
            <Kpi label="Parents told within" value={stats.avgMinutesToAlert == null ? '–' : `${Math.round(stats.avgMinutesToAlert)} min`} hint="of class starting, on average" />
          </div>
          {sessions.length ? (
            <div className="sessions">
              {sessions.map((s) => (
                <SessionCard key={s.id} session={s} tz={tz} now={now} isToday={isToday} />
              ))}
            </div>
          ) : (
            <Empty title={isToday ? (data.holiday ? 'Enjoy the holiday' : 'No classes today') : 'No classes on this day'} icon="calendar">
              {isToday && !data.holiday && <>Add batches in <a href="#/settings/batches">Settings</a>.</>}
            </Empty>
          )}
        </div>
        {isToday && (
          <div className="stack">
            <Activity />
            <NeedsAttention />
          </div>
        )}
      </div>
    </div>
  );
}
