import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Platform } from '../server/platform.js';
import { createApp, createEventHub } from '../server/app.js';
import { createErrorReporter, parseDsn, scrub } from '../server/errors.js';

const quiet = { error() {}, warn() {}, log() {} };

test('Sentry DSN parsing and number masking', () => {
  assert.deepEqual(parseDsn('https://abc123@o42.ingest.sentry.io/4507'), { publicKey: 'abc123', url: 'https://o42.ingest.sentry.io/api/4507/envelope/' });
  assert.equal(parseDsn(''), null);
  assert.equal(parseDsn('not a url'), null);
  assert.equal(scrub('Send to 919876543210 failed'), 'Send to [number] failed');
  assert.equal(scrub('parent +91 98765 43210 replied'), 'parent [number] replied');
  assert.equal(scrub('batch 12 at 16:00'), 'batch 12 at 16:00');
});

test('error reports: sent once per kind per minute, with numbers masked; off without a DSN', async () => {
  const calls = [];
  let now = 1_000_000;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const r = createErrorReporter({ dsn: 'https://key@sentry.example/9', fetchImpl, clock: () => now, logger: quiet, release: 'abc' });
  const boom = () => new Error('WhatsApp send to 919876543210 failed');
  assert.ok(r.capture(boom(), { tags: { institute: 'bright-future' }, request: { method: 'POST', path: '/api/i/x' } }));
  assert.equal(r.capture(boom()), null, 'same error within a minute is skipped');
  now += 61_000;
  assert.ok(r.capture(boom()));
  await r.flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://sentry.example/api/9/envelope/');
  assert.match(calls[0].init.headers['X-Sentry-Auth'], /sentry_key=key/);
  const event = JSON.parse(calls[0].init.body.split('\n')[2]);
  assert.equal(event.exception.values[0].value, 'WhatsApp send to [number] failed');
  assert.equal(event.tags.institute, 'bright-future');
  assert.equal(event.release, 'abc');
  assert.deepEqual(event.request, { method: 'POST', url: '/api/i/x' });
  assert.ok(!calls[0].init.body.includes('9876543210'));

  const off = createErrorReporter({ dsn: '', fetchImpl: () => assert.fail('should not send') });
  assert.equal(off.enabled, false);
  assert.equal(off.capture(new Error('x')), null);
});

async function serve(tt, opts) {
  const platform = new Platform({ logger: quiet });
  const app = createApp({ platform, hub: createEventHub(), logger: quiet, ...opts(platform) });
  const server = app.listen(0);
  tt.after(() => server.close());
  return { platform, base: `http://127.0.0.1:${server.address().port}` };
}

test('health check: 503 when the scheduler stalls or the database stops answering', async (tt) => {
  const { platform, base } = await serve(tt, () => ({ schedulerMaxAgeMs: 60_000, release: 'v1' }));
  let r = await fetch(`${base}/api/health`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).release, 'v1');

  platform.lastTickAt = Date.now() - 5 * 60_000; // last scheduler round 5 minutes ago
  r = await fetch(`${base}/api/health`);
  assert.equal(r.status, 503);
  assert.deepEqual((await r.json()).problems, ['scheduler']);

  await platform.tickAll();
  assert.equal((await fetch(`${base}/api/health`)).status, 200);

  platform.db.close();
  r = await fetch(`${base}/api/health`);
  assert.equal(r.status, 503);
  assert.ok((await r.json()).problems.includes('database'));
});

test('unexpected errors: the user sees a plain message, Sentry gets the details', async (tt) => {
  const captured = [];
  const reporter = { capture: (err, ctx) => captured.push({ err, ctx }) };
  const { platform, base } = await serve(tt, () => ({ reporter }));
  platform.needsSetup = () => {
    throw new Error('disk on fire');
  };
  const r = await fetch(`${base}/api/auth/me`);
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: 'Something went wrong' });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].err.message, 'disk on fire');
  assert.deepEqual(captured[0].ctx.request, { method: 'GET', path: '/api/auth/me' });
});

test('the server stops cleanly on SIGTERM (as Docker does on deploy)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-stop-'));
  const child = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, SESSION_SECRET: 'x'.repeat(40), SETUP_TOKEN: 'test-code', SEED_DEMO: 'true', TICK_SECONDS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server didn't start:\n${out}`)), 15_000);
    child.stdout.on('data', () => out.includes('Attendance Alert on') && (clearTimeout(t), resolve()));
  });
  await new Promise((r) => setTimeout(r, 1500)); // let a scheduler round run
  child.kill('SIGTERM');
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0, out);
  assert.match(out, /SIGTERM: shutting down/);
  // Databases were closed properly: the write-ahead log was folded back into the main file.
  for (const f of ['platform.db-wal', path.join('institutes', 'bright-future.db-wal')]) {
    const p = path.join(dataDir, f);
    assert.ok(!fs.existsSync(p) || fs.statSync(p).size === 0, `${f} should be empty after a clean close`);
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});
