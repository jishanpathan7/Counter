import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Platform } from '../server/platform.js';
import { createApp, createEventHub } from '../server/app.js';
import { createSecretBox, SecretUnreadableError } from '../server/secrets.js';
import { DEMO_PIN, seedDemo } from '../server/seed.js';

const quiet = { error() {}, warn() {}, log() {} };
const tmpDir = (tt) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-privacy-'));
  tt.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const SECRET_A = 'a'.repeat(40);
const SECRET_B = 'b'.repeat(40);

test('secret box: encrypts with a fresh nonce, detects a wrong key or tampering, passes old plain values through', () => {
  const box = createSecretBox(SECRET_A);
  const a = box.seal('EAAG-token-123');
  const b = box.seal('EAAG-token-123');
  assert.match(a, /^enc:v1:/);
  assert.notEqual(a, b, 'same value encrypts differently each time');
  assert.ok(!a.includes('EAAG'));
  assert.equal(box.open(a), 'EAAG-token-123');
  assert.equal(box.open('plain-from-old-version'), 'plain-from-old-version');
  assert.equal(box.seal(''), '');
  assert.throws(() => createSecretBox(SECRET_B).open(a), SecretUnreadableError);
  const tampered = a.slice(0, -2) + (a.endsWith('A') ? 'B' : 'A') + a.slice(-1);
  assert.throws(() => box.open(tampered), SecretUnreadableError);
});

test('WhatsApp credentials are encrypted on disk, old plain ones get encrypted, a changed key is flagged', (tt) => {
  const dataDir = tmpDir(tt);
  let p = new Platform({ dataDir, env: { SESSION_SECRET: SECRET_A }, logger: quiet });
  p.createInstitute({ name: 'Star Classes', slug: 'star' });
  const svc = p.service('star');
  svc.updateWhatsAppConfig({ token: 'EAAG-real-token', phoneNumberId: '123', appSecret: 'app-secret-xyz', verifyToken: 'hello' });
  assert.equal(svc.getWhatsAppConfig().token, 'EAAG-real-token');
  assert.equal(p.refreshMessenger('star'), 'whatsapp');
  const raw = svc.rawSettings();
  assert.match(raw['wa.token'], /^enc:v1:/);
  assert.match(raw['wa.appSecret'], /^enc:v1:/);
  assert.equal(raw['wa.phoneNumberId'], '123', 'non-secret settings stay readable');

  // A database from before encryption: plain values are encrypted the first time it's opened.
  svc.setSetting('wa.token', 'EAAG-old-plain');
  p.close();
  p = new Platform({ dataDir, env: { SESSION_SECRET: SECRET_A }, logger: quiet });
  assert.match(p.service('star').rawSettings()['wa.token'], /^enc:v1:/);
  assert.equal(p.service('star').getWhatsAppConfig().token, 'EAAG-old-plain');
  p.close();
  const onDisk = fs.readFileSync(path.join(dataDir, 'institutes', 'star.db'));
  assert.ok(!onDisk.includes('EAAG-old-plain') && !onDisk.includes('app-secret-xyz'), 'no credential in the file in plain text');

  // A different key (SESSION_SECRET changed): nothing is sent with garbage; the owner is told.
  const errors = [];
  p = new Platform({ dataDir, env: { SESSION_SECRET: SECRET_B }, logger: { ...quiet, error: (m) => errors.push(m) } });
  const s2 = p.service('star');
  assert.equal(s2.messenger.mode, 'simulator');
  assert.deepEqual(s2.getWhatsAppPublic().unreadable, ['token', 'appSecret']);
  assert.match(errors[0], /can't be decrypted/);
  // Entering the token again fixes it.
  s2.updateWhatsAppConfig({ token: 'EAAG-new', appSecret: 'new-secret' });
  assert.deepEqual(s2.getWhatsAppPublic().unreadable, []);
  assert.equal(p.refreshMessenger('star'), 'whatsapp');
  p.close();

  // DATA_ENCRYPTION_KEY takes priority over SESSION_SECRET.
  p = new Platform({ dataDir, env: { SESSION_SECRET: SECRET_B, DATA_ENCRYPTION_KEY: 'k'.repeat(40) }, logger: quiet });
  assert.deepEqual(p.service('star').getWhatsAppPublic().unreadable, ['token', 'appSecret']);
  p.close();
});

async function start(tt) {
  const dataDir = tmpDir(tt);
  const platform = new Platform({ dataDir, env: { SESSION_SECRET: SECRET_A }, logger: quiet });
  seedDemo(platform);
  const app = createApp({ platform, hub: createEventHub(), logger: quiet });
  const server = app.listen(0);
  tt.after(() => {
    server.close();
    try {
      platform.close();
    } catch {
      /* closed by the test */
    }
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  platform.__base = base;
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
        /* not JSON */
      }
      return { status: res.status, body: data, headers: res.headers };
    };
  };
  return { platform, dataDir, client };
}

