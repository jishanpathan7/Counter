import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '../server/platform.js';
import { createApp, createEventHub } from '../server/app.js';
import { addMonths, billingState, financialYear, gstFor, rupeesInWords } from '../server/billing.js';
import { DEMO_PIN, seedDemo } from '../server/seed.js';
import { addDays } from '../server/time.js';

const quiet = { error() {}, warn() {}, log() {} };

test('billing rules: payment states, months, GST and amounts in words', () => {
  const s = (paidUntil, plan = 'standard') => billingState({ plan, paidUntil }, '2026-11-19').state;
  assert.equal(s(null, 'custom'), 'ok', 'no due date: nothing enforced');
  assert.equal(s('2026-11-19'), 'ok');
  assert.equal(s('2026-11-25', 'trial'), 'trial');
  assert.equal(s('2026-11-12'), 'due', '7 days late: reminder');
  assert.equal(s('2026-11-11'), 'readonly', '8 days late');
  assert.equal(s('2026-11-05'), 'readonly', '14 days late');
  assert.equal(s('2026-11-04'), 'lapsed', '15 days late');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-11-19', 12), '2027-11-19');
  assert.equal(financialYear('2026-03-31'), '2025-26');
  assert.equal(financialYear('2026-04-01'), '2026-27');
  const seller = { sellerGstin: '23ABCDE1234F1Z5', sellerState: 'Madhya Pradesh' };
  assert.deepEqual(gstFor(1999, { ...seller, buyerState: 'madhya pradesh' }).lines.map((l) => l.label), ['CGST 9%', 'SGST 9%']);
  assert.deepEqual(gstFor(1999, { ...seller, buyerState: 'Rajasthan' }).lines, [{ label: 'IGST 18%', amount: 359.82 }]);
  assert.equal(gstFor(1999, { ...seller, buyerState: 'Rajasthan' }).total, 2358.82);
  assert.equal(gstFor(1999, { sellerGstin: '', buyerState: 'x' }).total, 1999, 'not GST-registered: no tax');
  assert.equal(rupeesInWords(2358.82), 'Rupees two thousand three hundred fifty-eight and eighty-two paise only');
  assert.equal(rupeesInWords(1234567), 'Rupees twelve lakh thirty-four thousand five hundred sixty-seven only');
});

