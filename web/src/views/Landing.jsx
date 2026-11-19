import { useEffect, useState } from 'react';
import { api, navigate } from '../api.js';
import { BrandMark, Icon } from '../ui.jsx';

function refCode() {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('ref');
    if (fromUrl) sessionStorage.setItem('ref', fromUrl.toUpperCase().slice(0, 16));
    return sessionStorage.getItem('ref');
  } catch {
    return null;
  }
}

const STEPS = [
  { icon: 'check', title: 'The teacher taps who is absent', text: 'Everyone is present by default. Tap Absent, Late or Leave, then Send. Under a minute for a class of 40, in English or Hindi.' },
  { icon: 'chat', title: 'Parents get a WhatsApp in minutes', text: 'With three buttons: on leave, coming late, or "call me". Their answer updates the register by itself.' },
  { icon: 'phone', title: 'No reply? The front desk calls', text: 'Unanswered alerts land on one call list. Log what the parent said with a tap.' },
];

const FAQ = [
  ['Do parents need to install anything?', 'No. Alerts arrive on WhatsApp, which parents already use. They reply with one tap.'],
  ['What about parents who don’t want WhatsApp messages?', 'Only parents who agreed get messages (on the admission form, or by sending START). Anyone can reply STOP, and their absences go to the call list instead.'],
  ['Can teachers use it in Hindi?', 'Yes. The attendance screen switches between English and हिंदी, and you can write the parent message in Hinglish, English or Hindi.'],
  ['Who owns the data?', 'Your institute. Download everything any time, erase a student when a parent asks, and set how long old messages are kept.'],
  ['What if a teacher forgets to send attendance?', 'The front desk sees "not sent by the teacher" on their screen and can send it for them. Parents are never messaged from a half-finished list.'],
];

