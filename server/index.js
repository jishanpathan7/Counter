import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { AttendanceService } from './service.js';
import { createApp, createEventHub } from './app.js';
import { createSimulatorMessenger, createWhatsAppMessenger } from './messaging.js';
import { seedDemo } from './seed.js';
import { isValidTimeZone } from './time.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env if present (no dependency needed).
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const port = Number(env.PORT ?? 3001);
const tz = env.INSTITUTE_TZ || 'Asia/Kolkata';
const dbFile = path.resolve(root, env.DB_FILE || 'data/attendance.db');
const tickSeconds = Number(env.TICK_SECONDS ?? 10);

if (!isValidTimeZone(tz)) throw new Error(`INSTITUTE_TZ "${tz}" is not a valid time zone`);
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const messenger =
  env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID
    ? createWhatsAppMessenger({
        token: env.WHATSAPP_TOKEN,
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
        templateName: env.WHATSAPP_TEMPLATE,
        templateLanguage: env.WHATSAPP_TEMPLATE_LANG || 'en',
      })
    : createSimulatorMessenger();

const hub = createEventHub();
const db = openDb(dbFile);
const service = new AttendanceService({ db, messenger, tz, onChange: () => hub.broadcast() });

if (env.SEED_DEMO !== 'false' && seedDemo(service)) console.log('Seeded demo batches and students');

const app = createApp({
  service,
  hub,
  mode: messenger.mode,
  accessCode: env.ACCESS_CODE || '',
  whatsapp: { verifyToken: env.WHATSAPP_VERIFY_TOKEN, appSecret: env.WHATSAPP_APP_SECRET },
  staticDir: path.join(root, 'dist'),
});

let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    await service.tick();
  } catch (err) {
    console.error('Scheduler tick failed:', err);
  } finally {
    ticking = false;
  }
}, tickSeconds * 1000);

app.listen(port, () => {
  console.log(`Attendance server on http://localhost:${port} (WhatsApp: ${messenger.mode}, time zone: ${tz})`);
  if (!env.ACCESS_CODE) console.log('No ACCESS_CODE set: anyone who can reach this server can use it.');
});
