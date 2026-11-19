import { useState } from 'react';
import { api, navigate } from '../api.js';
import { BrandMark, Icon } from '../ui.jsx';

function Hero() {
  return (
    <section className="auth-hero">
      <div className="row" style={{ gap: 12 }}>
        <div className="brand-mark" style={{ background: '#fff', color: 'var(--green)' }}><Icon name="check" /></div>
        <b style={{ fontSize: 18 }}>Attendance Alert</b>
      </div>
      <div className="stack">
        <h1>
          Absent? Parents know by <mark>4:12</mark>, not 6:05.
        </h1>
        <p>
          Teachers mark attendance on their phone. Parents of absent students get a WhatsApp in minutes, reply with
          one tap, and the register updates itself. No reply? Your front desk gets a call task.
        </p>
      </div>
      <div className="hero-steps">
        <div className="hero-step"><b>10 min</b>after class starts, absentees are verified</div>
        <div className="hero-step"><b>1 tap</b>for parents: “Leave” or “Late 15 min”</div>
        <div className="hero-step"><b>0</b>students slipping through the gap</div>
      </div>
    </section>
  );
}

export function Login({ demo, onDone }) {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e, p = phone, k = pin) => {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/login', { phone: p, pin: k });
      await onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <Hero />
      <section className="auth-panel">
        <form className="auth-card" onSubmit={submit}>
          <h1>Log in</h1>
          <p className="muted" style={{ marginTop: -8 }}>Use your mobile number and PIN.</p>
          <label className="field">
            Mobile number
            <input className="input" inputMode="tel" autoComplete="username" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" autoFocus />
          </label>
          <label className="field">
            PIN
            <input className="input" type="password" inputMode="numeric" autoComplete="current-password" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="••••" />
          </label>
          {error && <p className="error-text small" role="alert">{error}</p>}
          <button className="btn primary block" disabled={busy || !phone || pin.length < 4}>{busy ? 'Logging in…' : 'Log in'}</button>
          <p className="muted small">Forgot your PIN? Ask your institute owner to reset it from Settings → Team.</p>

          {demo && (
            <div className="demo-box">
              <div className="row between">
                <b className="small">Demo accounts</b>
                <span className="tiny muted">PIN {demo.pin}</span>
              </div>
              {demo.ephemeral && <p className="tiny muted" style={{ margin: '6px 0 0' }}>Demo server: changes you make reset from time to time.</p>}
              <div className="demo-logins">
                {demo.logins.map((l) => (
                  <button key={l.phone} type="button" onClick={() => { setPhone(l.phone); setPin(demo.pin); submit(null, l.phone, demo.pin); }}>
                    <b>{l.role}</b>
                    <span className="muted">{l.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </form>
      </section>
    </div>
  );
}

export function SetupWizard({ onDone, setupCodeRequired }) {
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ name: '', phone: '', pin: '', pin2: '', instituteName: '', city: '', setupCode: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const next = (e) => {
    e.preventDefault();
    setError('');
    if (f.pin.length < 4) return setError('PIN must be at least 4 digits');
    if (f.pin !== f.pin2) return setError("PINs don't match");
    setStep(1);
  };
  const finish = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/setup', { name: f.name, phone: f.phone, pin: f.pin, instituteName: f.instituteName, city: f.city, setupCode: f.setupCode });
      await onDone();
      navigate(`/i/${r.institute.slug}/#/settings`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <Hero />
      <section className="auth-panel">
        <div className="auth-card">
          <div className="steps-dots"><i className="on" /><i className={step ? 'on' : ''} /></div>
          {step === 0 ? (
            <form className="stack" onSubmit={next}>
              <div>
                <div className="eyebrow">Step 1 of 2</div>
                <h1>Create your account</h1>
                <p className="muted">You'll be the admin. You can add institutes, owners, teachers and front-desk staff later.</p>
              </div>
              <label className="field">Your name<input className="input" value={f.name} onChange={set('name')} required autoFocus /></label>
              <label className="field">Mobile number<input className="input" inputMode="tel" value={f.phone} onChange={set('phone')} required placeholder="98765 43210" /></label>
              <div className="grid2">
                <label className="field">PIN (4–8 digits)<input className="input" type="password" inputMode="numeric" maxLength={8} value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} required /></label>
                <label className="field">Repeat PIN<input className="input" type="password" inputMode="numeric" maxLength={8} value={f.pin2} onChange={(e) => setF({ ...f, pin2: e.target.value.replace(/\D/g, '') })} required /></label>
              </div>
              {error && <p className="error-text small">{error}</p>}
              <button className="btn primary block">Continue</button>
            </form>
          ) : (
            <form className="stack" onSubmit={finish}>
              <div>
                <div className="eyebrow">Step 2 of 2</div>
                <h1>Your first institute</h1>
                <p className="muted">Next you'll add batches and students.</p>
              </div>
              <label className="field">Institute name<input className="input" value={f.instituteName} onChange={set('instituteName')} required autoFocus placeholder="e.g. Bright Future Classes" /></label>
              <label className="field">City<input className="input" value={f.city} onChange={set('city')} placeholder="Optional" /></label>
              {setupCodeRequired && (
                <label className="field">
                  Setup code
                  <input className="input" value={f.setupCode} onChange={set('setupCode')} required autoComplete="off" />
                  <span className="hint">Printed in the server log when it starts, or the SETUP_TOKEN you configured.</span>
                </label>
              )}
              {error && <p className="error-text small">{error}</p>}
              <div className="row">
                <button type="button" className="btn ghost" onClick={() => setStep(0)}>Back</button>
                <button className="btn primary grow" disabled={busy}>{busy ? 'Setting up…' : 'Create institute'}</button>
              </div>
            </form>
          )}
          <div className="row muted small"><BrandMark /> You can add more institutes and people later.</div>
        </div>
      </section>
    </div>
  );
}
