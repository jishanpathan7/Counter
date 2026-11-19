import fs from 'node:fs';

/**
 * Numbered schema migrations, tracked with SQLite's `PRAGMA user_version`.
 *
 * Each migration runs once, in order, inside a transaction. They're written to be safe on
 * databases created by any earlier version (they check before changing). Before an existing
 * database file is changed, a copy is saved next to it (`<file>.before-v<N>`), so a bad upgrade
 * can be undone without the backup bucket.
 */
export function runMigrations(db, migrations, { file = null, existing = null, logger = console, label = 'database' } = {}) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  if (!pending.length) return { from: current, to: current, applied: [] };
  const target = pending.at(-1).version;

  const hadData = existing ?? current > 0;
  if (file && file !== ':memory:' && hadData) {
    const copy = `${file}.before-v${target}`;
    try {
      fs.rmSync(copy, { force: true });
      db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    } catch (err) {
      logger.warn?.(`Couldn't save a copy of ${label} before upgrading: ${err.message}`);
    }
  }
  for (const m of pending) {
    db.exec('BEGIN');
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Upgrading ${label} to version ${m.version} (${m.name}) failed: ${err.message}`);
    }
  }
  if (hadData) logger.log?.(`Upgraded ${label} from version ${current} to ${target}`);
  return { from: current, to: target, applied: pending.map((m) => m.version) };
}

export const hasColumn = (db, table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
