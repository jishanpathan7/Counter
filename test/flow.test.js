import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../server/db.js';
import { AttendanceService, normalizePhone, parseReplyText } from '../server/service.js';
import { buildPayload, parseWebhook, verifySignature } from '../server/messaging.js';
import { zonedTimeToIso, localDate } from '../server/time.js';

const TZ = 'Asia/Kolkata';
const MIN = 60_000;

function setup({ failSend = false } = {}) {
  let now = Date.parse('2026-11-18T10:25:00Z'); // 3:55 PM IST, a Wednesday
  const sent = [];
  const messenger = {
    mode: 'test',
    async send(msg) {
      if (failSend && msg.buttons) throw new Error('boom');
      sent.push(msg);
      return { id: 'x' };
    },
  };
  const db = openDb(':memory:');
  const service = new AttendanceService({ db, messenger, tz: TZ, clock: () => now, logger: { error() {} } });
  const batch = service.createBatch({ name: 'Batch B', startTime: '16:00', days: [0, 1, 2, 3, 4, 5, 6] });
  const ids = {};
  for (const [name, phone] of [['Aarav', '9000000001'], ['Diya', '9000000002'], ['Rohan', '9000000003'], ['Meera', '9000000004']]) {
    ids[name] = service.createStudent({ batchId: batch.id, name, parentName: `${name} parent`, parentPhone: phone }).id;
  }
  const session = service.ensureSession(batch.id);
  return {
    service,
    sent,
    batch,
    session,
    ids,
    advance: (ms) => (now += ms),
    view: () => service.getSessionView(session.id),
    student: (name) => service.getSessionView(session.id).students.find((s) => s.name === name),
  };
}

test('time zone helpers', () => {
  assert.equal(zonedTimeToIso(TZ, '2026-11-18', '16:00'), '2026-11-18T10:30:00.000Z');
  assert.equal(localDate(TZ, Date.parse('2026-11-18T19:00:00Z')), '2026-11-19');
  assert.equal(zonedTimeToIso('America/New_York', '2026-07-01', '09:00'), '2026-07-01T13:00:00.000Z');
});

test('phone numbers and free-text replies are normalised', () => {
  assert.equal(normalizePhone('90000 00001'), '919000000001');
  assert.equal(normalizePhone('+91 90000-00001'), '919000000001');
  assert.equal(normalizePhone('09000000001'), '919000000001');
  assert.equal(parseReplyText('Aaj chutti hai'), 'LEAVE');
  assert.equal(parseReplyText('thoda late aa raha hai'), 'LATE');
  assert.equal(parseReplyText('ok'), null);
});

