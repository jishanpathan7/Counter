import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '../server/platform.js';
import { createApp, createEventHub } from '../server/app.js';
import { DEMO_PIN, seedDemo } from '../server/seed.js';

const quiet = { error() {}, warn() {}, log() {} };

test('landing page info is public; referral links are counted and partners see their institutes', async (tt) => {
  const platform = new Platform({ logger: quiet });
  seedDemo(platform);
  const server = createApp({ platform, hub: createEventHub(), demo: true, logger: quiet }).listen(0);
  tt.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const pub = await (await fetch(`${base}/api/public/landing`)).json();
  assert.deepEqual(pub.plans.map((p) => [p.name, p.monthly]), [['Starter', 999], ['Standard', 1999], ['Pro', 3999]]);
  assert.equal(pub.trialDays, 30);
  assert.equal(pub.brand, 'Attendance Alert', 'the sample agency name is never shown publicly');
  assert.equal(pub.demo, true);

  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '9999900000', pin: DEMO_PIN }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const agency = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const partner = (await agency('POST', '/api/agency/referrals', { name: 'Kota Tuition Network', code: 'kota10', kind: 'reseller', commissionPct: 20 })).body;
  assert.equal(partner.code, 'KOTA10');
  assert.equal((await agency('POST', '/api/agency/referrals', { name: 'Again', code: 'KOTA10' })).status, 409);

  // Visits through the link (anonymous) and an institute signed through it.
  for (let i = 0; i < 3; i++) await fetch(`${base}/api/public/visit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'kota10' }) });
  assert.equal((await (await fetch(`${base}/api/public/visit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'NOPE' }) })).json()).ok, false);
  await agency('POST', '/api/agency/institutes', { name: 'Kota Stars', ownerName: 'R', ownerPhone: '9822000011', ownerPin: DEMO_PIN, referralCode: 'KOTA10' });
  await agency('PATCH', '/api/agency/institutes/excel/billing', { referralCode: 'KOTA10' }); // Excel came through them too (Starter, paying)
  const list = (await agency('GET', '/api/agency/referrals')).body;
  const kota = list.find((x) => x.code === 'KOTA10');
  assert.equal(kota.visits, 3);
  assert.deepEqual(kota.institutes.map((i) => i.slug).sort(), ['excel', 'kota-stars']);
  assert.equal(kota.paying, 1, 'the trial does not count as paying');
  assert.equal(kota.mrr, 999);
  assert.equal(kota.commissionMonthly, 199.8);
  assert.equal((await agency('PATCH', '/api/agency/institutes/excel/billing', { referralCode: 'MISSING' })).status, 404);
});
