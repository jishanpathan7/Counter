#!/usr/bin/env node
/**
 * Backups with Litestream: every change to every database is copied to S3-compatible storage
 * within about a second, so losing the server loses at most the last few seconds.
 *
 *   node server/backup.js enabled              exit 0 if backups are configured
 *   node server/backup.js config [file]        write the Litestream config (stdout without a file)
 *   node server/backup.js restore              restore any database that is missing locally
 *   node server/backup.js drill                restore everything into a temp folder and check it
 *   node server/backup.js copy <db> <out> [time]
 *                                              restore one database (e.g. institutes/x.db) to a separate
 *                                              file, optionally as it was at an ISO time
 *
 * Configured with environment variables (see .env.example):
 *   BACKUP_S3_BUCKET, BACKUP_S3_PATH, BACKUP_S3_REGION, BACKUP_S3_ENDPOINT,
 *   BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY  (S3, R2, Spaces, ...)
 *   BACKUP_DIR                                            (a local folder instead, for testing)
 *   BACKUP_RETENTION (default 720h = 30 days), BACKUP_HEARTBEAT_URL (optional monitor ping)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function backupSettings(env = process.env) {
  const dataDir = path.resolve(ROOT, env.DATA_DIR || 'data');
  if (env.BACKUP_S3_BUCKET) {
    return {
      dataDir,
      replica: {
        type: 's3',
        bucket: env.BACKUP_S3_BUCKET,
        path: (env.BACKUP_S3_PATH || 'attendance-alert').replace(/^\/+|\/+$/g, ''),
        region: env.BACKUP_S3_REGION || 'ap-south-1',
        ...(env.BACKUP_S3_ENDPOINT ? { endpoint: env.BACKUP_S3_ENDPOINT, 'force-path-style': true } : {}),
        ...(env.BACKUP_S3_ACCESS_KEY_ID ? { 'access-key-id': env.BACKUP_S3_ACCESS_KEY_ID, 'secret-access-key': env.BACKUP_S3_SECRET_ACCESS_KEY || '' } : {}),
      },
      retention: env.BACKUP_RETENTION || '720h',
      heartbeatUrl: env.BACKUP_HEARTBEAT_URL || null,
    };
  }
  if (env.BACKUP_DIR) {
    return { dataDir, replica: { type: 'file', path: path.resolve(ROOT, env.BACKUP_DIR) }, retention: env.BACKUP_RETENTION || '720h', heartbeatUrl: env.BACKUP_HEARTBEAT_URL || null };
  }
  return null;
}

/** Litestream config: watch the whole data folder, so new institutes are backed up automatically. */
export function litestreamConfig(settings) {
  const config = {
    ...(settings.heartbeatUrl ? { 'heartbeat-url': settings.heartbeatUrl, 'heartbeat-interval': '5m' } : {}),
    snapshot: { interval: '24h', retention: settings.retention },
    dbs: [{ dir: settings.dataDir, pattern: '*.db', recursive: true, watch: true, replica: settings.replica }],
  };
  return JSON.stringify(config, null, 2); // JSON is valid YAML, and needs no quoting rules
}

/** Config for restoring one database: Litestream restores by name only for databases listed one by one. */
function singleDbConfig(settings, relPath) {
  const replica = { ...settings.replica, path: path.posix.join(settings.replica.path, relPath.split(path.sep).join('/')) };
  return JSON.stringify({ dbs: [{ path: path.join(settings.dataDir, relPath), replica }] });
}

function litestream(args, { quiet = false } = {}) {
  return execFileSync(process.env.LITESTREAM_BIN || 'litestream', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'pipe' : 'inherit'] });
}

/** Restore one database (path relative to the data folder) to `out`. Returns false if there's no backup of it. */
function restoreOne(settings, relPath, out, tmp, { timestamp = null } = {}) {
  const cfg = path.join(tmp, `${relPath.replaceAll(path.sep, '_')}.json`);
  fs.writeFileSync(cfg, singleDbConfig(settings, relPath));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const at = timestamp ? ['-timestamp', new Date(timestamp).toISOString()] : [];
  litestream(['restore', '-config', cfg, '-if-replica-exists', ...at, '-o', out, path.join(settings.dataDir, relPath)]);
  return fs.existsSync(out);
}