test('the whole reel flow: mark absentees, send, verify, alert, reply, auto-update, escalate, call', async () => {
  const t = setup();
  const { service, session, ids } = t;

  // Step 1: the teacher taps only the absentees, then sends the list at 3:58.
  await service.mark(session.id, ids.Rohan, 'A');
  await service.mark(session.id, ids.Meera, 'A');
  t.advance(3 * MIN);
  await service.submit(session.id);
  assert.ok(t.view().submittedAt);

  // Before 4:10 nothing is verified.
  t.advance(11 * MIN); // 4:09
  await service.tick();
  assert.equal(t.view().verifiedAt, null);
  assert.equal(t.sent.length, 0);

  // Step 2 + 3: at 4:10 absentees are verified and parents get WhatsApp alerts.
  t.advance(1 * MIN); // 4:10
  await service.tick();
  const v = t.view();
  assert.ok(v.verifiedAt);
  assert.deepEqual(v.counts, { P: 2, A: 2, L: 0, T: 0, unmarked: 0 }, 'untapped students are present');
  assert.equal(t.sent.length, 2);
  const rohanMsg = t.sent.find((m) => m.to === '919000000003');
  assert.match(rohanMsg.text, /Rohan ki attendance record nahi hui/);
  assert.match(rohanMsg.text, /4:00 PM/);
  assert.deepEqual(rohanMsg.buttons.map((b) => b.title), ['Leave', 'Late 15 min', 'Mujhe call karein']);
  assert.deepEqual(rohanMsg.params, ['Rohan parent', 'Batch B', '4:00 PM', 'Rohan']);

  // A second tick must not send duplicate alerts.
  await service.tick();
  assert.equal(t.sent.length, 2);

  // Step 4 + 5: Rohan's parent taps "Late 15 min" at 4:12; the record updates itself to Late.
  t.advance(2 * MIN);
  const lateBtn = rohanMsg.buttons.find((b) => b.title === 'Late 15 min');
  const r = await service.handleReply({ phone: '919000000003', payload: lateBtn.id, text: 'Late 15 min' });
  assert.equal(r.matched, true);
  assert.equal(t.student('Rohan').status, 'T');
  assert.equal(t.student('Rohan').alert.reply, 'Late 15 min');
  assert.equal(t.sent.at(-1).text, 'Thank you. Noted: Late 15 min.');

  // Step 6: Meera's parent does not reply within 10 minutes → staff call task.
  t.advance(7 * MIN); // 4:19, 9 minutes after the alert
  await service.tick();
  assert.equal(service.listTasks('open').length, 0);
  t.advance(1 * MIN); // 4:20
  await service.tick();
  assert.equal(t.student('Meera').alert.status, 'escalated');
  const tasks = service.listTasks('open');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].studentName, 'Meera');
  assert.equal(tasks[0].reason, 'No reply in 10 min');

  // Staff calls: it was a bunk.
  service.completeTask(tasks[0].id, { outcome: 'bunk' });
  assert.equal(service.listTasks('open').length, 0);
  assert.equal(t.student('Meera').status, 'A');
  assert.match(t.student('Meera').note, /Bunk/);

  const stats = service.getStats();
  assert.equal(stats.present, 3, 'late students count as present');
  assert.equal(stats.late, 1);
  assert.equal(stats.alertsSent, 2);
  assert.equal(stats.replied, 1);
  assert.equal(stats.escalated, 1);
  assert.equal(stats.avgMinutesToAlert, 10);
});

test('a late reply after escalation still updates the record and closes the call task', async () => {
  const t = setup();
  await t.service.markAll(t.session.id, 'P');
  await t.service.mark(t.session.id, t.ids.Aarav, 'A');
  await t.service.verify(t.session.id);
  t.advance(11 * MIN);
  await t.service.tick();
  assert.equal(t.service.listTasks('open').length, 1);

  const r = await t.service.handleReply({ phone: '9000000001', text: 'sorry, aaj chutti hai' });
  assert.equal(r.matched, true);
  assert.equal(t.student('Aarav').status, 'L');
  assert.equal(t.service.listTasks('open').length, 0);
  assert.equal(t.service.listTasks('done')[0].outcome, 'Parent replied: Leave');
});

test('replies cannot touch another parent\'s alert', async () => {
  const t = setup();
  await t.service.markAll(t.session.id, 'A');
  await t.service.verify(t.session.id);
  const alertId = t.student('Rohan').alert.id;
  // Diya's parent sends a payload carrying Rohan's alert id.
  const r = await t.service.handleReply({ phone: '9000000002', payload: `LEAVE:${alertId}` });
  assert.equal(t.student('Rohan').status, 'A');
  // It falls back to Diya's own alert instead.
  assert.equal(r.matched, true);
  assert.equal(t.student('Diya').status, 'L');
});

test('marking absent after verification alerts immediately; marking present closes the task', async () => {
  const t = setup();
  await t.service.markAll(t.session.id, 'P');
  await t.service.verify(t.session.id);
  assert.equal(t.sent.length, 0);

  await t.service.mark(t.session.id, t.ids.Diya, 'A');
  assert.equal(t.sent.length, 1);
  t.advance(11 * MIN);
  await t.service.tick();
  assert.equal(t.service.listTasks('open').length, 1);

  await t.service.mark(t.session.id, t.ids.Diya, 'P');
  assert.equal(t.service.listTasks('open').length, 0);
});

