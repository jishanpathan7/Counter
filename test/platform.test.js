import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '../server/platform.js';
import { createApp, createEventHub } from '../server/app.js';
import { seedDemo } from '../server/seed.js';

const quiet = { error() {} };

async function start(tt, { seed = true } = {}) {
  const now = Date.parse('2026-11-18T12:00:00Z'); // 5:30 PM IST
  const platform = new Platform({ clock: () => now, logger: quiet });
  if (seed) seedDemo(platform);
  const app = createApp({ platform, hub: createEventHub(), demo: seed, logger: quiet });
  const server = app.listen(0);
  tt.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    const call = async (method, p, body) => {
      const r = await fetch(`${base}${p}`, {
        method,
        headers: { cookie, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: r.status, body: data, headers: r.headers };
    };
    return { call, login: (phone, pin = '1234') => call('POST', '/api/auth/login', { phone, pin }) };
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
  const r = await c.call('POST', '/api/setup', { name: 'Me', phone: '9811111111', pin: '4321', instituteName: 'Star Classes' });
  assert.equal(r.status, 201);
  assert.equal(r.body.institute.slug, 'star-classes');
  const me = await c.call('GET', '/api/auth/me');
  assert.equal(me.body.user.isAgency, true);
  assert.equal(me.body.memberships[0].slug, 'star-classes');
  assert.equal((await c.call('POST', '/api/setup', { name: 'X', phone: '9822222222', pin: '1111', instituteName: 'Y' })).status, 409);
});

test('login, wrong PIN lockout, logout', async (tt) => {
  const { client } = await start(tt);
  const c = client();
  assert.equal((await c.call('GET', '/api/i/bright-future/board')).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await c.login('9999900001', '0000')).status, 401);
  assert.equal((await c.login('9999900001', '1234')).status, 429);
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
    name: 'Sharma Tutorials', city: 'Pune', feeMonthly: 9000, ownerName: 'Neha Sharma', ownerPhone: '9822000000', ownerPin: '5555',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.slug, 'sharma-tutorials');
  assert.equal((await agency.call('GET', '/api/agency/overview')).body.totals.mrr, 27000);
  const owner = client();
  const login = await owner.login('9822000000', '5555');
  assert.deepEqual(login.body.memberships.map((m) => [m.slug, m.role]), [['sharma-tutorials', 'owner']]);
});

test('team management keeps at least one owner', async (tt) => {
  const { client } = await start(tt);
  const owner = client();
  const me = (await owner.login('9999900001')).body.user;
  const added = await owner.call('POST', '/api/i/bright-future/team', { name: 'Ravi Sir', phone: '9833000000', pin: '2468', role: 'teacher' });
  assert.equal(added.status, 201);
  assert.equal((await owner.call('PATCH', `/api/i/bright-future/team/${me.id}`, { role: 'staff' })).status, 409);
  assert.equal((await owner.call('DELETE', `/api/i/bright-future/team/${me.id}`)).status, 409);
  assert.equal((await owner.call('DELETE', `/api/i/bright-future/team/${added.body.id}`)).status, 204);
  const ravi = client();
  assert.equal((await ravi.login('9833000000', '2468')).body.memberships.length, 0);
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
  await owner.call('POST', `/api/i/bright-future/sessions/${s.id}/verify`);
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