/** Restore one database to a separate file (never over the live one), optionally as it was at `timestamp`. */
export function restoreCopy(settings, relPath, out, timestamp = null) {
  const rel = path.normalize(relPath);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !rel.endsWith('.db')) throw new Error('Give the database as e.g. platform.db or institutes/<slug>.db');
  const target = path.resolve(out);
  if (target.startsWith(path.resolve(settings.dataDir) + path.sep)) throw new Error('Restore to a file outside the data folder, then check it before replacing anything.');
  if (fs.existsSync(target)) throw new Error(`${out} already exists`);
  if (timestamp && Number.isNaN(Date.parse(timestamp))) throw new Error('Time must look like 2026-11-19T10:00:00+05:30');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-'));
  try {
    return restoreOne(settings, rel, target, tmp, { timestamp });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function instituteSlugs(platformDbFile) {
  const db = new DatabaseSync(platformDbFile, { readOnly: true });
  try {
    return db.prepare('SELECT slug FROM institutes ORDER BY slug').all().map((r) => r.slug);
  } finally {
    db.close();
  }
}

/**
 * On a fresh server (or after losing the disk), bring back every database that's missing.
 * Databases that already exist are never touched.
 */
export function restoreMissing(settings, log = console.log) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-'));
  try {
    const platformDb = path.join(settings.dataDir, 'platform.db');
    let restored = 0;
    if (!fs.existsSync(platformDb)) {
      if (!restoreOne(settings, 'platform.db', platformDb, tmp)) {
        log('No backup found: starting with an empty database.');
        return { restored: 0 };
      }
      restored += 1;
    }
    for (const slug of instituteSlugs(platformDb)) {
      const rel = path.join('institutes', `${slug}.db`);
      const file = path.join(settings.dataDir, rel);
      if (fs.existsSync(file)) continue;
      if (restoreOne(settings, rel, file, tmp)) restored += 1;
      else log(`No backup of institute "${slug}" yet.`);
    }
    if (restored) log(`Restored ${restored} database${restored === 1 ? '' : 's'} from the backup.`);
    return { restored };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const COUNTED = {
  platform: ['users', 'institutes', 'memberships'],
  institute: ['students', 'batches', 'sessions', 'alerts', 'messages', 'consents'],
};

function counts(file, tables) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    const rows = Object.fromEntries(
      tables.map((t) => {
        try {
          return [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n];
        } catch {
          return [t, null];
        }
      }),
    );
    return { integrity, rows };
  } finally {
    db.close();
  }
}

/**
 * Restore drill: restore everything from the backup into a temporary folder, check each database
 * is intact, and compare row counts with the live data. Run it monthly; a backup you've never
 * restored is only a hope.
 */
export function drill(settings, log = console.log) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-'));
  const out = path.join(tmp, 'restored');
  const problems = [];
  const report = [];
  try {
    const check = (rel, tables) => {
      const restored = path.join(out, rel);
      if (!restoreOne(settings, rel, restored, tmp)) {
        problems.push(`${rel}: no backup`);
        return null;
      }
      const got = counts(restored, tables);
      if (got.integrity !== 'ok') problems.push(`${rel}: integrity check says ${got.integrity}`);
      const liveFile = path.join(settings.dataDir, rel);
      const live = fs.existsSync(liveFile) ? counts(liveFile, tables) : null;
      for (const t of tables) {
        const a = got.rows[t];
        const b = live?.rows[t];
        // A few rows written in the last second may not be in the backup yet; more than that is a problem.
        const behind = live && a != null && b != null ? b - a : 0;
        if (behind > 5 || behind < 0) problems.push(`${rel}: ${t} has ${a} rows in the backup, ${b} live`);
      }
      report.push({ db: rel, integrity: got.integrity, backup: got.rows, live: live?.rows ?? null });
      return restored;
    };
    const platformDb = check('platform.db', COUNTED.platform);
    if (platformDb) for (const slug of instituteSlugs(platformDb)) check(path.join('institutes', `${slug}.db`), COUNTED.institute);
    for (const r of report) {
      log(`${r.db.padEnd(32)} ${r.integrity === 'ok' ? 'intact' : r.integrity}  ${Object.entries(r.backup).map(([t, n]) => `${t} ${n}${r.live && r.live[t] !== n ? ` (live ${r.live[t]})` : ''}`).join(', ')}`);
    }
    log(problems.length ? `\nRestore drill FAILED:\n- ${problems.join('\n- ')}` : `\nRestore drill passed: ${report.length} databases restored and intact.`);
    return { ok: problems.length === 0 && report.length > 0, problems, report };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------- command line
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  const settings = backupSettings();
  if (cmd === 'enabled') process.exit(settings ? 0 : 1);
  if (!settings) {
    console.error('Backups are not configured: set BACKUP_S3_BUCKET (or BACKUP_DIR).');
    process.exit(2);
  }
  if (cmd === 'config') {
    if (arg) fs.writeFileSync(arg, litestreamConfig(settings));
    else process.stdout.write(`${litestreamConfig(settings)}\n`);
  } else if (cmd === 'restore') {
    fs.mkdirSync(path.join(settings.dataDir, 'institutes'), { recursive: true });
    if (settings.replica.type === 'file') {
      // Fail at startup, not silently later: a backup folder we can't write is no backup.
      try {
        fs.mkdirSync(settings.replica.path, { recursive: true });
        fs.accessSync(settings.replica.path, fs.constants.W_OK);
      } catch {
        console.error(`Can't write to the backup folder ${settings.replica.path}.`);
        process.exit(1);
      }
    }
    restoreMissing(settings);
  } else if (cmd === 'copy') {
    const [, db, out, at] = process.argv.slice(2);
    if (!db || !out) {
      console.error('Usage: node server/backup.js copy institutes/<slug>.db /tmp/copy.db [2026-11-19T10:00:00+05:30]');
      process.exit(2);
    }
    let ok;
    try {
      ok = restoreCopy(settings, db, out, at);
    } catch (err) {
      console.error(err.message);
      process.exit(2);
    }
    if (!ok) {
      console.error(`No backup of ${db}${at ? ' at that time' : ''}.`);
      process.exit(1);
    }
    console.log(`Restored ${db}${at ? ` as of ${at}` : ''} to ${out}`);
  } else if (cmd === 'drill') {
    process.exit(drill(settings).ok ? 0 : 1);
  } else {
    console.error('Usage: node server/backup.js enabled | config [file] | restore | drill | copy <db> <out> [time]');
    process.exit(2);
  }
}
