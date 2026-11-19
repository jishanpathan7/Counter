import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Platform } from './platform.js';
import { createApp, createEventHub } from './app.js';
import { createErrorReporter } from './errors.js';
import { seedDemo } from './seed.js';
import { isValidTimeZone } from './time.js';

/** TRUST_PROXY: a hop count ("1"), true/false, or addresses/subnets ("loopback, 10.0.0.0/8"). */
export function parseTrustProxy(v) {
  const s = String(v ?? '').trim();
  if (!s) return 'loopback';
  if (/^\d+$/.test(s)) return Number(s);
  if (s === 'true' || s === 'false') return s === 'true';
  return s;
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Builds the platform and the HTTP app.
 *
 * serverless: true is for hosts like Vercel, where code runs as short-lived functions:
 * data goes to the temporary folder, there is no background timer (the scheduler runs as
 * requests come in) and screens poll instead of keeping a live connection open.
 */
export function createRuntime({ env = process.env, serverless = false, dev = false, logger = console } = {}) {
  const envFile = path.join(ROOT, '.env');
  if (!serverless && fs.existsSync(envFile)) process.loadEnvFile(envFile);

  const tz = env.INSTITUTE_TZ || 'Asia/Kolkata';
  if (!isValidTimeZone(tz)) throw new Error(`INSTITUTE_TZ "${tz}" is not a valid time zone`);
  const dataDir = serverless ? path.join(env.TMPDIR || '/tmp', 'attendance-alert') : path.resolve(ROOT, env.DATA_DIR || 'data');
  // Demo data (and the demo logins on the login screen) only when explicitly asked for,
  // or in local development. A production deploy never ships them by accident.
  const demo = env.SEED_DEMO === 'true' || (dev && env.SEED_DEMO !== 'false');

  if (!dev && !(env.SESSION_SECRET && env.SESSION_SECRET.length >= 32)) {
    throw new Error('SESSION_SECRET must be set to a random string of at least 32 characters, e.g. the output of `openssl rand -hex 32`.');
  }

  // Which build is running (set by the Docker build or Vercel), shown in /api/health and error reports.
  const release = env.APP_RELEASE || env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || null;
  const reporter = createErrorReporter({
    dsn: env.SENTRY_DSN || '',
    environment: env.SENTRY_ENVIRONMENT || (dev ? 'development' : serverless ? 'preview' : 'production'),
    release,
    logger,
  });
  const tickMs = Math.max(1, Number(env.TICK_SECONDS ?? 10)) * 1000;

  if (env.DATA_ENCRYPTION_KEY && env.DATA_ENCRYPTION_KEY.length < 32) {
    throw new Error('DATA_ENCRYPTION_KEY must be at least 32 characters, e.g. the output of `openssl rand -hex 32`.');
  }

  const hub = createEventHub();
  const platform = new Platform({ dataDir, tz, env, logger, reporter, onChange: (slug) => hub.broadcast(slug) });

  const seeded = demo && seedDemo(platform);
  if (seeded) platform.setMeta('demo', '1');
  const isDemo = demo && Boolean(seeded || platform.meta('demo'));

  // Version 1 kept WhatsApp settings in .env: copy them into the first institute once.
  if (env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && !platform.meta('envWhatsAppImported')) {
    const first = platform.listInstitutes()[0];
    if (first) {
      platform.service(first.slug).updateWhatsAppConfig({
        token: env.WHATSAPP_TOKEN,
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
        template: env.WHATSAPP_TEMPLATE || '',
        templateLang: env.WHATSAPP_TEMPLATE_LANG || 'en',
        verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
        appSecret: env.WHATSAPP_APP_SECRET || '',
      });
      platform.refreshMessenger(first.slug);
      platform.setMeta('envWhatsAppImported', '1');
      logger.log?.(`Imported WhatsApp settings from .env into "${first.name}"`);
    }
  }

  // Serverless: run the scheduler at most every few seconds, piggybacking on requests.
  let lastTick = 0;
  const tickOnRequest = serverless
    ? async () => {
        if (Date.now() - lastTick < 3000) return;
        lastTick = Date.now();
        await platform.tickAll();
      }
    : null;

  // First-run setup creates the platform admin, so it needs a one-time code outside development.
  // Use SETUP_TOKEN, or on a normal server a random code printed to the log.
  let setupToken = null;
  if (!dev && platform.needsSetup()) {
    setupToken = env.SETUP_TOKEN || crypto.randomBytes(9).toString('base64url');
    if (env.SETUP_TOKEN) logger.log?.('First-run setup needs the SETUP_TOKEN code.');
    else if (serverless) logger.warn?.('Set SETUP_TOKEN to enable first-run setup on this deployment.');
    else logger.log?.(`First-run setup code: ${setupToken}`);
  }

  const app = createApp({
    platform,
    hub,
    demo: isDemo,
    setupToken,
    realtime: !serverless,
    ephemeral: serverless,
    tickOnRequest,
    trustProxy: serverless ? true : parseTrustProxy(env.TRUST_PROXY),
    reporter,
    release,
    // A scheduler that hasn't run for a few rounds is a problem (no alerts go out). Serverless has none.
    schedulerMaxAgeMs: serverless ? 0 : Math.max(60_000, tickMs * 6),
    staticDir: serverless ? null : path.join(ROOT, 'dist'),
    logger,
  });

  return { app, platform, tz, dataDir, isDemo, reporter, tickMs };
}
