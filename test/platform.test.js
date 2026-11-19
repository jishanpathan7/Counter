import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '../server/platform.js';
import { createApp, createEventHub } from '../server/app.js';
import { DEMO_PIN, seedDemo } from '../server/seed.js';
import { hashPin } from '../server/platform.js';
import { createRuntime } from '../server/runtime.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const quiet = { error() {} };

async function start(tt, { seed = true, demo = seed, trustProxy = false } = {}) {
  const now = Date.parse('2026-11-18T12:00:00Z'); // 5:30 PM IST
  const platform = new Platform({ clock: () => now, logger: quiet });
  if (seed) seedDemo(platform);
  const app = createApp({ platform, hub: createEventHub(), demo, trustProxy, logger: quiet });
  const server = app.listen(0);
  tt.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = ({ ip } = {}) => {
    let cookie = '';
    const call = async (method, p, body) => {
      const r = await fetch(`${base}${p}`, {
        method,
        headers: { cookie, 'Content-Type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: r.status, body: data, headers: r.headers };
    };
    return {
      call,
      login: (phone, pin = DEMO_PIN) => call('POST', '/api/auth/login', { phone, pin }),
      getCookie: () => cookie,
      setCookie: (c) => (cookie = c),
    };
  };
  return { platform, client, base };
}

test('demo seed builds three institutes with history', async (tt) => {
  const { platform } = await start(tt);
  const o = platform.agencyOverview();
  assert.equal(o.totals.institutes, 3);
  assert.equal(o.totals.active, 2);
  assert.equal(o.totals.mrr, 18000);
  const r = platform.service('bright-future').getReport({});
  assert.ok(r.totals.total > 300, 'a month of attendance');
  assert.ok(r.alerts.sent > 20);
  assert.ok(r.atRisk.some((s) => s.name === 'Kabir Khan'));
});

test('first-run setup creates the admin and first institute, once', async (tt) => {
  const { client } = await start(tt, { seed: false });
  const c = client();
  assert.equal((await c.call('GET', '/api/auth/me')).body.needsSetup, true);
  const r = await c.call('POST', '/api/setup', { name: 'Me', phone: '9811111111', pin: '739154', instituteName: 'Star Classes' });
  assert.equal(r.status, 201);
  assert.equal(r.body.institute.slug, 'star-classes');
  const me = await c.call('GET', '/api/auth/me');
  assert.equal(me.body.user.isAgency, true);
  assert.equal(me.body.memberships[0].slug, 'star-classes');
  assert.equal((await c.call('POST', '/api/setup', { name: 'X', phone: '9822222222', pin: '628403', instituteName: 'Y' })).status, 409);
});

test('login, wrong PIN lockout, logout', async (tt) => {
  const { client } = await start(tt);
  const c = client();
  assert.equal((await c.call('GET', '/api/i/bright-future/board')).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await c.login('9999900001', '0000')).status, 401);
  assert.equal((await c.login('9999900001', DEMO_PIN)).status, 429);
  const d = client();
  assert.equal((await d.login('9999900002')).status, 200);
  assert.equal((await d.call('GET', '/api/i/bright-future/board')).status, 200);
  await d.call('POST', '/api/auth/logout');
  assert.equal((await d.call('GET', '/api/i/bright-future/board')).status, 401);
});

test('roles: owner, staff, teacher and agency see the right things', async (tt) => {
  const { client, platform } = await start(tt);
  const owner = client();
  await owner.login('9999900001');
  assert.equal((await owner.call('GET', '/api/i/bright-future/team')).status, 200);
  assert.equal((await owner.call('GET', '/api/i/excel/board')).status, 404, 'other institutes are invisible');
  assert.equal((await owner.call('GET', '/api/agency/overview')).status, 403);

  const staff = client();
  await staff.login('9999900002');
  assert.equal((await staff.call('GET', '/api/i/bright-future/reports')).status, 200);
  assert.equal((await staff.call('GET', '/api/i/bright-future/team')).status, 403);
  assert.equal((await staff.call('PATCH', '/api/i/bright-future/settings', { verifyAfterMinutes: 1 })).status, 403);

  const teacher = client();
  await teacher.login('9999900003');
  assert.equal((await teacher.call('GET', '/api/i/bright-future/board')).status, 403);
  const batches = (await teacher.call('GET', '/api/i/bright-future/batches')).body;
  assert.deepEqual(batches.map((b) => b.name), ['Class 10 · Batch B', 'Class 12 · JEE']);
  const batchA = platform.service('bright-future').listBatches().find((b) => b.name.includes('Batch A'));
  assert.equal((await teacher.call('POST', `/api/i/bright-future/batches/${batchA.id}/today`)).status, 403);
  const s = (await teacher.call('POST', `/api/i/bright-future/batches/${batches[0].id}/today`)).body;
  assert.equal(s.students[0].parentPhone, undefined, 'teachers do not see parent numbers');
  const marked = await teacher.call('POST', `/api/i/bright-future/sessions/${s.id}/mark`, { studentId: s.students[0].id, status: 'P' });
  assert.equal(marked.status, 200);

  const agency = client();
  await agency.login('9999900000');
  assert.equal((await agency.call('GET', '/api/agency/overview')).body.institutes.length, 3);
  assert.equal((await agency.call('GET', '/api/i/excel/board')).status, 200);
});

test('paused institutes lock out their team but not the agency', async (tt) => {
  const { client } = await start(tt);
  const owner = client();
  await owner.login('9999900005');
  assert.equal((await owner.call('GET', '/api/i/toppers/board')).status, 403);
  const agency = client();
  await agency.login('9999900000');
  await agency.call('PATCH', '/api/agency/institutes/toppers', { status: 'active' });
  assert.equal((await owner.call('GET', '/api/i/toppers/board')).status, 200);
});

test('agency creates an institute with a new owner who can log in', async (tt) => {
  const { client } = await start(tt);
  const agency = client();
  await agency.login('9999900000');
  const r = await agency.call('POST', '/api/agency/institutes', {
    name: 'Sharma Tutorials', city: 'Pune', feeMonthly: 9000, ownerName: 'Neha Sharma', ownerPhone: '9822000000', ownerPin: '583920',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.slug, 'sharma-tutorials');
  assert.equal((await agency.call('GET', '/api/agency/overview')).body.totals.mrr, 27000);
  const owner = client();
  const login = await owner.login('9822000000', '583920');
  assert.deepEqual(login.body.memberships.map((m) => [m.slug, m.role]), [['sharma-tutorials', 'owner']]);
});

test('team management keeps at least one owner', async (tt) => {
  const { client } = await start(tt);
  const owner = client();
  const me = (await owner.login('9999900001')).body.user;
  const added = await owner.call('POST', '/api/i/bright-future/team', { name: 'Ravi Sir', phone: '9833000000', pin: '613478', role: 'teacher' });
  assert.equal(added.status, 201);
  assert.equal((await owner.call('PATCH', `/api/i/bright-future/team/${me.id}`, { role: 'staff' })).status, 409);
  assert.equal((await owner.call('DELETE', `/api/i/bright-future/team/${me.id}`)).status, 409);
  assert.equal((await owner.call('DELETE', `/api/i/bright-future/team/${added.body.id}`)).status, 204);
  const ravi = client();
  assert.equal((await ravi.login('9833000000', '613478')).body.memberships.length, 0);
});

test('simulator reply, CSV export, WhatsApp settings never leak secrets', async (tt) => {
  const { client, platform, base } = await start(tt);
  const owner = client();
  await owner.login('9999900001');
  const svc = platform.service('bright-future');
  const jee = svc.listBatches().find((b) => b.name.includes('JEE')); // 6 PM: still to come in the demo
  const s = (await owner.call('POST', `/api/i/bright-future/batches/${jee.id}/today`)).body;
  assert.equal(s.verifiedAt, null);
  await owner.call('POST', `/api/i/bright-future/sessions/${s.id}/mark-all`, { status: 'P' });
  const rohan = s.students.find((x) => x.name.startsWith('Yash'));
  await owner.call('POST', `/api/i/bright-future/sessions/${s.id}/mark`, { studentId: rohan.id, status: 'A' });
  await owner.call('POST', `/api/i/bright-future/sessions/${s.id}/submit`);
  await svc.verify(s.id); // the 6 PM class isn't due yet at 5:30; verify now for the test
  const msgs = (await owner.call('GET', `/api/i/bright-future/messages?phone=${rohan.parentPhone}`)).body;
  const btn = msgs.at(-1).buttons[1];
  const reply = await owner.call('POST', '/api/i/bright-future/simulator/reply', { phone: rohan.parentPhone, payload: btn.id, text: btn.title });
  assert.equal(reply.body.matched, true);

  const csv = await owner.call('GET', '/api/i/bright-future/reports.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.body, /Student,Batch,Parent/);

  const wa = await owner.call('PATCH', '/api/i/bright-future/whatsapp', { token: 'secret-token', phoneNumberId: '123', verifyToken: 'v' });
  assert.equal(wa.body.token, true);
  assert.equal(wa.body.mode, 'whatsapp');
  assert.ok(!JSON.stringify((await owner.call('GET', '/api/i/bright-future/whatsapp')).body).includes('secret-token'));

  // webhook verification uses the institute's own verify token
  const ok = await fetch(`${base}/webhooks/whatsapp/bright-future?hub.mode=subscribe&hub.verify_token=v&hub.challenge=42`);
  assert.equal(await ok.text(), '42');
  const bad = await fetch(`${base}/webhooks/whatsapp/bright-future?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`);
  assert.equal(bad.status, 403);
});

test('owners cannot take over accounts that belong to another institute or the agency', async (tt) => {
  const { client } = await start(tt);
  const owner = client();
  await owner.login('9999900001');

  // The agency admin can't be added at all.
  assert.equal((await owner.call('POST', '/api/i/bright-future/team', { name: 'x', phone: '9999900000', pin: '628403', role: 'staff' })).status, 409);

  // Another institute's owner can be added, but their name and PIN stay theirs.
  const added = await owner.call('POST', '/api/i/bright-future/team', { name: 'Fake Name', phone: '9999900004', pin: '628403', role: 'staff' });
  assert.equal(added.status, 201);
  assert.equal(added.body.sharedAccount, true);
  assert.equal((await owner.call('PATCH', `/api/i/bright-future/team/${added.body.id}`, { pin: '846213' })).status, 403);
  assert.equal((await owner.call('PATCH', `/api/i/bright-future/team/${added.body.id}`, { name: 'Hacked' })).status, 403);
  // Role changes are still fine.
  assert.equal((await owner.call('PATCH', `/api/i/bright-future/team/${added.body.id}`, { role: 'teacher' })).status, 200);

  const victim = client();
  assert.equal((await victim.login('9999900004', '846213')).status, 401, 'attacker PIN does not work');
  assert.equal((await victim.login('9999900004', DEMO_PIN)).status, 200, 'original PIN still works');
  assert.equal((await victim.call('GET', '/api/auth/me')).body.user.name, 'Sunita Verma');

  // Removing them from this institute doesn't sign them out of their own.
  assert.equal((await owner.call('DELETE', `/api/i/bright-future/team/${added.body.id}`)).status, 204);
  assert.equal((await victim.call('GET', '/api/i/excel/board')).status, 200);
});

test('webhooks are rejected unless signed with the app secret; the unscoped route is gone', async (tt) => {
  const { client, platform, base } = await start(tt);
  const owner = client();
  await owner.login('9999900001');
  const svc = platform.service('bright-future');
  const jee = svc.listBatches().find((b) => b.name.includes('JEE'));
  const s = (await owner.call('POST', `/api/i/bright-future/batches/${jee.id}/today`)).body;
  await owner.call('POST', `/api/i/bright-future/sessions/${s.id}/mark-all`, { status: 'P' });
  const yash = s.students.find((x) => x.name.startsWith('Yash'));
  await owner.call('POST', `/api/i/bright-future/sessions/${s.id}/mark`, { studentId: yash.id, status: 'A' });
  await owner.call('POST', `/api/i/bright-future/sessions/${s.id}/submit`);
  await svc.verify(s.id); // the 6 PM class isn't due yet at 5:30; verify now for the test

  const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: yash.parentPhone, type: 'text', text: { body: 'chutti' } }] } }] }] });
  const post = (url, headers = {}) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

  assert.equal((await post('/webhooks/whatsapp/bright-future')).status, 403, 'no app secret configured: rejected');
  assert.equal((await post('/webhooks/whatsapp')).status, 404, 'legacy unscoped route removed');

  svc.updateWhatsAppConfig({ appSecret: 's3cret' });
  assert.equal((await post('/webhooks/whatsapp/bright-future', { 'x-hub-signature-256': 'sha256=forged' })).status, 401);
  assert.equal(svc.getSessionView(s.id).students.find((x) => x.id === yash.id).status, 'A', 'forged reply changed nothing');

  const sig = `sha256=${crypto.createHmac('sha256', 's3cret').update(body).digest('hex')}`;
  assert.equal((await post('/webhooks/whatsapp/bright-future', { 'x-hub-signature-256': sig })).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(svc.getSessionView(s.id).students.find((x) => x.id === yash.id).status, 'L');
});

