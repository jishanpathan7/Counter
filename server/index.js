import { createRuntime } from './runtime.js';
import { DEMO_LOGINS, DEMO_PIN } from './seed.js';

const port = Number(process.env.PORT ?? 3001);
// `npm run dev` passes --dev: demo data on by default, no session secret needed.
const { app, platform, tz, dataDir, isDemo, reporter, tickMs, requestLog } = createRuntime({ dev: process.argv.includes('--dev') });

process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
  reporter.capture(err, { tags: { where: 'unhandledRejection' } });
});
process.on('uncaughtException', async (err) => {
  console.error('Crash:', err);
  reporter.capture(err, { tags: { where: 'uncaughtException' }, level: 'fatal' });
  await reporter.flush();
  process.exit(1);
});

let ticking = null;
const timer = setInterval(() => {
  if (ticking) return;
  ticking = platform.tickAll().finally(() => (ticking = null));
}, tickMs);

const server = app.listen(port, () => {
  console.log(`Attendance Alert on http://localhost:${port} (time zone ${tz}, data in ${dataDir})`);
  if (reporter.enabled) console.log('Error reports go to Sentry.');
  if (platform.needsSetup()) console.log('First run: open the app to create your account.');
  if (isDemo) {
    console.log(`Demo logins (PIN ${DEMO_PIN}):`);
    for (const l of DEMO_LOGINS) console.log(`  ${l.role.padEnd(16)} ${l.phone}  ${l.name}`);
  }
});

// Docker / systemd stop: finish the current scheduler round, close the databases, then exit.
let stopping = false;
const shutdown = async (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref(); // never hang a deploy
  clearInterval(timer);
  server.close();
  server.closeIdleConnections?.();
  setTimeout(() => server.closeAllConnections?.(), 2000).unref(); // live-update streams stay open otherwise
  await ticking?.catch(() => {});
  platform.close();
  requestLog.close();
  await reporter.flush();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