test('export: a family gets everything held about them, and only theirs', async (tt) => {
  const { platform, client } = await start(tt);
  const bf = platform.service('bright-future');
  const rohan = bf.listStudents().find((s) => s.name === 'Rohan Verma') ?? bf.listStudents()[0];
  const sib = bf.createStudent({ name: 'Little Sibling', parentPhone: rohan.parentPhone, batchId: rohan.batchId });
  const desk = await client('9999900002'); // front desk can answer a parent's request

  const r = await desk('GET', `/api/i/bright-future/students/${sib.id}/export`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="little-sibling-family-data-\d{4}-\d{2}-\d{2}\.json"/);
  assert.equal(r.body.parent.phone, rohan.parentPhone);
  assert.deepEqual(r.body.students.map((s) => s.name).sort(), [rohan.name, 'Little Sibling'].sort());
  assert.ok(r.body.students.find((s) => s.name === rohan.name).attendance.length > 0);
  assert.ok(['present', 'absent', 'late', 'on leave'].includes(r.body.students.find((s) => s.name === rohan.name).attendance[0].status));
  assert.ok(r.body.consent);
  const others = bf.listStudents().filter((s) => s.parentPhone !== rohan.parentPhone).map((s) => s.name);
  assert.ok(others.every((n) => !JSON.stringify(r.body).includes(n)), "no other family's data");
  assert.match(bf.listPrivacyLog()[0].action, /export_family/);
  assert.equal(bf.listPrivacyLog()[0].actor, 'Pooja Desai');
});

test('export: the owner can download the whole institute, without credentials; staff cannot', async (tt) => {
  const { platform, client } = await start(tt);
  platform.service('bright-future').updateWhatsAppConfig({ token: 'EAAG-secret', appSecret: 'shh', verifyToken: 'vt' });
  const owner = await client('9999900001');
  const r = await owner('GET', '/api/i/bright-future/export');
  assert.equal(r.status, 200);
  assert.equal(r.body.format, 'attendance-alert-export');
  assert.ok(r.body.students.length >= 21 && r.body.attendance.length > 100);
  assert.ok(r.body.team.some((m) => m.role === 'owner'));
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes('EAAG') && !text.includes('enc:v1') && !text.includes('pin_hash'), 'no credentials or PIN hashes');
  const desk = await client('9999900002');
  assert.equal((await desk('GET', '/api/i/bright-future/export')).status, 403);
});

