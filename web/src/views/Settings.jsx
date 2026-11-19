import { useEffect, useRef, useState } from 'react';
import { api as rootApi, fmtAgo, fmtDate, fmtPhone, fmtTime, fmtTime24, useApp, useData } from '../api.js';
import { Avatar, Empty, Icon, Loading, Modal } from '../ui.jsx';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SECTIONS = [
  { id: 'general', label: 'General', icon: 'gear' },
  { id: 'batches', label: 'Batches', icon: 'calendar' },
  { id: 'holidays', label: 'Holidays', icon: 'sun' },
  { id: 'team', label: 'Team', icon: 'users' },
  { id: 'whatsapp', label: 'WhatsApp & message', icon: 'chat' },
  { id: 'billing', label: 'Plan & billing', icon: 'chart' },
  { id: 'privacy', label: 'Privacy & data', icon: 'shield' },
  { id: 'account', label: 'My account', icon: 'user' },
];

function useSave() {
  const { toast } = useApp();
  return async (fn, msg = 'Saved') => {
    try {
      const r = await fn();
      toast(msg);
      return r;
    } catch (e) {
      toast(e.message, 'bad');
      return null;
    }
  };
}

// ------------------------------------------------------------------ general
function General() {
  const { api, info } = useApp();
  const save = useSave();
  const { data } = useData('/settings');
  const [f, setF] = useState(null);
  const [digest, setDigest] = useState(null);
  useEffect(() => {
    if (data && !f) setF(data);
  }, [data, f]);
  if (!f) return <Loading height={300} />;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  return (
    <div className="stack">
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); save(() => api.patch('/settings', f).then(setF)); }}>
        <h2>Institute & timing</h2>
        <label className="field">Institute name<input className="input" value={f.instituteName} onChange={set('instituteName')} /></label>
        <div className="grid2">
          <label className="field">
            Message parents after (minutes)
            <input className="input" type="number" min="0" max="240" step="any" value={f.verifyAfterMinutes} onChange={set('verifyAfterMinutes')} />
            <span className="hint">From class start, once the teacher has sent the list. Unsent classes never alert parents.</span>
          </label>
          <label className="field">
            Call the parent if no reply in (minutes)
            <input className="input" type="number" min="0" max="240" step="any" value={f.replyTimeoutMinutes} onChange={set('replyTimeoutMinutes')} />
            <span className="hint">Then the parent goes on the call list</span>
          </label>
        </div>
        <div className="divider" />
        <h3>Parent consent</h3>
        <label className="check"><input type="checkbox" checked={f.requireConsent} onChange={set('requireConsent')} /> Only send WhatsApp alerts to parents who agreed</label>
        <p className="muted small" style={{ marginTop: -8 }}>
          Recommended. Parents agree by signing the admission form (record it under Students) or by sending START on WhatsApp. Without consent the absence becomes a call task instead. Parents who send STOP are never messaged, whatever this setting says.
        </p>
        <div className="divider" />
        <h3>Daily summary for the owner</h3>
        <p className="muted small" style={{ marginTop: -8 }}>An end-of-day WhatsApp with the day's attendance, alerts, calls and students who need attention.</p>
        <label className="check"><input type="checkbox" checked={f.digestEnabled} onChange={set('digestEnabled')} /> Send me a daily summary</label>
        <div className="grid2">
          <label className="field">Owner's WhatsApp<input className="input" inputMode="tel" value={f.ownerPhone} onChange={set('ownerPhone')} placeholder="98765 43210" /></label>
          <label className="field">Send at<input className="input" type="time" value={f.digestTime} onChange={set('digestTime')} /></label>
        </div>
        <div className="row">
          <button className="btn primary">Save</button>
          <button type="button" className="btn ghost" onClick={() => api.get('/digest/preview').then(setDigest)}>Preview summary</button>
          <button type="button" className="btn ghost" onClick={() => save(() => api.post('/digest/send'), 'Summary sent')} disabled={!data?.ownerPhone}>Send now</button>
        </div>
        {info.mode === 'simulator' && <p className="muted small">Trying it out? Set both timers to 0.5 and press “Start class now” on Home.</p>}
      </form>
      {digest && (
        <Modal title="Today's summary" onClose={() => setDigest(null)}>
          <div className="phone mini" style={{ background: 'var(--chat-bg)' }}>
            <div className="phone-body"><div className="bubble-wrap out"><div className="bubble out">{digest.text}</div></div></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ batches
function BatchForm({ initial, onSave, onCancel }) {
  const [f, setF] = useState(initial ?? { name: '', startTime: '16:00', durationMinutes: 120, days: [1, 2, 3, 4, 5, 6] });
  const toggle = (d) => setF({ ...f, days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d] });
  return (
    <form className="stack tight" onSubmit={(e) => { e.preventDefault(); onSave({ ...f, durationMinutes: Number(f.durationMinutes) }); }}>
      <div className="batch-form">
        <label className="field">Batch name<input className="input" placeholder="e.g. Class 10 · Batch B" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
        <label className="field">Starts at<input className="input" type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} required /></label>
        <label className="field">Length (min)<input className="input" type="number" min="15" max="480" step="5" value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: e.target.value })} /></label>
      </div>
      <div className="row">
        <div className="days" role="group" aria-label="Days">
          {DAYS.map((d, i) => (
            <button type="button" key={d} aria-pressed={f.days.includes(i)} className={`day ${f.days.includes(i) ? 'on' : ''}`} onClick={() => toggle(i)}>{d}</button>
          ))}
        </div>
        <span className="grow" />
        {onCancel && <button className="btn ghost small" type="button" onClick={onCancel}>Cancel</button>}
        <button className="btn primary small">{initial ? 'Save' : 'Add batch'}</button>
      </div>
    </form>
  );
}

