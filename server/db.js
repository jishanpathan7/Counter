import { DatabaseSync } from 'node:sqlite';

// P present · A absent · L leave · T late (arrived late, or parent says they're on the way)
const attendanceTable = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('P', 'A', 'L', 'T')),
  note       TEXT,
  source     TEXT NOT NULL,                       -- teacher | system | parent | staff
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, student_id)
);`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  start_time TEXT NOT NULL,                       -- 'HH:MM' in the institute's time zone
  days       TEXT NOT NULL DEFAULT '1,2,3,4,5,6', -- weekdays, 0 = Sunday
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS students (
  id           INTEGER PRIMARY KEY,
  batch_id     INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  parent_name  TEXT,
  parent_phone TEXT NOT NULL,                     -- digits only, with country code
  active       INTEGER NOT NULL DEFAULT 1
);

-- One class session per batch per day.
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY,
  batch_id    INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  starts_at   TEXT NOT NULL,
  submitted_at TEXT,                             -- the teacher sent the list to the office
  verified_at TEXT,
  UNIQUE (batch_id, date)
);

${attendanceTable('attendance')}

-- One WhatsApp alert per absent student per session.
CREATE TABLE IF NOT EXISTS alerts (
  id           INTEGER PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id   INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  phone        TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('sent', 'replied', 'escalated', 'failed')),
  sent_at      TEXT NOT NULL,
  reply        TEXT,
  replied_at   TEXT,
  escalated_at TEXT,
  error        TEXT,
  UNIQUE (session_id, student_id)
);

-- Staff call task, created when a parent does not reply in time.
CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY,
  alert_id   INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('open', 'done')),
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  done_at    TEXT,
  outcome    TEXT,
  urgent     INTEGER NOT NULL DEFAULT 0,          -- parent says they don't know where the child is
  UNIQUE (alert_id)
);

-- Every WhatsApp message in or out, for the audit trail and the simulator.
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  phone      TEXT NOT NULL,
  direction  TEXT NOT NULL CHECK (direction IN ('out', 'in')),
  body       TEXT NOT NULL,
  buttons    TEXT,
  alert_id   INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
  error      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS holidays (
  date  TEXT PRIMARY KEY,                         -- 'YYYY-MM-DD'
  label TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_phone ON alerts(phone);
CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
`;

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Small additive migrations for databases created by older versions. */
function migrate(db) {
  const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!hasColumn('batches', 'duration_minutes')) {
    db.exec('ALTER TABLE batches ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 120');
  }
  if (!hasColumn('tasks', 'urgent')) {
    db.exec('ALTER TABLE tasks ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn('sessions', 'submitted_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN submitted_at TEXT');
    db.exec('UPDATE sessions SET submitted_at = verified_at WHERE verified_at IS NOT NULL');
  }
  // Older databases only allowed P/A/L: rebuild the table to add T (late) and move late records over.
  const att = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attendance'").get()?.sql ?? '';
  if (!att.includes("'T'")) {
    db.exec('BEGIN');
    try {
      db.exec(attendanceTable('attendance_v2'));
      db.exec(`INSERT INTO attendance_v2 SELECT session_id, student_id,
                 CASE WHEN status = 'L' AND note LIKE 'Late%' THEN 'T' ELSE status END, note, source, updated_at
               FROM attendance`);
      db.exec('DROP TABLE attendance');
      db.exec('ALTER TABLE attendance_v2 RENAME TO attendance');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
