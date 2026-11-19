import { useEffect, useState } from 'react';
import { fmtTime, fmtTime24, useApp, useData, useNow } from '../api.js';
import { AlertState, Avatar, Empty, Icon, Loading, SessionBadge } from '../ui.jsx';
import { LANGS, useT } from '../i18n.js';

// Marking by exception: everyone is present unless the teacher taps one of these.
// Tapping the selected one again puts the student back to present.
const EXCEPTIONS = ['A', 'T', 'L'];

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
  const [t, lang, setLang] = useT();

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
      toast(t('teacher.sentToast'));
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setSending(false);
    }
  };

  if (!batches) return <Loading height={300} />;
  if (!batches.length) {
    return (
      <Empty title={info.role === 'teacher' ? t('teacher.noBatches') : 'No batches yet'} icon="calendar">
        {info.role === 'teacher' ? t('teacher.askOwner') : <>Create a batch in <a href="#/settings/batches">Settings</a> first.</>}
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
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <h1 lang={lang}>{t('teacher.title')}</h1>
          <p className="muted" lang={lang}>{t('teacher.intro')}</p>
        </div>
        <div className="seg" role="group" aria-label="Language">
          {LANGS.map((l) => (
            <button key={l.id} type="button" lang={l.id} className={lang === l.id ? 'on' : ''} aria-pressed={lang === l.id} onClick={() => setLang(l.id)}>{l.label}</button>
          ))}
        </div>
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
              <h2 lang={lang}>{t('teacher.inClass', session.students.length - absent - leave, session.students.length)}</h2>
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
                        <div className="muted small" lang={lang}>{current === 'L' ? t('status.onLeave') : t(`status.${current}`)}</div>
                      )}
                    </div>
                  </div>
                  <div className="pal" role="group" aria-label={t('teacher.exceptionsFor', s.name)}>
                    {EXCEPTIONS.map((st) => (
                      <button
                        key={st}
                        lang={lang}
                        aria-label={`${t(`status.${st}`)}: ${s.name}`}
                        aria-pressed={current === st}
                        className={`pal-btn wide s-${st} ${current === st ? 'on' : ''}`}
                        onClick={() => mark(s, st)}
                      >
                        {t(`status.${st}`)}
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          {!session.students.length && <p className="muted">{t('teacher.noStudents')}</p>}

          <div className="send-bar">
            <span className="small" lang={lang}>
              {(() => {
                const [a, l, v] = t('teacher.counts', absent, late, leave).split(' · ');
                return <><b className="s-A">{a}</b> · <b className="s-T">{l}</b> · <b className="s-L">{v}</b></>;
              })()}
            </span>
            {session.submittedAt ? (
              <span className="small ok-text" lang={lang}><Icon name="check" size={14} /> {t('teacher.sent', fmtTime(session.submittedAt))}</span>
            ) : (
              <button className="btn primary" onClick={send} disabled={sending || !session.students.length}>
                <Icon name="send" /> <span lang={lang}>{t('teacher.send')}</span>
              </button>
            )}
          </div>
          <p className="muted small" style={{ marginTop: 10 }} lang={lang}>
            {session.verifiedAt
              ? t('teacher.after.verified')
              : session.submittedAt
                ? t('teacher.after.sent', fmtTime(session.verifyDueAt))
                : t('teacher.after.notSent', fmtTime(session.verifyDueAt))}
          </p>
        </section>
      )}
    </div>
  );
}
