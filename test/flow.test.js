import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../server/db.js';
import { AttendanceService, normalizePhone, parseReplyText } from '../server/service.js';
import { buildPayload, parseWebhook, verifySignature } from '../server/messaging.js';
import { createApp, createEventHub } from '../server/app.js';
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

test('the whole reel flow: mark, verify, alert, reply, auto-update, escalate, call', async () => {
  const t = setup();
  const { service, session, ids } = t;

  // Step 1: teacher marks
  await service.mark(session.id, ids.Aarav, 'P');
  await service.mark(session.id, ids.Diya, 'P');
  await service.mark(session.id, ids.Rohan, 'A');
  // Meera is left unmarked.

  // Before 4:10 nothing is verified.
  t.advance(14 * MIN); // 4:09
  await service.tick();
  assert.equal(t.view().verifiedAt, null);
  assert.equal(t.sent.length, 0);

  // Step 2 + 3: at 4:10 absentees are verified and parents get WhatsApp alerts.
  t.advance(1 * MIN); // 4:10
  await service.tick();
  const v = t.view();
  assert.ok(v.verifiedAt);
  assert.deepEqual(v.counts, { P: 2, A: 2, L: 0, unmarked: 0 });
  assert.equal(t.student('Meera').note, 'Not marked by teacher');
  assert.equal(t.sent.length, 2);
  const rohanMsg = t.sent.find((m) => m.to === '919000000003');
  assert.match(rohanMsg.text, /Rohan ki attendance record nahi hui/);
  assert.match(rohanMsg.text, /4:00 PM/);
  assert.deepEqual(rohanMsg.buttons.map((b) => b.title), ['Leave', 'Late 15 min']);
  assert.deepEqual(rohanMsg.params, ['Rohan parent', 'Batch B', '4:00 PM', 'Rohan']);

  // A second tick must not send duplicate alerts.
  await service.tick();
  assert.equal(t.sent.length, 2);

  // Step 4 + 5: Rohan's parent taps "Late 15 min" at 4:12; the record updates itself.
  t.advance(2 * MIN);
  const lateBtn = rohanMsg.buttons.find((b) => b.title === 'Late 15 min');
  const r = await service.handleReply({ phone: '919000000003', payload: lateBtn.id, text: 'Late 15 min' });
  assert.equal(r.matched, true);
  assert.equal(t.student('Rohan').status, 'L');
  assert.equal(t.student('Rohan').alert.reply, 'Late 15 min');
  assert.equal(t.sent.at(-1).text, 'Thank you. Noted: Late 15 min.');

  // Step 6: Meera's parent does not reply within 3 minutes → staff call task.
  t.advance(1 * MIN); // 4:13
  await service.tick();
  assert.equal(t.student('Meera').alert.status, 'escalated');
  const tasks = service.listTasks('open');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].studentName, 'Meera');
  assert.equal(tasks[0].parentPhone, '919000000004');

  // Staff calls: it was a bunk.
  service.completeTask(tasks[0].id, { outcome: 'bunk' });
  assert.equal(service.listTasks('open').length, 0);
  assert.equal(t.student('Meera').status, 'A');
  assert.match(t.student('Meera').note, /Bunk/);

  const stats = service.getStats();
  assert.equal(stats.alertsSent, 2);
  assert.equal(stats.replied, 1);
  assert.equal(stats.escalated, 1);
  assert.equal(stats.avgMinutesToAlert, 10);
});

test('a late reply after escalation still updates the record and closes the call task', async () => {
  const t = setup();
  await t.service.mark(t.session.id, t.ids.Aarav, 'A');
  await t.service.markAll(t.session.id, 'P');
  await t.service.mark(t.session.id, t.ids.Aarav, 'A');
  await t.service.verify(t.session.id);
  t.advance(5 * MIN);
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
  t.advance(4 * MIN);
  await t.service.tick();
  assert.equal(t.service.listTasks('open').length, 1);

  await t.service.mark(t.session.id, t.ids.Diya, 'P');
  assert.equal(t.service.listTasks('open').length, 0);
});

test('no auto-verify (and no parent messages) when the teacher has not taken attendance', async () => {
  const t = setup();
  t.advance(60 * MIN); // well past 4:10
  await t.service.tick();
  assert.equal(t.view().verifiedAt, null);
  assert.equal(t.view().attendanceTaken, false);
  assert.equal(t.sent.length, 0);

  // The teacher starts marking late: no verification while they are still going.
  await t.service.mark(t.session.id, t.ids.Aarav, 'P');
  await t.service.tick();
  assert.equal(t.view().verifiedAt, null);
  t.advance(30_000);
  await t.service.mark(t.session.id, t.ids.Diya, 'P');
  await t.service.mark(t.session.id, t.ids.Rohan, 'A');
  t.advance(60_000);
  await t.service.tick();
  assert.equal(t.view().verifiedAt, null);
  assert.equal(t.sent.length, 0);

  // They stop with Meera unmarked; after the quiet period it verifies.
  t.advance(30_000);
  await t.service.tick();
  assert.ok(t.view().verifiedAt);
  assert.equal(t.sent.length, 2); // Rohan + unmarked Meera
});

test('overdue session verifies as soon as everyone is marked', async () => {
  const t = setup();
  t.advance(60 * MIN);
  await t.service.markAll(t.session.id, 'P');
  await t.service.mark(t.session.id, t.ids.Meera, 'A');
  await t.service.tick();
  assert.ok(t.view().verifiedAt);
  assert.equal(t.sent.length, 1);
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

test('HTTP API: access code, marking, and the simulator', async (tt) => {
  const t = setup();
  const app = createApp({ service: t.service, hub: createEventHub(), mode: 'simulator', accessCode: 'letmein', logger: { error() {} } });
  const server = app.listen(0);
  tt.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/api/board`)).status, 401);
  assert.equal((await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"code":"nope"}' })).status, 401);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"code":"letmein"}' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (method, p, body) =>
    fetch(`${base}${p}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  const board = await call('GET', '/api/board');
  assert.equal(board.status, 200);
  assert.equal(board.body.sessions.length, 1);

  const bad = await call('POST', `/api/sessions/${t.session.id}/mark`, { studentId: t.ids.Aarav, status: 'X' });
  assert.equal(bad.status, 400);

  await call('POST', `/api/sessions/${t.session.id}/mark-all`, { status: 'P' });
  await call('POST', `/api/sessions/${t.session.id}/mark`, { studentId: t.ids.Meera, status: 'A' });
  const verified = await call('POST', `/api/sessions/${t.session.id}/verify`);
  assert.ok(verified.body.verifiedAt);

  const threads = await call('GET', '/api/messages/threads');
  assert.equal(threads.status, 200);
  assert.equal(threads.body[0].phone, '919000000004');
  assert.equal(threads.body[0].students, 'Meera');

  const msgs = await call('GET', '/api/messages?phone=9000000004');
  assert.equal(msgs.body.length, 1);
  const leave = msgs.body[0].buttons[0];
  const reply = await call('POST', '/api/simulator/reply', { phone: '9000000004', payload: leave.id, text: leave.title });
  assert.equal(reply.body.matched, true);
  assert.equal(t.student('Meera').status, 'L');

  const missing = await call('GET', '/api/nope');
  assert.equal(missing.status, 404);
});
