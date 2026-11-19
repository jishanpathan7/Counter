import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Platform } from './platform.js';
import { createApp, createEventHub } from './app.js';
import { seedDemo } from './seed.js';
import { isValidTimeZone } from './time.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Builds the platform and the HTTP app.
 *
 * serverless: true is for hosts like Vercel, where code runs as short-lived functions:
 * data goes to the temporary folder, there is no background timer (the scheduler runs as
 * requests come in) and screens poll instead of keeping a live connection open.
 */
export function createRuntime({ env = process.env, serverless = false, logger = console } = {}) {
  const envFile = path.join(ROOT, '.env');
  if (!serverless && fs.existsSync(envFile)) process.loadEnvFile(envFile);

  const tz = env.INSTITUTE_TZ || 'Asia/Kolkata';
  if (!isValidTimeZone(tz)) throw new Error(`INSTITUTE_TZ "${tz}" is not a valid time zone`);
  const dataDir = serverless ? path.join(env.TMPDIR || '/tmp', 'attendance-alert') : path.resolve(ROOT, env.DATA_DIR || 'data');
  const demo = env.SEED_DEMO !== 'false';

  if (serverless && !env.SESSION_SECRET) {
    logger.warn?.('SESSION_SECRET is not set: logins will not survive across server instances.');
  }

  const hub = createEventHub();
  const platform = new Platform({ dataDir, tz, env, logger, onChange: (slug) => hub.broadcast(slug) });

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

  const app = createApp({
    platform,
    hub,
    demo: isDemo,
    realtime: !serverless,
    ephemeral: serverless,
    tickOnRequest,
    staticDir: serverless ? null : path.join(ROOT, 'dist'),
    logger,
  });

  return { app, platform, tz, dataDir, isDemo };
}