function Batches() {
  const { api } = useApp();
  const save = useSave();
  const { data } = useData('/batches');
  const [editing, setEditing] = useState(null);
  const [formKey, setFormKey] = useState(0);
  const remove = (b) => {
    if (window.confirm(`Remove ${b.name}? Past attendance is kept in reports.`)) save(() => api.del(`/batches/${b.id}`), 'Batch removed');
  };
  return (
    <div className="stack">
      <section className="card stack">
        <h2>New batch</h2>
        <BatchForm key={formKey} onSave={(f) => save(() => api.post('/batches', f), 'Batch added').then((r) => r && setFormKey((k) => k + 1))} />
      </section>
      {!data ? <Loading /> : data.map((b) => (
        <section key={b.id} className="card">
          {editing === b.id ? (
            <BatchForm initial={{ name: b.name, startTime: b.startTime, days: b.days, durationMinutes: b.durationMinutes }} onCancel={() => setEditing(null)} onSave={(f) => save(() => api.patch(`/batches/${b.id}`, f)).then((r) => r && setEditing(null))} />
          ) : (
            <div className="session-head">
              <div>
                <h3>{b.name}</h3>
                <div className="muted small">
                  {fmtTime24(b.startTime)} · {b.durationMinutes} min · {b.days.length === 7 ? 'Every day' : b.days.map((d) => DAYS[d]).join(', ')} · {b.studentCount} students
                </div>
              </div>
              <div className="row">
                <a className="btn ghost small" href="#/students">Students</a>
                <button className="btn ghost small" onClick={() => setEditing(b.id)}><Icon name="edit" /> Edit</button>
                <button className="btn ghost small" style={{ color: 'var(--red)' }} onClick={() => remove(b)} aria-label={`Remove ${b.name}`}><Icon name="trash" /></button>
              </div>
            </div>
          )}
        </section>
      ))}
      {data && !data.length && <Empty title="No batches yet" icon="calendar">Add your first batch above.</Empty>}
    </div>
  );
}

