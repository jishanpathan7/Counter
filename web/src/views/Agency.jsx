import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney, navigate } from '../api.js';
import { Sparkline } from '../charts.jsx';
import { BrandMark, Empty, Icon, Kpi, Loading, Modal, PctBar } from '../ui.jsx';

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function NewInstitute({ onClose, onDone, toast }) {
  const [f, setF] = useState({ name: '', slug: '', city: '', feeMonthly: 0, ownerName: '', ownerPhone: '', ownerPin: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value, ...(k === 'name' && !slugTouched ? { slug: slugify(e.target.value) } : {}) });
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/agency/institutes', { ...f, feeMonthly: Number(f.feeMonthly) });
      toast(`${r.name} is ready`);
      onDone(r);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Add an institute" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="grid2">
          <label className="field">Institute name<input className="input" value={f.name} onChange={set('name')} required autoFocus /></label>
          <label className="field">City<input className="input" value={f.city} onChange={set('city')} /></label>
        </div>
        <div className="grid2">
          <label className="field">
            Web address
            <input className="input" value={f.slug} onChange={(e) => { setSlugTouched(true); setF({ ...f, slug: slugify(e.target.value) }); }} required />
            <span className="hint">/i/{f.slug || 'name'}</span>
          </label>
          <div className="field">
            Plan
            <span className="hint" style={{ marginTop: 6 }}>Starts with a 30-day free trial (up to 100 students). Choose a plan afterwards from the institute's card.</span>
          </div>
        </div>
        <div className="divider" />
        <div>
          <b>Owner login</b>
          <p className="muted small">The coaching owner logs in with this number and PIN. Leave blank to manage it yourself for now.</p>
        </div>
        <div className="grid3">
          <label className="field">Owner name<input className="input" value={f.ownerName} onChange={set('ownerName')} /></label>
          <label className="field">Mobile<input className="input" inputMode="tel" value={f.ownerPhone} onChange={set('ownerPhone')} /></label>
          <label className="field">PIN (6–8 digits)<input className="input" inputMode="numeric" maxLength={8} value={f.ownerPin} onChange={(e) => setF({ ...f, ownerPin: e.target.value.replace(/\D/g, '') })} /></label>
        </div>
        {error && <p className="error-text small">{error}</p>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create institute'}</button>
        </div>
      </form>
    </Modal>
  );
}

export const BILL_LABEL = { ok: 'Paid', trial: 'Trial', due: 'Payment due', readonly: 'Overdue: read-only', lapsed: 'Paused: unpaid' };
export const billTone = (st) => (st === 'ok' ? 'ok' : st === 'trial' ? '' : st === 'due' ? 'warn' : 'bad');
const fmtDay = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