test('erase: a student is gone for good, siblings keep the parent, STOP is still respected', async (tt) => {
  const { platform, dataDir, client } = await start(tt);
  const bf = platform.service('bright-future');
  const owner = await client('9999900001');
  const desk = await client('9999900002');
  const [a, b] = bf.listStudents().filter((s) => bf.db.prepare('SELECT COUNT(*) n FROM alerts WHERE student_id = ?').get(s.id).n > 0);
  const sib = bf.createStudent({ name: 'Zz Sibling', parentPhone: a.parentPhone, batchId: a.batchId });
  await bf.handleReply({ phone: a.parentPhone, text: 'kal se chutti' }); // a message from this parent

  assert.equal((await desk('POST', `/api/i/bright-future/students/${a.id}/erase`, { confirm: a.name })).status, 403, 'owner only');
  assert.equal((await owner('POST', `/api/i/bright-future/students/${a.id}/erase`, { confirm: 'someone else' })).status, 400);

  // With a sibling still enrolled, the parent's messages and consent stay.
  let r = await owner('POST', `/api/i/bright-future/students/${a.id}/erase`, { confirm: a.name.toUpperCase() });
  assert.equal(r.status, 200);
  assert.ok(r.body.attendance > 0 && r.body.alerts > 0);
  const count = (sql, ...args) => bf.db.prepare(sql).get(...args).n;
  assert.equal(count('SELECT COUNT(*) n FROM students WHERE id = ?', a.id), 0);
  assert.equal(count('SELECT COUNT(*) n FROM attendance WHERE student_id = ?', a.id), 0);
  assert.equal(count('SELECT COUNT(*) n FROM alerts WHERE student_id = ?', a.id), 0);
  assert.ok(count('SELECT COUNT(*) n FROM messages WHERE phone = ?', a.parentPhone) > 0);

  // Last child on that number: the parent's messages and consent records go too.
  bf.deleteStudent(sib.id); // "removed" first, then erased from the Privacy page
  assert.equal(bf.listRemovedStudents().length, 1);
  assert.equal((await owner('POST', '/api/i/bright-future/privacy/erase-removed', { confirm: 'yes' })).status, 400);
  r = await owner('POST', '/api/i/bright-future/privacy/erase-removed', { confirm: 'ERASE' });
  assert.deepEqual(r.body, { erased: 1 });
  assert.equal(count('SELECT COUNT(*) n FROM messages WHERE phone = ?', a.parentPhone), 0);
  assert.equal(count('SELECT COUNT(*) n FROM consent_log WHERE phone = ?', a.parentPhone), 0);
  assert.equal(bf.consentFor(a.parentPhone), null);

  // A parent who sent STOP stays on the do-not-message list after erasure.
  await bf.handleReply({ phone: b.parentPhone, text: 'STOP' });
  await owner('POST', `/api/i/bright-future/students/${b.id}/erase`, { confirm: b.name });
  assert.equal(bf.consentFor(b.parentPhone).status, 'opted_out');

  // The log says what happened, without the names.
  const { body: privacy } = await owner('GET', '/api/i/bright-future/privacy');
  const log = privacy.log.filter((l) => l.action === 'erase_student');
  assert.equal(log.length, 3);
  assert.ok(log.every((l) => l.actor === 'Rakesh Sharma' && !l.detail.includes(a.name) && !l.detail.includes(b.name)));

  // And the names aren't left behind in the database file either.
  bf.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const file = fs.readFileSync(path.join(dataDir, 'institutes', 'bright-future.db'));
  for (const name of [a.name, b.name, 'Zz Sibling']) assert.ok(!file.includes(name), `${name} should not be in the file`);
});

test('agency: deleting an institute removes its data and the accounts only it used', async (tt) => {
  const { platform, dataDir, client } = await start(tt);
  const agency = await client('9999900000');
  const owner = await client('9999900001');
  // Someone on two teams keeps their account.
  platform.addMember('excel', { name: 'Pooja Desai', phone: '9999900002', pin: DEMO_PIN, role: 'staff' });
  const dbFile = path.join(dataDir, 'institutes', 'bright-future.db');
  assert.ok(fs.existsSync(dbFile));

  assert.equal((await owner('POST', '/api/agency/institutes/bright-future/delete', { confirm: 'bright-future' })).status, 403);
  assert.equal((await agency('POST', '/api/agency/institutes/bright-future/delete', { confirm: 'bright-future' })).status, 409, 'must be paused first');
  await agency('PATCH', '/api/agency/institutes/bright-future', { status: 'paused' });
  assert.equal((await agency('POST', '/api/agency/institutes/bright-future/delete', { confirm: 'Bright Future' })).status, 400);
  const r = await agency('POST', '/api/agency/institutes/bright-future/delete', { confirm: 'bright-future' });
  assert.equal(r.status, 200);
  assert.equal(r.body.accounts, 2, 'the owner and the teacher; the front desk works elsewhere too');

  assert.ok(!fs.existsSync(dbFile) && !fs.existsSync(`${dbFile}-wal`));
  assert.equal((await owner('GET', '/api/auth/me')).body.user, null, "the owner's login no longer works");
  assert.ok(platform.db.prepare("SELECT id FROM users WHERE phone = '919999900002'").get(), 'shared account kept');
  assert.equal((await agency('GET', '/api/i/bright-future/info')).status, 404);
  const { body: log } = await agency('GET', '/api/agency/privacy-log');
  assert.match(log[0].detail, /Bright Future Classes \(bright-future\): database and 2 team accounts deleted/);
  // Other institutes are untouched.
  assert.equal((await agency('GET', '/api/i/excel/students')).status, 200);
});

