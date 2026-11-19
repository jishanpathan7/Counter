import { useEffect, useRef, useState } from 'react';
import { api as rootApi, fmtAgo, fmtDate, fmtPhone, fmtTime24, useApp, useData } from '../api.js';
import { Avatar, Empty, Icon, Loading, Modal } from '../ui.jsx';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SECTIONS = [
  { id: 'general', label: 'General', icon: 'gear' },
  { id: 'batches', label: 'Batches', icon: 'calendar' },
  { id: 'holidays', label: 'Holidays', icon: 'sun' },
  { id: 'team', label: 'Team', icon: 'users' },
  { id: 'whatsapp', label: 'WhatsApp & message', icon: 'chat' },
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
  const { api } = useApp();
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
            Verify absentees after (minutes)
            <input className="input" type="number" min="0" max="240" step="any" value={f.verifyAfterMinutes} onChange={set('verifyAfterMinutes')} />
            <span className="hint">From class start, once the teacher has sent the list. Unsent classes never alert parents.</span>
          </label>
          <label className="field">
            Call task if no reply in (minutes)
            <input className="input" type="number" min="0" max="240" step="any" value={f.replyTimeoutMinutes} onChange={set('replyTimeoutMinutes')} />
            <span className="hint">Step 6: then it lands on the call list</span>
          </label>
        </div>
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
        <p className="muted small">Tip for demos: set both timers to 0.5 and use “Start class now” on the dashboard.</p>
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
          <input className="input" inputMode="numeric" maxLength={8} value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} required={isNew} placeholder={isNew ? '4–8 digits' : 'Leave blank to keep'} />
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
          <p className="muted small">With an approved Meta template, WhatsApp shows the template's own wording instead; this text is used in the simulator and for interactive messages.</p>
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
    const body = { phoneNumberId: f.phoneNumberId, template: f.template, templateLang: f.templateLang, verifyToken: f.verifyToken };
    if (f.token) body.token = f.token;
    if (f.appSecret) body.appSecret = f.appSecret;
    save(() => api.patch('/whatsapp', body), 'WhatsApp settings saved').then((r) => r && setF({ ...r, token: '', appSecret: '' }));
  };
  const disconnect = () => {
    if (window.confirm('Disconnect WhatsApp? Messages will go to the simulator.')) save(() => api.patch('/whatsapp', { token: '', phoneNumberId: '' }), 'Disconnected').then((r) => r && setF({ ...r, token: '', appSecret: '' }));
  };
  return (
    <div className="stack">
      <MessageEditor />
      {!f ? <Loading /> : (
        <form className="card stack" onSubmit={submit}>
          <div className="row between">
            <div>
              <h2>WhatsApp Cloud API</h2>
              <p className="muted small">Connect your institute's WhatsApp Business number from Meta. Until then, messages go to the simulator.</p>
            </div>
            <span className={`chip ${info.mode === 'whatsapp' ? 'ok' : 'warn'}`}>{info.mode === 'whatsapp' ? 'Connected' : 'Simulator'}</span>
          </div>
          <div className="grid2">
            <label className="field">Phone number ID<input className="input" value={f.phoneNumberId} onChange={(e) => setF({ ...f, phoneNumberId: e.target.value })} placeholder="from WhatsApp → API setup" /></label>
            <label className="field">
              Access token
              <input className="input" type="password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} placeholder={data.token ? '•••••• saved (type to replace)' : 'Permanent access token'} autoComplete="off" />
            </label>
          </div>
          <div className="grid2">
            <label className="field">Template name<input className="input" value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })} placeholder="attendance_alert" /><span className="hint">Approved template with Leave / Late 15 min quick replies</span></label>
            <label className="field">Template language<input className="input" value={f.templateLang} onChange={(e) => setF({ ...f, templateLang: e.target.value })} placeholder="en" /></label>
          </div>
          <div className="divider" />
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
            <label className="field">App secret<input className="input" type="password" value={f.appSecret} onChange={(e) => setF({ ...f, appSecret: e.target.value })} placeholder={data.appSecret ? '•••••• saved' : 'required: replies are rejected without it'} autoComplete="off" /><span className="hint">From Meta App settings → Basic. Parent replies are only accepted when signed with it.</span></label>
          </div>
          <div className="row">
            <button className="btn primary">Save</button>
            {info.mode === 'whatsapp' && <button type="button" className="btn ghost" style={{ color: 'var(--red)' }} onClick={disconnect}>Disconnect</button>}
          </div>
        </form>
      )}
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
      {error && <p className="error-text small">{error}</p>}
      <div><button className="btn primary">Change PIN</button></div>
    </form>
  );
}

export default function Settings() {
  const { route } = useApp();
  const section = SECTIONS.find((s) => s.id === route[0]) ?? SECTIONS[0];
  const View = { general: General, batches: Batches, holidays: Holidays, team: Team, whatsapp: WhatsAppSettings, account: Account }[section.id];
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
