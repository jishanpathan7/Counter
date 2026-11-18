import { REPLY_OPTIONS, TASK_OUTCOMES } from './service.js';
import { addDays, zonedTimeToIso } from './time.js';

export const DEMO_PIN = '1234';
export const DEMO_LOGINS = [
  { role: 'Agency admin', name: 'Agency Admin', phone: '9999900000' },
  { role: 'Institute owner', name: 'Rakesh Sharma', phone: '9999900001' },
  { role: 'Front desk', name: 'Pooja Desai', phone: '9999900002' },
  { role: 'Teacher', name: 'Anil Sir', phone: '9999900003' },
];

/** Deterministic random numbers so the demo looks the same every time. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MON_SAT = [1, 2, 3, 4, 5, 6];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

const BRIGHT_FUTURE = [
  {
    name: 'Class 10 · Batch A', startTime: '07:00', days: MON_SAT, duration: 90,
    students: [['Kabir', 'Khan', 0.62], ['Ananya', 'Gupta', 0.95], ['Ishaan', 'Patel', 0.9], ['Sara', 'Ali', 0.88], ['Vihaan', 'Joshi', 0.93], ['Myra', 'Kapoor', 0.97], ['Arjun', 'Reddy', 0.85]],
  },
  {
    name: 'Class 10 · Batch B', startTime: '16:00', days: EVERY_DAY, duration: 120,
    students: [['Aarav', 'Sharma', 0.96], ['Diya', 'Iyer', 0.94], ['Rohan', 'Verma', 0.7], ['Meera', 'Nair', 0.86], ['Advait', 'Kulkarni', 0.92], ['Anika', 'Bose', 0.9], ['Reyansh', 'Mehta', 0.8], ['Tara', 'Singh', 0.95]],
  },
  {
    name: 'Class 12 · JEE', startTime: '18:00', days: MON_SAT, duration: 120,
    students: [['Aditya', 'Rao', 0.91], ['Kavya', 'Menon', 0.97], ['Yash', 'Agarwal', 0.66], ['Nisha', 'Pillai', 0.9], ['Dev', 'Malhotra', 0.87], ['Riya', 'Chauhan', 0.93]],
  },
];

const EXCEL = [
  {
    name: 'Class 9 · Morning', startTime: '08:00', days: MON_SAT, duration: 90,
    students: [['Pranav', 'Jain', 0.9], ['Ira', 'Saxena', 0.94], ['Om', 'Tiwari', 0.72], ['Siya', 'Dubey', 0.92], ['Krish', 'Yadav', 0.88]],
  },
  {
    name: 'NEET Foundation', startTime: '17:30', days: MON_SAT, duration: 120,
    students: [['Avni', 'Mishra', 0.95], ['Laksh', 'Pandey', 0.83], ['Zoya', 'Qureshi', 0.91], ['Rudra', 'Thakur', 0.78]],
  },
];

const TOPPERS = [
  { name: 'Class 11 · Science', startTime: '15:00', days: MON_SAT, duration: 120, students: [['Neel', 'Bhatt', 0.9], ['Aisha', 'Sheikh', 0.93], ['Parth', 'Shah', 0.86]] },
];

let phoneSeq = 10000;
const nextPhone = () => `90000${String(++phoneSeq).padStart(5, '0')}`;

function addBatches(svc, defs) {
  const rates = new Map();
  const batches = defs.map((d) => {
    const b = svc.createBatch({ name: d.name, startTime: d.startTime, days: d.days, durationMinutes: d.duration });
    for (const [first, last, rate, mother] of d.students) {
      const parent = mother ?? (phoneSeq % 3 === 0 ? `Mrs. ${last}` : `Mr. ${last}`);
      const st = svc.createStudent({ batchId: b.id, name: `${first} ${last}`, parentName: parent, parentPhone: nextPhone() });
      rates.set(st.id, rate);
    }
    return b;
  });
  return { batches, rates };
}

/**
 * Fill past classes with realistic attendance, WhatsApp alerts, replies and call outcomes.
 * Today's classes that have not finished yet are left alone so the live flow can be tried.
 */
