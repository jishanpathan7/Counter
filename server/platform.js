import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.js';
import { AttendanceService, HttpError, normalizePhone } from './service.js';
import { messengerFromConfig } from './messaging.js';
import { addDays } from './time.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  pin_hash      TEXT NOT NULL,
  is_agency     INTEGER NOT NULL DEFAULT 0,   -- runs the platform; can open every institute
  token_version INTEGER NOT NULL DEFAULT 0,   -- bump to sign the user out everywhere
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS institutes (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  city        TEXT,
  fee_monthly INTEGER NOT NULL DEFAULT 0,      -- what the institute pays you (₹ / month)
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  institute_id INTEGER NOT NULL REFERENCES institutes(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'teacher')),
  batch_ids    TEXT NOT NULL DEFAULT '[]',     -- teachers: the batches they take
  PRIMARY KEY (user_id, institute_id)
);
`;

export const ROLES = ['owner', 'staff', 'teacher'];
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const PIN_RE = /^\d{4,8}$/;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 5 * 60_000;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

export function slugify(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function checkPin(pin, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

function requirePin(pin) {
  if (!PIN_RE.test(String(pin ?? ''))) throw new HttpError(400, 'PIN must be 4 to 8 digits');
  return String(pin);
}

function requirePhone(raw) {
  const phone = normalizePhone(raw);
  if (phone.length < 11 || phone.length > 15) throw new HttpError(400, 'Enter a valid mobile number');
  return phone;
}

function requireName(v, field = 'Name') {
  const s = String(v ?? '').trim();
  if (!s) throw new HttpError(400, `${field} is required`);
  if (s.length > 80) throw new HttpError(400, `${field} is too long`);
  return s;
}

export class Platform {
  /**
   * @param dataDir  folder for platform.db and one database per institute; null keeps everything in memory (tests)
   */
  constructor({ dataDir = null, tz = 'Asia/Kolkata', clock = () => Date.now(), env = {}, onChange = () => {}, logger = console }) {
    this.dataDir = dataDir;
    this.tz = tz;
    this.clock = clock;
    this.env = env;
    this.onChange = onChange;
    this.logger = logger;
    this.services = new Map();
    this.loginFails = new Map();
    if (dataDir) fs.mkdirSync(path.join(dataDir, 'institutes'), { recursive: true });
    this.db = new DatabaseSync(dataDir ? path.join(dataDir, 'platform.db') : ':memory:');
    if (dataDir) this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  nowIso() {
    return new Date(this.clock()).toISOString();
  }

  // ------------------------------------------------------------------ meta

  meta(key, fallback = null) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? fallback;
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  /** HMAC secret for login cookies: SESSION_SECRET, or a random one kept in the database. */
  secret() {
    if (this.env.SESSION_SECRET) return this.env.SESSION_SECRET;
    let s = this.meta('sessionSecret');
    if (!s) {
      s = crypto.randomBytes(32).toString('hex');
      this.setMeta('sessionSecret', s);
    }
    return s;
  }

  needsSetup() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  }

  // ----------------------------------------------------------------- users

  publicUser(u) {
    return u && { id: u.id, name: u.name, phone: u.phone, isAgency: Boolean(u.is_agency) };
  }

  getUser(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(id) ?? null;
  }

  createUser({ name, phone, pin, isAgency = false }) {
    const p = requirePhone(phone);
    if (this.db.prepare('SELECT 1 FROM users WHERE phone = ?').get(p)) throw new HttpError(409, 'Someone with this number already has an account');
    const r = this.db
      .prepare('INSERT INTO users (name, phone, pin_hash, is_agency, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(requireName(name), p, hashPin(requirePin(pin)), isAgency ? 1 : 0, this.nowIso());
    return this.getUser(Number(r.lastInsertRowid));
  }

  setPin(userId, pin) {
    this.db.prepare('UPDATE users SET pin_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hashPin(requirePin(pin)), userId);
  }

  authenticate(phoneRaw, pin) {
    const phone = normalizePhone(phoneRaw);
    const key = phone || 'unknown';
    const f = this.loginFails.get(key);
    const now = this.clock();
    if (f && f.until > now) {
      throw new HttpError(429, `Too many wrong PINs. Try again in ${Math.ceil((f.until - now) / 60000)} min.`);
    }
    const u = this.db.prepare('SELECT * FROM users WHERE phone = ? AND active = 1').get(phone);
    if (!u || !checkPin(pin, u.pin_hash)) {
      const fails = (f && f.until <= now && f.until ? 0 : f?.fails ?? 0) + 1;
      this.loginFails.set(key, { fails, until: fails >= LOGIN_MAX_FAILS ? now + LOGIN_LOCK_MS : 0 });
      throw new HttpError(401, 'Wrong mobile number or PIN');
    }
    this.loginFails.delete(key);
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(this.nowIso(), u.id);
    return u;
  }

  issueToken(user) {
    const body = Buffer.from(JSON.stringify({ uid: user.id, tv: user.token_version, exp: this.clock() + TOKEN_TTL_MS })).toString('base64url');
    const sig = crypto.createHmac('sha256', this.secret()).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  userFromToken(token) {
    if (!token || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', this.secret()).update(body).digest('base64url');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
      const { uid, tv, exp } = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (exp < this.clock()) return null;
      const u = this.getUser(uid);
      return u && u.token_version === tv ? u : null;
    } catch {
      return null;
    }
  }

  signOutEverywhere(userId) {
    this.db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(userId);
  }

  // ------------------------------------------------------------ institutes

  listInstitutes() {
    return this.db.prepare('SELECT * FROM institutes ORDER BY name').all().map((i) => this.publicInstitute(i));
  }

  publicInstitute(i) {
    return { id: i.id, slug: i.slug, name: i.name, city: i.city, feeMonthly: i.fee_monthly, status: i.status, createdAt: i.created_at };
  }

  institute(slug) {
    const i = this.db.prepare('SELECT * FROM institutes WHERE slug = ?').get(String(slug));
    if (!i) throw new HttpError(404, 'Institute not found');
    return i;
  }

  createInstitute({ name, slug, city = '', feeMonthly = 0, owner = null, ownerUserId = null }) {
    const n = requireName(name, 'Institute name');
    const sl = slug ? String(slug).toLowerCase() : slugify(n);
    if (!SLUG_RE.test(sl)) throw new HttpError(400, 'Web address must be 3–40 lowercase letters, numbers or dashes');
    if (this.db.prepare('SELECT 1 FROM institutes WHERE slug = ?').get(sl)) throw new HttpError(409, `The address "${sl}" is taken`);
    const fee = Number(feeMonthly) || 0;
    if (fee < 0 || fee > 10_000_000) throw new HttpError(400, 'Monthly fee looks wrong');

    // Validate the owner before creating anything.
    let ownerId = ownerUserId;
    if (!ownerId && owner) {
      const existing = this.db.prepare('SELECT * FROM users WHERE phone = ?').get(requirePhone(owner.phone));
      ownerId = existing ? existing.id : this.createUser(owner).id;
    }
    const r = this.db
      .prepare('INSERT INTO institutes (slug, name, city, fee_monthly, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sl, n, String(city ?? '').trim().slice(0, 60) || null, Math.round(fee), this.nowIso());
    if (ownerId) {
      this.db.prepare("INSERT INTO memberships (user_id, institute_id, role) VALUES (?, ?, 'owner')").run(ownerId, Number(r.lastInsertRowid));
    }
    const svc = this.service(sl);
    svc.updateSettings({ instituteName: n });
    this.onChange(null);
    return this.publicInstitute(this.institute(sl));
  }

  updateInstitute(slug, patch = {}) {
    const i = this.institute(slug);
    const name = patch.name !== undefined ? requireName(patch.name, 'Institute name') : i.name;
    const city = patch.city !== undefined ? String(patch.city).trim().slice(0, 60) || null : i.city;
    const fee = patch.feeMonthly !== undefined ? Math.round(Number(patch.feeMonthly) || 0) : i.fee_monthly;
    const status = patch.status !== undefined ? patch.status : i.status;
    if (!['active', 'paused'].includes(status)) throw new HttpError(400, 'Status must be active or paused');
    this.db.prepare('UPDATE institutes SET name = ?, city = ?, fee_monthly = ?, status = ? WHERE id = ?').run(name, city, fee, status, i.id);
    if (name !== i.name) this.service(slug).updateSettings({ instituteName: name });
    this.onChange(slug);
    return this.publicInstitute(this.institute(slug));
  }

  /** The attendance service (and database) for one institute, opened on first use. */
  service(slug) {
    if (this.services.has(slug)) return this.services.get(slug);
    this.institute(slug);
    const file = this.dataDir ? path.join(this.dataDir, 'institutes', `${slug}.db`) : ':memory:';
    const db = openDb(file);
    const svc = new AttendanceService({
      db,
      messenger: null,
      tz: this.tz,
      clock: this.clock,
      onChange: () => this.onChange(slug),
      logger: this.logger,
    });
    svc.messenger = messengerFromConfig(svc.getWhatsAppConfig());
    this.services.set(slug, svc);
    return svc;
  }

  refreshMessenger(slug) {
    const svc = this.service(slug);
    svc.messenger = messengerFromConfig(svc.getWhatsAppConfig());
    return svc.messenger.mode;
  }

  async tickAll() {
    for (const i of this.db.prepare("SELECT slug FROM institutes WHERE status = 'active'").all()) {
      try {
        await this.service(i.slug).tick();
      } catch (err) {
        this.logger.error?.(`Scheduler failed for ${i.slug}:`, err);
      }
    }
  }

  // ----------------------------------------------------------- memberships

  /** Institutes a user can open, with their role in each. Agency admins can open all of them as owner. */
  membershipsFor(user) {
    if (user.is_agency) {
      return this.db.prepare('SELECT * FROM institutes ORDER BY name').all().map((i) => ({ ...this.publicInstitute(i), role: 'owner', batchIds: [] }));
    }
    return this.db
      .prepare(
        `SELECT i.*, m.role, m.batch_ids FROM memberships m JOIN institutes i ON i.id = m.institute_id
          WHERE m.user_id = ? ORDER BY i.name`,
      )
      .all(user.id)
      .map((r) => ({ ...this.publicInstitute(r), role: r.role, batchIds: JSON.parse(r.batch_ids) }));
  }

  membership(user, slug) {
    return this.membershipsFor(user).find((m) => m.slug === slug) ?? null;
  }

  listTeam(slug) {
    const i = this.institute(slug);
    return this.db
      .prepare(
        `SELECT u.id, u.name, u.phone, u.last_login_at AS lastLoginAt, m.role, m.batch_ids
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.institute_id = ? AND u.active = 1
          ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'staff' THEN 1 ELSE 2 END, u.name`,
      )
      .all(i.id)
      .map(({ batch_ids, ...r }) => ({ ...r, batchIds: JSON.parse(batch_ids) }));
  }

  addMember(slug, { name, phone, pin, role, batchIds = [] }) {
    const i = this.institute(slug);
    if (!ROLES.includes(role)) throw new HttpError(400, 'Role must be owner, staff or teacher');
    const p = requirePhone(phone);
    let u = this.db.prepare('SELECT * FROM users WHERE phone = ?').get(p);
    if (!u) u = this.createUser({ name, phone: p, pin });
    if (this.db.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND institute_id = ?').get(u.id, i.id)) {
      throw new HttpError(409, `${u.name} is already in the team`);
    }
    this.db
      .prepare('INSERT INTO memberships (user_id, institute_id, role, batch_ids) VALUES (?, ?, ?, ?)')
      .run(u.id, i.id, role, JSON.stringify(this.cleanBatchIds(slug, batchIds)));
    this.onChange(slug);
    return this.listTeam(slug).find((m) => m.id === u.id);
  }

  updateMember(slug, userId, patch = {}) {
    const i = this.institute(slug);
    const m = this.db.prepare('SELECT * FROM memberships WHERE user_id = ? AND institute_id = ?').get(userId, i.id);
    if (!m) throw new HttpError(404, 'Team member not found');
    const role = patch.role ?? m.role;
    if (!ROLES.includes(role)) throw new HttpError(400, 'Role must be owner, staff or teacher');
    if (m.role === 'owner' && role !== 'owner') this.assertAnotherOwner(i.id, userId);
    const batchIds = patch.batchIds !== undefined ? this.cleanBatchIds(slug, patch.batchIds) : JSON.parse(m.batch_ids);
    this.db.prepare('UPDATE memberships SET role = ?, batch_ids = ? WHERE user_id = ? AND institute_id = ?').run(role, JSON.stringify(batchIds), userId, i.id);
    if (patch.name !== undefined) this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(requireName(patch.name), userId);
    if (patch.pin) this.setPin(userId, patch.pin);
    this.onChange(slug);
    return this.listTeam(slug).find((x) => x.id === userId);
  }

  removeMember(slug, userId) {
    const i = this.institute(slug);
    const m = this.db.prepare('SELECT * FROM memberships WHERE user_id = ? AND institute_id = ?').get(userId, i.id);
    if (!m) throw new HttpError(404, 'Team member not found');
    if (m.role === 'owner') this.assertAnotherOwner(i.id, userId);
    this.db.prepare('DELETE FROM memberships WHERE user_id = ? AND institute_id = ?').run(userId, i.id);
    this.signOutEverywhere(userId);
    this.onChange(slug);
  }

  assertAnotherOwner(instituteId, userId) {
    const n = this.db
      .prepare("SELECT COUNT(*) AS n FROM memberships WHERE institute_id = ? AND role = 'owner' AND user_id != ?")
      .get(instituteId, userId).n;
    if (!n) throw new HttpError(409, 'An institute needs at least one owner');
  }

  cleanBatchIds(slug, ids) {
    const valid = new Set(this.service(slug).listBatches().map((b) => b.id));
    return [...new Set((Array.isArray(ids) ? ids : []).map(Number))].filter((id) => valid.has(id));
  }

  // ---------------------------------------------------------------- agency

  /** Business overview across all institutes, for the agency console. */
  agencyOverview() {
    const institutes = this.db.prepare('SELECT * FROM institutes ORDER BY name').all().map((i) => {
      const svc = this.service(i.slug);
      const today = svc.today();
      const monthFrom = `${today.slice(0, 8)}01`;
      const counts = svc.db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM students WHERE active = 1) AS students,
                  (SELECT COUNT(*) FROM batches WHERE active = 1) AS batches,
                  (SELECT COUNT(*) FROM alerts al JOIN sessions se ON se.id = al.session_id WHERE se.date >= ?) AS alertsMonth,
                  (SELECT COUNT(*) FROM alerts al JOIN sessions se ON se.id = al.session_id WHERE se.date >= ? AND al.status = 'replied') AS repliedMonth`,
        )
        .get(monthFrom, monthFrom);
      const week = svc.getReport({ from: addDays(today, -6), to: today });
      const t = svc.getStats(today);
      const team = this.db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE institute_id = ?').get(i.id).n;
      return {
        ...this.publicInstitute(i),
        ...counts,
        team,
        whatsapp: svc.messenger?.mode ?? 'simulator',
        weekPct: week.totals.pct,
        weekTrend: week.series.map((d) => d.pct),
        today: { present: t.present, absent: t.absent, leaveLate: t.leaveLate, openTasks: t.openTasks },
      };
    });
    const active = institutes.filter((i) => i.status === 'active');
    return {
      institutes,
      totals: {
        institutes: institutes.length,
        active: active.length,
        mrr: active.reduce((s, i) => s + i.feeMonthly, 0),
        students: institutes.reduce((s, i) => s + i.students, 0),
        alertsMonth: institutes.reduce((s, i) => s + i.alertsMonth, 0),
      },
    };
  }
}