test('production runtime: secret required, no demo data, setup needs the code', async (tt) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-runtime-'));
  tt.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const quietLog = { log() {}, warn() {}, error() {} };
  assert.throws(() => createRuntime({ env: { DATA_DIR: dir }, logger: quietLog }), /SESSION_SECRET/);
  assert.throws(() => createRuntime({ env: { DATA_DIR: dir, SESSION_SECRET: 'short' }, logger: quietLog }), /SESSION_SECRET/);

  const { app } = createRuntime({ env: { DATA_DIR: dir, SESSION_SECRET: 'x'.repeat(40), SETUP_TOKEN: 'open-sesame' }, logger: quietLog });
  const server = app.listen(0);
  tt.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const me = await (await fetch(`${base}/api/auth/me`)).json();
  assert.equal(me.demo, null, 'no demo logins exposed');
  assert.equal(me.needsSetup, true);
  assert.equal(me.setupCodeRequired, true);

  const setup = (code) => fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Admin', phone: '9811111111', pin: '482915', instituteName: 'Star Classes', setupCode: code }) });
  assert.equal((await setup('guess')).status, 403);
  assert.equal((await setup('open-sesame')).status, 201);
});

test('new PINs must be 6+ digits and hard to guess', async (tt) => {
  const { client } = await start(tt, { seed: false });
  const c = client();
  const setup = (pin, phone = '9811111111') => c.call('POST', '/api/setup', { name: 'Me', phone, pin, instituteName: 'Star Classes' });
  for (const weak of ['1234', '123456', '111111', '654321', '121212', '123123', '111111', '811111']) {
    assert.equal((await setup(weak)).status, 400, `${weak} should be refused`);
  }
  assert.match((await setup('111111')).body.error, /repeated/);
  assert.match((await setup('811111', '9811811111')).body.error, /part of your mobile number/);
  assert.equal((await setup('739154')).status, 201);
  assert.equal((await c.call('POST', '/api/i/star-classes/team', { name: 'T', phone: '9822000000', pin: '1234', role: 'teacher' })).status, 400);
});

