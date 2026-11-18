import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Platform } from './platform.js';
import { createApp, createEventHub } from './app.js';
import { DEMO_LOGINS, DEMO_PIN, seedDemo } from './seed.js';
import { isValidTimeZone } from './time.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env if present (no dependency needed).
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const port = Number(env.PORT ?? 3001);
const tz = env.INSTITUTE_TZ || 'Asia/Kolkata';
const dataDir = path.resolve(root, env.DATA_DIR || 'data');
const tickSeconds = Number(env.TICK_SECONDS ?? 10);
const demo = env.SEED_DEMO !== 'false';

if (!isValidTimeZone(tz)) throw new Error(`INSTITUTE_TZ "${tz}" is not a valid time zone`);

const hub = createEventHub();
const platform = new Platform({ dataDir, tz, env, onChange: (slug) => hub.broadcast(slug) });

const seeded = demo && seedDemo(platform);
const isDemo = demo && Boolean(seeded || platform.meta('demo'));
if (seeded) platform.setMeta('demo', '1');

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
    console.log(`Imported WhatsApp settings from .env into "${first.name}"`);
  }
}

const app = createApp({ platform, hub, demo: isDemo, staticDir: path.join(root, 'dist') });

let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    await platform.tickAll();
  } finally {
    ticking = false;
  }
}, tickSeconds * 1000);

app.listen(port, () => {
  console.log(`Attendance Alert on http://localhost:${port} (time zone ${tz}, data in ${dataDir})`);
  if (platform.needsSetup()) console.log('First run: open the app to create your account.');
  if (isDemo) {
    console.log(`Demo logins (PIN ${DEMO_PIN}):`);
    for (const l of DEMO_LOGINS) console.log(`  ${l.role.padEnd(16)} ${l.phone}  ${l.name}`);
  }
});