/** Plan, paid-until, payment link, the institute's invoice details, and payments with invoices. */
function BillingPanel({ inst, onClose, onDone, toast }) {
  const [b, setB] = useState(null);
  const [f, setF] = useState(null);
  const [pay, setPay] = useState({ amount: '', method: 'UPI', reference: '', paidAt: '' });
  const [error, setError] = useState('');
  const load = useCallback(
    () =>
      api.get(`/agency/institutes/${inst.slug}/billing`).then((r) => {
        setB(r);
        setF({ plan: r.plan, cycle: r.cycle, paidUntil: r.paidUntil ?? '', paymentLink: inst.paymentLink ?? '', feeMonthly: inst.feeMonthly, ...r.buyer });
      }),
    [inst.slug, inst.paymentLink, inst.feeMonthly],
  );
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.patch(`/agency/institutes/${inst.slug}/billing`, { ...f, feeMonthly: Number(f.feeMonthly) || 0 });
      toast('Billing saved');
      await load();
      onDone();
    } catch (err) {
      setError(err.message);
    }
  };
  const record = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api.post(`/agency/institutes/${inst.slug}/payments`, { ...pay, amount: pay.amount === '' ? undefined : Number(pay.amount) });
      toast(`Payment recorded: invoice ${r.invoiceNo}, paid until ${fmtDay(r.paidUntil)}`);
      setPay({ amount: '', method: 'UPI', reference: '', paidAt: '' });
      await load();
      onDone();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <Modal title={`${inst.name}: plan & billing`} onClose={onClose} wide>
      {!b || !f ? (
        error ? <p className="error-text">{error}</p> : <p className="muted">Loading…</p>
      ) : (
        <div className="stack">
          <div className="row" style={{ gap: 8 }}>
            <span className={`chip ${billTone(b.state)}`}>{BILL_LABEL[b.state]}</span>
            <span className="muted small">
              {b.paidUntil ? `${b.state === 'trial' ? 'Trial ends' : 'Paid until'} ${fmtDay(b.paidUntil)}${b.daysLate ? ` · ${b.daysLate} days late` : ''}` : 'No due date'} · {b.usage.students} students · {b.usage.alertsMonth} alerts this month (fair use {b.usage.fairUseAlerts})
            </span>
          </div>
          <form className="stack" onSubmit={save}>
            <div className="grid2">
              <label className="field">
                Plan
                <select className="select" value={f.plan} onChange={set('plan')}>
                  <option value="trial">Trial (30 days, free)</option>
                  {b.plans.map((p) => <option key={p.id} value={p.id}>{p.name}: ₹{p.monthly.toLocaleString('en-IN')}/month, up to {p.students} students</option>)}
                  <option value="custom">Custom (agreed fee, no limits)</option>
                </select>
              </label>
              <label className="field">
                Billing
                <select className="select" value={f.cycle} onChange={set('cycle')}>
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly (10 months' price)</option>
                </select>
              </label>
            </div>
            <div className="grid2">
              {f.plan === 'custom' && <label className="field">Agreed monthly fee (₹, before GST)<input className="input" type="number" min="0" step="1" value={f.feeMonthly} onChange={set('feeMonthly')} /></label>}
              <label className="field">Paid until<input className="input" type="date" value={f.paidUntil ?? ''} onChange={set('paidUntil')} /><span className="hint">Leave empty for no due date. Recording a payment moves it on.</span></label>
              <label className="field">Payment link<input className="input" value={f.paymentLink ?? ''} onChange={set('paymentLink')} placeholder="https://rzp.io/… or upi://pay?…" /><span className="hint">Empty: owners get a UPI link from your UPI ID, if set.</span></label>
            </div>
            <h3>Their invoice details</h3>
            <div className="grid2">
              <label className="field">Legal name<input className="input" value={f.legalName ?? ''} onChange={set('legalName')} placeholder={inst.name} /></label>
              <label className="field">GSTIN (if registered)<input className="input" value={f.gstin ?? ''} onChange={set('gstin')} /></label>
              <label className="field">State<input className="input" value={f.state ?? ''} onChange={set('state')} placeholder="e.g. Madhya Pradesh" /><span className="hint">Same state as yours: CGST + SGST. Otherwise IGST.</span></label>
              <label className="field">Address<input className="input" value={f.address ?? ''} onChange={set('address')} /></label>
            </div>
            <div><button className="btn primary">Save</button></div>
          </form>
          <div className="divider" />
          <form className="stack" onSubmit={record}>
            <h3>Record a payment</h3>
            <div className="grid2">
              <label className="field">Amount before GST (₹)<input className="input" type="number" min="1" step="any" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} placeholder={String(b.price ?? '')} /></label>
              <label className="field">Paid on<input className="input" type="date" value={pay.paidAt} onChange={(e) => setPay({ ...pay, paidAt: e.target.value })} /></label>
              <label className="field">Method<input className="input" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })} /></label>
              <label className="field">Reference (UTR / transaction ID)<input className="input" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></label>
            </div>
            <div><button className="btn" disabled={f.plan === 'trial'}>Record payment and make invoice</button></div>
          </form>
          {b.payments.length > 0 && (
            <ul className="list card flush">
              {b.payments.map((p) => (
                <li key={p.id} className="list-row">
                  <span className="grow"><b>{p.invoiceNo}</b><div className="muted small">{fmtDay(p.paidAt)} · {fmtDay(p.periodFrom)} – {fmtDay(p.periodTo)} · {p.method}</div></span>
                  <span className="num">₹{p.total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  <a className="btn ghost small" href={`/api/agency/payments/${p.id}/invoice`} target="_blank" rel="noreferrer">Invoice</a>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="error-text small">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

/** The agency's own details printed on invoices. */
function BillingProfile({ onClose, toast }) {
  const [f, setF] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get('/agency/billing-profile').then(setF).catch((e) => setError(e.message));
  }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    try {
      setF(await api.put('/agency/billing-profile', f));
      toast('Saved');
      onClose();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <Modal title="Your invoice details" onClose={onClose}>
      {!f ? <p className="muted">Loading…</p> : (
        <form className="stack" onSubmit={save}>
          <label className="field">Legal / business name<input className="input" value={f.legalName} onChange={set('legalName')} required /></label>
          <label className="field">Address<input className="input" value={f.address} onChange={set('address')} /></label>
          <div className="grid2">
            <label className="field">GSTIN<input className="input" value={f.gstin} onChange={set('gstin')} /><span className="hint">Leave empty if you aren't registered: invoices then carry no GST.</span></label>
            <label className="field">State<input className="input" value={f.state} onChange={set('state')} /></label>
            <label className="field">SAC code<input className="input" value={f.sac} onChange={set('sac')} /><span className="hint">The service code for your invoices. Confirm it with your CA.</span></label>
            <label className="field">Invoice prefix<input className="input" value={f.invoicePrefix} onChange={set('invoicePrefix')} /></label>
            <label className="field">UPI ID<input className="input" value={f.upiId} onChange={set('upiId')} placeholder="yourname@okaxis" /><span className="hint">For pay-by-UPI links when an institute has no payment link.</span></label>
          </div>
          {error && <p className="error-text small">{error}</p>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary">Save</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export default function Agency({ me, logout, theme, toast }) {
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [profile, setProfile] = useState(false);
  const load = useCallback(() => api.get('/agency/overview').then(setData).catch((e) => toast(e.message, 'bad')), [toast]);
  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (i) => {
    const status = i.status === 'active' ? 'paused' : 'active';
    if (status === 'paused' && !window.confirm(`Pause ${i.name}? Their team can't log in and no WhatsApp alerts go out until you resume.`)) return;
    await api.patch(`/agency/institutes/${i.slug}`, { status });
    toast(`${i.name} ${status === 'paused' ? 'paused' : 'resumed'}`);
    load();
  };

  const remove = async (i) => {
    const typed = window.prompt(
      `Delete ${i.name} for good?\n\nThis deletes all their students, attendance, WhatsApp messages and consent records, and the logins of team members who use no other institute. It can't be undone. Backup copies expire after the retention period (30 days).\n\nDownload their data first if they want it: open the institute → Settings → Privacy & data.\n\nType ${i.slug} to confirm:`,
    );
    if (typed == null) return;
    try {
      const r = await api.post(`/agency/institutes/${i.slug}/delete`, { confirm: typed.trim() });
      toast(`${i.name} deleted (${r.accounts} team login${r.accounts === 1 ? '' : 's'} removed)`);
      load();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  const t = data?.totals;
  return (
    <div style={{ minHeight: '100vh' }}>
      <header className="agency-top">
        <div className="inner">
          <BrandMark />
          <div className="grow">
            <div className="brand-name">Agency console</div>
            <div className="tiny muted">{me.user.name}</div>
          </div>
          <button className="x" onClick={theme.toggle} aria-label="Toggle dark mode"><Icon name={theme.isDark ? 'sun' : 'moon'} /></button>
          <button className="btn ghost small" onClick={logout}><Icon name="logout" /> <span className="hide-sm">Log out</span></button>
        </div>
      </header>
      <main className="main stack">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div>
            <h1>Your institutes</h1>
            <p className="muted">Build once, set up for every institute. Each one gets its own team, students and WhatsApp number.</p>
          </div>
          <div className="row">
            <button className="btn ghost" onClick={() => setProfile(true)}>Invoice details</button>
            <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" /> Add institute</button>
          </div>
        </div>

        {!data ? (
          <Loading height={260} />
        ) : (
          <>
            <div className="kpis">
              <div className="kpi" style={{ gridColumn: 'span 2', background: 'var(--green-fill)', borderColor: 'var(--green-fill)' }}>
                <div className="mrr" style={{ color: '#fff' }}>{fmtMoney(t.mrr)}</div>
                <div className="kpi-label" style={{ color: 'rgba(255,255,255,.85)' }}>Monthly recurring revenue · {fmtMoney(t.mrr * 12)} a year</div>
              </div>
              <Kpi label="Active institutes" value={`${t.active}/${t.institutes}`} hint={`${t.activeThisWeek} sent classes this week`} />
              <Kpi label="Students covered" value={t.students} />
              <Kpi label="WhatsApp alerts this month" value={t.alertsMonth} tone="ok" />
            </div>

            {data.institutes.length ? (
              <div className="inst-grid">
                {data.institutes.map((i) => (
                  <article key={i.slug} className={`card inst-card ${i.status === 'paused' ? 'paused' : ''}`}>
                    <div className="session-head">
                      <div className="grow">
                        <h2 className="ellipsis">{i.name}</h2>
                        <div className="muted small">{i.city || '—'} · /i/{i.slug}</div>
                      </div>
                      <span className={`chip ${i.status === 'active' ? 'ok' : 'warn'}`}>{i.status}</span>
                    </div>
                    <div className="row between">
                      <div>
                        <div className="eyebrow">Attendance · last 7 days</div>
                        <div style={{ width: 160, marginTop: 4 }}><PctBar pct={i.weekPct} /></div>
                      </div>
                      <Sparkline values={i.weekTrend} />
                    </div>
                    <div className="inst-stats">
                      <div><b>{i.students}</b><span>students</span></div>
                      <div><b>{i.alertsMonth}</b><span>alerts / month</span></div>
                      <div><b className={i.loopWeek?.coveredPct != null && i.loopWeek.coveredPct < 90 ? 's-A' : ''}>{i.loopWeek?.coveredPct ?? '–'}{i.loopWeek?.coveredPct != null ? '%' : ''}</b><span>absences covered (7 d)</span></div>
                    </div>
                    <div className="row small muted">
                      <span>Today: <b className="s-P">{i.today.present}</b> present · <b className="s-A">{i.today.absent}</b> absent</span>
                      {i.today.openTasks > 0 && <span className="chip bad">{i.today.openTasks} calls pending</span>}
                      <span className={`chip ${i.whatsapp === 'whatsapp' ? 'ok' : ''}`}>{i.whatsapp === 'whatsapp' ? 'WhatsApp live' : 'Practice mode'}</span>
                    </div>
                    <div className="row between" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
                      <button className="link" onClick={() => setEditing(i)}>
                        {i.plan === 'trial' ? 'Trial' : `${fmtMoney(i.feeMonthly)}/month`} · <span className={`s-${billTone(i.billing.state) === 'bad' ? 'A' : billTone(i.billing.state) === 'warn' ? 'T' : 'P'}`}>{BILL_LABEL[i.billing.state]}</span>
                      </button>
                      <div className="row">
                        <button className="btn ghost small" onClick={() => toggle(i)}>
                          <Icon name={i.status === 'active' ? 'pause' : 'play'} /> {i.status === 'active' ? 'Pause' : 'Resume'}
                        </button>
                        {i.status === 'paused' && <button className="btn ghost small" style={{ color: 'var(--red)' }} onClick={() => remove(i)}><Icon name="trash" /> Delete</button>}
                        <button className="btn small" onClick={() => navigate(`/i/${i.slug}/`)}>Open <Icon name="arrow" /></button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <Empty title="No institutes yet" icon="building">Add your first coaching institute to get started.</Empty>
            )}
          </>
        )}
      </main>
      {adding && <NewInstitute toast={toast} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {editing && <BillingPanel inst={editing} toast={toast} onClose={() => setEditing(null)} onDone={load} />}
      {profile && <BillingProfile toast={toast} onClose={() => setProfile(false)} />}
    </div>
  );
}