test('someone with an old 4-digit PIN must set a new one before doing anything else', async (tt) => {
  const { client, platform } = await start(tt, { demo: false });
  platform.db.prepare('UPDATE users SET pin_hash = ? WHERE phone = ?').run(hashPin('1234'), '919999900002');
  const desk = client();
  const login = await desk.login('9999900002', '1234');
  assert.equal(login.status, 200);
  assert.equal(login.body.user.mustChangePin, true);
  assert.equal((await desk.call('GET', '/api/i/bright-future/board')).status, 403);
  assert.equal((await desk.call('POST', '/api/auth/pin', { current: '1234', next: '123456' })).status, 400, 'weak new PIN refused');
  assert.equal((await desk.call('POST', '/api/auth/pin', { current: '1234', next: '582047' })).status, 200);
  assert.equal((await desk.call('GET', '/api/auth/me')).body.user.mustChangePin, false);
  assert.equal((await desk.call('GET', '/api/i/bright-future/board')).status, 200);
});

test('logging out ends the session, even for a copied cookie', async (tt) => {
  const { client } = await start(tt);
  const a = client();
  await a.login('9999900001');
  const stolen = a.getCookie();
  await a.call('POST', '/api/auth/logout');
  const thief = client();
  thief.setCookie(stolen);
  assert.equal((await thief.call('GET', '/api/i/bright-future/board')).status, 401);
});

test('login limits: a phone is protected across many addresses, and one person can\'t lock everyone out', async (tt) => {
  const { client } = await start(tt, { trustProxy: true });
  // Five wrong PINs from one device lock that device for that phone...
  const attacker = client({ ip: '203.0.113.1' });
  for (let i = 0; i < 5; i++) await attacker.login('9999900001', '000000');
  assert.equal((await attacker.login('9999900001')).status, 429);
  // ...but the real owner on their own phone can still sign in.
  assert.equal((await client({ ip: '198.51.100.7' }).login('9999900001')).status, 200);

  // Guessing from many addresses: after 20 failures for one phone, it's locked everywhere.
  for (let i = 0; i < 20; i++) await client({ ip: `203.0.113.${10 + i}` }).login('9999900002', '000000');
  assert.equal((await client({ ip: '198.51.100.8' }).login('9999900002')).status, 429);

  // Spraying many phones from one address: locked after 30 failures.
  const sprayer = client({ ip: '203.0.113.200' });
  for (let i = 0; i < 30; i++) await sprayer.login(`98000${String(i).padStart(5, '0')}`, '000000');
  assert.equal((await sprayer.login('9999900003')).status, 429);
});