test('no parent is messaged for a class the teacher never sent, even if it is partly marked', async () => {
  const t = setup();
  t.advance(60 * MIN); // well past 4:10
  await t.service.tick();
  assert.equal(t.view().verifiedAt, null);
  assert.equal(t.sent.length, 0);

  // The teacher marks Rohan absent but gets distracted and never sends the list.
  await t.service.mark(t.session.id, t.ids.Rohan, 'A');
  t.advance(30 * MIN);
  await t.service.tick();
  assert.equal(t.view().verifiedAt, null);
  assert.equal(t.view().submittedAt, null);
  assert.equal(t.sent.length, 0, 'unsent classes never alert parents');
  assert.match(t.service.buildDigest(), /not sent by teacher: Batch B/);

  // Sending it late verifies immediately; untapped students are present, so only Rohan's parent hears.
  await t.service.submit(t.session.id);
  assert.ok(t.view().verifiedAt);
  assert.equal(t.sent.length, 1);
  assert.equal(t.student('Meera').status, 'P');
});

test('a list sent early waits for the verify time, and marks can still change until then', async () => {
  const t = setup(); // 3:55
  await t.service.mark(t.session.id, t.ids.Rohan, 'A');
  await t.service.submit(t.session.id);
  t.advance(10 * MIN); // 4:05: Rohan walks in; Meera turns out to be late
  await t.service.mark(t.session.id, t.ids.Rohan, 'P');
  await t.service.mark(t.session.id, t.ids.Meera, 'T');
  await t.service.tick();
  assert.equal(t.view().verifiedAt, null);
  t.advance(5 * MIN); // 4:10
  await t.service.tick();
  assert.ok(t.view().verifiedAt);
  assert.equal(t.sent.length, 0, 'nobody absent, nobody alerted');
  assert.deepEqual(t.view().counts, { P: 3, A: 0, L: 0, T: 1, unmarked: 0 });
});

test('a failed WhatsApp send goes straight to a staff call task', async () => {
  const t = setup({ failSend: true });
  await t.service.mark(t.session.id, t.ids.Aarav, 'A');
  await t.service.verify(t.session.id);
  assert.equal(t.student('Aarav').alert.status, 'failed');
  const [task] = t.service.listTasks('open');
  assert.equal(task.reason, 'WhatsApp message failed');
});

test('WhatsApp payloads and webhook parsing', () => {
  const buttons = [{ id: 'LEAVE:1', title: 'Leave' }, { id: 'LATE:1', title: 'Late 15 min' }];
  const tpl = buildPayload({ to: '91900', text: 'hi', buttons, params: ['a', 'b'], templateName: 'attendance_alert' });
  assert.equal(tpl.type, 'template');
  assert.equal(tpl.template.components[2].parameters[0].payload, 'LATE:1');
  const inter = buildPayload({ to: '91900', text: 'hi', buttons });
  assert.equal(inter.interactive.action.buttons[0].reply.id, 'LEAVE:1');
  assert.equal(buildPayload({ to: '91900', text: 'hi' }).type, 'text');

  const replies = parseWebhook({
    entry: [{ changes: [{ value: { messages: [
      { from: '919000000003', type: 'button', button: { payload: 'LATE:7', text: 'Late 15 min' } },
      { from: '919000000004', type: 'interactive', interactive: { button_reply: { id: 'LEAVE:8', title: 'Leave' } } },
      { from: '919000000005', type: 'text', text: { body: 'chutti' } },
    ] } }] }],
  });
  assert.deepEqual(replies.map((r) => r.payload ?? r.text), ['LATE:7', 'LEAVE:8', 'chutti']);

  const body = Buffer.from('{"a":1}');
  const sig = `sha256=${crypto.createHmac('sha256', 's3cret').update(body).digest('hex')}`;
  assert.equal(verifySignature(body, sig, 's3cret'), true);
  assert.equal(verifySignature(body, sig, 'other'), false);
});

