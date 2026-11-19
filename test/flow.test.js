import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../server/db.js';
import { AttendanceService, normalizePhone, parseReplyText } from '../server/service.js';
import { buildPayload, createWhatsAppMessenger, parseWebhook, verifySignature, WhatsAppError } from '../server/messaging.js';
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
      return { id: `wamid.${sent.length}` };
    },
  };
  const db = openDb(':memory:');
  const service = new AttendanceService({ db, messenger, tz: TZ, clock: () => now, logger: { error() {} } });
  const batch = service.createBatch({ name: 'Batch B', startTime: '16:00', days: [0, 1, 2, 3, 4, 5, 6] });
  const ids = {};
  for (const [name, phone] of [['Aarav', '9000000001'], ['Diya', '9000000002'], ['Rohan', '9000000003'], ['Meera', '9000000004']]) {
    ids[name] = service.createStudent({ batchId: batch.id, name, parentName: `${name} parent`, parentPhone: phone }).id;
  }
  service.recordAllConsents({ recordedBy: 'test' }); // parents agreed on the admission form
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

  const { replies, statuses } = parseWebhook({
    entry: [{ changes: [{ value: {
      messages: [
        { id: 'in.1', from: '919000000003', type: 'button', button: { payload: 'LATE:7', text: 'Late 15 min' } },
        { id: 'in.2', from: '919000000004', type: 'interactive', interactive: { button_reply: { id: 'LEAVE:8', title: 'Leave' } } },
        { id: 'in.3', from: '919000000005', type: 'text', text: { body: 'chutti' } },
        { id: 'in.4', from: '919000000006', type: 'audio', audio: {} },
      ],
      statuses: [{ id: 'out.1', status: 'failed', timestamp: '1795000000', errors: [{ code: 131026, title: 'Message undeliverable' }] }],
    } }] }],
  });
  assert.deepEqual(replies.map((r) => r.payload ?? r.text), ['LATE:7', 'LEAVE:8', 'chutti', '[audio]']);
  assert.equal(replies[0].id, 'in.1');
  assert.deepEqual(statuses, [{ id: 'out.1', status: 'failed', timestamp: '1795000000', error: { code: 131026, title: 'Message undeliverable' } }]);

  // Owner summary template: no buttons, values flattened to one line.
  const digest = buildPayload({ to: '91900', text: 'x', params: ['Bright\nFuture', 'a\tb'], templateName: 'owner_summary' });
  assert.equal(digest.template.components.length, 1);
  assert.deepEqual(digest.template.components[0].parameters.map((p) => p.text), ['Bright Future', 'a b']);

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

