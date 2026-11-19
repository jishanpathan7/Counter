import { createRuntime } from './runtime.js';
import { DEMO_LOGINS, DEMO_PIN } from './seed.js';

const port = Number(process.env.PORT ?? 3001);
const tickSeconds = Number(process.env.TICK_SECONDS ?? 10);
// `npm run dev` passes --dev: demo data on by default, no session secret needed.
const { app, platform, tz, dataDir, isDemo } = createRuntime({ dev: process.argv.includes('--dev') });

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
