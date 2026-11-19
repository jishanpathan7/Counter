import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '../server/platform.js';
import { createApp, createEventHub } from '../server/app.js';
import { DEMO_PIN, seedDemo } from '../server/seed.js';

const quiet = { error() {}, warn() {}, log() {} };

test('first-week checklist: ticks itself off as the owner sets up, and the test alert reaches the owner', async (tt) => {
  const platform = new Platform({ logger: quiet });
  seedDemo(platform);
  const server = createApp({ platform, hub: createEventHub(), logger: quiet }).listen(0);
  tt.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (phone) => {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin: DEMO_PIN }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return async (method, p, body) => {
      const res = await fetch(`${base}${p}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
  };
  const agency = await login('9999900000');
  await agency('POST', '/api/agency/institutes', { name: 'New Classes', ownerName: 'Neha', ownerPhone: '9822000005', ownerPin: DEMO_PIN });
  const owner = await login('9822000005');
  const done = async () => Object.fromEntries((await owner('GET', '/api/i/new-classes/setup')).body.steps.map((s) => [s.id, s.done]));

  assert.deepEqual(await done(), { batches: false, students: false, team: false, consent: false, testAlert: false, firstClass: false, whatsapp: false });
  const batch = (await owner('POST', '/api/i/new-classes/batches', { name: 'A', startTime: '16:00', days: [0, 1, 2, 3, 4, 5, 6] })).body;
  await owner('POST', '/api/i/new-classes/students', { name: 'Kid', parentPhone: '9812300001', batchId: batch.id });
  await owner('POST', '/api/i/new-classes/team', { name: 'Teacher', phone: '9833000005', pin: '739154', role: 'teacher', batchIds: [batch.id] });
  await owner('POST', '/api/i/new-classes/consents/record-all', {});
  let d = await done();
  assert.deepEqual([d.batches, d.students, d.team, d.consent], [true, true, true, true]);

  // The test alert goes to the owner's own number, with the parent's reply buttons.
  const r = await owner('POST', '/api/i/new-classes/setup/test-alert');
  assert.equal(r.status, 200);
  assert.equal(r.body.sentTo, '919822000005');
  const thread = (await owner('GET', '/api/i/new-classes/messages?phone=919822000005')).body;
  assert.match(thread.at(-1).body, /^\[Test\].*Aarav \(sample\)/);
  assert.equal(thread.at(-1).buttons.length, 3);
  assert.equal((await done()).testAlert, true);

  // Staff can't use it (owner only), and the owner can hide the list.
  const desk = await login('9999900002');
  assert.equal((await desk('POST', '/api/i/bright-future/setup/test-alert')).status, 403);
  await owner('POST', '/api/i/new-classes/setup/dismiss');
  assert.equal((await owner('GET', '/api/i/new-classes/setup')).body.dismissed, true);
});