test('access log and sign-in log: who opened what, who signed in (numbers masked)', async (tt) => {
  const { platform, client } = await start(tt);
  const owner = await client('9999900001');
  const desk = await client('9999900002');
  const bf = platform.service('bright-future');
  const st = bf.listStudents()[0];
  await desk('GET', `/api/i/bright-future/students/${st.id}`);
  const { body } = await owner('GET', '/api/i/bright-future/privacy');
  assert.equal(body.access[0].actor, 'Pooja Desai');
  assert.equal(body.access[0].type, 'student_viewed');
  assert.equal(body.access[0].studentName, st.name);
  assert.equal((await desk('GET', '/api/i/bright-future/privacy')).status, 403);

  platform.authLog('login_failed', { phone: '919999900003', ip: '203.0.113.5' });
  const agency = await client('9999900000');
  const log = (await agency('GET', '/api/agency/auth-log')).body;
  assert.ok(log.some((l) => l.event === 'login' && l.name === 'Pooja Desai'));
  const failed = log.find((l) => l.event === 'login_failed');
  assert.equal(failed.phone, '91******0003', 'phone numbers masked');
  assert.equal((await owner('GET', '/api/agency/auth-log')).status, 403);
});

test('owners on a new device enter a WhatsApp code (only with real WhatsApp); remembered devices skip it', async (tt) => {
  const { platform, client } = await start(tt);
  const sent = [];
  let fail = false;
  const bf = platform.service('bright-future');
  // Real WhatsApp but no sign-in template yet: no code asked for.
  bf.messenger = { mode: 'whatsapp', async send() { throw new Error('should not send'); } };
  assert.equal((await (await fetch(`${platform.__base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '9999900001', pin: DEMO_PIN }) })).json()).needsCode, undefined);
  bf.updateWhatsAppConfig({ otpTemplate: 'login_code' });
  bf.messenger = { mode: 'whatsapp', async send(m) { if (fail) throw new Error('Meta down'); sent.push(m); return { id: `w${sent.length}` }; } };
  const login = (phone, cookie = '') =>
    fetch(`${platform.__base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ phone, pin: DEMO_PIN }) });
  const code = (body, cookie = '') => fetch(`${platform.__base}/api/auth/code`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });

  // New device: no session yet, a code goes to the owner's WhatsApp.
  let r = await login('9999900001');
  let body = await r.json();
  assert.equal(body.needsCode, true);
  assert.equal(body.sentTo, '••••0001');
  assert.equal(r.headers.get('set-cookie'), null, 'no session before the code');
  assert.equal(sent.at(-1).template, 'otp');
  const theCode = sent.at(-1).params[0];
  assert.match(theCode, /^\d{6}$/);
  assert.equal(bf.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body LIKE '%sign-in code%'").get().n, 0, 'codes are not kept in the WhatsApp log');

  assert.equal((await code({ challenge: body.challenge, code: '000000' })).status, 401);
  r = await code({ challenge: body.challenge, code: theCode, remember: true });
  assert.equal(r.status, 200);
  const cookies = r.headers.getSetCookie();
  assert.ok(cookies.some((c) => c.startsWith('aa_session=')));
  const device = cookies.find((c) => c.startsWith('aa_device=')).split(';')[0];
  assert.equal((await code({ challenge: body.challenge, code: theCode })).status, 401, 'a code works once');

  // Remembered device: straight in.
  body = await (await login('9999900001', device)).json();
  assert.equal(body.needsCode, undefined);
  assert.equal(body.user.name, 'Rakesh Sharma');

  // Front desk never gets a code; agency neither.
  assert.equal((await (await login('9999900002')).json()).needsCode, undefined);
  assert.equal((await (await login('9999900000')).json()).needsCode, undefined);

  // WhatsApp down: the owner still gets in (no lock-out), and the agency's sign-in log shows it.
  fail = true;
  body = await (await login('9999900001')).json();
  assert.equal(body.needsCode, undefined);
  assert.equal(platform.listAuthLog(5).find((l) => l.event === 'new_device_no_code')?.name, 'Rakesh Sharma');
  fail = false;

  // A new PIN forgets remembered devices.
  const u = platform.db.prepare("SELECT id FROM users WHERE phone = '919999900001'").get();
  platform.setPin(u.id, '582047');
  const again = await fetch(`${platform.__base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: device }, body: JSON.stringify({ phone: '9999900001', pin: '582047' }) });
  assert.equal((await again.json()).needsCode, true);
  void client;
});

test('login-code template payload: code in the body and the copy-code button', async () => {
  const { buildPayload } = await import('../server/messaging.js');
  const p = buildPayload({ to: '919999900001', text: 'x', params: ['123456'], templateName: 'login_code', templateLanguage: 'en', otp: true });
  assert.deepEqual(p.template.components, [
    { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '123456' }] },
  ]);
});