function generateHistory(svc, { days, rates, seed, holidays = [], liveToday = [] }) {
  const rand = rng(seed);
  const pick = (weights) => {
    const total = weights.reduce((s, [, w]) => s + w, 0);
    let r = rand() * total;
    for (const [v, w] of weights) if ((r -= w) <= 0) return v;
    return weights[0][0];
  };
  const today = svc.today();
  const now = svc.now();
  for (const [offset, label] of holidays) svc.addHoliday({ date: addDays(today, offset), label });
  const holidaySet = new Set(svc.listHolidays().map((h) => h.date));
  const iso = (ms) => new Date(ms).toISOString();
  const db = svc.db;
  const batches = db.prepare('SELECT * FROM batches WHERE active = 1').all();
  const studentsOf = db.prepare('SELECT * FROM students WHERE batch_id = ? AND active = 1 ORDER BY id');
  const insSession = db.prepare('INSERT INTO sessions (batch_id, date, starts_at, verified_at) VALUES (?, ?, ?, ?)');
  const insAtt = db.prepare('INSERT INTO attendance (session_id, student_id, status, note, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  const updAtt = db.prepare('UPDATE attendance SET status = ?, note = ?, source = ?, updated_at = ? WHERE session_id = ? AND student_id = ?');
  const insAlert = db.prepare('INSERT INTO alerts (session_id, student_id, phone, status, sent_at, reply, replied_at, escalated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insTask = db.prepare("INSERT INTO tasks (alert_id, status, reason, created_at, done_at, outcome) VALUES (?, 'done', ?, ?, ?, ?)");
  const insMsg = db.prepare('INSERT INTO messages (phone, direction, body, buttons, alert_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const settings = svc.rawSettings();

  db.exec('BEGIN');
  try {
    for (let d = addDays(today, -days); d <= today; d = addDays(d, 1)) {
      if (holidaySet.has(d)) continue;
      const weekday = new Date(`${d}T12:00:00Z`).getUTCDay();
      for (const b of batches) {
        if (!b.days.split(',').map(Number).includes(weekday)) continue;
        const startsAt = zonedTimeToIso(svc.tz, d, b.start_time);
        const start = Date.parse(startsAt);
        if (start + 45 * 60_000 > now) continue; // still to come (or live) today
        if (d === today && liveToday.includes(b.id)) continue; // kept open so the live flow can be tried any time
        const verified = start + 10 * 60_000;
        const sessionId = Number(insSession.run(b.id, d, startsAt, iso(verified)).lastInsertRowid);
        const markAt = start + (2 + rand() * 6) * 60_000;
        let n = 0;
        for (const st of studentsOf.all(b.id)) {
          const rate = rates.get(st.id) ?? 0.9;
          const r = rand();
          const status = r < rate ? 'P' : r < rate + (1 - rate) * 0.2 ? 'L' : 'A';
          insAtt.run(sessionId, st.id, status, status === 'L' ? 'Leave (told the teacher)' : null, 'teacher', iso(markAt + n * 4000));
          n++;
          if (status !== 'A') continue;

          const sent = verified + n * 1500;
          const time = new Intl.DateTimeFormat('en-IN', { timeZone: svc.tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(start)).toUpperCase();
          const body = settings.alertTemplate
            .replace('{parent}', st.parent_name || 'Parent')
            .replace('{batch}', b.name)
            .replace('{time}', time)
            .replace('{student}', st.name)
            .replace('{institute}', settings.instituteName);
          if (rand() < 0.68) {
            const choice = rand() < 0.6 ? 'LEAVE' : 'LATE';
            const replied = sent + (0.4 + rand() * 2.4) * 60_000;
            const alertId = Number(insAlert.run(sessionId, st.id, st.parent_phone, 'replied', iso(sent), choice, iso(replied), null).lastInsertRowid);
            updAtt.run(REPLY_OPTIONS[choice].status, REPLY_OPTIONS[choice].note, 'parent', iso(replied), sessionId, st.id);
            if (d === today) {
              insMsg.run(st.parent_phone, 'out', body, JSON.stringify(Object.entries(REPLY_OPTIONS).map(([k, o]) => ({ id: `${k}:${alertId}`, title: o.title }))), alertId, iso(sent));
              insMsg.run(st.parent_phone, 'in', REPLY_OPTIONS[choice].title, null, alertId, iso(replied));
              insMsg.run(st.parent_phone, 'out', `Thank you. Noted: ${REPLY_OPTIONS[choice].title}.`, null, alertId, iso(replied + 1000));
            }
          } else {
            const escalated = sent + 3 * 60_000;
            const alertId = Number(insAlert.run(sessionId, st.id, st.parent_phone, 'escalated', iso(sent), null, null, iso(escalated)).lastInsertRowid);
            const outcome = pick([['bunk', 40], ['leave', 25], ['late', 10], ['unreachable', 25]]);
            const done = escalated + (3 + rand() * 20) * 60_000;
            insTask.run(alertId, 'No reply in 3 min', iso(escalated), iso(done), TASK_OUTCOMES[outcome].note);
            updAtt.run(TASK_OUTCOMES[outcome].status, TASK_OUTCOMES[outcome].note, 'staff', iso(done), sessionId, st.id);
            if (d === today) {
              insMsg.run(st.parent_phone, 'out', body, JSON.stringify(Object.entries(REPLY_OPTIONS).map(([k, o]) => ({ id: `${k}:${alertId}`, title: o.title }))), alertId, iso(sent));
            }
          }
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Demo workspace: an agency running three institutes, with a month of history. */
export function seedDemo(platform) {
  if (!platform.needsSetup()) return false;
  phoneSeq = 10000;
  platform.createUser({ name: 'Agency Admin', phone: '9999900000', pin: DEMO_PIN, isAgency: true });

  platform.createInstitute({
    name: 'Bright Future Classes', slug: 'bright-future', city: 'Indore', feeMonthly: 10000,
    owner: { name: 'Rakesh Sharma', phone: '9999900001', pin: DEMO_PIN },
  });
  const bf = platform.service('bright-future');
  bf.updateSettings({ ownerPhone: '9999900001', digestEnabled: true, digestTime: '21:00' });
  const { batches, rates } = addBatches(bf, BRIGHT_FUTURE);
  platform.addMember('bright-future', { name: 'Pooja Desai', phone: '9999900002', pin: DEMO_PIN, role: 'staff' });
  platform.addMember('bright-future', { name: 'Anil Sir', phone: '9999900003', pin: DEMO_PIN, role: 'teacher', batchIds: [batches[1].id, batches[2].id] });
  // Batch B (the class from the reel) is left open today so you can run the live flow at any hour.
  generateHistory(bf, { days: 35, rates, seed: 7, holidays: [[-12, 'Guru Nanak Jayanti'], [25, 'Christmas']], liveToday: [batches[1].id] });

  platform.createInstitute({
    name: 'Excel Coaching Centre', slug: 'excel', city: 'Bhopal', feeMonthly: 8000,
    owner: { name: 'Sunita Verma', phone: '9999900004', pin: DEMO_PIN },
  });
  const ex = platform.service('excel');
  const exData = addBatches(ex, EXCEL);
  generateHistory(ex, { days: 21, rates: exData.rates, seed: 11, holidays: [[-12, 'Guru Nanak Jayanti']] });

  platform.createInstitute({
    name: 'Toppers Academy', slug: 'toppers', city: 'Jaipur', feeMonthly: 12000,
    owner: { name: 'Mahesh Gupta', phone: '9999900005', pin: DEMO_PIN },
  });
  const tp = platform.service('toppers');
  const tpData = addBatches(tp, TOPPERS);
  generateHistory(tp, { days: 10, rates: tpData.rates, seed: 3 });
  platform.updateInstitute('toppers', { status: 'paused' });
  return true;
}