// ------------------------------------------------------------------ holidays
function Holidays() {
  const { api, info } = useApp();
  const save = useSave();
  const { data } = useData('/holidays');
  const [f, setF] = useState({ date: info.today, label: '' });
  const upcoming = (data ?? []).filter((h) => h.date >= info.today);
  const past = (data ?? []).filter((h) => h.date < info.today).reverse();
  return (
    <div className="stack">
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); save(() => api.post('/holidays', f), 'Holiday added').then((r) => r && setF({ ...f, label: '' })); }}>
        <h2>Add a holiday</h2>
        <p className="muted small" style={{ marginTop: -8 }}>No classes are scheduled and no WhatsApp alerts go out on holidays.</p>
        <div className="batch-form" style={{ gridTemplateColumns: '170px 1fr auto' }}>
          <label className="field">Date<input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required /></label>
          <label className="field">Name<input className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="e.g. Diwali" required /></label>
          <button className="btn primary">Add</button>
        </div>
      </form>
      {[['Upcoming', upcoming], ['Past', past]].map(([title, list]) => list.length > 0 && (
        <section key={title} className="card flush">
          <div className="card-head" style={{ padding: '16px 16px 0' }}><h3>{title}</h3></div>
          <table className="table">
            <tbody>
              {list.map((h) => (
                <tr key={h.date}>
                  <td style={{ width: 180 }}>{fmtDate(h.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</td>
                  <td><b>{h.label}</b></td>
                  <td className="right"><button className="link danger" onClick={() => save(() => api.del(`/holidays/${h.date}`), 'Holiday removed')}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      {data && !data.length && <Empty title="No holidays yet" icon="sun" />}
    </div>
  );
}

// ------------------------------------------------------------------ team
const ROLES = [
  { id: 'owner', label: 'Owner', desc: 'Everything, including settings and team' },
  { id: 'staff', label: 'Front desk', desc: 'Dashboard, students, call tasks, WhatsApp, reports' },
  { id: 'teacher', label: 'Teacher', desc: 'Takes attendance for their batches' },
];

function MemberForm({ initial, batches, onSave, onCancel, isNew }) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const toggleBatch = (id) => setF({ ...f, batchIds: f.batchIds.includes(id) ? f.batchIds.filter((x) => x !== id) : [...f.batchIds, id] });
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); onSave(f); }}>
      <div className="grid2">
        <label className="field">Name<input className="input" value={f.name} onChange={set('name')} required autoFocus disabled={!isNew && f.sharedAccount} /></label>
        <label className="field">Mobile number<input className="input" inputMode="tel" value={f.phone} onChange={set('phone')} required disabled={!isNew} /></label>
      </div>
      <div className="field">
        Role
        <div className="stack tight">
          {ROLES.map((r) => (
            <label key={r.id} className="check" style={{ alignItems: 'flex-start' }}>
              <input type="radio" name="role" checked={f.role === r.id} onChange={() => setF({ ...f, role: r.id })} />
              <span><b>{r.label}</b> <span className="muted small">· {r.desc}</span></span>
            </label>
          ))}
        </div>
      </div>
      {f.role === 'teacher' && (
        <div className="field">
          Batches they take
          <div className="days">
            {batches.map((b) => (
              <button type="button" key={b.id} className={`day ${f.batchIds.includes(b.id) ? 'on' : ''}`} onClick={() => toggleBatch(b.id)}>{b.name}</button>
            ))}
          </div>
          <span className="hint">None selected = all batches</span>
        </div>
      )}
      {!isNew && f.sharedAccount ? (
        <p className="muted small">This person also uses another institute, so only they can change their name or PIN (from My account).</p>
      ) : (
        <label className="field">
          {isNew ? 'PIN for their first login' : 'Reset PIN'}
          <input className="input" inputMode="numeric" maxLength={8} value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} required={isNew} placeholder={isNew ? '6–8 digits' : 'Leave blank to keep'} />
          {isNew && <span className="hint">If they already have an account with another institute, they keep their own name and PIN.</span>}
        </label>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <button className="btn primary">{isNew ? 'Add to team' : 'Save'}</button>
      </div>
    </form>
  );
}

function Team() {
  const { api, me } = useApp();
  const save = useSave();
  const { data } = useData('/team');
  const { data: batches } = useData('/batches');
  const [modal, setModal] = useState(null);
  const batchName = (id) => batches?.find((b) => b.id === id)?.name;
  const close = (r) => r && setModal(null);
  return (
    <div className="stack">
      <div className="row between">
        <div>
          <h2>Team</h2>
          <p className="muted small">Everyone logs in with their own mobile number and PIN.</p>
        </div>
        <button className="btn primary" onClick={() => setModal({ isNew: true })}><Icon name="plus" /> Add person</button>
      </div>
      {!data ? <Loading /> : (
        <div className="card flush table-wrap">
          <table className="table">
            <thead><tr><th>Person</th><th>Role</th><th className="hide-sm">Last login</th><th /></tr></thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div className="who">
                      <Avatar name={m.name} />
                      <div><b>{m.name}</b>{m.id === me.user.id && <span className="muted small"> (you)</span>}<div className="muted tiny">{fmtPhone(m.phone)}</div></div>
                    </div>
                  </td>
                  <td>
                    <span className={`chip ${m.role === 'owner' ? 'ok' : m.role === 'staff' ? 'info' : ''}`}>{ROLES.find((r) => r.id === m.role)?.label}</span>
                    {m.role === 'teacher' && <div className="muted tiny" style={{ marginTop: 4 }}>{m.batchIds.length ? m.batchIds.map(batchName).filter(Boolean).join(', ') : 'All batches'}</div>}
                  </td>
                  <td className="small muted hide-sm">{fmtAgo(m.lastLoginAt)}</td>
                  <td className="right">
                    <button className="link" onClick={() => setModal({ member: m })}>Edit</button>
                    {m.id !== me.user.id && (
                      <button className="link danger" style={{ marginLeft: 12 }} onClick={() => window.confirm(`Remove ${m.name} from the team?`) && save(() => api.del(`/team/${m.id}`), 'Removed')}>Remove</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {modal && batches && (
        <Modal title={modal.isNew ? 'Add a team member' : `Edit ${modal.member.name}`} onClose={() => setModal(null)}>
          <MemberForm
            isNew={modal.isNew}
            batches={batches}
            initial={modal.isNew ? { name: '', phone: '', role: 'teacher', batchIds: [], pin: '' } : { ...modal.member, pin: '' }}
            onCancel={() => setModal(null)}
            onSave={(f) =>
              save(() => (modal.isNew ? api.post('/team', f) : api.patch(`/team/${modal.member.id}`, { name: f.name, role: f.role, batchIds: f.batchIds, ...(f.pin ? { pin: f.pin } : {}) })), modal.isNew ? `${f.name} added` : 'Saved').then(close)
            }
          />
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ WhatsApp + message
const PLACEHOLDERS = ['{parent}', '{student}', '{batch}', '{time}', '{institute}'];

function MessageEditor() {
  const { api } = useApp();
  const save = useSave();
  const { data } = useData('/settings');
  const [tpl, setTpl] = useState(null);
  const [preview, setPreview] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (data && tpl === null) setTpl(data.alertTemplate);
  }, [data, tpl]);
  useEffect(() => {
    if (tpl === null) return undefined;
    const t = setTimeout(() => api.post('/settings/preview', { template: tpl }).then((r) => setPreview(r.text)).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [tpl, api]);
  if (tpl === null) return <Loading />;
  const insert = (p) => {
    const el = ref.current;
    const s = el?.selectionStart ?? tpl.length;
    const e = el?.selectionEnd ?? tpl.length;
    setTpl(tpl.slice(0, s) + p + tpl.slice(e));
    requestAnimationFrame(() => el?.focus());
  };
  return (
    <section className="card">
      <div className="grid2" style={{ alignItems: 'start', gap: 20 }}>
        <div className="stack">
          <div>
            <h2>Absence alert message</h2>
            <p className="muted small">Write it in the language your parents read. Tap a tag to insert it.</p>
          </div>
          <div className="placeholders">{PLACEHOLDERS.map((p) => <button key={p} type="button" onClick={() => insert(p)}>{p}</button>)}</div>
          <textarea ref={ref} className="textarea" value={tpl} onChange={(e) => setTpl(e.target.value)} aria-label="Alert message" />
          <div className="row">
            <button className="btn primary" onClick={() => save(() => api.patch('/settings', { alertTemplate: tpl }))}>Save message</button>
            <button className="btn ghost" onClick={() => setTpl('Namaste {parent}, aaj ki {batch} class ({time}) mein {student} ki attendance record nahi hui. Please confirm.')}>Hinglish</button>
            <button className="btn ghost" onClick={() => setTpl('Dear {parent}, {student} has not been marked present in today\'s {batch} class ({time}) at {institute}. Please let us know.')}>English</button>
            <button className="btn ghost" onClick={() => setTpl('नमस्ते {parent}, आज की {batch} क्लास ({time}) में {student} की उपस्थिति दर्ज नहीं हुई। कृपया बताएं।')}>हिंदी</button>
          </div>
          <p className="muted small">Once WhatsApp is connected, parents see the wording WhatsApp approved for your account. This text is what practice mode shows, and what parents get when they've messaged you in the last 24 hours.</p>
        </div>
        <div className="phone mini">
          <div className="phone-head"><div className="avatar">MV</div><div><div className="phone-title">Mr. Verma</div><div className="phone-sub">Preview</div></div></div>
          <div className="phone-body" style={{ minHeight: 220 }}>
            <div className="bubble-wrap out">
              <div className="bubble out"><div className="bubble-from">{data.instituteName}</div>{preview}<div className="bubble-time">4:10 PM</div></div>
              <div className="bubble-buttons"><button disabled>↩ Leave</button><button disabled>↩ Late 15 min</button><button disabled>↩ Mujhe call karein</button></div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function WhatsAppSettings() {
  const { api, slug, info } = useApp();
  const save = useSave();
  const { data } = useData('/whatsapp');
  const [f, setF] = useState(null);
  useEffect(() => {
    if (data && !f) setF({ ...data, token: '', appSecret: '' });
  }, [data, f]);
  const webhook = `${window.location.origin}/webhooks/whatsapp/${slug}`;
  const submit = (e) => {
    e.preventDefault();
    const body = { phoneNumberId: f.phoneNumberId, template: f.template, digestTemplate: f.digestTemplate, templateLang: f.templateLang, verifyToken: f.verifyToken };
    if (f.token) body.token = f.token;
    if (f.appSecret) body.appSecret = f.appSecret;
    save(() => api.patch('/whatsapp', body), 'WhatsApp settings saved').then((r) => r && setF({ ...r, token: '', appSecret: '' }));
  };
  const disconnect = () => {
    if (window.confirm('Disconnect WhatsApp? The app goes back to practice mode and parents stop getting alerts.')) save(() => api.patch('/whatsapp', { token: '', phoneNumberId: '' }), 'Disconnected').then((r) => r && setF({ ...r, token: '', appSecret: '' }));
  };
  return (
    <div className="stack">
      <MessageEditor />
      {!f ? <Loading /> : (
        <form className="card stack" onSubmit={submit}>
          {data?.unreadable?.length > 0 && (
            <div className="banner" style={{ background: 'var(--red-soft)', color: 'var(--red)', borderColor: 'var(--red-line)' }}>
              <Icon name="alert" /> The saved {data.unreadable.map((k) => (k === 'token' ? 'access token' : 'app secret')).join(' and ')} can't be read, because the server's encryption key changed. Enter {data.unreadable.length > 1 ? 'them' : 'it'} again below. Until then WhatsApp messages can't be sent.
            </div>
          )}
          <div className="row between">
            <div>
              <h2>WhatsApp Business</h2>
              <p className="muted small">
                {info.mode === 'whatsapp'
                  ? 'Connected: parents get alerts from your institute’s WhatsApp number.'
                  : 'Not connected yet, so the app runs in practice mode: messages stay inside the app (see WhatsApp in the menu) and no parent is contacted.'}
              </p>
            </div>
            <span className={`chip ${info.mode === 'whatsapp' ? 'ok' : 'warn'}`}>{info.mode === 'whatsapp' ? 'Connected' : 'Practice mode'}</span>
          </div>
          <label className="field">WhatsApp number parents see<input className="input" inputMode="tel" value={f.displayPhone ?? ''} onChange={(e) => setF({ ...f, displayPhone: e.target.value })} placeholder="91 98765 43210" /><span className="hint">Used for the "send START" link parents use to agree to alerts.</span></label>
          <details className="tech" open={data.unreadable?.length > 0 || undefined}>
            <summary>Technical setup <span className="muted small">for whoever sets up your WhatsApp Business account with Meta</span></summary>
            <div className="stack" style={{ marginTop: 12 }}>
              <div className="grid2">
                <label className="field">Phone number ID<input className="input" value={f.phoneNumberId} onChange={(e) => setF({ ...f, phoneNumberId: e.target.value })} placeholder="from WhatsApp → API setup" /></label>
                <label className="field">
                  Access token
                  <input className="input" type="password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} placeholder={data.token ? '•••••• saved (type to replace)' : 'Permanent access token'} autoComplete="off" />
                  <span className="hint">Stored encrypted.</span>
                </label>
              </div>
              <div className="grid2">
                <label className="field">Absence alert template<input className="input" value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })} placeholder="attendance_alert" /><span className="hint">Approved, with 3 quick replies: Leave, Late 15 min, Mujhe call karein</span></label>
                <label className="field">Owner summary template<input className="input" value={f.digestTemplate ?? ''} onChange={(e) => setF({ ...f, digestTemplate: e.target.value })} placeholder="owner_summary" /><span className="hint">Approved, 8 values; without it the daily summary isn't sent</span></label>
              </div>
              <div className="grid2">
                <label className="field">Template language<input className="input" value={f.templateLang} onChange={(e) => setF({ ...f, templateLang: e.target.value })} placeholder="en" /></label>
              </div>
              <h3>Webhook (for parent replies)</h3>
              <div className="field">
                Callback URL
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <div className="code grow">{webhook}</div>
                  <button type="button" className="btn ghost small" onClick={() => navigator.clipboard?.writeText(webhook)}><Icon name="copy" /> Copy</button>
                </div>
              </div>
              <div className="grid2">
                <label className="field">Verify token<input className="input" value={f.verifyToken} onChange={(e) => setF({ ...f, verifyToken: e.target.value })} placeholder="any phrase; paste the same in Meta" /></label>
                <label className="field">App secret<input className="input" type="password" value={f.appSecret} onChange={(e) => setF({ ...f, appSecret: e.target.value })} placeholder={data.appSecret ? '•••••• saved' : 'required: replies are rejected without it'} autoComplete="off" /><span className="hint">From Meta App settings → Basic. Parent replies are only accepted when signed with it. Stored encrypted.</span></label>
              </div>
            </div>
          </details>
          <div className="row">
            <button className="btn primary">Save</button>
            {info.mode === 'whatsapp' && <button type="button" className="btn ghost" style={{ color: 'var(--red)' }} onClick={disconnect}>Disconnect</button>}
          </div>
        </form>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ plan & billing
const STATE_TEXT = { ok: 'Paid', trial: 'Free trial', due: 'Payment due', readonly: 'Overdue', lapsed: 'Paused' };
const day = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');

function Meter({ label, used, cap, hint }) {
  const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return (
    <div>
      <div className="row between"><span>{label}</span><b className="num">{used}{cap ? ` / ${cap}` : ''}</b></div>
      {cap ? <div className={`bar ${pct >= 100 ? 'bad' : pct >= 85 ? 'warn' : ''}`} style={{ marginTop: 6 }}><span style={{ width: `${pct}%` }} /></div> : null}
      {hint && <div className="muted small" style={{ marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function Billing() {
  const { slug } = useApp();
  const { data: b } = useData('/billing');
  if (!b) return <Loading />;
  const tone = b.state === 'ok' ? 'ok' : b.state === 'trial' ? '' : b.state === 'due' ? 'warn' : 'bad';
  return (
    <div className="stack">
      <section className="card stack">
        <div className="row between">
          <div>
            <h2>{b.planName} plan</h2>
            <p className="muted small">
              {b.price ? `₹${b.price.toLocaleString('en-IN')} ${b.cycle === 'yearly' ? 'a year' : 'a month'} + GST` : b.plan === 'trial' ? 'Free for 30 days' : ''}
              {b.paidUntil ? ` · ${b.state === 'trial' ? 'trial ends' : 'paid until'} ${day(b.paidUntil)}` : ''}
            </p>
          </div>
          <span className={`chip ${tone}`}>{STATE_TEXT[b.state]}</span>
        </div>
        {b.paymentLink && b.state !== 'trial' && <div><a className="btn primary" href={b.paymentLink} target="_blank" rel="noreferrer">Pay now</a></div>}
        <p className="muted small">To change plan, contact your provider. Taking attendance, WhatsApp alerts, replies and call lists are never limited by the plan.</p>
      </section>
      <section className="card stack">
        <h2>This month</h2>
        <Meter label="Students" used={b.usage.students} cap={b.limits.students} hint={b.limits.students && b.usage.students >= b.limits.students ? 'Plan limit reached: new students can’t be added.' : null} />
        <Meter label="Team logins" used={b.usage.logins} cap={b.limits.logins} />
        <Meter label="WhatsApp alerts" used={b.usage.alertsMonth} cap={b.usage.fairUseAlerts || null} hint={`Included: about ${4} alerts per student per month.`} />
        {!b.limits.fullReports && <p className="muted small">Reports cover the last month. Longer reports and CSV downloads come with the Standard plan.</p>}
      </section>
      <section className="card stack">
        <h2>Invoices</h2>
        {b.payments.length ? (
          <ul className="list">
            {b.payments.map((p) => (
              <li key={p.id} className="list-row">
                <span className="grow"><b>{p.invoiceNo}</b><div className="muted small">{day(p.paidAt)} · for {day(p.periodFrom)} – {day(p.periodTo)}</div></span>
                <span className="num">₹{p.total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                <a className="btn ghost small" href={`/api/i/${slug}/billing/invoices/${p.id}`} target="_blank" rel="noreferrer">Download</a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">No invoices yet.</p>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ privacy
const PRIVACY_ACTION = {
  export_family: 'Downloaded a family\'s data',
  export_all: 'Downloaded all institute data',
  erase_student: 'Erased a student',
  retention: 'Automatic clean-up',
};
const ACCESS_ACTION = { student_viewed: 'opened', student_added: 'added', student_edited: 'changed', student_removed: 'removed' };

function Retention({ data, reload }) {
  const { api, toast } = useApp();
  if (!data) return null;
  const s = data.settings;
  const set = async (patch) => {
    try {
      await api.patch('/settings', patch);
      toast('Saved');
      reload();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  const runNow = async () => {
    try {
      const r = await api.post('/privacy/clean-up');
      toast(`Cleaned up: ${r.messages + r.unknown} messages, ${r.students} students, ${r.events} log entries`);
      reload();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  return (
    <section className="card stack">
      <div>
        <h2>How long data is kept</h2>
        <p className="muted small">Old data is deleted automatically once a day. Keep only what you need.</p>
      </div>
      <div className="grid2">
        <label className="field">
          WhatsApp messages
          <select className="select" value={s.retentionMessagesMonths} onChange={(e) => set({ retentionMessagesMonths: Number(e.target.value) })}>
            {[6, 12, 24].map((m) => <option key={m} value={m}>Delete after {m} months</option>)}
          </select>
        </label>
        <label className="field">
          Removed students
          <select className="select" value={s.retentionRemovedMonths} onChange={(e) => set({ retentionRemovedMonths: Number(e.target.value) })}>
            {[6, 12, 24].map((m) => <option key={m} value={m}>Erase {m} months after removal</option>)}
            <option value={0}>Keep until erased by hand</option>
          </select>
        </label>
      </div>
      <p className="muted small">Always: messages from numbers that aren't parents are deleted after 30 days, and the activity log after a year.</p>
      <div><button className="btn ghost small" onClick={runNow}>Clean up now</button></div>
    </section>
  );
}

function Privacy() {
  const { api, slug, toast } = useApp();
  const { data, reload } = useData('/privacy');
  const erase = async (st) => {
    const typed = window.prompt(`Erase ${st.name} for good? Their attendance, alerts and call notes are deleted (and the parent's messages and consent, if no other child uses that number). This can't be undone.\n\nType the student's name to confirm:`);
    if (typed == null) return;
    try {
      await api.post(`/students/${st.id}/erase`, { confirm: typed });
      toast(`${st.name}'s data was erased`);
      reload();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  const eraseAll = async () => {
    const typed = window.prompt(`Erase all ${data.removed.length} removed students for good? This can't be undone.\n\nType ERASE to confirm:`);
    if (typed == null) return;
    try {
      const r = await api.post('/privacy/erase-removed', { confirm: typed });
      toast(`${r.erased} removed student${r.erased === 1 ? '' : 's'} erased`);
      reload();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  return (
    <div className="stack">
      <section className="card stack">
        <div>
          <h2>Your data</h2>
          <p className="muted small">
            Students' and parents' details belong to your institute. Download everything at any time: students, attendance, alerts, WhatsApp messages and consent records, as one file you can keep or take to another system. WhatsApp credentials and PINs are not included.
          </p>
        </div>
        <div><a className="btn primary" href={`/api/i/${slug}/export`} download><Icon name="download" /> Download all data</a></div>
        <p className="muted small">
          For one family (when a parent asks what you hold about them), open the student and use <b>Download family data</b>.
          WhatsApp access tokens are stored encrypted.
        </p>
      </section>

      <section className="card stack">
        <div className="row between">
          <div>
            <h2>Removed students</h2>
            <p className="muted small">Removing a student hides them but keeps their history for reports. Erase it once you no longer need it, for example at the end of the academic year, or when a parent asks.</p>
          </div>
          {data?.removed.length > 1 && <button className="btn ghost" style={{ color: 'var(--red)' }} onClick={eraseAll}>Erase all {data.removed.length}</button>}
        </div>
        {!data ? <Loading /> : data.removed.length ? (
          <ul className="risk-list">
            {data.removed.map((st) => (
              <li key={st.id}>
                <div className="grow">
                  <b className="small">{st.name}</b> <span className="muted small">· {st.batchName} · {st.records} attendance records{st.removedAt ? ` · removed ${fmtDate(st.removedAt.slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</span>
                </div>
                <button className="btn ghost small" style={{ color: 'var(--red)' }} onClick={() => erase(st)}>Erase</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">No removed students are being kept.</p>
        )}
      </section>

      <Retention data={data} reload={reload} />

      <section className="card stack">
        <div>
          <h2>Who looked at student details</h2>
          <p className="muted small">Every time someone opens, adds, changes or removes a student. Kept for a year.</p>
        </div>
        {data?.access.length ? (
          <ul className="list">
            {data.access.slice(0, 30).map((e, i) => (
              <li key={i} className="list-row">
                <span className="grow"><b>{e.actor || '—'}</b> {ACCESS_ACTION[e.type] ?? e.type} {e.studentName ? <a href={`#/students/${e.studentId}`}>{e.studentName}</a> : `student #${e.studentId}`}</span>
                <span className="muted small">{fmtDate(e.at.slice(0, 10), { day: 'numeric', month: 'short' })} {fmtTime(e.at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Nothing yet.</p>
        )}
      </section>

      <section className="card stack">
        <div>
          <h2>Privacy log</h2>
          <p className="muted small">Every download and erasure: who, what and when. Erased students appear by number only.</p>
        </div>
        {data?.log.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
              <tbody>
                {data.log.map((l, i) => (
                  <tr key={i}>
                    <td className="small">{fmtDate(l.at.slice(0, 10), { day: 'numeric', month: 'short' })} {fmtTime(l.at)}</td>
                    <td className="small">{l.actor || '—'}</td>
                    <td className="small">{PRIVACY_ACTION[l.action] ?? l.action}{l.detail ? <div className="muted tiny">{l.detail}</div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted small">Nothing yet.</p>
        )}
        <p className="muted tiny">Backup copies of erased data expire after the backup retention period (30 days by default).</p>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ account
function Account() {
  const save = useSave();
  const { me } = useApp();
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (f.next.length < 6) return setError('PIN must be 6 to 8 digits');
    if (f.next !== f.again) return setError("New PINs don't match");
    const r = await save(() => rootApi.post('/auth/pin', { current: f.current, next: f.next }), 'PIN changed');
    if (r) setF({ current: '', next: '', again: '' });
  };
  const pin = (k) => ({ className: 'input', type: 'password', inputMode: 'numeric', maxLength: 8, value: f[k], onChange: (e) => setF({ ...f, [k]: e.target.value.replace(/\D/g, '') }), required: true });
  return (
    <form className="card stack" onSubmit={submit} style={{ maxWidth: 480 }}>
      <div className="who"><Avatar name={me.user.name} lg /><div><h2>{me.user.name}</h2><div className="muted small">{fmtPhone(me.user.phone)}</div></div></div>
      <h3>Change PIN</h3>
      <label className="field">Current PIN<input {...pin('current')} /></label>
      <div className="grid2">
        <label className="field">New PIN<input {...pin('next')} /></label>
        <label className="field">Repeat new PIN<input {...pin('again')} /></label>
      </div>
      <p className="hint">Use 6 to 8 digits. Avoid 123456, repeated digits or part of your mobile number. Changing it signs you out on your other devices.</p>
      {error && <p className="error-text small">{error}</p>}
      <div><button className="btn primary">Change PIN</button></div>
    </form>
  );
}

export default function Settings() {
  const { route } = useApp();
  const section = SECTIONS.find((s) => s.id === route[0]) ?? SECTIONS[0];
  const View = { general: General, batches: Batches, holidays: Holidays, team: Team, whatsapp: WhatsAppSettings, billing: Billing, privacy: Privacy, account: Account }[section.id];
  return (
    <div>
      <div className="page-head"><div><h1>Settings</h1></div></div>
      <div className="settings">
        <nav className="subnav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#/settings/${s.id}`} className={`nav-item ${s.id === section.id ? 'active' : ''}`}>
              <Icon name={s.icon} /> {s.label}
            </a>
          ))}
        </nav>
        <div style={{ minWidth: 0 }}>
          <View />
        </div>
      </div>
    </div>
  );
}