test('WhatsApp client: current API version, retries on temporary errors, timeouts, no blind retries', async () => {
  const calls = [];
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fake = (responses) => async (url, opts) => {
    calls.push(url);
    const r = responses.shift();
    if (r === 'hang') return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
    return r;
  };
  const make = (responses, extra = {}) =>
    createWhatsAppMessenger({ token: 't', phoneNumberId: '123', fetchImpl: fake(responses), sleep: async () => {}, ...extra });

  // Default version is v26.0 (v21.0 is removed on 21 Jan 2027); it can be overridden.
  await make([reply(200, { messages: [{ id: 'w1' }] })]).send({ to: '91', text: 'hi' });
  assert.match(calls.at(-1), /graph\.facebook\.com\/v26\.0\/123\/messages/);
  await make([reply(200, { messages: [{ id: 'w1' }] })], { apiVersion: 'v27.0' }).send({ to: '91', text: 'hi' });
  assert.match(calls.at(-1), /\/v27\.0\//);

  // 500, then rate limit, then success: three attempts, the id comes back.
  calls.length = 0;
  const ok = await make([reply(500, {}), reply(400, { error: { code: 130429, message: 'rate limit' } }), reply(200, { messages: [{ id: 'w9' }] })]).send({ to: '91', text: 'hi' });
  assert.equal(ok.id, 'w9');
  assert.equal(calls.length, 3);

  // A permanent error (bad token) is not retried.
  calls.length = 0;
  await assert.rejects(make([reply(401, { error: { code: 190, message: 'Invalid token' } })]).send({ to: '91', text: 'hi' }), (e) => e instanceof WhatsAppError && !e.retryable && /Invalid token/.test(e.message));
  assert.equal(calls.length, 1);

  // A hung request times out (and is retried, then gives up).
  await assert.rejects(make(['hang', 'hang', 'hang'], { timeoutMs: 20 }).send({ to: '91', text: 'hi' }), /didn't answer/);

  // The owner summary is never sent as free text on real WhatsApp.
  await assert.rejects(make([]).send({ to: '91', text: 'x', template: 'digest', params: [] }), /owner-summary template/);
});

test('delivery updates: ticks never go backwards, and an undeliverable alert becomes a call at once', async () => {
  const t = setup();
  await t.service.markAll(t.session.id, 'P');
  await t.service.mark(t.session.id, t.ids.Rohan, 'A');
  await t.service.mark(t.session.id, t.ids.Meera, 'A');
  await t.service.verify(t.session.id);
  const wamidOf = (name) => t.service.db.prepare("SELECT m.wamid FROM messages m JOIN alerts a ON a.id = m.alert_id JOIN students s ON s.id = a.student_id WHERE s.name = ? AND m.buttons IS NOT NULL").get(name).wamid;
  const rohan = wamidOf('Rohan');
  assert.ok(rohan, 'message id stored');
  assert.equal(t.student('Rohan').alert.delivery, 'sent');

  t.service.handleStatus({ id: rohan, status: 'read' });
  t.service.handleStatus({ id: rohan, status: 'delivered' }); // arrives late: ignored
  assert.equal(t.student('Rohan').alert.delivery, 'read');

  t.service.handleStatus({ id: wamidOf('Meera'), status: 'failed', error: { code: 131026, title: 'Message undeliverable' } });
  assert.equal(t.student('Meera').alert.status, 'failed');
  const [task] = t.service.listTasks('open');
  assert.equal(task.studentName, 'Meera');
  assert.match(task.reason, /not on WhatsApp/);
  assert.equal(t.service.handleStatus({ id: 'unknown', status: 'read' }).matched, false);
});

test('a webhook delivered twice is handled once', async () => {
  const t = setup();
  await t.service.markAll(t.session.id, 'P');
  await t.service.mark(t.session.id, t.ids.Rohan, 'A');
  await t.service.verify(t.session.id);
  const before = t.sent.length;
  const first = await t.service.handleReply({ id: 'in.42', phone: '9000000003', text: 'chutti' });
  const again = await t.service.handleReply({ id: 'in.42', phone: '9000000003', text: 'chutti' });
  assert.equal(first.matched, true);
  assert.equal(again.duplicate, true);
  assert.equal(t.sent.length, before + 1, 'one acknowledgement, not two');
  assert.equal(t.service.listMessages('9000000003').filter((m) => m.direction === 'in').length, 1);
});

test('owner summary goes out with template values', async () => {
  const t = setup();
  await t.service.markAll(t.session.id, 'P');
  await t.service.mark(t.session.id, t.ids.Rohan, 'A');
  await t.service.verify(t.session.id);
  t.service.updateSettings({ ownerPhone: '9000000099' });
  await t.service.maybeSendDigest({ force: true });
  const msg = t.sent.find((m) => m.to === '919000000099');
  assert.equal(msg.template, 'digest');
  assert.deepEqual(msg.params, ['My Coaching Institute', '18 Nov', 3, 1, 0, 1, 0, 0]);
});

test('consent: no WhatsApp without it, START turns alerts on, STOP turns them off for good', async () => {
  const t = setup();
  const { service, ids } = t;
  service.clearConsent(ids.Rohan, { recordedBy: 'test' });
  assert.equal(service.consentFor('9000000003'), null);

  // Day 1: no consent yet, so no WhatsApp; staff get a call instead.
  await service.markAll(t.session.id, 'P');
  await service.mark(t.session.id, ids.Rohan, 'A');
  await service.verify(t.session.id);
  assert.equal(t.sent.length, 0);
  assert.equal(t.student('Rohan').alert.status, 'failed');
  assert.match(service.listTasks('open')[0].reason, /no WhatsApp consent/);

  // The parent sends START (e.g. from the admission QR code).
  const r = await service.handleReply({ phone: '9000000003', text: 'START' });
  assert.equal(r.consent, 'opted_in');
  assert.equal(service.consentFor('9000000003').source, 'whatsapp');
  assert.match(t.sent.at(-1).text, /Rohan ke attendance alerts/);

  // Day 2: now the alert goes out on WhatsApp.
  t.advance(24 * 60 * 60_000);
  const day2 = service.ensureSession(t.batch.id);
  await service.markAll(day2.id, 'P');
  await service.mark(day2.id, ids.Rohan, 'A');
  await service.verify(day2.id);
  assert.ok(t.sent.some((m) => m.to === '919000000003' && m.buttons));

  // STOP: no more alerts, even with the consent rule switched off, and staff can't override it.
  await service.handleReply({ phone: '9000000003', text: 'stop' });
  assert.equal(service.consentFor('9000000003').status, 'opted_out');
  assert.throws(() => service.recordConsent(ids.Rohan), /sent STOP/);
  service.updateSettings({ requireConsent: false });
  t.advance(24 * 60 * 60_000);
  const day3 = service.ensureSession(t.batch.id);
  await service.markAll(day3.id, 'P');
  await service.mark(day3.id, ids.Rohan, 'A');
  const before = t.sent.length;
  await service.verify(day3.id);
  assert.equal(t.sent.length, before, 'opted-out parents are never messaged');
  assert.match(service.getSessionView(day3.id).students.find((s) => s.name === 'Rohan').alert.error, /STOP/);

  // An unknown number can't opt itself in.
  await service.handleReply({ phone: '9876500000', text: 'start' });
  assert.equal(service.consentFor('9876500000'), null);
  assert.match(t.sent.at(-1).text, /records mein nahi mila/);

  const log = service.db.prepare('SELECT status, source FROM consent_log WHERE phone = ? ORDER BY id').all('919000000003');
  assert.deepEqual(log.map((l) => `${l.status}/${l.source}`), ['opted_in/staff', 'cleared/staff', 'opted_in/whatsapp', 'opted_out/whatsapp']);
});

test('loop metrics: covered absences and guardrails count what really happened', async () => {
  const t = setup();
  const { service, ids } = t;
  service.clearConsent(ids.Meera, { recordedBy: 'test' }); // Meera's parent never agreed
  // Class starts 4:00 PM (it's 3:55). The teacher sends it at 4:20, ten minutes late.
  t.advance(25 * 60_000);
  for (const n of ['Aarav', 'Diya', 'Rohan', 'Meera']) await service.mark(t.session.id, ids[n], 'A');
  await service.submit(t.session.id, { actor: 'Anil Sir' }); // past the 10-min mark: alerts go now
  const day = service.today();

  // Aarav's parent replies "leave" within minutes.
  await service.handleReply({ phone: '9000000001', payload: `LEAVE:${t.student('Aarav').alert.id}` });
  // Nobody replies for Diya and Rohan: both become calls.
  t.advance(11 * 60_000);
  await service.tick();
  const tasks = service.listTasks('open');
  const call = (name) => tasks.find((x) => x.studentName === name);
  // Diya was actually in class (a false alert); Rohan's call is never logged.
  service.completeTask(call('Diya').id, { outcome: 'present', actor: 'Pooja' });

  const m = service.getLoopMetrics({ from: day, to: day });
  assert.equal(m.absences, 4);
  // Sent 20 min after class start: past the 15-minute promise, so none count as covered.
  assert.equal(m.covered, 0);
  assert.equal(m.onTimeMarking.pct, 0);
  assert.equal(m.replies.of, 3, "Meera's parent wasn't messaged (no consent)");
  assert.equal(m.replies.pct, 33.3);
  assert.equal(m.falseAlerts.n, 1);
  assert.equal(m.falseAlerts.pct, 25);
  assert.equal(m.sameDayCalls.of, 3, "Diya, Rohan and Meera's call-instead");
  assert.equal(m.sameDayCalls.pct, 33.3);
  assert.equal(m.delivery.practice, true, 'no delivery receipts without real WhatsApp');

  // The event log tells the story, with who did what.
  const ev = service.listEvents({ limit: 50 }).reverse();
  assert.deepEqual(
    [...new Set(ev.map((e) => e.type))].sort(), // alerts go out in parallel, so their order varies
    ['alert_blocked', 'alert_sent', 'call_logged', 'class_submitted', 'class_verified', 'escalated', 'reply_received'],
  );
  assert.equal(ev[0].type, 'class_submitted');
  const sub = ev.find((e) => e.type === 'class_submitted');
  assert.equal(sub.actor, 'Anil Sir');
  assert.deepEqual(sub.data, { minutesAfterStart: 20, onTime: false });
  assert.equal(ev.find((e) => e.type === 'call_logged').actor, 'Pooja');

  // Next day, done right: sent on time, parent replies, so the absence is covered.
  t.advance(24 * 60 * 60_000 - 36 * 60_000); // back to 3:55 PM tomorrow
  const s2 = service.ensureSession(t.batch.id);
  t.advance(7 * 60_000); // 4:02 PM
  await service.mark(s2.id, ids.Rohan, 'A');
  await service.submit(s2.id);
  t.advance(8 * 60_000); // 4:10 PM: alerts go out
  await service.tick();
  const alert = service.getSessionView(s2.id).students.find((s) => s.name === 'Rohan').alert;
  await service.handleReply({ phone: '9000000003', payload: `LATE:${alert.id}` });
  const m2 = service.getLoopMetrics({ from: service.today(), to: service.today() });
  assert.deepEqual([m2.absences, m2.covered, m2.coveredPct, m2.onTimeMarking.pct], [1, 1, 100, 100]);
});

test('second guardian and siblings: both parents told, siblings get one message, either can answer', async () => {
  const t = setup();
  const { service, ids } = t;
  // Aarav has a second guardian who also agreed to WhatsApp; Diya's sibling Dev shares her parent's number.
  service.updateStudent(ids.Aarav, { guardian2Name: 'Aarav mother', guardian2Phone: '9100000001' });
  const dev = service.createStudent({ batchId: t.batch.id, name: 'Dev', parentName: 'Diya parent', parentPhone: '9000000002' });
  service.recordConsent(ids.Aarav, { recordedBy: 'test' }); // the form lists both numbers
  assert.throws(() => service.updateStudent(ids.Rohan, { guardian2Phone: '9000000003' }), /same as the first/);

  for (const id of [ids.Aarav, ids.Diya, dev.id]) await service.mark(t.session.id, id, 'A');
  await service.submit(t.session.id);
  t.advance(15 * 60_000);
  await service.tick();

  const toAarav = t.sent.filter((m) => m.buttons && m.params?.[3] === 'Aarav');
  assert.deepEqual(toAarav.map((m) => m.to).sort(), ['919000000001', '919100000001'], 'both guardians messaged');
  assert.deepEqual(toAarav.map((m) => m.params[0]).sort(), ['Aarav mother', 'Aarav parent']);
  const toDiya = t.sent.filter((m) => m.to === '919000000002' && m.buttons);
  assert.equal(toDiya.length, 1, 'one message for both siblings');
  assert.equal(toDiya[0].params[3], 'Dev & Diya');
  assert.match(toDiya[0].buttons[0].id, /^LEAVE:\d+,\d+$/);

  // The second guardian answers with the button: Aarav is on leave.
  const r = await service.handleReply({ phone: '9100000001', payload: toAarav[0].buttons[0].id });
  assert.equal(r.matched, true);
  assert.equal(t.student('Aarav').status, 'L');
  assert.equal(t.sent.at(-1).to, '919100000001', 'thank-you goes to whoever replied');

  // One tap answers for both siblings.
  await service.handleReply({ phone: '9000000002', payload: toDiya[0].buttons[1].id }); // LATE
  assert.equal(t.student('Diya').status, 'T');
  assert.equal(t.student('Dev').status, 'T');
  // A stranger can't use those buttons.
  assert.equal((await service.handleReply({ phone: '9555555555', payload: toDiya[0].buttons[0].id })).matched, false);

  // Next day: the first number sends STOP. The second guardian still gets told, so it's not a call.
  await service.handleReply({ phone: '9000000001', text: 'STOP' });
  const before = t.sent.length;
  t.advance(24 * 60 * 60_000);
  const s2 = service.ensureSession(t.batch.id);
  t.advance(-15 * 60_000);
  await service.mark(s2.id, ids.Aarav, 'A');
  await service.submit(s2.id);
  t.advance(15 * 60_000);
  await service.tick();
  const day2 = service.getSessionView(s2.id).students.find((s) => s.name === 'Aarav').alert;
  assert.equal(day2.status, 'sent');
  assert.deepEqual(t.sent.slice(before).filter((m) => m.buttons).map((m) => m.to), ['919100000001'], 'only the second guardian');

  // WhatsApp can't deliver to one number but the other got it: the parents know, no call needed.
  service.handleStatus({ id: 'wamid.unknown', status: 'failed' }); // ignored
  const aaravAlert = service.getSessionView(t.session.id).students.find((s) => s.name === 'Aarav').alert.id;
  const msgs = service.db.prepare("SELECT * FROM messages WHERE alert_id = ? AND direction = 'out' AND buttons IS NOT NULL").all(aaravAlert);
  assert.equal(msgs.length, 2);
  service.handleStatus({ id: msgs[0].wamid, status: 'delivered' });
  service.handleStatus({ id: msgs[1].wamid, status: 'failed', error: { code: 131026 } });
  const aarav1 = service.getSessionView(t.session.id).students.find((s) => s.name === 'Aarav').alert;
  assert.equal(aarav1.status, 'replied');
  assert.equal(aarav1.delivery, 'delivered');

  // Import: optional 5th/6th columns add a second guardian.
  const imp = service.importStudents({ csv: 'Kiran, Mr K, 9200000001, Batch B, Mrs K, 9200000002', batchId: t.batch.id });
  assert.equal(imp.added, 1);
  const kiran = service.listStudents().find((s) => s.name === 'Kiran');
  assert.equal(kiran.guardian2Phone, '919200000002');
});

test('retention: old messages, strangers and long-removed students are cleaned up once a day', async () => {
  const t = setup();
  const { service, ids } = t;
  const at = (daysAgo) => new Date(Date.parse(service.nowIso()) - daysAgo * 86_400_000).toISOString();
  const msg = (phone, daysAgo) => service.db.prepare("INSERT INTO messages (phone, direction, body, created_at) VALUES (?, 'in', 'hi', ?)").run(phone, at(daysAgo));
  msg('919000000001', 400); // a parent, 13 months ago: past the 12-month default
  msg('919000000001', 100); // a parent, recent enough: kept
  msg('919111111111', 45); // not a parent, 45 days ago: past 30 days
  msg('919111111111', 5); // not a parent, recent: kept for now
  service.deleteStudent(ids.Meera);
  service.db.prepare('UPDATE students SET removed_at = ? WHERE id = ?').run(at(400), ids.Meera);
  service.db.prepare("INSERT INTO events (at, type) VALUES (?, 'student_viewed')").run(at(400));

  const r = service.maybeApplyRetention();
  assert.deepEqual(r, { messages: 1, unknown: 1, students: 1, events: 1 });
  assert.equal(service.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
  assert.equal(service.db.prepare('SELECT COUNT(*) AS n FROM students WHERE id = ?').get(ids.Meera).n, 0, 'erased, not just hidden');
  assert.equal(service.listPrivacyLog()[0].action, 'retention');
  assert.equal(service.maybeApplyRetention(), null, 'once a day');

  // Owners choose the keep period (from a fixed set); "keep" means removed students stay.
  assert.throws(() => service.updateSettings({ retentionMessagesMonths: 1 }), /must be one of/);
  service.updateSettings({ retentionMessagesMonths: 24, retentionRemovedMonths: 0 });
  service.deleteStudent(ids.Rohan);
  service.db.prepare('UPDATE students SET removed_at = ? WHERE id = ?').run(at(900), ids.Rohan);
  assert.equal(service.applyRetention().students, 0);
});