async function start(tt) {
  const now = Date.parse('2026-11-19T10:00:00Z');
  const platform = new Platform({ clock: () => now, logger: quiet });
  seedDemo(platform);
  const app = createApp({ platform, hub: createEventHub(), logger: quiet });
  const server = app.listen(0);
  tt.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = async (phone) => {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin: DEMO_PIN }) });
    const cookie = r.headers.get('set-cookie')?.split(';')[0] ?? '';
    return async (method, p, body) => {
      const res = await fetch(`${base}${p}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let data = text;
      try {
        data = JSON.parse(text);
      } catch {
        /* html */
      }
      return { status: res.status, body: data };
    };
  };
  return { platform, client, today: platform.today() };
}

test('plans limit students and logins, never the alert loop', async (tt) => {
  const { platform, client } = await start(tt);
  const agency = await client('9999900000');
  const created = await agency('POST', '/api/agency/institutes', { name: 'Small Tutorials', ownerName: 'Asha', ownerPhone: '9822000001', ownerPin: DEMO_PIN });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const owner = await client('9822000001');
  const b0 = await owner('GET', '/api/i/small-tutorials/billing');
  assert.equal(b0.body.state, 'trial', JSON.stringify(b0));

  await agency('PATCH', '/api/agency/institutes/small-tutorials/billing', { plan: 'starter', paidUntil: addDays(platform.today(), 20) });
  const batch = (await owner('POST', '/api/i/small-tutorials/batches', { name: 'A', startTime: '16:00', days: [1, 2, 3, 4, 5, 6] })).body;
  const csv = (n, from = 0) => Array.from({ length: n }, (_, i) => `Kid ${from + i}, P, 98${String(10000000 + from + i).padStart(8, '0')}`).join('\n');
  const tooMany = await owner('POST', '/api/i/small-tutorials/students/import', { csv: csv(101), batchId: batch.id });
  assert.equal(tooMany.status, 402);
  assert.match(tooMany.body.error, /Starter plan includes up to 100 students/);
  assert.equal((await owner('POST', '/api/i/small-tutorials/students/import', { csv: csv(100), batchId: batch.id })).body.added, 100);
  assert.equal((await owner('POST', '/api/i/small-tutorials/students', { name: 'One more', parentPhone: '9812399999', batchId: batch.id })).status, 402);

  // Starter: 3 logins (the owner is one).
  for (const [i, phone] of ['9833000001', '9833000002'].entries()) {
    assert.equal((await owner('POST', '/api/i/small-tutorials/team', { name: `T${i}`, phone, pin: '739154', role: 'teacher' })).status, 201);
  }
  assert.equal((await owner('POST', '/api/i/small-tutorials/team', { name: 'T3', phone: '9833000003', pin: '739154', role: 'teacher' })).status, 402);

  // Starter reports: the last month only, no CSV.
  assert.equal((await owner('GET', `/api/i/small-tutorials/reports?from=${addDays(platform.today(), -60)}`)).status, 402);
  assert.equal((await owner('GET', '/api/i/small-tutorials/reports.csv')).status, 402);
  assert.equal((await owner('GET', '/api/i/small-tutorials/reports')).status, 200);
  const bf = await client('9999900001'); // Standard: everything
  assert.equal((await bf('GET', `/api/i/bright-future/reports?from=${addDays(platform.today(), -60)}`)).status, 200);
});

test('late payment: reminder, then setup read-only while alerts continue, then paused', async (tt) => {
  const { platform, client, today } = await start(tt);
  const agency = await client('9999900000');
  const owner = await client('9999900001');
  const teacher = await client('9999900003');

  await agency('PATCH', '/api/agency/institutes/bright-future/billing', { paidUntil: addDays(today, -3) });
  assert.equal((await owner('GET', '/api/i/bright-future/info')).body.billing.state, 'due');
  assert.ok((await owner('POST', '/api/i/bright-future/holidays', { date: addDays(today, 30), label: 'Test' })).status < 300, 'still fully usable');

  await agency('PATCH', '/api/agency/institutes/bright-future/billing', { paidUntil: addDays(today, -10) });
  const blocked = await owner('POST', '/api/i/bright-future/holidays', { date: addDays(today, 31), label: 'Test' });
  assert.equal(blocked.status, 402);
  assert.match(blocked.body.error, /Attendance and WhatsApp alerts keep working/);
  const mine = (await teacher('GET', '/api/i/bright-future/info')).body.batchIds;
  const session = (await owner('GET', '/api/i/bright-future/board')).body.sessions.find((x) => mine.includes(x.batch.id) && !x.verifiedAt);
  assert.ok(session, "a class of the teacher's still open today");
  const marked = await teacher('POST', `/api/i/bright-future/sessions/${session.id}/mark`, { studentId: session.students[0].id, status: 'A' });
  assert.equal(marked.status, 200, `marking still works: ${JSON.stringify(marked.body)}`);
  assert.equal((await teacher('POST', `/api/i/bright-future/sessions/${session.id}/submit`)).status, 200, 'and sending the list');

  await agency('PATCH', '/api/agency/institutes/bright-future/billing', { paidUntil: addDays(today, -20) });
  assert.equal((await owner('GET', '/api/i/bright-future/info')).status, 402);
  assert.equal((await agency('GET', '/api/i/bright-future/info')).status, 200, 'the agency can still get in');
  let ticked = [];
  for (const slug of ['bright-future', 'excel']) platform.service(slug).tick = async () => ticked.push(slug);
  await platform.tickAll();
  assert.deepEqual(ticked, ['excel'], 'a lapsed institute is paused: no automatic alerts');

  // Paying brings it straight back, and the new period starts today (not from the lapsed date).
  const paid = await agency('POST', '/api/agency/institutes/bright-future/payments', { method: 'UPI', reference: 'utr123' });
  assert.equal(paid.status, 201);
  assert.ok(paid.body.paidUntil > today && paid.body.paidUntil <= addDays(today, 31), 'one month from today');
  assert.equal((await owner('GET', '/api/i/bright-future/info')).body.billing.state, 'ok');
});

test('payments: invoice numbers per financial year, GST, and owners see only their own', async (tt) => {
  const { platform, client } = await start(tt);
  const agency = await client('9999900000');
  const owner = await client('9999900001');
  const before = (await owner('GET', '/api/i/bright-future/billing')).body;
  assert.equal(before.payments.length, 2, 'two demo payments');
  const fy = financialYear(platform.today());
  assert.deepEqual(before.payments.map((p) => p.invoiceNo).sort(), [`DEMO/${financialYear(addDays(platform.today(), -40))}/0001`, `DEMO/${fy}/0002`].sort());

  // Paying early extends from the current paid-until date, not from today.
  const r = await agency('POST', '/api/agency/institutes/bright-future/payments', { method: 'Bank transfer' });
  assert.equal(r.body.invoiceNo, `DEMO/${fy}/0003`);
  assert.equal(r.body.total, 2358.82, '₹1,999 + 18% GST');
  assert.ok(r.body.paidUntil > before.paidUntil);

  const inv = await owner('GET', `/api/i/bright-future/billing/invoices/${r.body.id}`);
  assert.equal(inv.status, 200);
  assert.match(inv.body, /Tax invoice/);
  assert.match(inv.body, /CGST 9%/);
  assert.match(inv.body, /23ABCDE1234F1Z5/);
  assert.match(inv.body, /Rupees two thousand three hundred fifty-eight and eighty-two paise only/);

  // Another institute's owner can't open it; front desk can't see billing at all.
  await agency('POST', '/api/agency/institutes', { name: 'Other Classes', ownerName: 'O', ownerPhone: '9822000009', ownerPin: DEMO_PIN });
  const other = await client('9822000009');
  assert.equal((await other('GET', `/api/i/other-classes/billing/invoices/${r.body.id}`)).status, 404);
  const desk = await client('9999900002');
  assert.equal((await desk('GET', '/api/i/bright-future/billing')).status, 403);

  // Without a payment link, owners get a UPI link for the amount due.
  await agency('PUT', '/api/agency/billing-profile', { upiId: 'demoagency@okaxis' });
  const link = (await owner('GET', '/api/i/bright-future/billing')).body.paymentLink;
  assert.match(link, /^upi:\/\/pay\?pa=demoagency%40okaxis&pn=Demo%20Agency%20\(sample\)&am=2358\.82&cu=INR/);
  // An Excel invoice crosses no state line either; Toppers (Rajasthan) would get IGST.
  await agency('PATCH', '/api/agency/institutes/toppers/billing', { plan: 'pro' });
  const tp = await agency('POST', '/api/agency/institutes/toppers/payments', {});
  assert.match((await agency('GET', `/api/agency/payments/${tp.body.id}/invoice`)).body, /IGST 18%/);
});