export default function Landing() {
  const [info, setInfo] = useState(null);
  const [ref] = useState(refCode);

  useEffect(() => {
    api.get('/public/landing').then(setInfo).catch(() => setInfo({ plans: [], brand: 'Attendance Alert' }));
    // Count a partner-link visit once per browser session, only when the code is in the address.
    try {
      const fromUrl = new URLSearchParams(window.location.search).get('ref');
      if (fromUrl && sessionStorage.getItem('refCounted') !== fromUrl.toUpperCase()) {
        sessionStorage.setItem('refCounted', fromUrl.toUpperCase());
        api.post('/public/visit', { ref: fromUrl }).catch(() => {});
      }
    } catch {
      /* storage unavailable: don't count */
    }
  }, [ref]);

  const waText = encodeURIComponent(`Hi, I run a coaching institute and would like a demo of attendance alerts.${ref ? ` (ref ${ref})` : ''}`);
  const waLink = info?.salesWhatsapp ? `https://wa.me/${info.salesWhatsapp}?text=${waText}` : null;
  const cta = (
    <div className="row" style={{ gap: 10 }}>
      {waLink && <a className="btn primary lg" href={waLink} target="_blank" rel="noreferrer"><Icon name="chat" /> Chat with us on WhatsApp</a>}
      {info?.demo && <button className={`btn ${waLink ? 'ghost' : 'primary'} lg`} onClick={() => navigate('/login')}>Try the demo</button>}
      {!waLink && !info?.demo && <button className="btn primary lg" onClick={() => navigate('/login')}>Log in</button>}
    </div>
  );

  return (
    <div className="landing">
      <header className="landing-top">
        <div className="landing-inner row between">
          <div className="row" style={{ gap: 10 }}><BrandMark /><b>{info?.brand ?? 'Attendance Alert'}</b></div>
          <button className="btn ghost" onClick={() => navigate('/login')}>Log in</button>
        </div>
      </header>

      <section className="landing-hero">
        <div className="landing-inner landing-hero-grid">
          <div className="stack">
            <div className="eyebrow">For coaching institutes</div>
            <h1>A student is absent. The parent knows in minutes, not at 6 pm.</h1>
            <p className="lead">
              Teachers mark only who's missing. Parents get a WhatsApp right away and answer with one tap. Anyone who doesn't reply lands on your front desk's call list. Nobody slips through.
            </p>
            {cta}
            {info?.trialDays && <p className="muted small">Free for {info.trialDays} days. No card needed.</p>}
          </div>
          <div className="landing-phone" aria-label="What a parent receives">
            <div className="phone-head"><div className="avatar">BF</div><div><div className="phone-title">Bright Future Classes</div><div className="phone-sub">WhatsApp</div></div></div>
            <div className="phone-body">
              <div className="bubble-wrap out"><div className="bubble out">Namaste Mr. Verma, aaj ki Class 10 · Batch B class (4:00 PM) mein Rohan ki attendance record nahi hui. Please confirm.<div className="bubble-time">4:10 PM</div></div>
                <div className="bubble-buttons"><button disabled>↩ Leave</button><button disabled>↩ Late 15 min</button><button disabled>↩ Mujhe call karein</button></div>
              </div>
              <div className="bubble-wrap in"><div className="bubble in">Leave<div className="bubble-time">4:11 PM</div></div></div>
              <div className="bubble-wrap out"><div className="bubble out">Thank you. Noted: Leave.<div className="bubble-time">4:11 PM</div></div></div>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-inner">
          <h2>How it works</h2>
          <div className="landing-cards three">
            {STEPS.map((s, i) => (
              <div key={s.title} className="card stack tight">
                <div className="landing-step"><Icon name={s.icon} /> Step {i + 1}</div>
                <h3>{s.title}</h3>
                <p className="muted">{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-section alt">
        <div className="landing-inner landing-cards two">
          <div className="stack tight">
            <h2>For the owner</h2>
            <ul className="landing-list">
              <li>One line each evening: classes taken, parents told, calls left.</li>
              <li>Which students keep missing class, before the parent finds out from the results.</li>
              <li>Reports by batch and student, for parent–teacher meetings.</li>
            </ul>
          </div>
          <div className="stack tight">
            <h2>For the front desk</h2>
            <ul className="landing-list">
              <li>A "Today" list: who to call, who hasn't replied yet, which class isn't in.</li>
              <li>Tap to call, then one tap to note what the parent said.</li>
              <li>"Mujhe call karein" from a parent goes to the top in red.</li>
            </ul>
          </div>
        </div>
      </section>

      {info?.plans?.length > 0 && (
        <section className="landing-section">
          <div className="landing-inner">
            <h2>Simple prices</h2>
            <p className="muted">Per institute, plus GST. WhatsApp messages included for normal use. A year costs ten months.</p>
            <div className="landing-cards three">
              {info.plans.map((p) => (
                <div key={p.id} className={`card stack tight ${p.id === 'standard' ? 'landing-featured' : ''}`}>
                  <h3>{p.name}</h3>
                  <div className="landing-price">₹{p.monthly.toLocaleString('en-IN')}<span className="muted small"> / month</span></div>
                  <ul className="landing-list small">
                    <li>Up to {p.students.toLocaleString('en-IN')} students</li>
                    <li>{p.logins} staff logins</li>
                    <li>{p.fullReports ? 'Full reports and CSV export' : 'Reports for the last month'}</li>
                    <li>WhatsApp alerts, replies and call list</li>
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="landing-section alt">
        <div className="landing-inner">
          <h2>Questions</h2>
          <div className="stack tight">
            {FAQ.map(([q, a]) => (
              <details key={q} className="card landing-faq">
                <summary>{q}</summary>
                <p className="muted">{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-inner stack" style={{ alignItems: 'flex-start' }}>
          <h2>See it with your own batch</h2>
          <p className="muted">We'll set it up with your batches and send a test alert to your phone.</p>
          {cta}
        </div>
      </section>
      <footer className="landing-foot"><div className="landing-inner muted small">© {new Date().getFullYear()} {info?.brand ?? 'Attendance Alert'}</div></footer>
    </div>
  );
}