test('holidays stop sessions; templates, import, reports, timeline and digest work', async () => {
  const t = setup();
  const { service } = t;
  t.advance(15 * 60_000); // 4:10 PM

  // template
  service.updateSettings({ alertTemplate: 'Hello {parent}: {student} missed {batch} at {time}' });
  await service.mark(t.session.id, t.ids.Rohan, 'A');
  await service.markAll(t.session.id, 'P');
  await service.mark(t.session.id, t.ids.Rohan, 'A');
  await service.verify(t.session.id);
  assert.equal(t.sent[0].text, 'Hello Rohan parent: Rohan missed Batch B at 4:00 PM');
  assert.throws(() => service.updateSettings({ alertTemplate: 'no placeholder' }), /must include \{student\}/);

  // timeline tells the story in order
  t.advance(2 * 60_000);
  await service.handleReply({ phone: '9000000003', text: 'late aa raha hai' });
  const kinds = service.getTimeline(t.session.id).map((e) => e.kind);
  assert.deepEqual(kinds, ['start', 'submit', 'verify', 'alert', 'reply']);

  // report
  const r = service.getReport({ from: service.today(), to: service.today() });
  assert.equal(r.totals.total, 4);
  assert.equal(r.alerts.sent, 1);
  assert.equal(r.alerts.replyRate, 100);
  assert.equal(r.alerts.avgMinBeforeClassEnd, 110); // alert at 4:10, class ends 6:00

  // import: dry run reports problems, real run adds valid rows
  const csv = 'name,parent,phone,batch\nKiran,Mr. K,98765 43210,Batch B\nNoPhone,Mr. N,123,Batch B\nGhost,Mr. G,9876543211,Batch Z';
  const dry = service.importStudents({ csv, dryRun: true });
  assert.deepEqual(dry.rows.map((x) => x.error), [null, 'Invalid phone number', 'No batch called "Batch Z"']);
  assert.equal(service.listStudents().length, 4);
  assert.equal(service.importStudents({ csv }).added, 1);
  assert.equal(service.listStudents().length, 5);

  // holiday tomorrow: no session is created
  t.advance(24 * 60 * 60_000);
  service.addHoliday({ date: service.today(), label: 'Diwali' });
  service.ensureTodaySessions();
  const board = service.getBoard();
  assert.equal(board.holiday, 'Diwali');
  assert.equal(board.sessions.length, 0);

  // digest goes to the owner once
  service.updateSettings({ ownerPhone: '9000000099', digestEnabled: true, digestTime: '00:00' });
  await service.tick();
  await service.tick();
  const digests = t.sent.filter((m) => m.to === '919000000099');
  assert.equal(digests.length, 1);
  assert.match(digests[0].text, /summary for/);
});

test('student profile and at-risk detection', async () => {
  const t = setup();
  const { service } = t;
  // Rohan absent (no reply, bunk) on 3 days in a row
  for (let day = 0; day < 3; day++) {
    const s = service.ensureSession(t.batch.id);
    await service.markAll(s.id, 'P');
    await service.mark(s.id, t.ids.Rohan, 'A');
    await service.verify(s.id);
    t.advance(11 * 60_000);
    await service.tick();
    const [task] = service.listTasks('open');
    service.completeTask(task.id, { outcome: 'bunk' });
    t.advance(24 * 60 * 60_000 - 11 * 60_000);
  }
  const p = service.getStudentProfile(t.ids.Rohan);
  assert.equal(p.absentStreak, 3);
  assert.equal(p.stats30.bunks, 3);
  assert.equal(p.stats30.atRisk, true);
  assert.equal(p.alerts.length, 3);
  const dir = service.getStudentDirectory();
  assert.equal(dir.find((s) => s.name === 'Aarav').atRisk, false);
});

