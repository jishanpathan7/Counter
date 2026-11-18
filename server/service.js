import { formatTime, localDate, localWeekday, zonedTimeToIso } from './time.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DEFAULT_SETTINGS = {
  instituteName: 'My Coaching Institute',
  verifyAfterMinutes: '10', // Step 2: absent entries are verified this long after class starts
  replyTimeoutMinutes: '3', // Step 6: no parent reply within this → staff call task
};

/** Parent reply options sent as WhatsApp quick-reply buttons. */
export const REPLY_OPTIONS = {
  LEAVE: { title: 'Leave', status: 'L', note: 'Leave (parent replied)' },
  LATE: { title: 'Late 15 min', status: 'L', note: 'Late 15 min (parent replied)' },
};

/** Outcomes staff can record after calling a parent. */
export const TASK_OUTCOMES = {
  leave: { status: 'L', note: 'Leave (confirmed on call)' },
  late: { status: 'L', note: 'Late (confirmed on call)' },
  present: { status: 'P', note: 'Present (confirmed on call)' },
  bunk: { status: 'A', note: 'Bunk, parent informed on call' },
  unreachable: { status: 'A', note: 'Parent unreachable' },
};

const STATUSES = ['P', 'A', 'L'];
/** If the teacher is still marking at verify time, wait until they've stopped for this long. */
export const MARKING_QUIET_MS = 90_000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`; // Indian mobile number without country code
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits;
}

/** Map a free-text WhatsApp reply to a reply option, if it clearly means one. */
export function parseReplyText(text) {
  const t = String(text ?? '').toLowerCase();
  if (!t.trim()) return null;
  const late = /\b(late|der|aa raha|aa rahi|coming|on the way|raste)\b/.test(t);
  const leave = /\b(leave|chutti|chhutti|holiday|sick|bimar|beemar|nahi aayega|nahi aayegi|absent)\b/.test(t);
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

function parsePhone(value) {
  const phone = normalizePhone(value);
  if (phone.length < 11 || phone.length > 15) throw new HttpError(400, 'Enter a valid WhatsApp number');
  return phone;
}

export class AttendanceService {
  constructor({ db, messenger, clock = () => Date.now(), tz = 'Asia/Kolkata', onChange = () => {}, logger = console }) {
    this.db = db;
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

  getSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const s = { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
    return {
      instituteName: s.instituteName,
      verifyAfterMinutes: Number(s.verifyAfterMinutes),
      replyTimeoutMinutes: Number(s.replyTimeoutMinutes),
    };
  }

  updateSettings(patch = {}) {
    const upsert = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    if (patch.instituteName !== undefined) upsert.run('instituteName', requireText(patch.instituteName, 'Institute name'));
    for (const key of ['verifyAfterMinutes', 'replyTimeoutMinutes']) {
      if (patch[key] === undefined) continue;
      const n = Number(patch[key]);
      if (!Number.isFinite(n) || n < 0 || n > 240) throw new HttpError(400, `${key} must be between 0 and 240 minutes`);
      upsert.run(key, String(n));
    }
    this.changed();
    return this.getSettings();
  }

  // ----------------------------------------------------------------- batches

  listBatches() {
    return this.db
      .prepare(
        `SELECT b.id, b.name, b.start_time AS startTime, b.days,
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

  createBatch({ name, startTime, days = [1, 2, 3, 4, 5, 6] }) {
    const n = requireText(name, 'Batch name');
    if (!TIME_RE.test(String(startTime))) throw new HttpError(400, 'Start time must be HH:MM');
    const r = this.db
      .prepare('INSERT INTO batches (name, start_time, days) VALUES (?, ?, ?)')
      .run(n, startTime, parseDays(days));
    this.changed();
    return this.listBatches().find((b) => b.id === Number(r.lastInsertRowid));
  }

  updateBatch(id, patch = {}) {
    const b = this.getBatch(id);
    const name = patch.name !== undefined ? requireText(patch.name, 'Batch name') : b.name;
    const startTime = patch.startTime !== undefined ? patch.startTime : b.start_time;
    if (!TIME_RE.test(String(startTime))) throw new HttpError(400, 'Start time must be HH:MM');
    const days = patch.days !== undefined ? parseDays(patch.days) : b.days;
    this.db.prepare('UPDATE batches SET name = ?, start_time = ?, days = ? WHERE id = ?').run(name, startTime, days, b.id);
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

  deleteStudent(id) {
    const r = this.db.prepare('UPDATE students SET active = 0 WHERE id = ? AND active = 1').run(id);
    if (!r.changes) throw new HttpError(404, 'Student not found');
    this.changed();
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
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Status must be P, A or L');
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
        this.closeTaskFor(session.id, student.id, `Marked ${status === 'P' ? 'present' : 'leave/late'} by ${source}`);
      }
    }
    this.changed();
  }

  async markAll(sessionId, status) {
    const session = this.getSessionRow(sessionId);
    const students = this.listStudents(session.batch_id);
    for (const st of students) await this.mark(session.id, st.id, status);
  }

  // ----------------------------- Step 2 + 3: verify, then alert the parents

  async verify(sessionId) {
    const session = this.getSessionRow(sessionId);
    const at = this.nowIso();
    const r = this.db.prepare('UPDATE sessions SET verified_at = ? WHERE id = ? AND verified_at IS NULL').run(at, session.id);
    if (!r.changes) return; // already verified (possibly by a concurrent tick)

    // Anyone the teacher did not mark has no attendance record, so treat them as absent.
    this.db
      .prepare(
        `INSERT INTO attendance (session_id, student_id, status, note, source, updated_at)
         SELECT ?, s.id, 'A', 'Not marked by teacher', 'system', ?
           FROM students s
          WHERE s.batch_id = ? AND s.active = 1
            AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.session_id = ? AND a.student_id = s.id)`,
      )
      .run(session.id, at, session.batch_id, session.id);

    const absentees = this.db
      .prepare(
        `SELECT s.* FROM attendance a JOIN students s ON s.id = a.student_id
          WHERE a.session_id = ? AND a.status = 'A' AND s.active = 1
            AND NOT EXISTS (SELECT 1 FROM alerts al WHERE al.session_id = a.session_id AND al.student_id = s.id)
          ORDER BY s.name`,
      )
      .all(session.id);

    const verified = { ...session, verified_at: at };
    for (const student of absentees) await this.sendAlert(verified, student);
    this.changed();
  }

  async sendAlert(session, student) {
    const batch = this.db.prepare('SELECT * FROM batches WHERE id = ?').get(session.batch_id);
    const r = this.db
      .prepare("INSERT OR IGNORE INTO alerts (session_id, student_id, phone, status, sent_at) VALUES (?, ?, ?, 'sent', ?)")
      .run(session.id, student.id, student.parent_phone, this.nowIso());
    if (!r.changes) return; // one alert per student per session
    const alertId = Number(r.lastInsertRowid);

    const time = formatTime(this.tz, session.starts_at);
    const parentName = student.parent_name || 'Parent';
    const text =
      `Namaste ${parentName}, aaj ki ${batch.name} class (${time}) mein ${student.name} ki attendance record nahi hui. ` +
      `Please confirm.`;
    const buttons = Object.entries(REPLY_OPTIONS).map(([key, o]) => ({ id: `${key}:${alertId}`, title: o.title }));

    const msg = this.logMessage({ phone: student.parent_phone, direction: 'out', body: text, buttons, alertId });
    try {
      await this.messenger.send({
        to: student.parent_phone,
        text,
        buttons,
        params: [parentName, batch.name, time, student.name],
      });
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
  async handleReply({ phone, payload = null, text = '' }) {
    const from = normalizePhone(phone);
    let alert = null;
    let choice = null;

    const m = /^(LEAVE|LATE):(\d+)$/.exec(String(payload ?? ''));
    if (m) {
      choice = m[1];
      alert = this.db.prepare('SELECT * FROM alerts WHERE id = ? AND phone = ?').get(Number(m[2]), from) ?? null;
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

    this.logMessage({ phone: from, direction: 'in', body: String(text || payload || '').slice(0, 1000), alertId: alert?.id ?? null });

    if (!alert || !choice) {
      this.changed();
      return { matched: false };
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
    this.closeTaskFor(alert.session_id, alert.student_id, `Parent replied: ${option.title}`);

    const ack = `Thank you. Noted: ${option.title}.`;
    this.logMessage({ phone: from, direction: 'out', body: ack, alertId: alert.id });
    try {
      await this.messenger.send({ to: from, text: ack });
    } catch (err) {
      this.logger.error?.(`WhatsApp acknowledgement failed: ${err.message}`);
    }

    this.changed();
    return { matched: true, alertId: alert.id, choice };
  }

  // ---------------------------------------------- Step 6: staff call tasks

  createTask(alertId, reason) {
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

    // Only sessions where the teacher has taken attendance. Otherwise a batch added after its
    // start time (or a server started mid-day) would mark everyone absent and message every parent.
    const due = this.db
      .prepare(
        `SELECT * FROM sessions se WHERE se.verified_at IS NULL AND se.date = ?
           AND EXISTS (SELECT 1 FROM attendance a WHERE a.session_id = se.id)`,
      )
      .all(this.today());
    for (const s of due) {
      if (now < Date.parse(s.starts_at) + verifyAfterMinutes * 60_000) continue;
      // Don't verify while the teacher is still mid-way through marking: wait until everyone
      // is marked, or until there have been no new marks for a short quiet period.
      const { unmarked, lastMark } = this.db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM students st WHERE st.batch_id = ? AND st.active = 1
                    AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.session_id = ? AND a.student_id = st.id)) AS unmarked,
                  (SELECT MAX(updated_at) FROM attendance WHERE session_id = ?) AS lastMark`,
        )
        .get(s.batch_id, s.id, s.id);
      if (unmarked > 0 && now < Date.parse(lastMark) + MARKING_QUIET_MS) continue;
      await this.verify(s.id);
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
                al.id AS alert_id, al.status AS alert_status, al.sent_at, al.reply, al.replied_at, al.escalated_at, al.error,
                t.id AS task_id, t.status AS task_status, t.outcome AS task_outcome
           FROM students st
           LEFT JOIN attendance a ON a.session_id = ? AND a.student_id = st.id
           LEFT JOIN alerts al ON al.session_id = ? AND al.student_id = st.id
           LEFT JOIN tasks t ON t.alert_id = al.id
          WHERE st.batch_id = ? AND (st.active = 1 OR a.status IS NOT NULL)
          ORDER BY st.name`,
      )
      .all(s.id, s.id, s.batch_id);

    const counts = { P: 0, A: 0, L: 0, unmarked: 0 };
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
              sentAt: r.sent_at,
              replyDueAt: new Date(Date.parse(r.sent_at) + replyTimeoutMinutes * 60_000).toISOString(),
              reply: r.reply ? REPLY_OPTIONS[r.reply]?.title ?? r.reply : null,
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
      sessions: sessions.map((s) => this.getSessionView(s.id)),
      stats: this.getStats(date),
    };
  }

  getStats(date = this.today()) {
    const one = (sql, ...args) => this.db.prepare(sql).get(...args);
    const att = one(
      `SELECT SUM(a.status = 'P') AS present, SUM(a.status = 'A') AS absent, SUM(a.status = 'L') AS leaveLate
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
      present: att.present ?? 0,
      absent: att.absent ?? 0,
      leaveLate: att.leaveLate ?? 0,
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
        `SELECT t.id, t.status, t.reason, t.created_at AS createdAt, t.done_at AS doneAt, t.outcome,
                st.id AS studentId, st.name AS studentName, st.parent_name AS parentName, al.phone AS parentPhone,
                b.name AS batchName, se.date, se.starts_at AS startsAt, al.sent_at AS alertSentAt
           FROM tasks t
           JOIN alerts al ON al.id = t.alert_id
           JOIN students st ON st.id = al.student_id
           JOIN sessions se ON se.id = al.session_id
           JOIN batches b ON b.id = se.batch_id
          WHERE t.status = ?
          ORDER BY ${status === 'open' ? 't.created_at ASC' : 't.done_at DESC'}
          LIMIT 200`,
      )
      .all(status);
  }

  // -------------------------------------------------------------- messages

  logMessage({ phone, direction, body, buttons = null, alertId = null }) {
    const r = this.db
      .prepare('INSERT INTO messages (phone, direction, body, buttons, alert_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(phone, direction, body, buttons ? JSON.stringify(buttons) : null, alertId, this.nowIso());
    return Number(r.lastInsertRowid);
  }

  listThreads() {
    return this.db
      .prepare(
        `SELECT t.phone, t.count, m.body AS lastBody, m.created_at AS lastAt,
                (SELECT group_concat(name, ', ') FROM (SELECT DISTINCT name FROM students WHERE parent_phone = t.phone AND active = 1)) AS students,
                (SELECT parent_name FROM students WHERE parent_phone = t.phone AND parent_name IS NOT NULL LIMIT 1) AS parentName
           FROM (SELECT phone, MAX(id) AS lastId, COUNT(*) AS count FROM messages GROUP BY phone) t
           JOIN messages m ON m.id = t.lastId
          ORDER BY t.lastId DESC`,
      )
      .all();
  }

  listMessages(phone) {
    const p = normalizePhone(phone);
    return this.db
      .prepare(
        `SELECT m.id, m.direction, m.body, m.buttons, m.alert_id AS alertId, m.error, m.created_at AS createdAt,
                al.status AS alertStatus
           FROM messages m LEFT JOIN alerts al ON al.id = m.alert_id
          WHERE m.phone = ? ORDER BY m.id`,
      )
      .all(p)
      .map((m) => ({ ...m, buttons: m.buttons ? JSON.parse(m.buttons) : null }));
  }
}
