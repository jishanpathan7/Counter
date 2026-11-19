import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, SCHEMA_VERSION } from '../server/db.js';

test('an institute database from the first version upgrades in order, with a copy saved first', (tt) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-migrate-'));
  tt.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.db');
  // The schema as the first release created it: P/A/L only, none of the later columns.
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE batches (id INTEGER PRIMARY KEY, name TEXT NOT NULL, start_time TEXT NOT NULL, days TEXT NOT NULL DEFAULT '1,2,3,4,5,6', active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE students (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, name TEXT NOT NULL, parent_name TEXT, parent_phone TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, date TEXT NOT NULL, starts_at TEXT NOT NULL, verified_at TEXT, UNIQUE (batch_id, date));
    CREATE TABLE attendance (session_id INTEGER NOT NULL, student_id INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('P', 'A', 'L')), note TEXT, source TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (session_id, student_id));
    CREATE TABLE alerts (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, student_id INTEGER NOT NULL, phone TEXT NOT NULL, status TEXT NOT NULL, sent_at TEXT NOT NULL, reply TEXT, replied_at TEXT, escalated_at TEXT, error TEXT, UNIQUE (session_id, student_id));
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, alert_id INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, done_at TEXT, outcome TEXT, UNIQUE (alert_id));
    CREATE TABLE messages (id INTEGER PRIMARY KEY, phone TEXT NOT NULL, direction TEXT NOT NULL, body TEXT NOT NULL, buttons TEXT, alert_id INTEGER, error TEXT, created_at TEXT NOT NULL);
    INSERT INTO batches (id, name, start_time) VALUES (1, 'Batch A', '16:00');
    INSERT INTO students (id, batch_id, name, parent_phone) VALUES (1, 1, 'Aarav', '919000000001'), (2, 1, 'Diya', '919000000002');
    INSERT INTO sessions (id, batch_id, date, starts_at, verified_at) VALUES (1, 1, '2026-01-05', '2026-01-05T10:30:00Z', '2026-01-05T10:33:00Z');
    INSERT INTO attendance VALUES (1, 1, 'L', 'Late 15 min (parent replied)', 'parent', '2026-01-05T10:40:00Z'), (1, 2, 'L', 'Leave', 'parent', '2026-01-05T10:41:00Z');
  `);
  old.close();

  const logs = [];
  const db = openDb(file, { logger: { log: (m) => logs.push(m), warn() {} } });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.ok(fs.existsSync(`${file}.before-v${SCHEMA_VERSION}`), 'a copy of the old file was saved');
  assert.match(logs[0], new RegExp(`from version 0 to ${SCHEMA_VERSION}`));
  // Data moved over: the old "late" leave became Late; others stay.
  assert.deepEqual(db.prepare('SELECT student_id, status FROM attendance ORDER BY student_id').all().map((r) => [r.student_id, r.status]), [[1, 'T'], [2, 'L']]);
  assert.equal(db.prepare('SELECT submitted_at FROM sessions').get().submitted_at, '2026-01-05T10:33:00Z', 'old classes count as sent');
  for (const [t, c] of [['students', 'guardian2_phone'], ['alerts', 'phone2'], ['messages', 'wamid'], ['tasks', 'urgent'], ['batches', 'duration_minutes'], ['students', 'removed_at']]) {
    assert.ok(db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c), `${t}.${c}`);
  }
  db.close();

  // Opening again changes nothing.
  fs.rmSync(`${file}.before-v${SCHEMA_VERSION}`);
  const again = openDb(file, { logger: { log: (m) => logs.push(m) } });
  assert.equal(logs.length, 1);
  assert.ok(!fs.existsSync(`${file}.before-v${SCHEMA_VERSION}`));
  again.close();
});

test('a new database starts at the latest version without saving a copy', (tt) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-migrate-'));
  tt.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = openDb(path.join(dir, 'new.db'), { logger: { log: () => assert.fail('no upgrade message for a new database') } });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('before')), []);
  db.close();
});