test('a parent who says the child left home gets an urgent call, never "leave"', async () => {
  const t = setup();
  await t.service.markAll(t.session.id, 'P');
  await t.service.mark(t.session.id, t.ids.Rohan, 'A');
  await t.service.mark(t.session.id, t.ids.Meera, 'A');
  await t.service.verify(t.session.id);

  // Free text: the reel's emergency, in the parent's own words.
  const r = await t.service.handleReply({ phone: '9000000003', text: 'absent kaise? ghar se toh nikal gaya tha' });
  assert.equal(r.choice, 'MISSING');
  assert.equal(t.student('Rohan').status, 'A');
  assert.equal(t.student('Rohan').alert.replyKey, 'MISSING');

  // Button: same outcome.
  const meeraBtn = t.sent.find((m) => m.to === '919000000004').buttons.find((b) => b.title === 'Mujhe call karein');
  await t.service.handleReply({ phone: '9000000004', payload: meeraBtn.id, text: meeraBtn.title });

  const tasks = t.service.listTasks('open');
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((x) => x.urgent === 1), 'both calls are urgent');
  assert.equal(t.sent.at(-1).text, 'Thank you. Our staff will call you right away.');

  // Urgent tasks never close by the timeout; they stay until staff log the call.
  t.advance(30 * 60_000);
  await t.service.tick();
  assert.equal(t.service.listTasks('open').length, 2);
  assert.match(t.service.getTimeline(t.session.id).map((e) => e.text).join('|'), /doesn't know where Rohan is/);
});

test('a later message cannot overwrite what staff logged after a call', async () => {
  const t = setup();
  await t.service.markAll(t.session.id, 'P');
  await t.service.mark(t.session.id, t.ids.Rohan, 'A');
  await t.service.verify(t.session.id);
  t.advance(11 * 60_000);
  await t.service.tick();
  const [task] = t.service.listTasks('open');
  t.service.completeTask(task.id, { outcome: 'bunk' });

  const r = await t.service.handleReply({ phone: '9000000003', text: 'aaj chutti hai' });
  assert.equal(r.matched, false);
  assert.equal(t.student('Rohan').status, 'A');
  assert.match(t.student('Rohan').note, /Bunk/);
});

test('buttons from an earlier day are ignored', async () => {
  const t = setup();
  await t.service.markAll(t.session.id, 'P');
  await t.service.mark(t.session.id, t.ids.Rohan, 'A');
  await t.service.verify(t.session.id);
  const btn = t.sent[0].buttons[0];
  t.advance(24 * 60 * 60_000);
  const r = await t.service.handleReply({ phone: '9000000003', payload: btn.id, text: btn.title });
  assert.equal(r.matched, false);
});

test('older databases upgrade: late records become T, sent classes keep their history', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-migrate-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE batches (id INTEGER PRIMARY KEY, name TEXT NOT NULL, start_time TEXT NOT NULL, days TEXT NOT NULL DEFAULT '1', active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE students (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, name TEXT NOT NULL, parent_name TEXT, parent_phone TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, date TEXT NOT NULL, starts_at TEXT NOT NULL, verified_at TEXT, UNIQUE (batch_id, date));
    CREATE TABLE attendance (session_id INTEGER NOT NULL, student_id INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('P', 'A', 'L')), note TEXT, source TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (session_id, student_id));
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, alert_id INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, done_at TEXT, outcome TEXT, UNIQUE (alert_id));
    INSERT INTO batches VALUES (1, 'B', '16:00', '1', 1);
    INSERT INTO students VALUES (1, 1, 'Rohan', NULL, '919000000003', 1), (2, 1, 'Meera', NULL, '919000000004', 1);
    INSERT INTO sessions VALUES (1, 1, '2026-11-17', '2026-11-17T10:30:00.000Z', '2026-11-17T10:40:00.000Z');
    INSERT INTO attendance VALUES (1, 1, 'L', 'Late 15 min (parent replied)', 'parent', 'x'), (1, 2, 'L', 'Leave (parent replied)', 'parent', 'x');
  `);
  old.close();
  const db = openDb(file);
  const rows = db.prepare('SELECT student_id, status FROM attendance ORDER BY student_id').all().map((r) => [r.student_id, r.status]);
  assert.deepEqual(rows, [[1, 'T'], [2, 'L']]);
  assert.equal(db.prepare('SELECT submitted_at FROM sessions WHERE id = 1').get().submitted_at, '2026-11-17T10:40:00.000Z');
  assert.doesNotThrow(() => db.prepare("INSERT INTO attendance VALUES (1, 2, 'T', NULL, 'teacher', 'y') ON CONFLICT DO UPDATE SET status = 'T'").run());
  db.close();
});
