import { addDays, daysBetween, formatTime, localDate, localTime, localWeekday, zonedTimeToIso } from './time.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const DEFAULT_ALERT_TEMPLATE =
  'Namaste {parent}, aaj ki {batch} class ({time}) mein {student} ki attendance record nahi hui. Please confirm.';

const DEFAULT_SETTINGS = {
  instituteName: 'My Coaching Institute',
  verifyAfterMinutes: '10', // Step 2: absent entries are verified this long after class starts
  replyTimeoutMinutes: '10', // Step 6: no parent reply within this → staff call task
  alertTemplate: DEFAULT_ALERT_TEMPLATE,
  digestEnabled: '0', // end-of-day WhatsApp summary to the owner
  digestTime: '20:00',
  ownerPhone: '',
  requireConsent: '1', // only message parents who agreed; others become a call task
};

export const CONSENT_WORDING = {
  whatsapp: 'Parent sent START to receive attendance alerts on WhatsApp',
  staff: 'Consent recorded on the admission form',
};
const OPT_OUT_RE = /^\s*(stop|unsubscribe|band karo|band kar do|band|रोको|बंद करो|बंद)(?=\s|$|[.!])/i;
const OPT_IN_RE = /^\s*(start|subscribe|shuru|शुरू)(?=\s|$|[.!])/i;
const YES_RE = /^\s*(haan|han|ha|yes|ok|हाँ|हां)[.! ]*$/i;

/** WhatsApp Cloud API settings, kept per institute. Secrets never leave the server. */
const WA_KEYS = ['token', 'phoneNumberId', 'displayPhone', 'template', 'digestTemplate', 'templateLang', 'verifyToken', 'appSecret'];
const WA_SECRET = new Set(['token', 'appSecret']);

/** Fill {placeholders} in a message template. */
export function renderTemplate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

/** Run `fn` over `items` with at most `limit` running at once (WhatsApp sends in parallel, but politely). */
export async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const DELIVERY_RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };

/** A student is "at risk" if they keep missing class without a reason. */
export const AT_RISK = { minPct: 75, recentAbsences: 3, recentDays: 14 };

/** Parent reply options sent as WhatsApp quick-reply buttons. */
export const REPLY_OPTIONS = {
  LEAVE: { title: 'Leave', status: 'L', note: 'Leave (parent replied)' },
  LATE: { title: 'Late 15 min', status: 'T', note: 'Late 15 min (parent replied)' },
  // The case the product exists for: the parent thought the child was in class.
  // The student stays absent and staff get an urgent call task that never closes by itself.
  MISSING: {
    title: 'Mujhe call karein',
    status: 'A',
    note: "Parent doesn't know where the child is",
    urgent: true,
    ack: 'Thank you. Our staff will call you right away.',
  },
};
const REPLY_KEYS = Object.keys(REPLY_OPTIONS).join('|');

/** Outcomes staff can record after calling a parent. */
export const TASK_OUTCOMES = {
  leave: { status: 'L', note: 'Leave (confirmed on call)' },
  late: { status: 'T', note: 'Late (confirmed on call)' },
  present: { status: 'P', note: 'Present (confirmed on call)' },
  bunk: { status: 'A', note: 'Bunk, parent informed on call' },
  unreachable: { status: 'A', note: 'Parent unreachable' },
};

const STATUSES = ['P', 'A', 'L', 'T'];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const STATUS_WORDS = { P: 'present', A: 'absent', L: 'on leave', T: 'late' };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`; // Indian mobile number without country code
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits;
}

/**
 * Map a free-text WhatsApp reply to a reply option, if it clearly means one.
 * A parent who believes the child should be in class ("ghar se nikal gaya tha", "why absent?")
 * is MISSING, never LEAVE: a wrong "leave" would close the staff call in a real emergency.
 * When unsure, return null so the reply escalates to a person.
 */
export function parseReplyText(text) {
  const t = String(text ?? '').toLowerCase().normalize('NFC');
  if (!t.trim()) return null;
  const missing =
    /ghar se (nikla|nikli|nikal|gaya|gayi)|nikal (gaya|gayi|chuka|chuki)|\b(toh|to) (gaya|gayi|nikla|nikli)\b|gaya tha|gayi thi|left (home|for class|for coaching|the house|at)|already left|went to (class|coaching|tuition)|kahan (hai|gaya|gayi)|where is|pahuncha nahi|pahunchi nahi|घर से|निकल गय|पहुँचा नहीं|पहुंचा नहीं|कहाँ है|कहां है/.test(t) ||
    /\b(why|kyu|kyun|kyon|kaise)\b[^.!]{0,25}\babsent\b|\babsent\b[^.!]{0,25}(\b(why|kyu|kyun|kyon|kaise)\b|\?)/.test(t);
  if (missing) return 'MISSING';
  const late =
    /\b(late|der|deri|aa raha|aa rahi|aa rha|aa rhi|on the way|raste|rasta|traffic|reaching|will reach)\b|देर|लेट|आ रहा|आ रही|रास्ते/.test(t);
  const leave =
    /\b(leave|chutti|chhutti|holiday|sick|bimar|beemar|bukhar|fever|unwell|ill|tabiyat|tabiyet|doctor|hospital|shaadi|shadi|wedding|out of station|nahi aa payega|nahi aa payegi|nahi aa paayega|nahi aa paayegi|aaj nahi aayega|aaj nahi aayegi|nahi aa sakta|nahi aa sakti|not coming|won't come|will not come)\b|छुट्टी|बीमार|बुखार|तबीयत|शादी|नहीं आ/.test(t);
  if (late && !leave) return 'LATE';
  if (leave && !late) return 'LEAVE';
  return null;
}

function requireText(value, field, max = 80) {
  const v = String(value ?? '').trim();
  if (!v) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} is too long`);
  return v;
}

function parseDays(days) {
  const list = Array.isArray(days) ? days : String(days ?? '').split(',');
  const nums = [...new Set(list.map((d) => Number(d)))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (!nums.length) throw new HttpError(400, 'Pick at least one day');
  return nums.sort().join(',');
}

function parseDuration(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 15 || n > 480) throw new HttpError(400, 'Class length must be 15–480 minutes');
  return n;
}

function parsePhone(value) {
  const phone = normalizePhone(value);
  if (phone.length < 11 || phone.length > 15) throw new HttpError(400, 'Enter a valid WhatsApp number');
  return phone;
}

export class AttendanceService {
  constructor({ db, messenger, clock = () => Date.now(), tz = 'Asia/Kolkata', onChange = () => {}, logger = console, secrets = null }) {
    this.db = db;
    this.secrets = secrets; // encrypts the WhatsApp token and app secret at rest (see secrets.js)
    this.messenger = messenger;
    this.clock = clock;
    this.tz = tz;
    this.onChange = onChange;
    this.logger = logger;
  }

  now() {
    return this.clock();
  }

  nowIso() {
    return new Date(this.clock()).toISOString();
  }

  today() {
    return localDate(this.tz, this.clock());
  }

  changed() {
    this.onChange();
  }

  // ---------------------------------------------------------------- settings

  rawSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  }

  setSetting(key, value) {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  getSettings() {
    const s = this.rawSettings();
    return {
      instituteName: s.instituteName,
      verifyAfterMinutes: Number(s.verifyAfterMinutes),
      replyTimeoutMinutes: Number(s.replyTimeoutMinutes),
      alertTemplate: s.alertTemplate,
      digestEnabled: s.digestEnabled === '1',
      digestTime: s.digestTime,
      ownerPhone: s.ownerPhone,
      requireConsent: s.requireConsent !== '0',
    };
  }

  updateSettings(patch = {}) {
    const upsert = { run: (k, v) => this.setSetting(k, v) };
    if (patch.instituteName !== undefined) upsert.run('instituteName', requireText(patch.instituteName, 'Institute name'));
    if (patch.alertTemplate !== undefined) {
      const t = requireText(patch.alertTemplate, 'Alert message', 900);
      if (!t.includes('{student}')) throw new HttpError(400, 'The alert message must include {student}');
      upsert.run('alertTemplate', t);
    }
    if (patch.digestEnabled !== undefined) upsert.run('digestEnabled', patch.digestEnabled ? '1' : '0');
    if (patch.requireConsent !== undefined) upsert.run('requireConsent', patch.requireConsent ? '1' : '0');
    if (patch.digestTime !== undefined) {
      if (!TIME_RE.test(String(patch.digestTime))) throw new HttpError(400, 'Summary time must be HH:MM');
      upsert.run('digestTime', patch.digestTime);
    }
    if (patch.ownerPhone !== undefined) upsert.run('ownerPhone', patch.ownerPhone ? parsePhone(patch.ownerPhone) : '');
    for (const key of ['verifyAfterMinutes', 'replyTimeoutMinutes']) {
      if (patch[key] === undefined) continue;
      const n = Number(patch[key]);
      if (!Number.isFinite(n) || n < 0 || n > 240) throw new HttpError(400, `${key} must be between 0 and 240 minutes`);
      upsert.run(key, String(n));
    }
    this.changed();
    return this.getSettings();
  }

  /**
   * Full WhatsApp config (server-side only), with the token and app secret decrypted.
   * A credential that can't be decrypted (the encryption key changed) comes back empty and is listed
   * in `unreadable`, so the owner is asked to enter it again instead of the app sending with garbage.
   */
  getWhatsAppConfig() {
    const s = this.rawSettings();
    const unreadable = [];
    const cfg = Object.fromEntries(
      WA_KEYS.map((k) => {
        const v = s[`wa.${k}`] ?? '';
        if (!WA_SECRET.has(k) || !this.secrets) return [k, v];
        try {
          return [k, this.secrets.open(v)];
        } catch {
          unreadable.push(k);
          return [k, ''];
        }
      }),
    );
    if (unreadable.length) Object.defineProperty(cfg, 'unreadable', { value: unreadable, enumerable: false });
    return cfg;
  }

  /** WhatsApp config safe to show in the browser: secrets are reduced to "set / not set". */
  getWhatsAppPublic() {
    const c = this.getWhatsAppConfig();
    return { ...Object.fromEntries(WA_KEYS.map((k) => [k, WA_SECRET.has(k) ? Boolean(c[k]) : c[k]])), unreadable: c.unreadable ?? [] };
  }

  /** Encrypt credentials saved by older versions in plain text. Returns how many were converted. */
  sealStoredSecrets() {
    if (!this.secrets) return 0;
    const s = this.rawSettings();
    let n = 0;
    for (const k of WA_SECRET) {
      const v = s[`wa.${k}`];
      if (v && !this.secrets.isSealed(v)) {
        this.setSetting(`wa.${k}`, this.secrets.seal(v));
        n += 1;
      }
    }
    return n;
  }

  updateWhatsAppConfig(patch = {}) {
    for (const k of WA_KEYS) {
      if (patch[k] === undefined || patch[k] === null) continue;
      if (WA_SECRET.has(k) && patch[k] === true) continue; // "keep existing"
      const v = String(patch[k]).trim();
      if (v.length > 600) throw new HttpError(400, `${k} is too long`);
      this.setSetting(`wa.${k}`, WA_SECRET.has(k) && this.secrets ? this.secrets.seal(v) : v);
    }
    this.changed();
    return this.getWhatsAppPublic();
  }

  // ----------------------------------------------------------------- batches

  listBatches() {
    return this.db
      .prepare(
        `SELECT b.id, b.name, b.start_time AS startTime, b.days, b.duration_minutes AS durationMinutes,
                (SELECT COUNT(*) FROM students s WHERE s.batch_id = b.id AND s.active = 1) AS studentCount
           FROM batches b WHERE b.active = 1 ORDER BY b.start_time, b.name`,
      )
      .all()
      .map((b) => ({ ...b, days: b.days.split(',').map(Number) }));
  }

  getBatch(id) {
    const b = this.db.prepare('SELECT * FROM batches WHERE id = ? AND active = 1').get(id);
    if (!b) throw new HttpError(404, 'Batch not found');
    return b;
  }

  createBatch({ name, startTime, days = [1, 2, 3, 4, 5, 6], durationMinutes = 120 }) {
    const n = requireText(name, 'Batch name');
    if (!TIME_RE.test(String(startTime))) throw new HttpError(400, 'Start time must be HH:MM');
    const r = this.db
      .prepare('INSERT INTO batches (name, start_time, days, duration_minutes) VALUES (?, ?, ?, ?)')
      .run(n, startTime, parseDays(days), parseDuration(durationMinutes));
    this.changed();
    return this.listBatches().find((b) => b.id === Number(r.lastInsertRowid));
  }

  updateBatch(id, patch = {}) {
    const b = this.getBatch(id);
    const name = patch.name !== undefined ? requireText(patch.name, 'Batch name') : b.name;
    const startTime = patch.startTime !== undefined ? patch.startTime : b.start_time;
    if (!TIME_RE.test(String(startTime))) throw new HttpError(400, 'Start time must be HH:MM');
    const days = patch.days !== undefined ? parseDays(patch.days) : b.days;
    const duration = patch.durationMinutes !== undefined ? parseDuration(patch.durationMinutes) : b.duration_minutes;
    this.db
      .prepare('UPDATE batches SET name = ?, start_time = ?, days = ?, duration_minutes = ? WHERE id = ?')
      .run(name, startTime, days, duration, b.id);
    if (startTime !== b.start_time) {
      // Move today's session if it has not been verified yet.
      const date = this.today();
      this.db
        .prepare('UPDATE sessions SET starts_at = ? WHERE batch_id = ? AND date = ? AND verified_at IS NULL')
        .run(zonedTimeToIso(this.tz, date, startTime), b.id, date);
    }
    this.changed();
    return this.listBatches().find((x) => x.id === b.id);
  }

  deleteBatch(id) {
    const b = this.getBatch(id);
    // Soft delete keeps attendance history intact.
    this.db.prepare('UPDATE batches SET active = 0 WHERE id = ?').run(b.id);
    this.changed();
  }

  // ---------------------------------------------------------------- students

  listStudents(batchId) {
    const sql = `SELECT id, batch_id AS batchId, name, parent_name AS parentName, parent_phone AS parentPhone
                   FROM students WHERE active = 1 ${batchId ? 'AND batch_id = ?' : ''} ORDER BY name`;
    return batchId ? this.db.prepare(sql).all(batchId) : this.db.prepare(sql).all();
  }

  createStudent({ batchId, name, parentName, parentPhone }) {
    const batch = this.getBatch(batchId);
    const r = this.db
      .prepare('INSERT INTO students (batch_id, name, parent_name, parent_phone) VALUES (?, ?, ?, ?)')
      .run(batch.id, requireText(name, 'Student name'), String(parentName ?? '').trim() || null, parsePhone(parentPhone));
    this.changed();
    return this.listStudents(batch.id).find((s) => s.id === Number(r.lastInsertRowid));
  }

  updateStudent(id, patch = {}) {
    const s = this.db.prepare('SELECT * FROM students WHERE id = ? AND active = 1').get(id);
    if (!s) throw new HttpError(404, 'Student not found');
    const batchId = patch.batchId !== undefined ? this.getBatch(patch.batchId).id : s.batch_id;
    const name = patch.name !== undefined ? requireText(patch.name, 'Student name') : s.name;
    const parentName = patch.parentName !== undefined ? String(patch.parentName).trim() || null : s.parent_name;
    const parentPhone = patch.parentPhone !== undefined ? parsePhone(patch.parentPhone) : s.parent_phone;
    this.db
      .prepare('UPDATE students SET batch_id = ?, name = ?, parent_name = ?, parent_phone = ? WHERE id = ?')
      .run(batchId, name, parentName, parentPhone, s.id);
    this.changed();
    return this.listStudents(batchId).find((x) => x.id === s.id);
  }

  /** "Remove": the student leaves the lists; their history stays for reports until it is erased. */
  deleteStudent(id) {
    const r = this.db.prepare('UPDATE students SET active = 0, removed_at = ? WHERE id = ? AND active = 1').run(this.nowIso(), id);
    if (!r.changes) throw new HttpError(404, 'Student not found');
    this.changed();
  }

  // ----------------------------------------------------------------- privacy (DPDP)

  logPrivacy(actor, action, detail = null) {
    this.db.prepare('INSERT INTO privacy_log (at, actor, action, detail) VALUES (?, ?, ?, ?)').run(this.nowIso(), actor ?? null, action, detail);
  }

  listPrivacyLog(limit = 100) {
    return this.db.prepare('SELECT at, actor, action, detail FROM privacy_log ORDER BY id DESC LIMIT ?').all(limit);
  }

  /** Students who were removed but whose data is still kept. */
  listRemovedStudents() {
    return this.db
      .prepare(
        `SELECT st.id, st.name, st.parent_name AS parentName, st.parent_phone AS parentPhone, st.removed_at AS removedAt, b.name AS batchName,
                (SELECT COUNT(*) FROM attendance a WHERE a.student_id = st.id) AS records
           FROM students st JOIN batches b ON b.id = st.batch_id
          WHERE st.active = 0 ORDER BY st.removed_at DESC, st.name`,
      )
      .all();
  }

  /**
   * Everything held about one family (the parent's number and every child on it, current or removed),
   * for a parent who asks what the institute has on them.
   */
  exportFamily(studentId, { actor = null } = {}) {
    const first = this.db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
    if (!first) throw new HttpError(404, 'Student not found');
    const phone = first.parent_phone;
    const children = this.db
      .prepare('SELECT st.*, b.name AS batch_name FROM students st JOIN batches b ON b.id = st.batch_id WHERE st.parent_phone = ? ORDER BY st.id = ? DESC, st.id')
      .all(phone, studentId); // the student asked about first
    const out = {
      exportedAt: this.nowIso(),
      institute: this.rawSettings().instituteName,
      parent: { name: first.parent_name, phone },
      students: children.map((c) => ({
        name: c.name,
        batch: c.batch_name,
        status: c.active ? 'current' : `removed ${c.removed_at ?? ''}`.trim(),
        attendance: this.db
          .prepare(
            `SELECT se.date, b.name AS batch, a.status, a.note, a.source, a.updated_at AS updatedAt
               FROM attendance a JOIN sessions se ON se.id = a.session_id JOIN batches b ON b.id = se.batch_id
              WHERE a.student_id = ? ORDER BY se.date, b.name`,
          )
          .all(c.id)
          .map((a) => ({ ...a, status: STATUS_WORDS[a.status] ?? a.status })),
        alerts: this.db
          .prepare(
            `SELECT se.date, al.status, al.sent_at AS sentAt, al.reply, al.replied_at AS repliedAt, al.error,
                    t.reason AS callReason, t.outcome AS callOutcome, t.done_at AS calledAt
               FROM alerts al JOIN sessions se ON se.id = al.session_id LEFT JOIN tasks t ON t.alert_id = al.id
              WHERE al.student_id = ? ORDER BY al.sent_at`,
          )
          .all(c.id),
      })),
      whatsappMessages: this.db.prepare('SELECT direction, body, created_at AS at, error FROM messages WHERE phone = ? ORDER BY id').all(phone),
      consent: this.consentFor(phone),
      consentHistory: this.db.prepare('SELECT status, source, wording, recorded_by AS recordedBy, at FROM consent_log WHERE phone = ? ORDER BY id').all(phone),
    };
    const sibs = children.length - 1;
    this.logPrivacy(actor, 'export_family', `student #${studentId}${sibs ? ` and ${plural(sibs, 'sibling')}` : ''}`);
    return out;
  }

  /** The institute's whole database as JSON (to keep a copy, or to move to another system). Credentials are left out. */
  exportAll({ actor = null } = {}) {
    const rows = (sql) => this.db.prepare(sql).all();
    const settings = Object.fromEntries(
      rows('SELECT key, value FROM settings').filter((r) => !/^wa\.(token|appSecret|verifyToken)$/.test(r.key)).map((r) => [r.key, r.value]),
    );
    this.logPrivacy(actor, 'export_all', null);
    return {
      format: 'attendance-alert-export',
      version: 1,
      exportedAt: this.nowIso(),
      settings,
      batches: rows('SELECT * FROM batches ORDER BY id'),
      students: rows('SELECT * FROM students ORDER BY id'),
      sessions: rows('SELECT * FROM sessions ORDER BY id'),
      attendance: rows('SELECT * FROM attendance ORDER BY session_id, student_id'),
      alerts: rows('SELECT * FROM alerts ORDER BY id'),
      tasks: rows('SELECT * FROM tasks ORDER BY id'),
      messages: rows('SELECT * FROM messages ORDER BY id'),
      consents: rows('SELECT * FROM consents ORDER BY phone'),
      consentLog: rows('SELECT * FROM consent_log ORDER BY id'),
      holidays: rows('SELECT * FROM holidays ORDER BY date'),
      privacyLog: rows('SELECT * FROM privacy_log ORDER BY id'),
    };
  }

  /**
   * Erase a student for good: attendance, alerts, call tasks and the student record. If no other
   * child uses the same parent number, the parent's WhatsApp messages and consent records go too.
   * A parent who sent STOP stays on the do-not-message list (number only), so they are never
   * messaged again by mistake.
   */
  eraseStudent(id, { actor = null } = {}) {
    const st = this.db.prepare('SELECT * FROM students WHERE id = ?').get(id);
    if (!st) throw new HttpError(404, 'Student not found');
    const counts = {};
    this.db.exec('BEGIN');
    try {
      const run = (sql, ...args) => this.db.prepare(sql).run(...args).changes;
      counts.calls = run('DELETE FROM tasks WHERE alert_id IN (SELECT id FROM alerts WHERE student_id = ?)', id);
      counts.alerts = run('DELETE FROM alerts WHERE student_id = ?', id);
      counts.attendance = run('DELETE FROM attendance WHERE student_id = ?', id);
      run('DELETE FROM students WHERE id = ?', id);
      const siblings = this.db.prepare('SELECT COUNT(*) AS n FROM students WHERE parent_phone = ?').get(st.parent_phone).n;
      counts.messages = 0;
      if (!siblings) {
        counts.messages = run('DELETE FROM messages WHERE phone = ?', st.parent_phone);
        run('DELETE FROM consent_log WHERE phone = ?', st.parent_phone);
        run("DELETE FROM consents WHERE phone = ? AND status != 'opted_out'", st.parent_phone);
        run("UPDATE consents SET wording = NULL, recorded_by = NULL WHERE phone = ?", st.parent_phone);
      }
      this.logPrivacy(
        actor,
        'erase_student',
        `student #${id}: ${plural(counts.attendance, 'attendance record')}, ${plural(counts.alerts, 'alert')}, ${plural(counts.calls, 'call')}, ${plural(counts.messages, 'message')}${siblings ? ' (parent kept: another child is enrolled)' : ''}`,
      );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.changed();
    return counts;
  }

  /** Erase every removed student (e.g. at the end of the academic year). */
  eraseRemovedStudents({ actor = null } = {}) {
    const ids = this.db.prepare('SELECT id FROM students WHERE active = 0').all().map((r) => r.id);
    for (const id of ids) this.eraseStudent(id, { actor });
    return { erased: ids.length };
  }

  // ---------------------------------------------------------------- sessions

  getSessionRow(id) {
    const s = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!s) throw new HttpError(404, 'Session not found');
    return s;
  }

  /** Today's session for a batch, created on demand (also for extra classes on off days). */
  ensureSession(batchId, date = this.today()) {
    const batch = this.getBatch(batchId);
    this.db
      .prepare('INSERT OR IGNORE INTO sessions (batch_id, date, starts_at) VALUES (?, ?, ?)')
      .run(batch.id, date, zonedTimeToIso(this.tz, date, batch.start_time));
    return this.db.prepare('SELECT * FROM sessions WHERE batch_id = ? AND date = ?').get(batch.id, date);
  }

  ensureTodaySessions() {
    if (this.holidayOn(this.today())) return;
    const weekday = localWeekday(this.tz, this.clock());
    for (const b of this.db.prepare('SELECT * FROM batches WHERE active = 1').all()) {
      if (b.days.split(',').map(Number).includes(weekday)) this.ensureSession(b.id);
    }
  }

  /** Demo helper: pretend the class starts right now so the timers run from here. */
  startNow(sessionId) {
    const s = this.getSessionRow(sessionId);
    if (s.verified_at) throw new HttpError(409, 'This session is already verified');
    this.db.prepare('UPDATE sessions SET starts_at = ? WHERE id = ?').run(this.nowIso(), s.id);
    this.changed();
  }

  // -------------------------------------------------- Step 1: teacher marks

  async mark(sessionId, studentId, status, { source = 'teacher', note = null } = {}) {
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Status must be P (present), A (absent), L (leave) or T (late)');
    const session = this.getSessionRow(sessionId);
    const student = this.db
      .prepare('SELECT * FROM students WHERE id = ? AND batch_id = ? AND active = 1')
      .get(studentId, session.batch_id);
    if (!student) throw new HttpError(404, 'Student is not in this batch');

    this.db
      .prepare(
        `INSERT INTO attendance (session_id, student_id, status, note, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, student_id) DO UPDATE SET
           status = excluded.status, note = excluded.note, source = excluded.source, updated_at = excluded.updated_at`,
      )
      .run(session.id, student.id, status, note, source, this.nowIso());

    if (session.verified_at) {
      if (status === 'A') {
        // Marked absent after verification: alert right away.
        await this.sendAlert(session, student);
      } else {
        this.closeTaskFor(session.id, student.id, `Marked ${STATUS_WORDS[status]} by ${source}`);
      }
    }
    this.changed();
  }

  async markAll(sessionId, status) {
    const session = this.getSessionRow(sessionId);
    const students = this.listStudents(session.batch_id);
    for (const st of students) await this.mark(session.id, st.id, status);
  }

  /**
   * The teacher sends the list to the office. Marking is by exception: anyone the teacher
   * didn't tap is present. Parents are only ever alerted for a class that was sent, so a
   * forgotten or half-finished list can never message a parent by mistake.
   */
  async submit(sessionId) {
    const session = this.getSessionRow(sessionId);
    const at = this.nowIso();
    this.db
      .prepare(
        `INSERT INTO attendance (session_id, student_id, status, note, source, updated_at)
         SELECT ?, s.id, 'P', NULL, 'teacher', ?
           FROM students s
          WHERE s.batch_id = ? AND s.active = 1
            AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.session_id = ? AND a.student_id = s.id)`,
      )
      .run(session.id, at, session.batch_id, session.id);
    this.db.prepare('UPDATE sessions SET submitted_at = COALESCE(submitted_at, ?) WHERE id = ?').run(at, session.id);
    // Already past the verify time (teacher sent it late): alert now rather than on the next tick.
    const { verifyAfterMinutes } = this.getSettings();
    if (!session.verified_at && this.now() >= Date.parse(session.starts_at) + verifyAfterMinutes * 60_000) {
      await this.verify(session.id);
    }
    this.changed();
  }

  // ----------------------------- Step 2 + 3: verify, then alert the parents

  /** Alert the parents of students marked absent. Unmarked students are never treated as absent. */
  async verify(sessionId) {
    const session = this.getSessionRow(sessionId);
    const at = this.nowIso();
    const r = this.db
      .prepare('UPDATE sessions SET verified_at = ?, submitted_at = COALESCE(submitted_at, ?) WHERE id = ? AND verified_at IS NULL')
      .run(at, at, session.id);
    if (!r.changes) return; // already verified (possibly by a concurrent tick)

    const absentees = this.db
      .prepare(
        `SELECT s.* FROM attendance a JOIN students s ON s.id = a.student_id
          WHERE a.session_id = ? AND a.status = 'A' AND s.active = 1
            AND NOT EXISTS (SELECT 1 FROM alerts al WHERE al.session_id = a.session_id AND al.student_id = s.id)
          ORDER BY s.name`,
      )
      .all(session.id);

    const verified = { ...session, verified_at: at };
    await mapLimit(absentees, 8, (student) => this.sendAlert(verified, student));
    this.changed();
  }

  async sendAlert(session, student) {
    const batch = this.db.prepare('SELECT * FROM batches WHERE id = ?').get(session.batch_id);
    const r = this.db
      .prepare("INSERT OR IGNORE INTO alerts (session_id, student_id, phone, status, sent_at) VALUES (?, ?, ?, 'sent', ?)")
      .run(session.id, student.id, student.parent_phone, this.nowIso());
    if (!r.changes) return; // one alert per student per session
    const alertId = Number(r.lastInsertRowid);

    // No WhatsApp without consent: the absence still reaches the parent, by a phone call.
    const consent = this.consentFor(student.parent_phone);
    const blocked =
      consent?.status === 'opted_out'
        ? 'Parent replied STOP to WhatsApp alerts'
        : this.rawSettings().requireConsent !== '0' && consent?.status !== 'opted_in'
          ? 'No WhatsApp consent recorded for this parent yet'
          : null;
    if (blocked) {
      this.db.prepare("UPDATE alerts SET status = 'failed', error = ? WHERE id = ?").run(blocked, alertId);
      this.createTask(alertId, `Call instead: ${blocked.charAt(0).toLowerCase()}${blocked.slice(1)}`);
      return;
    }

    const time = formatTime(this.tz, session.starts_at);
    const parentName = student.parent_name || 'Parent';
    const text = renderTemplate(this.rawSettings().alertTemplate, {
      parent: parentName,
      student: student.name,
      batch: batch.name,
      time,
      institute: this.rawSettings().instituteName,
    });
    const buttons = Object.entries(REPLY_OPTIONS).map(([key, o]) => ({ id: `${key}:${alertId}`, title: o.title }));

    const msg = this.logMessage({ phone: student.parent_phone, direction: 'out', body: text, buttons, alertId });
    try {
      const { id } = await this.messenger.send({
        to: student.parent_phone,
        text,
        buttons,
        template: 'alert',
        params: [parentName, batch.name, time, student.name],
      });
      this.markSent(msg, id);
      this.db.prepare("UPDATE alerts SET delivery = 'sent' WHERE id = ?").run(alertId);
    } catch (err) {
      this.logger.error?.(`WhatsApp alert ${alertId} failed: ${err.message}`);
      this.db.prepare("UPDATE alerts SET status = 'failed', error = ? WHERE id = ?").run(err.message, alertId);
      this.db.prepare('UPDATE messages SET error = ? WHERE id = ?').run(err.message, msg);
      // The parent still needs to know: hand it to staff straight away.
      this.createTask(alertId, 'WhatsApp message failed');
    }
  }

  // ------------------------------------------ Step 4 + 5: parent replies

  /**
   * Handle an incoming WhatsApp message. `payload` is the quick-reply button id
   * (e.g. 'LATE:12'); `text` is what the parent typed or the button label.
   */
  async handleReply({ phone, payload = null, text = '', id = null }) {
    const from = normalizePhone(phone);
    // Meta retries webhooks it thinks failed: the same message id means we've already handled it.
    if (id && this.db.prepare('SELECT 1 FROM messages WHERE wamid = ?').get(id)) return { matched: false, duplicate: true };

    const consentReply = await this.handleConsentMessage({ from, text: String(text || ''), id });
    if (consentReply) return consentReply;
    let alert = null;
    let choice = null;

    const m = new RegExp(`^(${REPLY_KEYS}):(\\d+)$`).exec(String(payload ?? ''));
    if (m) {
      choice = m[1];
      // Only today's alerts: an old button tapped days later must not rewrite history.
      alert =
        this.db
          .prepare(
            `SELECT al.* FROM alerts al JOIN sessions se ON se.id = al.session_id
              WHERE al.id = ? AND al.phone = ? AND se.date = ?`,
          )
          .get(Number(m[2]), from, this.today()) ?? null;
    }
    if (!choice) choice = parseReplyText(text || payload);
    if (!alert && choice) {
      // Free text: apply it to this parent's latest open alert from today.
      alert =
        this.db
          .prepare(
            `SELECT al.* FROM alerts al JOIN sessions se ON se.id = al.session_id
              WHERE al.phone = ? AND se.date = ? ORDER BY al.id DESC LIMIT 1`,
          )
          .get(from, this.today()) ?? null;
    }

    try {
      this.logMessage({ phone: from, direction: 'in', body: String(text || payload || '').slice(0, 1000), alertId: alert?.id ?? null, wamid: id });
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) return { matched: false, duplicate: true }; // a retry arriving at the same moment
      throw err;
    }

    if (!alert || !choice) {
      this.changed();
      return { matched: false };
    }

    // Once staff have called and logged an outcome, a later message doesn't overwrite it;
    // it stays visible in the WhatsApp log for the front desk.
    const current = this.db
      .prepare('SELECT source FROM attendance WHERE session_id = ? AND student_id = ?')
      .get(alert.session_id, alert.student_id);
    if (current?.source === 'staff') {
      this.changed();
      return { matched: false, reason: 'staff-outcome' };
    }

    const option = REPLY_OPTIONS[choice];
    const at = this.nowIso();
    this.db
      .prepare("UPDATE alerts SET status = 'replied', reply = ?, replied_at = ? WHERE id = ?")
      .run(choice, at, alert.id);
    this.db
      .prepare(
        `UPDATE attendance SET status = ?, note = ?, source = 'parent', updated_at = ?
          WHERE session_id = ? AND student_id = ?`,
      )
      .run(option.status, option.note, at, alert.session_id, alert.student_id);
    if (option.urgent) {
      this.createTask(alert.id, "URGENT: parent doesn't know where the child is", { urgent: true });
    } else {
      this.closeTaskFor(alert.session_id, alert.student_id, `Parent replied: ${option.title}`);
    }

    const ack = option.ack ?? `Thank you. Noted: ${option.title}.`;
    const ackMsg = this.logMessage({ phone: from, direction: 'out', body: ack, alertId: alert.id });
    try {
      const { id: ackId } = await this.messenger.send({ to: from, text: ack });
      this.markSent(ackMsg, ackId);
    } catch (err) {
      this.logger.error?.(`WhatsApp acknowledgement failed: ${err.message}`);
      this.db.prepare("UPDATE messages SET error = ?, status = 'failed' WHERE id = ?").run(err.message, ackMsg);
    }

    this.changed();
    return { matched: true, alertId: alert.id, choice };
  }

  // ---------------------------------------------------- consent (opt-in)

  consentFor(phone) {
    const c = this.db.prepare('SELECT status, source, wording, recorded_by AS recordedBy, updated_at AS updatedAt FROM consents WHERE phone = ?').get(normalizePhone(phone));
    return c ?? null;
  }

  setConsent(phone, status, { source, recordedBy = null } = {}) {
    const p = normalizePhone(phone);
    const at = this.nowIso();
    const wording = CONSENT_WORDING[source] ?? null;
    this.db
      .prepare(
        `INSERT INTO consents (phone, status, source, wording, recorded_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(phone) DO UPDATE SET status = excluded.status, source = excluded.source, wording = excluded.wording,
           recorded_by = excluded.recorded_by, updated_at = excluded.updated_at`,
      )
      .run(p, status, source, wording, recordedBy, at);
    this.db
      .prepare('INSERT INTO consent_log (phone, status, source, wording, recorded_by, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p, status, source, wording, recordedBy, at);
    this.changed();
  }

  /** The office records consent from the signed admission form. A parent's STOP can't be overridden. */
  recordConsent(studentId, { recordedBy = null } = {}) {
    const st = this.db.prepare('SELECT * FROM students WHERE id = ? AND active = 1').get(studentId);
    if (!st) throw new HttpError(404, 'Student not found');
    if (this.consentFor(st.parent_phone)?.status === 'opted_out') {
      throw new HttpError(409, 'This parent sent STOP. Only they can turn alerts back on, by sending START.');
    }
    this.setConsent(st.parent_phone, 'opted_in', { source: 'staff', recordedBy });
    return this.consentFor(st.parent_phone);
  }

  /** Remove a consent the office recorded by mistake (back to "not yet"). */
  clearConsent(studentId, { recordedBy = null } = {}) {
    const st = this.db.prepare('SELECT * FROM students WHERE id = ? AND active = 1').get(studentId);
    if (!st) throw new HttpError(404, 'Student not found');
    const c = this.consentFor(st.parent_phone);
    if (!c) return null;
    if (c.source !== 'staff') throw new HttpError(409, 'This consent came from the parent on WhatsApp; only they can change it.');
    this.db.prepare('DELETE FROM consents WHERE phone = ?').run(st.parent_phone);
    this.db
      .prepare("INSERT INTO consent_log (phone, status, source, wording, recorded_by, at) VALUES (?, 'cleared', 'staff', NULL, ?, ?)")
      .run(st.parent_phone, recordedBy, this.nowIso());
    this.changed();
    return null;
  }

  /** Record admission-form consent for every parent who has no record yet (optionally one batch). */
  recordAllConsents({ batchId = null, recordedBy = null } = {}) {
    const phones = this.db
      .prepare(
        `SELECT DISTINCT st.parent_phone AS phone FROM students st
          WHERE st.active = 1 AND (? IS NULL OR st.batch_id = ?)
            AND NOT EXISTS (SELECT 1 FROM consents c WHERE c.phone = st.parent_phone)`,
      )
      .all(batchId, batchId);
    for (const { phone } of phones) this.setConsent(phone, 'opted_in', { source: 'staff', recordedBy });
    return { recorded: phones.length };
  }

  /** START / STOP (and a plain "haan" from a parent who hasn't opted in yet). Returns null if it's neither. */
  async handleConsentMessage({ from, text, id }) {
    const current = this.consentFor(from);
    const optOut = OPT_OUT_RE.test(text);
    const optIn = !optOut && (OPT_IN_RE.test(text) || (!current && YES_RE.test(text)));
    if (!optOut && !optIn) return null;

    const children = this.db
      .prepare('SELECT name FROM students WHERE parent_phone = ? AND active = 1 ORDER BY name')
      .all(from)
      .map((r) => r.name.split(' ')[0]);
    const institute = this.rawSettings().instituteName;
    try {
      this.logMessage({ phone: from, direction: 'in', body: text.slice(0, 1000), wamid: id });
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) return { matched: false, duplicate: true };
      throw err;
    }

    let ack;
    let consent = null;
    if (optOut) {
      this.setConsent(from, 'opted_out', { source: 'whatsapp' });
      consent = 'opted_out';
      ack = `Theek hai, ab ${institute} se WhatsApp attendance alerts nahi aayenge. Dobara shuru karne ke liye START likhein.`;
    } else if (!children.length) {
      ack = `Yeh number ${institute} ke records mein nahi mila. Kripya office se sampark karein.`;
    } else {
      this.setConsent(from, 'opted_in', { source: 'whatsapp' });
      consent = 'opted_in';
      ack = `Dhanyavaad! Aapko ${institute} se ${children.join(', ')} ke attendance alerts WhatsApp par milenge. Band karne ke liye STOP likhein.`;
    }
    const ackMsg = this.logMessage({ phone: from, direction: 'out', body: ack });
    try {
      const { id: ackId } = await this.messenger.send({ to: from, text: ack });
      this.markSent(ackMsg, ackId);
    } catch (err) {
      this.db.prepare("UPDATE messages SET error = ?, status = 'failed' WHERE id = ?").run(err.message, ackMsg);
    }
    this.changed();
    return { matched: false, consent };
  }

  // ---------------------------------------------- Step 6: staff call tasks

  createTask(alertId, reason, { urgent = false } = {}) {
    if (urgent) {
      // Urgent wins over an existing open task (e.g. "no reply") and reopens nothing staff closed.
      this.db
        .prepare(
          `INSERT INTO tasks (alert_id, status, reason, created_at, urgent) VALUES (?, 'open', ?, ?, 1)
           ON CONFLICT(alert_id) DO UPDATE SET urgent = 1, reason = excluded.reason WHERE tasks.status = 'open'`,
        )
        .run(alertId, reason, this.nowIso());
      return;
    }
    this.db
      .prepare("INSERT OR IGNORE INTO tasks (alert_id, status, reason, created_at) VALUES (?, 'open', ?, ?)")
      .run(alertId, reason, this.nowIso());
  }

  closeTaskFor(sessionId, studentId, outcome) {
    this.db
      .prepare(
        `UPDATE tasks SET status = 'done', done_at = ?, outcome = ?
          WHERE status = 'open'
            AND alert_id IN (SELECT id FROM alerts WHERE session_id = ? AND student_id = ?)`,
      )
      .run(this.nowIso(), outcome, sessionId, studentId);
  }

  completeTask(taskId, { outcome, note } = {}) {
    const result = TASK_OUTCOMES[outcome];
    if (!result) throw new HttpError(400, `Outcome must be one of: ${Object.keys(TASK_OUTCOMES).join(', ')}`);
    const task = this.db
      .prepare('SELECT t.*, al.session_id, al.student_id FROM tasks t JOIN alerts al ON al.id = t.alert_id WHERE t.id = ?')
      .get(taskId);
    if (!task) throw new HttpError(404, 'Task not found');
    if (task.status === 'done') throw new HttpError(409, 'Task is already done');
    const at = this.nowIso();
    const extra = String(note ?? '').trim().slice(0, 200);
    const fullNote = extra ? `${result.note}: ${extra}` : result.note;
    this.db.prepare("UPDATE tasks SET status = 'done', done_at = ?, outcome = ? WHERE id = ?").run(at, fullNote, task.id);
    this.db
      .prepare(
        `UPDATE attendance SET status = ?, note = ?, source = 'staff', updated_at = ?
          WHERE session_id = ? AND student_id = ?`,
      )
      .run(result.status, fullNote, at, task.session_id, task.student_id);
    this.changed();
  }

  // ------------------------------------------------------------- scheduler

  /** Runs every few seconds: verifies sessions that are due and escalates unanswered alerts. */
  async tick() {
    this.ensureTodaySessions();
    const { verifyAfterMinutes, replyTimeoutMinutes } = this.getSettings();
    const now = this.now();

    // Only classes the teacher has sent to the office. A class nobody sent is flagged to the
    // front desk on the dashboard instead; its parents are never messaged automatically.
    const due = this.db
      .prepare('SELECT * FROM sessions WHERE verified_at IS NULL AND submitted_at IS NOT NULL AND date = ?')
      .all(this.today());
    for (const s of due) {
      if (now >= Date.parse(s.starts_at) + verifyAfterMinutes * 60_000) await this.verify(s.id);
    }

    let escalated = 0;
    for (const a of this.db.prepare("SELECT * FROM alerts WHERE status = 'sent'").all()) {
      if (now < Date.parse(a.sent_at) + replyTimeoutMinutes * 60_000) continue;
      const r = this.db
        .prepare("UPDATE alerts SET status = 'escalated', escalated_at = ? WHERE id = ? AND status = 'sent'")
        .run(this.nowIso(), a.id);
      if (r.changes) {
        this.createTask(a.id, `No reply in ${replyTimeoutMinutes} min`);
        escalated++;
      }
    }
    if (escalated) this.changed();
    await this.maybeSendDigest();
  }

  // ----------------------------------------------------------------- views

  /** Everything a screen needs about one session: students, marks, alerts, tasks. */
  getSessionView(sessionId) {
    const s = this.db
      .prepare(
        `SELECT se.*, b.name AS batch_name, b.start_time FROM sessions se JOIN batches b ON b.id = se.batch_id
          WHERE se.id = ?`,
      )
      .get(sessionId);
    if (!s) throw new HttpError(404, 'Session not found');
    const { verifyAfterMinutes, replyTimeoutMinutes } = this.getSettings();

    // Active students, plus anyone with a record in this session (kept for history).
    const rows = this.db
      .prepare(
        `SELECT st.id, st.name, st.parent_name, st.parent_phone,
                a.status, a.note, a.source, a.updated_at,
                al.id AS alert_id, al.status AS alert_status, al.delivery, al.sent_at, al.reply, al.replied_at, al.escalated_at, al.error,
                t.id AS task_id, t.status AS task_status, t.outcome AS task_outcome
           FROM students st
           LEFT JOIN attendance a ON a.session_id = ? AND a.student_id = st.id
           LEFT JOIN alerts al ON al.session_id = ? AND al.student_id = st.id
           LEFT JOIN tasks t ON t.alert_id = al.id
          WHERE st.batch_id = ? AND (st.active = 1 OR a.status IS NOT NULL)
          ORDER BY st.name`,
      )
      .all(s.id, s.id, s.batch_id);

    const counts = { P: 0, A: 0, L: 0, T: 0, unmarked: 0 };
    const students = rows.map((r) => {
      counts[r.status ?? 'unmarked']++;
      return {
        id: r.id,
        name: r.name,
        parentName: r.parent_name,
        parentPhone: r.parent_phone,
        status: r.status,
        note: r.note,
        source: r.source,
        alert: r.alert_id
          ? {
              id: r.alert_id,
              status: r.alert_status,
              delivery: r.delivery,
              sentAt: r.sent_at,
              replyDueAt: new Date(Date.parse(r.sent_at) + replyTimeoutMinutes * 60_000).toISOString(),
              reply: r.reply ? REPLY_OPTIONS[r.reply]?.title ?? r.reply : null,
              replyKey: r.reply,
              repliedAt: r.replied_at,
              escalatedAt: r.escalated_at,
              error: r.error,
            }
          : null,
        task: r.task_id ? { id: r.task_id, status: r.task_status, outcome: r.task_outcome } : null,
      };
    });

    return {
      id: s.id,
      date: s.date,
      batch: { id: s.batch_id, name: s.batch_name, startTime: s.start_time },
      startsAt: s.starts_at,
      verifyDueAt: new Date(Date.parse(s.starts_at) + verifyAfterMinutes * 60_000).toISOString(),
      submittedAt: s.submitted_at,
      verifiedAt: s.verified_at,
      attendanceTaken: rows.some((r) => r.status),
      counts,
      students,
    };
  }

  getBoard(date = this.today()) {
    if (date === this.today()) this.ensureTodaySessions();
    const sessions = this.db
      .prepare(
        `SELECT se.id FROM sessions se JOIN batches b ON b.id = se.batch_id
          WHERE se.date = ? AND (b.active = 1 OR se.verified_at IS NOT NULL)
          ORDER BY se.starts_at, b.name`,
      )
      .all(date);
    return {
      date,
      today: this.today(),
      now: this.nowIso(),
      tz: this.tz,
      settings: this.getSettings(),
      holiday: this.holidayOn(date),
      sessions: sessions.map((s) => this.getSessionView(s.id)),
      stats: this.getStats(date),
    };
  }

  getStats(date = this.today()) {
    const one = (sql, ...args) => this.db.prepare(sql).get(...args);
    const att = one(
      `SELECT SUM(a.status = 'P') AS onTime, SUM(a.status = 'T') AS late, SUM(a.status = 'A') AS absent, SUM(a.status = 'L') AS leave
         FROM attendance a JOIN sessions se ON se.id = a.session_id WHERE se.date = ?`,
      date,
    );
    const al = one(
      `SELECT COUNT(*) AS sent,
              SUM(al.status = 'replied') AS replied,
              SUM(al.status = 'sent') AS awaiting,
              SUM(al.status IN ('escalated', 'failed')) AS escalated,
              AVG((julianday(al.sent_at) - julianday(se.starts_at)) * 1440) AS avgMinutesToAlert
         FROM alerts al JOIN sessions se ON se.id = al.session_id WHERE se.date = ?`,
      date,
    );
    const openTasks = one("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'").n;
    return {
      present: (att.onTime ?? 0) + (att.late ?? 0), // late students did attend
      late: att.late ?? 0,
      leave: att.leave ?? 0,
      absent: att.absent ?? 0,
      leaveLate: (att.leave ?? 0) + (att.late ?? 0),
      alertsSent: al.sent ?? 0,
      replied: al.replied ?? 0,
      awaitingReply: al.awaiting ?? 0,
      escalated: al.escalated ?? 0,
      avgMinutesToAlert: al.avgMinutesToAlert == null ? null : Math.round(al.avgMinutesToAlert * 10) / 10,
      openTasks,
    };
  }

  listTasks(status = 'open') {
    return this.db
      .prepare(
        `SELECT t.id, t.status, t.reason, t.urgent, t.created_at AS createdAt, t.done_at AS doneAt, t.outcome,
                st.id AS studentId, st.name AS studentName, st.parent_name AS parentName, al.phone AS parentPhone,
                b.name AS batchName, se.date, se.starts_at AS startsAt, al.sent_at AS alertSentAt
           FROM tasks t
           JOIN alerts al ON al.id = t.alert_id
           JOIN students st ON st.id = al.student_id
           JOIN sessions se ON se.id = al.session_id
           JOIN batches b ON b.id = se.batch_id
          WHERE t.status = ?
          ORDER BY ${status === 'open' ? 't.urgent DESC, t.created_at ASC' : 't.done_at DESC'}
          LIMIT 200`,
      )
      .all(status);
  }

  // -------------------------------------------------------------- messages

  logMessage({ phone, direction, body, buttons = null, alertId = null, wamid = null }) {
    const r = this.db
      .prepare('INSERT INTO messages (phone, direction, body, buttons, alert_id, wamid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(phone, direction, body, buttons ? JSON.stringify(buttons) : null, alertId, wamid, this.nowIso());
    return Number(r.lastInsertRowid);
  }

  /** Record WhatsApp's message id for an outgoing message, so delivery updates can find it. */
  markSent(messageId, wamid) {
    this.db.prepare("UPDATE messages SET wamid = ?, status = 'sent', status_at = ? WHERE id = ?").run(wamid ?? null, this.nowIso(), messageId);
  }

  /**
   * A delivery update from WhatsApp for a message we sent. Updates arrive out of order, so a
   * status never moves backwards (read beats delivered beats sent); "failed" always wins.
   * An absence alert that can't be delivered goes straight to the call list.
   */
  handleStatus({ id, status, timestamp = null, error = null }) {
    if (!id || !DELIVERY_RANK[status]) return { matched: false };
    const msg = this.db.prepare("SELECT * FROM messages WHERE wamid = ? AND direction = 'out'").get(id);
    if (!msg) return { matched: false };
    if (status !== 'failed' && (DELIVERY_RANK[msg.status] ?? 0) >= DELIVERY_RANK[status]) return { matched: true };
    const at = timestamp ? new Date(Number(timestamp) * 1000).toISOString() : this.nowIso();
    const reason = error
      ? error.code === 131026
        ? 'This number is not on WhatsApp or cannot receive messages'
        : `${error.title || 'Delivery failed'}${error.code ? ` (code ${error.code})` : ''}`
      : null;
    this.db
      .prepare('UPDATE messages SET status = ?, status_at = ?, error = COALESCE(?, error) WHERE id = ?')
      .run(status, at, reason, msg.id);

    // The absence alert itself (acknowledgements carry no buttons).
    if (msg.alert_id && msg.buttons) {
      this.db.prepare('UPDATE alerts SET delivery = ? WHERE id = ?').run(status, msg.alert_id);
      if (status === 'failed') {
        const r = this.db
          .prepare("UPDATE alerts SET status = 'failed', error = ? WHERE id = ? AND status = 'sent'")
          .run(reason ?? 'Delivery failed', msg.alert_id);
        if (r.changes) this.createTask(msg.alert_id, `WhatsApp couldn't deliver: ${reason ?? 'unknown reason'}`);
      }
    }
    this.changed();
    return { matched: true };
  }

  listThreads() {
    const owner = this.rawSettings().ownerPhone;
    return this.db
      .prepare(
        `SELECT t.phone, t.count, m.body AS lastBody, m.created_at AS lastAt,
                (SELECT group_concat(name, ', ') FROM (SELECT DISTINCT name FROM students WHERE parent_phone = t.phone AND active = 1)) AS students,
                (SELECT parent_name FROM students WHERE parent_phone = t.phone AND parent_name IS NOT NULL LIMIT 1) AS parentName
           FROM (SELECT phone, MAX(id) AS lastId, COUNT(*) AS count FROM messages GROUP BY phone) t
           JOIN messages m ON m.id = t.lastId
          ORDER BY t.lastId DESC`,
      )
      .all()
      .map((t) => (t.phone === owner && !t.parentName ? { ...t, parentName: 'Owner · daily summary', isOwner: true } : t));
  }

  listMessages(phone) {
    const p = normalizePhone(phone);
    return this.db
      .prepare(
        `SELECT m.id, m.direction, m.body, m.buttons, m.alert_id AS alertId, m.error, m.status, m.created_at AS createdAt,
                al.status AS alertStatus
           FROM messages m LEFT JOIN alerts al ON al.id = m.alert_id
          WHERE m.phone = ? ORDER BY m.id`,
      )
      .all(p)
      .map((m) => ({ ...m, buttons: m.buttons ? JSON.parse(m.buttons) : null }));
  }

  // -------------------------------------------------------------- holidays

  holidayOn(date) {
    return this.db.prepare('SELECT label FROM holidays WHERE date = ?').get(date)?.label ?? null;
  }

  listHolidays() {
    return this.db.prepare('SELECT date, label FROM holidays ORDER BY date').all();
  }

  addHoliday({ date, label }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new HttpError(400, 'Pick a date');
    this.db
      .prepare('INSERT INTO holidays (date, label) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET label = excluded.label')
      .run(date, requireText(label, 'Holiday name', 60));
    // A holiday added for today removes today's untouched sessions.
    this.db
      .prepare(
        `DELETE FROM sessions WHERE date = ? AND verified_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.session_id = sessions.id)`,
      )
      .run(date);
    this.changed();
    return this.listHolidays();
  }

  deleteHoliday(date) {
    this.db.prepare('DELETE FROM holidays WHERE date = ?').run(date);
    this.changed();
    return this.listHolidays();
  }

  // ------------------------------------------------------- student insights

  /** Per-student attendance counts between two dates (inclusive). */
  studentStats({ from, to, batchId = null, studentId = null }) {
    const recentFrom = addDays(to, -(AT_RISK.recentDays - 1));
    const rows = this.db
      .prepare(
        `SELECT st.id, st.name, st.batch_id AS batchId, b.name AS batchName,
                st.parent_name AS parentName, st.parent_phone AS parentPhone,
                c.status AS consentStatus, c.source AS consentSource,
                COALESCE(SUM(x.status = 'P'), 0) AS P,
                COALESCE(SUM(x.status = 'A'), 0) AS A,
                COALESCE(SUM(x.status = 'L'), 0) AS L,
                COALESCE(SUM(x.status = 'T'), 0) AS T,
                COALESCE(SUM(x.status = 'A' AND x.note LIKE 'Bunk%'), 0) AS bunks,
                COUNT(x.status) AS total,
                COALESCE(SUM(x.status = 'A' AND x.date >= ?), 0) AS recentAbsences
           FROM students st
           JOIN batches b ON b.id = st.batch_id
           LEFT JOIN consents c ON c.phone = st.parent_phone
           LEFT JOIN (SELECT a.student_id, a.status, a.note, se.date
                        FROM attendance a JOIN sessions se ON se.id = a.session_id
                       WHERE se.date BETWEEN ? AND ?) x ON x.student_id = st.id
          WHERE st.active = 1 AND (? IS NULL OR st.batch_id = ?) AND (? IS NULL OR st.id = ?)
          GROUP BY st.id
          ORDER BY b.start_time, st.name`,
      )
      .all(recentFrom, from, to, batchId, batchId, studentId, studentId);
    return rows.map((r) => {
      const pct = r.total ? Math.round(((r.P + r.T) / r.total) * 100) : null; // late still attended
      const reasons = [];
      if (pct !== null && r.total >= 5 && pct < AT_RISK.minPct) reasons.push(`${pct}% attendance`);
      if (r.recentAbsences >= AT_RISK.recentAbsences) reasons.push(`${r.recentAbsences} absences in ${AT_RISK.recentDays} days`);
      if (r.bunks >= 2) reasons.push(`${r.bunks} bunks`);
      return { ...r, pct, atRisk: reasons.length > 0, riskReasons: reasons };
    });
  }

  /** Student directory: everyone with their last-30-day attendance. */
  getStudentDirectory({ batchId = null } = {}) {
    const to = this.today();
    return this.studentStats({ from: addDays(to, -29), to, batchId });
  }

  getStudentProfile(id) {
    const st = this.db
      .prepare(
        `SELECT st.*, b.name AS batch_name, b.start_time FROM students st JOIN batches b ON b.id = st.batch_id
          WHERE st.id = ? AND st.active = 1`,
      )
      .get(id);
    if (!st) throw new HttpError(404, 'Student not found');
    const today = this.today();
    const from = addDays(today, -89);
    const days = this.db
      .prepare(
        `SELECT se.date, a.status, a.note FROM attendance a JOIN sessions se ON se.id = a.session_id
          WHERE a.student_id = ? AND se.date BETWEEN ? AND ? ORDER BY se.date`,
      )
      .all(st.id, from, today);
    const holidays = this.db.prepare('SELECT date, label FROM holidays WHERE date BETWEEN ? AND ?').all(from, today);

    let streak = 0;
    for (const d of [...days].reverse()) {
      if (d.status !== 'A') break;
      streak++;
    }
    let presentStreak = 0;
    for (const d of [...days].reverse()) {
      if (d.status !== 'P') break;
      presentStreak++;
    }

    const alerts = this.db
      .prepare(
        `SELECT al.id, al.status, al.error, al.sent_at AS sentAt, al.reply, al.replied_at AS repliedAt, al.escalated_at AS escalatedAt,
                se.date, b.name AS batchName, t.outcome, t.status AS taskStatus
           FROM alerts al JOIN sessions se ON se.id = al.session_id JOIN batches b ON b.id = se.batch_id
           LEFT JOIN tasks t ON t.alert_id = al.id
          WHERE al.student_id = ? ORDER BY al.sent_at DESC LIMIT 25`,
      )
      .all(st.id)
      .map((a) => ({
        ...a,
        reply: a.reply ? REPLY_OPTIONS[a.reply]?.title ?? a.reply : null,
        replyMinutes: a.repliedAt ? Math.round((Date.parse(a.repliedAt) - Date.parse(a.sentAt)) / 6000) / 10 : null,
      }));

    const [s30] = this.studentStats({ from: addDays(today, -29), to: today, studentId: st.id });
    const [s90] = this.studentStats({ from, to: today, studentId: st.id });
    return {
      id: st.id,
      name: st.name,
      parentName: st.parent_name,
      parentPhone: st.parent_phone,
      consent: this.consentFor(st.parent_phone),
      consentLog: this.db
        .prepare('SELECT status, source, wording, recorded_by AS recordedBy, at FROM consent_log WHERE phone = ? ORDER BY id DESC LIMIT 10')
        .all(st.parent_phone),
      batch: { id: st.batch_id, name: st.batch_name, startTime: st.start_time },
      today,
      from,
      days,
      holidays,
      absentStreak: streak,
      presentStreak,
      stats30: s30,
      stats90: s90,
      alerts,
    };
  }

  /**
   * Bulk add students from CSV/TSV text: name, parent name, phone[, batch name].
   * With dryRun nothing is saved; every row comes back with its problem, if any.
   */
  importStudents({ csv, batchId = null, dryRun = false }) {
    const batches = this.listBatches();
    const fallback = batchId ? batches.find((b) => b.id === Number(batchId)) : null;
    const lines = String(csv ?? '')
      .split(/\r?\n/)
      .map((l, i) => ({ text: l.trim(), line: i + 1 }))
      .filter((l) => l.text);
    if (lines.length && /name/i.test(lines[0].text) && /phone|mobile|whatsapp/i.test(lines[0].text)) lines.shift();
    if (lines.length > 1000) throw new HttpError(400, 'Import at most 1000 students at a time');

    const rows = lines.map(({ text, line }) => {
      const cols = text.split(text.includes('\t') ? '\t' : ',').map((c) => c.trim().replace(/^"|"$/g, ''));
      const [name, parentName = '', phone = '', batchName = ''] = cols;
      const row = { line, name, parentName, phone, batchName: batchName || fallback?.name || '', error: null };
      const batch = batchName ? batches.find((b) => b.name.toLowerCase() === batchName.toLowerCase()) : fallback;
      if (!name) row.error = 'Missing student name';
      else if (!batch) row.error = batchName ? `No batch called "${batchName}"` : 'Pick a batch';
      else {
        const p = normalizePhone(phone);
        if (p.length < 11 || p.length > 15) row.error = 'Invalid phone number';
        else {
          row.phone = p;
          row.batchId = batch.id;
          row.batchName = batch.name;
        }
      }
      return row;
    });

    let added = 0;
    if (!dryRun) {
      const insert = this.db.prepare('INSERT INTO students (batch_id, name, parent_name, parent_phone) VALUES (?, ?, ?, ?)');
      this.db.exec('BEGIN');
      try {
        for (const r of rows) {
          if (r.error) continue;
          insert.run(r.batchId, r.name.slice(0, 80), r.parentName.slice(0, 80) || null, r.phone);
          added++;
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
      this.changed();
    }
    return { rows, added, valid: rows.filter((r) => !r.error).length };
  }

  // ---------------------------------------------------------------- reports

  getReport({ from, to, batchId = null }) {
    const today = this.today();
    to = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : today;
    from = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : addDays(to, -29);
    if (from > to) [from, to] = [to, from];
    if (daysBetween(from, to) > 366) throw new HttpError(400, 'Pick a range of at most one year');
    const b = batchId ? Number(batchId) : null;

    const daily = this.db
      .prepare(
        `SELECT se.date, SUM(a.status = 'P') AS P, SUM(a.status = 'A') AS A, SUM(a.status = 'L') AS L, SUM(a.status = 'T') AS T, COUNT(*) AS total
           FROM attendance a JOIN sessions se ON se.id = a.session_id
          WHERE se.date BETWEEN ? AND ? AND (? IS NULL OR se.batch_id = ?)
          GROUP BY se.date ORDER BY se.date`,
      )
      .all(from, to, b, b);
    const dailyMap = new Map(daily.map((d) => [d.date, d]));
    const holidays = new Map(this.db.prepare('SELECT date, label FROM holidays WHERE date BETWEEN ? AND ?').all(from, to).map((h) => [h.date, h.label]));
    const series = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const row = dailyMap.get(d);
      series.push({
        date: d,
        P: row?.P ?? 0,
        A: row?.A ?? 0,
        L: row?.L ?? 0,
        T: row?.T ?? 0,
        total: row?.total ?? 0,
        pct: row?.total ? Math.round(((row.P + row.T) / row.total) * 100) : null,
        holiday: holidays.get(d) ?? null,
      });
    }

    const batches = this.db
      .prepare(
        `SELECT b.id, b.name, b.start_time AS startTime, COUNT(DISTINCT se.id) AS sessions,
                COALESCE(SUM(a.status = 'P'), 0) AS P, COALESCE(SUM(a.status = 'A'), 0) AS A,
                COALESCE(SUM(a.status = 'L'), 0) AS L, COALESCE(SUM(a.status = 'T'), 0) AS T, COUNT(a.status) AS total
           FROM batches b
           LEFT JOIN sessions se ON se.batch_id = b.id AND se.date BETWEEN ? AND ?
           LEFT JOIN attendance a ON a.session_id = se.id
          WHERE b.active = 1 AND (? IS NULL OR b.id = ?)
          GROUP BY b.id ORDER BY b.start_time`,
      )
      .all(from, to, b, b)
      .map((r) => ({ ...r, pct: r.total ? Math.round(((r.P + r.T) / r.total) * 100) : null }));

    const al = this.db
      .prepare(
        `SELECT COUNT(*) AS sent,
                COALESCE(SUM(al.status = 'replied'), 0) AS replied,
                COALESCE(SUM(al.status IN ('escalated', 'failed')), 0) AS escalated,
                AVG(CASE WHEN al.replied_at IS NOT NULL THEN (julianday(al.replied_at) - julianday(al.sent_at)) * 1440 END) AS avgReplyMin,
                AVG((julianday(al.sent_at) - julianday(se.starts_at)) * 1440) AS avgMinToAlert,
                AVG((julianday(se.starts_at) - julianday(al.sent_at)) * 1440 + b.duration_minutes) AS avgMinBeforeClassEnd
           FROM alerts al JOIN sessions se ON se.id = al.session_id JOIN batches b ON b.id = se.batch_id
          WHERE se.date BETWEEN ? AND ? AND (? IS NULL OR se.batch_id = ?)`,
      )
      .get(from, to, b, b);
    const calls = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(t.status = 'done'), 0) AS done,
                COALESCE(SUM(t.outcome LIKE 'Bunk%'), 0) AS bunks,
                COALESCE(SUM(t.outcome LIKE 'Parent unreachable%'), 0) AS unreachable
           FROM tasks t JOIN alerts al ON al.id = t.alert_id JOIN sessions se ON se.id = al.session_id
          WHERE se.date BETWEEN ? AND ? AND (? IS NULL OR se.batch_id = ?)`,
      )
      .get(from, to, b, b);

    const students = this.studentStats({ from, to, batchId: b });
    const totals = series.reduce((t, d) => ({ P: t.P + d.P, A: t.A + d.A, L: t.L + d.L, T: t.T + d.T, total: t.total + d.total }), { P: 0, A: 0, L: 0, T: 0, total: 0 });
    const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
    return {
      from,
      to,
      batchId: b,
      totals: { ...totals, pct: totals.total ? Math.round(((totals.P + totals.T) / totals.total) * 100) : null },
      series,
      batches,
      alerts: {
        sent: al.sent,
        replied: al.replied,
        escalated: al.escalated,
        replyRate: al.sent ? Math.round((al.replied / al.sent) * 100) : null,
        avgReplyMin: round1(al.avgReplyMin),
        avgMinToAlert: round1(al.avgMinToAlert),
        avgMinBeforeClassEnd: al.avgMinBeforeClassEnd == null ? null : Math.round(al.avgMinBeforeClassEnd),
      },
      calls,
      students,
      atRisk: students.filter((s) => s.atRisk),
    };
  }

  // ------------------------------------------------------- timeline, feed

  /** The story of one class, step by step (what the reel animates). */
  getTimeline(sessionId) {
    const s = this.db
      .prepare('SELECT se.*, b.name AS batch_name FROM sessions se JOIN batches b ON b.id = se.batch_id WHERE se.id = ?')
      .get(sessionId);
    if (!s) throw new HttpError(404, 'Session not found');
    const nowIso = this.nowIso();
    const ev = [];
    const push = (at, kind, text, extra = {}) => at && at <= nowIso && ev.push({ at, kind, text, sessionId: s.id, batch: s.batch_name, ...extra });

    push(s.starts_at, 'start', 'Class started');
    const marks = this.db
      .prepare(
        `SELECT MIN(updated_at) AS first, MAX(updated_at) AS last, COUNT(*) AS n
           FROM attendance WHERE session_id = ? AND source = 'teacher'`,
      )
      .get(s.id);
    if (s.submitted_at) push(s.submitted_at, 'submit', 'Teacher sent attendance to the office');
    else if (marks.n) push(marks.last, 'mark', `Teacher marked ${marks.n} student${marks.n === 1 ? '' : 's'} (not sent yet)`);
    if (s.verified_at) {
      const c = this.db
        .prepare(
          `SELECT SUM(status = 'P') AS P, SUM(status = 'T') AS T, SUM(status = 'A') AS A, SUM(status = 'L') AS L
             FROM attendance WHERE session_id = ?`,
        )
        .get(s.id);
      push(s.verified_at, 'verify', `Verified: ${(c.P ?? 0) + (c.T ?? 0)} present (${c.T ?? 0} late), ${c.A ?? 0} absent, ${c.L ?? 0} on leave`);
    }
    const alerts = this.db
      .prepare(
        `SELECT al.*, st.name, st.parent_name, t.done_at, t.outcome FROM alerts al
           JOIN students st ON st.id = al.student_id LEFT JOIN tasks t ON t.alert_id = al.id
          WHERE al.session_id = ?`,
      )
      .all(s.id);
    for (const a of alerts) {
      const parent = a.parent_name || 'Parent';
      const who = { studentId: a.student_id, student: a.name };
      push(a.sent_at, a.status === 'failed' ? 'fail' : 'alert', a.status === 'failed' ? `WhatsApp to ${parent} failed (${a.name})` : `WhatsApp sent to ${parent} about ${a.name}`, who);
      if (a.replied_at && a.reply === 'MISSING') push(a.replied_at, 'escalate', `${parent} doesn't know where ${a.name} is: urgent call`, who);
      else if (a.replied_at) push(a.replied_at, 'reply', `${parent} replied: ${REPLY_OPTIONS[a.reply]?.title ?? a.reply}`, who);
      if (a.escalated_at) push(a.escalated_at, 'escalate', `No reply from ${parent}: call task created`, who);
      if (a.done_at) push(a.done_at, 'call', `Staff called about ${a.name}: ${a.outcome}`, who);
    }
    return ev.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  }

  /** Latest events across today's classes. */
  getActivity(limit = 15) {
    const ids = this.db.prepare('SELECT id FROM sessions WHERE date = ?').all(this.today());
    return ids
      .flatMap((r) => this.getTimeline(r.id))
      .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0))
      .slice(0, limit);
  }

  // ------------------------------------------------------- daily digest

  buildDigest(date = this.today()) {
    const st = this.getStats(date);
    const name = this.rawSettings().instituteName;
    const label = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
    const risk = this.getStudentDirectory().filter((s) => s.atRisk).slice(0, 5);
    const calls = this.db
      .prepare(
        `SELECT COALESCE(SUM(t.status = 'done'), 0) AS done, COALESCE(SUM(t.status = 'open'), 0) AS open,
                COALESCE(SUM(t.outcome LIKE 'Bunk%'), 0) AS bunks
           FROM tasks t JOIN alerts al ON al.id = t.alert_id JOIN sessions se ON se.id = al.session_id WHERE se.date = ?`,
      )
      .get(date);
    const lines = [
      `📋 ${name}: summary for ${label}`,
      `✅ Present ${st.present} (${st.late} late) · ❌ Absent ${st.absent} · 🕒 Leave ${st.leave}`,
      `💬 WhatsApp alerts ${st.alertsSent} (${st.replied} replied)`,
      `📞 Calls ${calls.done} done${calls.open ? `, ${calls.open} pending` : ''}${calls.bunks ? ` · ${calls.bunks} bunk${calls.bunks > 1 ? 's' : ''} caught` : ''}`,
    ];
    if (st.avgMinutesToAlert != null) lines.push(`⏱ Parents informed ${st.avgMinutesToAlert} min after class start`);
    const notSent = this.db
      .prepare(
        `SELECT b.name FROM sessions se JOIN batches b ON b.id = se.batch_id
          WHERE se.date = ? AND se.submitted_at IS NULL AND se.starts_at <= ? ORDER BY se.starts_at`,
      )
      .all(date, this.nowIso());
    if (notSent.length) lines.push(`📝 Attendance not sent by teacher: ${notSent.map((r) => r.name).join(', ')}`);
    if (risk.length) lines.push(`⚠️ Needs attention: ${risk.map((r) => `${r.name} (${r.batchName})`).join(', ')}`);
    return lines.join('\n');
  }

  /**
   * Values for the approved owner-summary template, in order:
   * {{1}} institute · {{2}} date · {{3}} present · {{4}} absent · {{5}} leave or late ·
   * {{6}} alerts sent · {{7}} parents replied · {{8}} calls pending
   */
  digestParams(date = this.today()) {
    const st = this.getStats(date);
    const label = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
    return [this.rawSettings().instituteName, label, st.present, st.absent, st.leaveLate, st.alertsSent, st.replied, st.openTasks];
  }

  async maybeSendDigest({ force = false } = {}) {
    const s = this.rawSettings();
    const today = this.today();
    if (!force) {
      if (s.digestEnabled !== '1' || !s.ownerPhone || s.lastDigestDate === today) return false;
      if (localTime(this.tz, this.clock()) < s.digestTime) return false;
    }
    if (!s.ownerPhone) throw new HttpError(400, "Add the owner's WhatsApp number first");
    this.setSetting('lastDigestDate', today);
    const text = this.buildDigest(today);
    const msg = this.logMessage({ phone: s.ownerPhone, direction: 'out', body: text });
    try {
      // On real WhatsApp this goes out as the approved owner-summary template (single-line values).
      const { id } = await this.messenger.send({ to: s.ownerPhone, text, template: 'digest', params: this.digestParams(today) });
      this.markSent(msg, id);
    } catch (err) {
      this.logger.error?.(`Owner summary failed: ${err.message}`);
      this.db.prepare("UPDATE messages SET error = ?, status = 'failed' WHERE id = ?").run(err.message, msg);
    }
    this.changed();
    return true;
  }
}
