import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const REQUEST_LOG_DAYS = 180; // CERT-In: keep logs for 180 days

/**
 * One line per API or webhook request, kept 180 days in `logs.db` next to the other databases
 * (so the backup copies it too). Paths are stored without the query string, so search terms or
 * phone numbers typed into the app never land in the log.
 */
export function createRequestLog({ dataDir = null, clock = () => Date.now(), logger = console } = {}) {
  const db = new DatabaseSync(dataDir ? path.join(dataDir, 'logs.db') : ':memory:');
  if (dataDir) db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY, at TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL,
    ms INTEGER NOT NULL, user_id INTEGER, ip TEXT, agent TEXT
  ); CREATE INDEX IF NOT EXISTS idx_requests_at ON requests(at);`);
  const insert = db.prepare('INSERT INTO requests (at, method, path, status, ms, user_id, ip, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  let lastPurge = 0;

  const purge = () => {
    lastPurge = clock();
    return db.prepare('DELETE FROM requests WHERE at < ?').run(new Date(clock() - REQUEST_LOG_DAYS * 86_400_000).toISOString()).changes;
  };

  const middleware = (req, res, next) => {
    const p = req.originalUrl.split('?')[0];
    if (!/^\/(api|webhooks)\//.test(p) || p === '/api/health' || p.endsWith('/events')) return next();
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      try {
        insert.run(
          new Date(clock()).toISOString(),
          req.method,
          p.slice(0, 300),
          res.statusCode,
          Number((process.hrtime.bigint() - started) / 1_000_000n),
          req.user?.id ?? null,
          req.ip ?? null,
          String(req.get('user-agent') ?? '').slice(0, 120),
        );
        if (clock() - lastPurge > 86_400_000) purge();
      } catch (err) {
        logger.error?.(`Request log write failed: ${err.message}`);
      }
    });
    next();
  };

  const list = ({ limit = 500, userId = null, from = null } = {}) =>
    db
      .prepare(
        `SELECT at, method, path, status, ms, user_id AS userId, ip, agent FROM requests
          WHERE (? IS NULL OR user_id = ?) AND (? IS NULL OR at >= ?) ORDER BY id DESC LIMIT ?`,
      )
      .all(userId, userId, from, from, Math.min(Number(limit) || 500, 5000));

  return { middleware, purge, list, close: () => db.close(), db };
}
