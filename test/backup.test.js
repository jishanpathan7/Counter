import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupSettings, drill, litestreamConfig, restoreCopy, restoreMissing } from '../server/backup.js';
import { Platform } from '../server/platform.js';
import { seedDemo } from '../server/seed.js';

test('backup settings come from the environment; nothing configured means no backups', () => {
  assert.equal(backupSettings({}), null);
  const s = backupSettings({ DATA_DIR: '/data', BACKUP_S3_BUCKET: 'aa-backups', BACKUP_S3_ENDPOINT: 'https://x.r2.cloudflarestorage.com', BACKUP_S3_ACCESS_KEY_ID: 'id', BACKUP_S3_SECRET_ACCESS_KEY: 'secret' });
  assert.deepEqual(s.replica, {
    type: 's3',
    bucket: 'aa-backups',
    path: 'attendance-alert',
    region: 'ap-south-1',
    endpoint: 'https://x.r2.cloudflarestorage.com',
    'force-path-style': true,
    'access-key-id': 'id',
    'secret-access-key': 'secret',
  });
  const cfg = JSON.parse(litestreamConfig({ ...s, heartbeatUrl: 'https://hc.example/ping' }));
  assert.equal(cfg.dbs[0].dir, '/data');
  assert.equal(cfg.dbs[0].recursive, true, 'institute databases live in a subfolder');
  assert.equal(cfg.dbs[0].watch, true, 'new institutes are picked up without a restart');
  assert.equal(cfg.snapshot.retention, '720h');
  assert.equal(cfg['heartbeat-url'], 'https://hc.example/ping');
});

let hasLitestream = false;
try {
  execFileSync(process.env.LITESTREAM_BIN || 'litestream', ['version'], { stdio: 'ignore' });
  hasLitestream = true;
} catch {
  /* not installed here: the Docker image has it */
}

test('disaster recovery: the server dies, the disk is gone, everything comes back', { skip: !hasLitestream && 'litestream is not installed' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-backup-'));
  const env = { DATA_DIR: path.join(root, 'data'), BACKUP_DIR: path.join(root, 'replica') };
  const settings = backupSettings(env);
  fs.mkdirSync(path.join(settings.dataDir, 'institutes'), { recursive: true });

  const platform = new Platform({ dataDir: settings.dataDir, logger: { error() {} } });
  seedDemo(platform);
  const cfg = path.join(root, 'litestream.json');
  fs.writeFileSync(cfg, litestreamConfig(settings));
  const ls = spawn(process.env.LITESTREAM_BIN || 'litestream', ['replicate', '-config', cfg], { stdio: 'ignore' });
  let beforeChange;
  try {
    await new Promise((r) => setTimeout(r, 3000));
    beforeChange = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 1500));
    // A change made while running reaches the backup within seconds.
    const bf = platform.service('bright-future');
    bf.createStudent({ name: 'Last Minute', parentPhone: '9812300000', batchId: bf.listBatches()[0].id });
    await new Promise((r) => setTimeout(r, 2500));
    const logs = [];
    assert.equal(drill(settings, (l) => logs.push(l)).ok, true, logs.join('\n'));
  } finally {
    ls.kill('SIGKILL');
  }
  // The disk is lost.
  platform.close();
  fs.rmSync(settings.dataDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(settings.dataDir, 'institutes'), { recursive: true });

  assert.equal(restoreMissing(settings, () => {}).restored, 4);
  const db = new DatabaseSync(path.join(settings.dataDir, 'institutes', 'bright-future.db'), { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM students WHERE name = 'Last Minute'").get().n, 1);
  db.close();
  // Running it again changes nothing: existing databases are never overwritten.
  assert.equal(restoreMissing(settings, () => {}).restored, 0);

  // Going back in time: a copy from just before the change doesn't have that student.
  const copy = path.join(root, 'before.db');
  assert.equal(restoreCopy(settings, 'institutes/bright-future.db', copy, beforeChange), true);
  const old = new DatabaseSync(copy, { readOnly: true });
  assert.equal(old.prepare("SELECT COUNT(*) AS n FROM students WHERE name = 'Last Minute'").get().n, 0);
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM students').get().n, 21);
  old.close();
  assert.throws(() => restoreCopy(settings, 'institutes/bright-future.db', path.join(settings.dataDir, 'x.db')), /outside the data folder/);
  fs.rmSync(root, { recursive: true, force: true });
});
