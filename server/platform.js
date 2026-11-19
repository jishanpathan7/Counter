import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { createSecretBox } from './secrets.js';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.js';
import { AttendanceService, HttpError, mapLimit, normalizePhone } from './service.js';
import { messengerFromConfig } from './messaging.js';
import { addDays, localDate } from './time.js';
import { addMonths, addDaysTo, billingState, FAIR_USE_ALERTS_PER_STUDENT, financialYear, gstFor, invoiceHtml, periodPrice, PLANS } from './billing.js';

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

-- Failed logins, kept in the database so limits survive restarts and apply across instances.
CREATE TABLE IF NOT EXISTS login_failures (
  id    INTEGER PRIMARY KEY,
  phone TEXT NOT NULL,
  ip    TEXT NOT NULL,
  at    INTEGER NOT NULL                        -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_login_failures_phone ON login_failures(phone, at);
CREATE INDEX IF NOT EXISTS idx_login_failures_ip ON login_failures(ip, at);

-- One row per signed-in device; logging out revokes just that row.
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,
  must_change_pin INTEGER NOT NULL DEFAULT 0,  -- signed in with a PIN that no longer meets the rules
  revoked_at      TEXT
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  institute_id INTEGER NOT NULL REFERENCES institutes(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'teacher')),
  batch_ids    TEXT NOT NULL DEFAULT '[]',     -- teachers: the batches they take
  PRIMARY KEY (user_id, institute_id)
);
-- Payments received. Kept even if the institute is later deleted: invoices are tax records.
CREATE TABLE IF NOT EXISTS payments (
  id             INTEGER PRIMARY KEY,
  institute_id   INTEGER,
  institute_slug TEXT NOT NULL,
  buyer          TEXT NOT NULL,                 -- JSON: name, legal name, GSTIN, state, address at the time
  description    TEXT NOT NULL,
  base_amount    REAL NOT NULL,                 -- before GST
  tax_lines      TEXT NOT NULL,                 -- JSON
  total_amount   REAL NOT NULL,
  period_from    TEXT NOT NULL,
  period_to      TEXT NOT NULL,
  method         TEXT,
  reference      TEXT,
  paid_at        TEXT NOT NULL,                 -- 'YYYY-MM-DD'
  invoice_no     TEXT NOT NULL UNIQUE,
  recorded_by    TEXT,
  created_at     TEXT NOT NULL
);
-- Institutes deleted for good (the institute's own privacy log goes with its database).
CREATE TABLE IF NOT EXISTS privacy_log (
  id     INTEGER PRIMARY KEY,
  at     TEXT NOT NULL,
  actor  TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
`;

export const ROLES = ['owner', 'staff', 'teacher'];
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
// Login limits over a 15-minute window. A phone + device pair locks after 5 wrong PINs; a phone
// across all devices after 20 (slows guessing from many addresses without letting one person lock
// someone else out quickly); one address after 30 (stops spraying PINs across many phones).
const LOGIN_WINDOW_MS = 15 * 60_000;
const LIMITS = { pair: 5, phone: 20, ip: 30 };
const scryptAsync = promisify(crypto.scrypt);

export function slugify(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Checks a PIN without blocking the server (scrypt runs on the thread pool). */
async function checkPin(pin, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = await scryptAsync(String(pin), Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// Compared against for unknown numbers, so a wrong number takes as long as a wrong PIN.
const DUMMY_HASH = hashPin(crypto.randomBytes(8).toString('hex'));

/** Why a PIN is too weak to set, or null if it's fine. */
export function pinProblem(pin, phone = '') {
  const p = String(pin ?? '');
  if (!/^\d{6,8}$/.test(p)) return 'PIN must be 6 to 8 digits';
  if (/^(\d)\1+$/.test(p)) return "Choose a PIN that isn't one digit repeated";
  if ('01234567890'.includes(p) || '09876543210'.includes(p)) return "Choose a PIN that isn't a simple sequence";
  if (/^(\d\d)\1+$/.test(p) || /^(\d{3})\1$/.test(p) || /^(\d)\1(\d)\2(\d)\3$/.test(p)) return 'Choose a less predictable PIN';
  const digits = normalizePhone(phone);
  if (digits.length >= 10 && digits.slice(-10).includes(p)) return "Don't use part of your mobile number";
  return null;
}

function requirePin(pin, phone) {
  const why = pinProblem(pin, phone);
  if (why) throw new HttpError(400, why);
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
  constructor({ dataDir = null, tz = 'Asia/Kolkata', clock = () => Date.now(), env = {}, onChange = () => {}, logger = console, reporter = null }) {
    this.dataDir = dataDir;
    this.reporter = reporter;
    this.lastTickAt = null;
    this.tz = tz;
    this.clock = clock;
    this.env = env;
    this.onChange = onChange;
    this.logger = logger;
    this.services = new Map();
    if (dataDir) fs.mkdirSync(path.join(dataDir, 'institutes'), { recursive: true });
    this.db = new DatabaseSync(dataDir ? path.join(dataDir, 'platform.db') : ':memory:');
    // WAL + a busy timeout: the backup process (Litestream) briefly holds read locks.
    if (dataDir) this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  migrate() {
    const has = (t, c) => this.db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
    if (!has('institutes', 'plan')) {
      // Institutes from before plans existed keep working exactly as before: no limits, no due date.
      this.db.exec(`ALTER TABLE institutes ADD COLUMN plan TEXT NOT NULL DEFAULT 'custom';
        ALTER TABLE institutes ADD COLUMN billing_cycle TEXT NOT NULL DEFAULT 'monthly';
        ALTER TABLE institutes ADD COLUMN paid_until TEXT;
        ALTER TABLE institutes ADD COLUMN payment_link TEXT;
        ALTER TABLE institutes ADD COLUMN billing TEXT;`);
    }
  }

  today() {
    return localDate(this.tz, this.clock());
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

  /** Encrypts stored credentials. Key: DATA_ENCRYPTION_KEY, else derived from the session secret. */
  secretBox() {
    if (!this._secretBox) this._secretBox = createSecretBox(this.env.DATA_ENCRYPTION_KEY || this.secret());
    return this._secretBox;
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
      .run(requireName(name), p, hashPin(requirePin(pin, p)), isAgency ? 1 : 0, this.nowIso());
    return this.getUser(Number(r.lastInsertRowid));
  }

  /** Sets a new PIN and signs the user out on every device (the caller issues a fresh session). */
  setPin(userId, pin) {
    const u = this.getUser(userId);
    this.db.prepare('UPDATE users SET pin_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hashPin(requirePin(pin, u?.phone)), userId);
    this.signOutEverywhere(userId);
  }

  /**
   * Checks a phone + PIN. Limits are counted in the database per phone + address, per phone and
   * per address (see LIMITS). Returns the user, plus whether their PIN no longer meets the rules.
   */
  async authenticate(phoneRaw, pin, { ip = 'unknown' } = {}) {
    const phone = normalizePhone(phoneRaw) || 'unknown';
    const now = this.clock();
    const since = now - LOGIN_WINDOW_MS;
    const count = (where, ...args) => this.db.prepare(`SELECT COUNT(*) AS n, MIN(at) AS first FROM login_failures WHERE at > ? AND ${where}`).get(since, ...args);
    const checks = [
      [count('phone = ? AND ip = ?', phone, ip), LIMITS.pair],
      [count('phone = ?', phone), LIMITS.phone],
      [count('ip = ?', ip), LIMITS.ip],
    ];
    const hit = checks.find(([c, limit]) => c.n >= limit);
    if (hit) {
      const wait = Math.max(1, Math.ceil((hit[0].first + LOGIN_WINDOW_MS - now) / 60000));
      throw new HttpError(429, `Too many wrong PINs. Try again in ${wait} min.`);
    }

    const u = this.db.prepare('SELECT * FROM users WHERE phone = ? AND active = 1').get(phone);
    const ok = await checkPin(pin, u ? u.pin_hash : DUMMY_HASH);
    if (!u || !ok) {
      this.db.prepare('INSERT INTO login_failures (phone, ip, at) VALUES (?, ?, ?)').run(phone, ip, now);
      this.db.prepare('DELETE FROM login_failures WHERE at < ?').run(now - 4 * LOGIN_WINDOW_MS);
      throw new HttpError(401, 'Wrong mobile number or PIN');
    }
    this.db.prepare('DELETE FROM login_failures WHERE phone = ? AND ip = ?').run(phone, ip);
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(this.nowIso(), u.id);
    return { user: u, weakPin: Boolean(pinProblem(pin, phone)) };
  }

  /** A signed, revocable session token for this device. */
  issueToken(user, { mustChangePin = false } = {}) {
    const sid = crypto.randomBytes(18).toString('base64url');
    this.db
      .prepare('INSERT INTO sessions (id, user_id, created_at, must_change_pin) VALUES (?, ?, ?, ?)')
      .run(sid, user.id, this.nowIso(), mustChangePin ? 1 : 0);
    const body = Buffer.from(JSON.stringify({ uid: user.id, sid, exp: this.clock() + TOKEN_TTL_MS })).toString('base64url');
    const sig = crypto.createHmac('sha256', this.secret()).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  readToken(token) {
    if (!token || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', this.secret()).update(body).digest('base64url');
    if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
      return claims.exp >= this.clock() && claims.sid ? claims : null;
    } catch {
      return null;
    }
  }

  /** The signed-in user for a token, or null if it's invalid, expired, logged out or revoked. */
  userFromToken(token) {
    const claims = this.readToken(token);
    if (!claims) return null;
    const session = this.db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL').get(claims.sid, claims.uid);
    if (!session) return null;
    const u = this.getUser(claims.uid);
    return u ? { ...u, sessionId: session.id, mustChangePin: Boolean(session.must_change_pin) } : null;
  }

  /** Log out one device. */
  revokeToken(token) {
    const claims = this.readToken(token);
    if (claims) this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(this.nowIso(), claims.sid);
  }

  signOutEverywhere(userId) {
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(this.nowIso(), userId);
  }

  // ------------------------------------------------------------ institutes

  listInstitutes() {
    return this.db.prepare('SELECT * FROM institutes ORDER BY name').all().map((i) => this.publicInstitute(i));
  }

  publicInstitute(i) {
    return {
      id: i.id,
      slug: i.slug,
      name: i.name,
      city: i.city,
      feeMonthly: i.fee_monthly,
      status: i.status,
      createdAt: i.created_at,
      plan: i.plan,
      billingCycle: i.billing_cycle,
      paidUntil: i.paid_until,
      paymentLink: i.payment_link,
      billing: { ...billingState({ plan: i.plan, paidUntil: i.paid_until }, this.today()) },
    };
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
      .prepare("INSERT INTO institutes (slug, name, city, fee_monthly, created_at, plan, paid_until) VALUES (?, ?, ?, ?, ?, 'trial', ?)")
      .run(sl, n, String(city ?? '').trim().slice(0, 60) || null, Math.round(fee), this.nowIso(), addDaysTo(this.today(), PLANS.trial.days));
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

  // ---------------------------------------------------------------- billing

  /** The agency's own details for invoices (legal name, address, GSTIN, state, SAC code, invoice prefix). */
  billingProfile() {
    return { legalName: '', address: '', gstin: '', state: '', sac: '', invoicePrefix: 'INV', upiId: '', ...JSON.parse(this.meta('billingProfile') || '{}') };
  }

  setBillingProfile(patch = {}) {
    const cur = this.billingProfile();
    const next = { ...cur };
    for (const k of ['legalName', 'address', 'gstin', 'state', 'sac', 'invoicePrefix', 'upiId']) {
      if (patch[k] === undefined) continue;
      const v = String(patch[k] ?? '').trim().slice(0, k === 'address' ? 300 : 80);
      if (k === 'gstin' && v && !/^\d{2}[A-Z0-9]{13}$/i.test(v)) throw new HttpError(400, 'GSTIN should be 15 characters, starting with the 2-digit state code');
      next[k] = k === 'gstin' ? v.toUpperCase() : v;
    }
    next.invoicePrefix = (next.invoicePrefix || 'INV').replace(/[^A-Za-z0-9-]/g, '').slice(0, 10) || 'INV';
    this.setMeta('billingProfile', JSON.stringify(next));
    return next;
  }

  /** Plan, limits, usage this month and payment state for one institute. */
  billingFor(slug) {
    const i = this.institute(slug);
    const plan = PLANS[i.plan] ?? PLANS.custom;
    const svc = this.service(slug);
    const monthStart = `${this.today().slice(0, 8)}01`;
    const students = svc.db.prepare('SELECT COUNT(*) AS n FROM students WHERE active = 1').get().n;
    const alertsMonth = svc.db.prepare('SELECT COUNT(*) AS n FROM alerts al JOIN sessions se ON se.id = al.session_id WHERE se.date >= ?').get(monthStart).n;
    const messagesMonth = svc.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND created_at >= ?").get(`${monthStart}T00:00:00`).n;
    const logins = this.db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE institute_id = ?').get(i.id).n;
    const price = periodPrice(i.plan, i.billing_cycle, i.plan === 'custom' ? i.fee_monthly : null);
    return {
      plan: i.plan,
      planName: plan.name,
      cycle: i.billing_cycle,
      price,
      paidUntil: i.paid_until,
      paymentLink: this.paymentLinkFor(i, price),
      ...billingState({ plan: i.plan, paidUntil: i.paid_until }, this.today()),
      limits: { students: plan.students, logins: plan.logins, fullReports: plan.fullReports },
      usage: { students, logins, alertsMonth, messagesMonth, fairUseAlerts: students * FAIR_USE_ALERTS_PER_STUDENT },
      buyer: JSON.parse(i.billing || '{}'),
      plans: Object.entries(PLANS).filter(([k]) => k !== 'custom' && k !== 'trial').map(([k, v]) => ({ id: k, name: v.name, monthly: v.monthly, students: v.students })),
    };
  }

  /** The institute's own payment link, or a UPI link built from the agency's UPI ID and the amount due. */
  paymentLinkFor(i, price) {
    if (i.payment_link) return i.payment_link;
    const upi = this.billingProfile().upiId;
    if (!upi || !price) return null;
    const total = gstFor(price, { sellerGstin: this.billingProfile().gstin, sellerState: this.billingProfile().state, buyerState: JSON.parse(i.billing || '{}').state }).total;
    const name = encodeURIComponent(this.billingProfile().legalName || 'Attendance Alert');
    return `upi://pay?pa=${encodeURIComponent(upi)}&pn=${name}&am=${total.toFixed(2)}&cu=INR&tn=${encodeURIComponent(`${i.name} ${PLANS[i.plan]?.name ?? ''}`.trim())}`;
  }

  /** Agency: change an institute's plan, cycle, paid-until date, payment link or billing details. */
  setBilling(slug, patch = {}) {
    const i = this.institute(slug);
    const plan = patch.plan !== undefined ? String(patch.plan) : i.plan;
    if (!PLANS[plan]) throw new HttpError(400, 'Unknown plan');
    const cycle = patch.cycle !== undefined ? String(patch.cycle) : i.billing_cycle;
    if (!['monthly', 'yearly'].includes(cycle)) throw new HttpError(400, 'Billing must be monthly or yearly');
    let paidUntil = patch.paidUntil !== undefined ? patch.paidUntil || null : i.paid_until;
    if (paidUntil && !/^\d{4}-\d{2}-\d{2}$/.test(paidUntil)) throw new HttpError(400, 'Paid-until must be a date');
    const link = patch.paymentLink !== undefined ? String(patch.paymentLink || '').trim() || null : i.payment_link;
    if (link && !/^(https:\/\/|upi:\/\/)/i.test(link)) throw new HttpError(400, 'The payment link should start with https:// or upi://');
    const buyer = { ...JSON.parse(i.billing || '{}') };
    for (const k of ['legalName', 'gstin', 'state', 'address']) {
      if (patch[k] !== undefined) buyer[k] = String(patch[k] ?? '').trim().slice(0, k === 'address' ? 300 : 80);
    }
    if (buyer.gstin && !/^\d{2}[A-Z0-9]{13}$/i.test(buyer.gstin)) throw new HttpError(400, "The institute's GSTIN should be 15 characters");
    if (buyer.gstin) buyer.gstin = buyer.gstin.toUpperCase();
    // A custom plan keeps its agreed monthly fee; the others use the plan's price.
    const fee = plan === 'custom' ? (patch.feeMonthly !== undefined ? Math.max(0, Math.round(Number(patch.feeMonthly) || 0)) : i.fee_monthly) : PLANS[plan].monthly;
    if (plan === 'trial' && i.plan !== 'trial' && patch.paidUntil === undefined) paidUntil = addDaysTo(this.today(), PLANS.trial.days);
    this.db
      .prepare('UPDATE institutes SET plan = ?, billing_cycle = ?, paid_until = ?, payment_link = ?, billing = ?, fee_monthly = ? WHERE id = ?')
      .run(plan, cycle, paidUntil, link, JSON.stringify(buyer), fee, i.id);
    this.onChange(slug);
    return this.billingFor(slug);
  }

  /**
   * Agency: a payment came in. Extends the paid-until date by one period (from the old date if it
   * hasn't passed, otherwise from today) and issues the next invoice number for the financial year.
   */
  recordPayment(slug, { amount, method = '', reference = '', paidAt = null, recordedBy = null } = {}) {
    const i = this.institute(slug);
    if (i.plan === 'trial') throw new HttpError(409, 'Move the institute to a paid plan first');
    const date = paidAt && /^\d{4}-\d{2}-\d{2}$/.test(paidAt) ? paidAt : this.today();
    const base = amount !== undefined && amount !== '' ? Number(amount) : periodPrice(i.plan, i.billing_cycle, i.plan === 'custom' ? i.fee_monthly : null);
    if (!Number.isFinite(base) || base <= 0 || base > 10_000_000) throw new HttpError(400, 'Enter the amount before GST');
    const seller = this.billingProfile();
    const buyer = { name: i.name, ...JSON.parse(i.billing || '{}') };
    const gst = gstFor(Math.round(base * 100) / 100, { sellerGstin: seller.gstin, sellerState: seller.state, buyerState: buyer.state });
    const from = i.paid_until && i.paid_until >= date ? addDaysTo(i.paid_until, 1) : date;
    const to = addDaysTo(i.billing_cycle === 'yearly' ? addMonths(from, 12) : addMonths(from, 1), -1);
    const fy = financialYear(date);
    const seq = this.db.prepare('SELECT COUNT(*) AS n FROM payments WHERE invoice_no LIKE ?').get(`${seller.invoicePrefix}/${fy}/%`).n + 1;
    const invoiceNo = `${seller.invoicePrefix}/${fy}/${String(seq).padStart(4, '0')}`;
    const description = `Attendance Alert ${PLANS[i.plan].name} plan (${i.billing_cycle})`;
    const r = this.db
      .prepare(
        `INSERT INTO payments (institute_id, institute_slug, buyer, description, base_amount, tax_lines, total_amount, period_from, period_to, method, reference, paid_at, invoice_no, recorded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(i.id, slug, JSON.stringify(buyer), description, Math.round(base * 100) / 100, JSON.stringify(gst.lines), gst.total, from, to, String(method).slice(0, 40), String(reference).slice(0, 80), date, invoiceNo, recordedBy, this.nowIso());
    this.db.prepare('UPDATE institutes SET paid_until = ? WHERE id = ?').run(to, i.id);
    this.onChange(slug);
    return { id: Number(r.lastInsertRowid), invoiceNo, paidUntil: to, total: gst.total };
  }

  listPayments(slug) {
    return this.db
      .prepare('SELECT id, invoice_no AS invoiceNo, paid_at AS paidAt, total_amount AS total, period_from AS periodFrom, period_to AS periodTo, method FROM payments WHERE institute_slug = ? ORDER BY id DESC')
      .all(slug);
  }

  invoice(paymentId, { slug = null } = {}) {
    const p = this.db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!p || (slug && p.institute_slug !== slug)) throw new HttpError(404, 'Invoice not found');
    return invoiceHtml(
      {
        invoiceNo: p.invoice_no,
        paidAt: p.paid_at,
        description: p.description,
        periodFrom: p.period_from,
        periodTo: p.period_to,
        baseAmount: p.base_amount,
        taxLines: JSON.parse(p.tax_lines),
        totalAmount: p.total_amount,
        method: p.method,
        reference: p.reference,
        buyer: JSON.parse(p.buyer),
      },
      this.billingProfile(),
    );
  }

  /** Limits from the plan, checked before adding students or team members. */
  checkLimit(slug, kind, adding = 1) {
    const b = this.billingFor(slug);
    const cap = b.limits[kind];
    if (cap == null) return;
    const used = b.usage[kind];
    if (used + adding > cap) {
      const what = kind === 'students' ? 'students' : 'team logins';
      throw new HttpError(402, `The ${b.planName} plan includes up to ${cap} ${what} (you have ${used}). Ask your provider to move you to a bigger plan.`);
    }
  }

  /**
   * Delete an institute for good, when its contract ends: its database (students, attendance,
   * messages, consents), its memberships, and the accounts of team members who use no other
   * institute. Copies in the backup storage expire after the backup retention period.
   */
  deleteInstitute(slug, { confirm, actor = null } = {}) {
    const inst = this.institute(slug);
    if (inst.status !== 'paused') throw new HttpError(409, 'Pause the institute first, then delete it.');
    if (confirm !== slug) throw new HttpError(400, `Type the institute's short name (${slug}) to confirm`);
    const svc = this.services.get(slug);
    if (svc) {
      svc.db.close();
      this.services.delete(slug);
    }
    const members = this.db.prepare('SELECT user_id AS id FROM memberships WHERE institute_id = ?').all(inst.id).map((r) => r.id);
    let accounts = 0;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM memberships WHERE institute_id = ?').run(inst.id);
      this.db.prepare('DELETE FROM institutes WHERE id = ?').run(inst.id);
      for (const id of members) {
        const u = this.db.prepare('SELECT phone, is_agency FROM users WHERE id = ?').get(id);
        const elsewhere = this.db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?').get(id).n;
        if (!u || u.is_agency || elsewhere) continue;
        this.db.prepare('DELETE FROM login_failures WHERE phone = ?').run(u.phone);
        this.db.prepare('DELETE FROM users WHERE id = ?').run(id); // their sessions go with it
        accounts += 1;
      }
      this.db
        .prepare('INSERT INTO privacy_log (at, actor, action, detail) VALUES (?, ?, ?, ?)')
        .run(new Date(this.clock()).toISOString(), actor, 'delete_institute', `${inst.name} (${slug}): database and ${accounts} team account${accounts === 1 ? '' : 's'} deleted`);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    if (this.dataDir) {
      for (const ext of ['', '-wal', '-shm']) fs.rmSync(path.join(this.dataDir, 'institutes', `${slug}.db${ext}`), { force: true });
    }
    this.onChange(slug);
    return { deleted: slug, accounts };
  }

  listPlatformPrivacyLog(limit = 50) {
    return this.db.prepare('SELECT at, actor, action, detail FROM privacy_log ORDER BY id DESC LIMIT ?').all(limit);
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
      secrets: this.secretBox(),
    });
    const sealed = svc.sealStoredSecrets();
    if (sealed) this.logger.log?.(`Encrypted ${sealed} stored WhatsApp credential${sealed === 1 ? '' : 's'} for ${slug}`);
    const cfg = svc.getWhatsAppConfig();
    if (cfg.unreadable) {
      const err = new Error(`WhatsApp ${cfg.unreadable.join(' and ')} for ${slug} can't be decrypted: the encryption key changed. Enter them again in Settings → WhatsApp.`);
      this.logger.error?.(err.message);
      this.reporter?.capture(err, { tags: { where: 'secrets', institute: slug } });
    }
    svc.messenger = messengerFromConfig(cfg, { apiVersion: this.env.WHATSAPP_GRAPH_VERSION });
    this.services.set(slug, svc);
    return svc;
  }

  refreshMessenger(slug) {
    const svc = this.service(slug);
    svc.messenger = messengerFromConfig(svc.getWhatsAppConfig(), { apiVersion: this.env.WHATSAPP_GRAPH_VERSION });
    return svc.messenger.mode;
  }

  /** One slow institute (or a slow WhatsApp call) must not hold up the others: run a few at once. */
  async tickAll() {
    const slugs = this.db
      .prepare("SELECT slug, plan, paid_until FROM institutes WHERE status = 'active'")
      .all()
      .filter((i) => billingState({ plan: i.plan, paidUntil: i.paid_until }, this.today()).state !== 'lapsed')
      .map((i) => i.slug);
    await mapLimit(slugs, 4, async (slug) => {
      try {
        await this.service(slug).tick();
      } catch (err) {
        this.logger.error?.(`Scheduler failed for ${slug}:`, err);
        this.reporter?.capture(err, { tags: { where: 'scheduler', institute: slug } });
      }
    });
    this.lastTickAt = this.clock();
  }

  /** Is the database answering? (for the health check) */
  ping() {
    return this.db.prepare('SELECT 1 AS ok').get().ok === 1;
  }

  /** Close every database cleanly (on shutdown), so the last writes are in the main files. */
  close() {
    for (const svc of this.services.values()) {
      try {
        svc.db.close();
      } catch {
        /* already closed */
      }
    }
    this.services.clear();
    this.db.close();
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
        `SELECT u.id, u.name, u.phone, u.last_login_at AS lastLoginAt, m.role, m.batch_ids,
                (u.is_agency = 1 OR (SELECT COUNT(*) FROM memberships m2 WHERE m2.user_id = u.id) > 1) AS sharedAccount
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.institute_id = ? AND u.active = 1
          ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'staff' THEN 1 ELSE 2 END, u.name`,
      )
      .all(i.id)
      .map(({ batch_ids, ...r }) => ({ ...r, sharedAccount: Boolean(r.sharedAccount), batchIds: JSON.parse(batch_ids) }));
  }

  /**
   * An institute may only change the name or PIN of accounts that belong to it alone.
   * Anyone who also works at another institute, or runs the platform, manages their own.
   */
  ownsAccount(userId, instituteId) {
    const u = this.db.prepare('SELECT is_agency FROM users WHERE id = ?').get(userId);
    if (!u || u.is_agency) return false;
    const rows = this.db.prepare('SELECT institute_id FROM memberships WHERE user_id = ?').all(userId);
    return rows.length === 1 && rows[0].institute_id === instituteId;
  }

  addMember(slug, { name, phone, pin, role, batchIds = [] }) {
    const i = this.institute(slug);
    if (!ROLES.includes(role)) throw new HttpError(400, 'Role must be owner, staff or teacher');
    const p = requirePhone(phone);
    let u = this.db.prepare('SELECT * FROM users WHERE phone = ?').get(p);
    if (u?.is_agency) throw new HttpError(409, "This number can't be added to a team");
    // An existing account (someone who also works at another institute) joins as-is:
    // the name and PIN given here are ignored, so nobody can take over that account.
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
    const changesAccount = (patch.name !== undefined && patch.name !== this.getUser(userId)?.name) || Boolean(patch.pin);
    if (changesAccount && !this.ownsAccount(userId, i.id)) {
      throw new HttpError(403, 'This person also uses another institute, so only they can change their name or PIN (from My account).');
    }
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
    // Sign them out only if this was their last institute; never disrupt their other workplaces.
    const remaining = this.db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?').get(userId).n;
    if (!remaining && !this.getUser(userId)?.is_agency) this.signOutEverywhere(userId);
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
        loopWeek: { coveredPct: week.loop.coveredPct, absences: week.loop.absences, onTimeMarking: week.loop.onTimeMarking.pct },
        // "Active" = at least one class sent by a teacher in the last 7 days.
        activeThisWeek: svc.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE date >= ? AND submitted_at IS NOT NULL').get(addDays(today, -6)).n > 0,
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
        // Revenue counts paying institutes only; trials are listed separately.
        mrr: active.filter((i) => i.plan !== 'trial').reduce((s, i) => s + i.feeMonthly, 0),
        trials: active.filter((i) => i.plan === 'trial').length,
        overdue: active.filter((i) => ['due', 'readonly', 'lapsed'].includes(i.billing.state)).length,
        students: institutes.reduce((s, i) => s + i.students, 0),
        alertsMonth: institutes.reduce((s, i) => s + i.alertsMonth, 0),
        activeThisWeek: institutes.filter((i) => i.activeThisWeek).length,
      },
    };
  }
}
