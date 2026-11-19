import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { HttpError, renderTemplate } from './service.js';
import { parseWebhook, verifySignature } from './messaging.js';
import { DEMO_LOGINS, DEMO_PIN } from './seed.js';

const COOKIE = 'aa_session';

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  );
}

/** Pushes "something changed" to open screens of one institute so they refresh live. */
export function createEventHub() {
  const clients = new Map(); // slug -> Set<res>
  const timers = new Map();
  const send = (slug) => {
    for (const [s, set] of clients) {
      if (slug && s !== slug) continue;
      for (const res of set) res.write('data: change\n\n');
    }
  };
  return {
    add(slug, res) {
      if (!clients.has(slug)) clients.set(slug, new Set());
      clients.get(slug).add(res);
      res.on('close', () => clients.get(slug)?.delete(res));
    },
    broadcast(slug = null) {
      const key = slug ?? '*';
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => send(slug), 120));
    },
  };
}

/** CSV cell, protected against spreadsheet formula injection. */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function createApp({ platform, hub, demo = false, setupToken = null, realtime = true, ephemeral = false, tickOnRequest = null, trustProxy = 'loopback', staticDir = null, reporter = null, release = null, schedulerMaxAgeMs = 0, requestLog = null, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy (Caddy on the same machine, or Vercel), take the visitor's real address for login limits.
  app.set('trust proxy', trustProxy);
  if (requestLog) app.use(requestLog.middleware);
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => (req.rawBody = buf) }));
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
    next();
  });

  // Serverless hosts have no background timer: run the scheduler as requests come in.
  if (tickOnRequest) {
    app.use('/api', async (_req, _res, next) => {
      try {
        await tickOnRequest();
      } catch (err) {
        logger.error?.('Scheduler tick failed:', err);
      }
      next();
    });
  }

  // ------------------------------------------------------------------ WhatsApp webhooks (one per institute)
  const verifyWebhook = (req, res) => {
    const cfg = platform.service(req.params.slug).getWhatsAppConfig();
    const ok = req.query['hub.mode'] === 'subscribe' && cfg.verifyToken && req.query['hub.verify_token'] === cfg.verifyToken;
    if (!ok) return res.sendStatus(403);
    res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
  };
  const receiveWebhook = async (req, res) => {
    const svc = platform.service(req.params.slug);
    const cfg = svc.getWhatsAppConfig();
    // Signatures are mandatory: otherwise anyone who knows the URL could forge a parent's reply.
    if (!cfg.appSecret) return res.sendStatus(403);
    if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'), cfg.appSecret)) return res.sendStatus(401);
    // Process first, then acknowledge: on serverless hosts work after the response may never run.
    // Duplicate deliveries (Meta retries) are recognised by message id and ignored.
    const { replies, statuses } = parseWebhook(req.body);
    for (const st of statuses) {
      try {
        svc.handleStatus(st);
      } catch (err) {
        logger.error?.(`Webhook status failed: ${err.message}`);
      }
    }
    for (const reply of replies) {
      try {
        await svc.handleReply(reply);
      } catch (err) {
        logger.error?.(`Webhook reply failed: ${err.message}`);
        reporter?.capture(err, { tags: { where: 'webhook', institute: req.params.slug } });
      }
    }
    res.sendStatus(200);
  };
  app.get('/webhooks/whatsapp/:slug', verifyWebhook);
  app.post('/webhooks/whatsapp/:slug', receiveWebhook);

  // ------------------------------------------------------------------ auth
  const tokenOf = (req) => parseCookies(req.headers.cookie)[COOKIE];
  const userOf = (req) => platform.userFromToken(tokenOf(req));
  const setSession = (req, res, user, opts = {}) => {
    const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${platform.issueToken(user, opts)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`);
  };
  const meUser = (u) => (u ? { ...platform.publicUser(u), mustChangePin: Boolean(u.mustChangePin) } : null);

  // For uptime monitors and Docker: 503 if the database doesn't answer or the scheduler has stalled
  // (a stalled scheduler means no alerts go out, which looks fine from outside but isn't).
  const startedAt = Date.now();
  app.get('/api/health', (_req, res) => {
    const problems = [];
    try {
      if (!platform.ping()) problems.push('database');
    } catch {
      problems.push('database');
    }
    if (schedulerMaxAgeMs) {
      const last = platform.lastTickAt ?? startedAt;
      if (Date.now() - last > schedulerMaxAgeMs) problems.push('scheduler');
    }
    res.set('Cache-Control', 'no-store');
    res.status(problems.length ? 503 : 200).json({
      ok: !problems.length,
      ...(problems.length ? { problems } : {}),
      ...(release ? { release } : {}),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  app.get('/api/auth/me', (req, res) => {
    const u = userOf(req);
    res.json({
      needsSetup: platform.needsSetup(),
      setupCodeRequired: Boolean(setupToken) && platform.needsSetup(),
      user: meUser(u),
      memberships: u ? platform.membershipsFor(u) : [],
      demo: demo ? { pin: DEMO_PIN, logins: DEMO_LOGINS, ephemeral } : null,
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { user, weakPin } = await platform.authenticate(req.body?.phone, String(req.body?.pin ?? ''), { ip: req.ip });
    // Older 4-digit or guessable PINs still work once, but must be replaced before anything else.
    const mustChangePin = weakPin;
    setSession(req, res, user, { mustChangePin });
    res.json({ user: { ...platform.publicUser(user), mustChangePin }, memberships: platform.membershipsFor(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    platform.revokeToken(tokenOf(req)); // the stolen-cookie case: logging out really ends the session
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  // First run: create the agency admin and the first institute.
  app.post('/api/setup', (req, res) => {
    if (!platform.needsSetup()) throw new HttpError(409, 'Already set up');
    const { name, phone, pin, instituteName, slug, city, setupCode } = req.body ?? {};
    if (setupToken && String(setupCode ?? '').trim() !== setupToken) {
      throw new HttpError(403, 'Wrong setup code. It is printed in the server log when the server starts.');
    }
    const user = platform.createUser({ name, phone, pin, isAgency: true });
    const inst = platform.createInstitute({ name: instituteName, slug, city, ownerUserId: user.id });
    setSession(req, res, user);
    res.status(201).json({ user: platform.publicUser(user), institute: inst });
  });

  app.use('/api', (req, _res, next) => {
    req.user = userOf(req);
    if (!req.user) throw new HttpError(401, 'Please log in');
    if (req.user.mustChangePin && req.path !== '/auth/pin') throw new HttpError(403, 'Please set a new PIN first');
    next();
  });

  app.post('/api/auth/pin', async (req, res) => {
    await platform.authenticate(req.user.phone, String(req.body?.current ?? ''), { ip: req.ip });
    platform.setPin(req.user.id, req.body?.next); // signs out every device
    setSession(req, res, platform.getUser(req.user.id));
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ agency console
  const agency = express.Router();
  agency.use((req, _res, next) => {
    if (!req.user.is_agency) throw new HttpError(403, 'Agency admins only');
    next();
  });
  agency.get('/overview', (_req, res) => res.json(platform.agencyOverview()));
  agency.post('/institutes', (req, res) => {
    const { name, slug, city, feeMonthly, ownerName, ownerPhone, ownerPin } = req.body ?? {};
    const owner = ownerPhone ? { name: ownerName, phone: ownerPhone, pin: ownerPin } : null;
    res.status(201).json(platform.createInstitute({ name, slug, city, feeMonthly, owner, ownerUserId: owner ? null : req.user.id }));
  });
  agency.patch('/institutes/:slug', (req, res) => res.json(platform.updateInstitute(req.params.slug, req.body ?? {})));
  agency.post('/institutes/:slug/delete', (req, res) => res.json(platform.deleteInstitute(req.params.slug, { confirm: req.body?.confirm, actor: req.user.name })));
  agency.get('/privacy-log', (_req, res) => res.json(platform.listPlatformPrivacyLog()));
  agency.get('/auth-log', (_req, res) => res.json(platform.listAuthLog(200)));
  agency.get('/request-log', (req, res) => {
    if (!requestLog) return res.json([]);
    res.json(requestLog.list({ limit: req.query.limit, userId: req.query.userId ? Number(req.query.userId) : null, from: req.query.from || null }));
  });
  agency.get('/billing-profile', (_req, res) => res.json(platform.billingProfile()));
  agency.put('/billing-profile', (req, res) => res.json(platform.setBillingProfile(req.body ?? {})));
  agency.get('/institutes/:slug/billing', (req, res) => res.json({ ...platform.billingFor(req.params.slug), payments: platform.listPayments(req.params.slug) }));
  agency.patch('/institutes/:slug/billing', (req, res) => res.json(platform.setBilling(req.params.slug, req.body ?? {})));
  agency.post('/institutes/:slug/payments', (req, res) => res.status(201).json(platform.recordPayment(req.params.slug, { ...(req.body ?? {}), recordedBy: req.user.name })));
  agency.get('/payments/:id/invoice', (req, res) => res.type('html').send(platform.invoice(Number(req.params.id))));
  app.use('/api/agency', agency);

  // ------------------------------------------------------------------ one institute
  const inst = express.Router({ mergeParams: true });
  app.use('/api/i/:slug', (req, _res, next) => {
    const m = platform.membership(req.user, req.params.slug);
    if (!m) throw new HttpError(404, 'Institute not found');
    if (m.status === 'paused' && !req.user.is_agency) throw new HttpError(403, 'This institute is paused. Contact your service provider.');
    // Late payment: the agency always gets in. After 14 days the institute is paused; between 8 and
    // 14 days setup changes wait, but attendance, alerts, replies and calls keep working.
    const bill = m.billing?.state;
    if (!req.user.is_agency && bill === 'lapsed') {
      throw new HttpError(402, 'This institute is paused because the subscription has not been paid. Contact your service provider.');
    }
    if (!req.user.is_agency && bill === 'readonly' && req.method !== 'GET' && !/^\/(sessions|tasks|simulator)\//.test(req.path)) {
      throw new HttpError(402, 'Payment is overdue, so changes to setup are paused until it is paid. Attendance and WhatsApp alerts keep working.');
    }
    req.member = m;
    req.svc = platform.service(req.params.slug);
    next();
  }, inst);

  const allow = (...roles) => (req, _res, next) => {
    if (!roles.includes(req.member.role)) throw new HttpError(403, "You don't have access to this");
    next();
  };
  const MGMT = allow('owner', 'staff');
  const OWNER = allow('owner');

  // Teachers only see the batches assigned to them (all batches if none are assigned).
  const canTeach = (req, batchId) =>
    req.member.role !== 'teacher' || !req.member.batchIds.length || req.member.batchIds.includes(Number(batchId));
  const sessionFor = (req) => {
    const s = req.svc.getSessionRow(Number(req.params.id));
    if (!canTeach(req, s.batch_id)) throw new HttpError(403, 'Not your batch');
    return s;
  };
  const sessionView = (req, id) => {
    const v = req.svc.getSessionView(id);
    if (req.member.role === 'teacher') v.students = v.students.map(({ parentPhone, ...s }) => s);
    return v;
  };

  inst.get('/info', (req, res) => {
    const { slug, name, city, status, role, batchIds } = req.member;
    res.json({
      institute: { slug, name, city, status },
      role,
      batchIds,
      user: platform.publicUser(req.user),
      mode: req.svc.messenger.mode,
      realtime,
      tz: req.svc.tz,
      today: req.svc.today(),
      // Parents opt in by messaging START to this number (wa.me link / QR on the admission form).
      optInPhone: String(req.svc.getWhatsAppConfig().displayPhone || '').replace(/\D/g, '') || null,
      requireConsent: req.svc.getSettings().requireConsent,
      billing: role === 'teacher' ? null : (() => {
        const b = platform.billingFor(slug);
        return { state: b.state, daysLeft: b.daysLeft, daysLate: b.daysLate, planName: b.planName, paymentLink: role === 'owner' ? b.paymentLink : null, paidUntil: b.paidUntil };
      })(),
    });
  });

  inst.get('/events', (req, res) => {
    if (!realtime) return res.sendStatus(204); // screens poll instead
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    hub.add(req.params.slug, res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    res.on('close', () => clearInterval(ping));
  });

  // dashboard
  inst.get('/board', MGMT, (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? '') ? req.query.date : undefined;
    res.json(req.svc.getBoard(date));
  });
  inst.get('/activity', MGMT, (req, res) => res.json(req.svc.getActivity(20)));

  // batches
  inst.get('/batches', (req, res) => res.json(req.svc.listBatches().filter((b) => canTeach(req, b.id))));
  inst.post('/batches', OWNER, (req, res) => res.status(201).json(req.svc.createBatch(req.body ?? {})));
  inst.patch('/batches/:id', OWNER, (req, res) => res.json(req.svc.updateBatch(Number(req.params.id), req.body ?? {})));
  inst.delete('/batches/:id', OWNER, (req, res) => {
    req.svc.deleteBatch(Number(req.params.id));
    res.sendStatus(204);
  });
  inst.post('/batches/:id/today', (req, res) => {
    if (!canTeach(req, req.params.id)) throw new HttpError(403, 'Not your batch');
    if (req.svc.holidayOn(req.svc.today())) throw new HttpError(409, `Today is a holiday: ${req.svc.holidayOn(req.svc.today())}`);
    const s = req.svc.ensureSession(Number(req.params.id));
    res.json(sessionView(req, s.id));
  });

  // sessions
  inst.get('/sessions/:id', (req, res) => res.json(sessionView(req, sessionFor(req).id)));
  inst.get('/sessions/:id/timeline', MGMT, (req, res) => res.json(req.svc.getTimeline(Number(req.params.id))));
  inst.post('/sessions/:id/mark', async (req, res) => {
    const s = sessionFor(req);
    await req.svc.mark(s.id, Number(req.body?.studentId), req.body?.status);
    res.json(sessionView(req, s.id));
  });
  inst.post('/sessions/:id/mark-all', async (req, res) => {
    const s = sessionFor(req);
    await req.svc.markAll(s.id, req.body?.status ?? 'P');
    res.json(sessionView(req, s.id));
  });
  // Teacher (or front desk on their behalf) sends the list to the office.
  inst.post('/sessions/:id/submit', async (req, res) => {
    const s = sessionFor(req);
    await req.svc.submit(s.id, { actor: req.user.name });
    res.json(sessionView(req, s.id));
  });
  inst.post('/sessions/:id/start-now', MGMT, (req, res) => {
    req.svc.startNow(Number(req.params.id));
    res.json(sessionView(req, Number(req.params.id)));
  });

  // students
  inst.get('/students', MGMT, (req, res) => res.json(req.svc.getStudentDirectory({ batchId: req.query.batchId ? Number(req.query.batchId) : null })));
  inst.get('/students/:id', MGMT, (req, res) => {
    const profile = req.svc.getStudentProfile(Number(req.params.id));
    req.svc.event('student_viewed', { actor: req.user.name, studentId: profile.id }); // access log
    res.json(profile);
  });
  inst.post('/students', MGMT, (req, res) => {
    platform.checkLimit(req.params.slug, 'students');
    const st = req.svc.createStudent(req.body ?? {});
    req.svc.event('student_added', { actor: req.user.name, studentId: st.id });
    res.status(201).json(st);
  });
  inst.post('/students/import', OWNER, (req, res) => {
    if (!req.body?.dryRun) {
      const preview = req.svc.importStudents({ ...(req.body ?? {}), dryRun: true });
      platform.checkLimit(req.params.slug, 'students', preview.rows.filter((r) => !r.error).length);
    }
    res.json(req.svc.importStudents(req.body ?? {}));
  });
  inst.post('/students/:id/consent', MGMT, (req, res) => {
    const by = req.user.name;
    const r = req.body?.action === 'clear' ? req.svc.clearConsent(Number(req.params.id), { recordedBy: by }) : req.svc.recordConsent(Number(req.params.id), { recordedBy: by });
    res.json({ consent: r });
  });
  inst.post('/consents/record-all', OWNER, (req, res) => res.json(req.svc.recordAllConsents({ batchId: req.body?.batchId ? Number(req.body.batchId) : null, recordedBy: req.user.name })));
  inst.patch('/students/:id', MGMT, (req, res) => {
    const st = req.svc.updateStudent(Number(req.params.id), req.body ?? {});
    req.svc.event('student_edited', { actor: req.user.name, studentId: Number(req.params.id) });
    res.json(st);
  });
  inst.delete('/students/:id', OWNER, (req, res) => {
    req.svc.deleteStudent(Number(req.params.id));
    req.svc.event('student_removed', { actor: req.user.name, studentId: Number(req.params.id) });
    res.sendStatus(204);
  });

  // privacy: export and erase (DPDP)
  const download = (res, name, data) => {
    res.set({ 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    res.type('application/json').send(JSON.stringify(data, null, 2));
  };
  const fileSafe = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'data';
  inst.get('/students/:id/export', MGMT, (req, res) => {
    const data = req.svc.exportFamily(Number(req.params.id), { actor: req.user.name });
    download(res, `${fileSafe(data.students[0]?.name)}-family-data-${req.svc.today()}.json`, data);
  });
  inst.get('/export', OWNER, (req, res) => {
    const data = req.svc.exportAll({ actor: req.user.name });
    data.team = platform.listTeam(req.params.slug).map(({ name, phone, role }) => ({ name, phone, role }));
    download(res, `${req.params.slug}-all-data-${req.svc.today()}.json`, data);
  });
  inst.post('/students/:id/erase', OWNER, (req, res) => {
    const st = req.svc.db.prepare('SELECT name FROM students WHERE id = ?').get(Number(req.params.id));
    if (!st) throw new HttpError(404, 'Student not found');
    if (String(req.body?.confirm ?? '').trim().toLowerCase() !== st.name.trim().toLowerCase()) {
      throw new HttpError(400, "Type the student's name exactly to confirm");
    }
    res.json(req.svc.eraseStudent(Number(req.params.id), { actor: req.user.name }));
  });
  inst.get('/privacy', OWNER, (req, res) =>
    res.json({ removed: req.svc.listRemovedStudents(), log: req.svc.listPrivacyLog(), access: req.svc.accessLog(100), settings: req.svc.getSettings() }),
  );
  inst.post('/privacy/clean-up', OWNER, (req, res) => res.json(req.svc.applyRetention({ actor: req.user.name })));
  inst.post('/privacy/erase-removed', OWNER, (req, res) => {
    if (req.body?.confirm !== 'ERASE') throw new HttpError(400, 'Type ERASE to confirm');
    res.json(req.svc.eraseRemovedStudents({ actor: req.user.name }));
  });

  // holidays
  inst.get('/holidays', (req, res) => res.json(req.svc.listHolidays()));
  inst.post('/holidays', OWNER, (req, res) => res.json(req.svc.addHoliday(req.body ?? {})));
  inst.delete('/holidays/:date', OWNER, (req, res) => res.json(req.svc.deleteHoliday(req.params.date)));

  // call tasks
  inst.get('/tasks', MGMT, (req, res) => res.json(req.svc.listTasks(req.query.status === 'done' ? 'done' : 'open')));
  inst.post('/tasks/:id/complete', MGMT, (req, res) => {
    req.svc.completeTask(Number(req.params.id), { ...(req.body ?? {}), actor: req.user.name });
    res.json({ ok: true });
  });

  // messages
  inst.get('/messages/threads', MGMT, (req, res) => res.json(req.svc.listThreads()));
  inst.get('/messages', MGMT, (req, res) => res.json(req.svc.listMessages(String(req.query.phone ?? ''))));
  inst.post('/simulator/reply', MGMT, async (req, res) => {
    if (req.svc.messenger.mode !== 'simulator') throw new HttpError(409, 'The simulator is off because real WhatsApp is connected');
    const { phone, payload, text } = req.body ?? {};
    if (!phone || (!payload && !String(text ?? '').trim())) throw new HttpError(400, 'phone and a reply are required');
    res.json(await req.svc.handleReply({ phone, payload, text }));
  });

  // reports
  inst.get('/reports/loop-trend', MGMT, (req, res) => res.json(req.svc.getLoopTrend(8)));
  const fullReports = (req) => {
    if (platform.billingFor(req.params.slug).limits.fullReports) return;
    const from = req.query.from && Date.parse(req.query.from);
    const to = req.query.to ? Date.parse(req.query.to) : Date.now();
    if (req.path.endsWith('.csv') || (from && to - from > 31 * 86_400_000)) {
      throw new HttpError(402, 'Reports longer than a month and CSV downloads are part of the Standard plan.');
    }
  };
  inst.get('/reports', MGMT, (req, res, next) => (fullReports(req), next()));
  inst.get('/reports.csv', MGMT, (req, res, next) => (fullReports(req), next()));
  inst.get('/reports', MGMT, (req, res) => res.json(req.svc.getReport({ from: req.query.from, to: req.query.to, batchId: req.query.batchId || null })));
  inst.get('/reports.csv', MGMT, (req, res) => {
    const r = req.svc.getReport({ from: req.query.from, to: req.query.to, batchId: req.query.batchId || null });
    const head = ['Student', 'Batch', 'Parent', 'Parent WhatsApp', 'Present', 'Late', 'Leave', 'Absent', 'Bunks', 'Classes', 'Attendance %', 'At risk'];
    const lines = [head, ...r.students.map((s) => [s.name, s.batchName, s.parentName, `+${s.parentPhone}`, s.P, s.T, s.L, s.A, s.bunks, s.total, s.pct ?? '', s.riskReasons.join('; ')])];
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="attendance-${req.params.slug}-${r.from}-to-${r.to}.csv"`);
    res.send(`﻿${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}`);
  });

  // settings
  inst.get('/settings', MGMT, (req, res) => res.json(req.svc.getSettings()));
  inst.patch('/settings', OWNER, (req, res) => {
    const s = req.svc.updateSettings(req.body ?? {});
    if (req.body?.instituteName) platform.updateInstitute(req.params.slug, { name: req.body.instituteName });
    res.json(s);
  });
  inst.post('/settings/preview', MGMT, (req, res) => {
    const s = req.svc.getSettings();
    res.json({
      text: renderTemplate(req.body?.template ?? s.alertTemplate, {
        parent: 'Mr. Verma', student: 'Rohan', batch: 'Class 10 · Batch B', time: '4:00 PM', institute: s.instituteName,
      }),
    });
  });
  inst.get('/whatsapp', OWNER, (req, res) => res.json({ ...req.svc.getWhatsAppPublic(), mode: req.svc.messenger.mode }));
  inst.patch('/whatsapp', OWNER, (req, res) => {
    const cfg = req.svc.updateWhatsAppConfig(req.body ?? {});
    res.json({ ...cfg, mode: platform.refreshMessenger(req.params.slug) });
  });
  inst.get('/digest/preview', OWNER, (req, res) => res.json({ text: req.svc.buildDigest() }));
  inst.post('/digest/send', OWNER, async (req, res) => {
    await req.svc.maybeSendDigest({ force: true });
    res.json({ ok: true });
  });

  // team
  inst.get('/team', OWNER, (req, res) => res.json(platform.listTeam(req.params.slug)));
  inst.post('/team', OWNER, (req, res) => {
    platform.checkLimit(req.params.slug, 'logins');
    res.status(201).json(platform.addMember(req.params.slug, req.body ?? {}));
  });

  // first-week checklist (owner)
  const teamCount = (slug) => platform.listTeam(slug).filter((m) => m.role !== 'owner').length;
  inst.get('/setup', OWNER, (req, res) => res.json(req.svc.setupChecklist({ teamCount: teamCount(req.params.slug) })));
  inst.post('/setup/dismiss', OWNER, (req, res) => {
    req.svc.dismissSetup();
    res.json({ ok: true });
  });
  inst.post('/setup/test-alert', OWNER, async (req, res) => res.json(await req.svc.sendTestAlert({ phone: req.user.phone, name: req.user.name })));

  // plan & billing (owner)
  inst.get('/billing', OWNER, (req, res) => res.json({ ...platform.billingFor(req.params.slug), payments: platform.listPayments(req.params.slug) }));
  inst.get('/billing/invoices/:id', OWNER, (req, res) => res.type('html').send(platform.invoice(Number(req.params.id), { slug: req.params.slug })));
  inst.patch('/team/:userId', OWNER, (req, res) => res.json(platform.updateMember(req.params.slug, Number(req.params.userId), req.body ?? {})));
  inst.delete('/team/:userId', OWNER, (req, res) => {
    if (Number(req.params.userId) === req.user.id) throw new HttpError(409, "You can't remove yourself");
    platform.removeMember(req.params.slug, Number(req.params.userId));
    res.sendStatus(204);
  });

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  // ------------------------------------------------------------------ built frontend
  if (staticDir && fs.existsSync(path.join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h', setHeaders: (res, p) => p.endsWith('sw.js') && res.set('Cache-Control', 'no-cache') }));
    app.get(/^\/(?!api\/|webhooks\/).*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) {
      logger.error?.(err);
      reporter?.capture(err, { tags: { where: 'http', institute: _req.params?.slug }, request: { method: _req.method, path: _req.path } });
    }
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });

  return app;
}
