import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { HttpError } from './service.js';
import { parseWebhook, verifySignature } from './messaging.js';

const COOKIE = 'att_auth';

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  );
}

/** Pushes a "something changed" event to every open dashboard so screens refresh live. */
export function createEventHub() {
  const clients = new Set();
  let timer = null;
  return {
    add(res) {
      clients.add(res);
      res.on('close', () => clients.delete(res));
    },
    broadcast() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const res of clients) res.write('data: change\n\n');
      }, 100);
    },
    get size() {
      return clients.size;
    },
  };
}

export function createApp({ service, hub, mode, accessCode = '', whatsapp = {}, staticDir = null, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb', verify: (req, _res, buf) => (req.rawBody = buf) }));

  // ------------------------------------------------------------ WhatsApp webhook
  app.get('/webhooks/whatsapp', (req, res) => {
    const ok = req.query['hub.mode'] === 'subscribe' && whatsapp.verifyToken && req.query['hub.verify_token'] === whatsapp.verifyToken;
    if (!ok) return res.sendStatus(403);
    res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
  });

  app.post('/webhooks/whatsapp', async (req, res) => {
    if (whatsapp.appSecret && !verifySignature(req.rawBody, req.get('x-hub-signature-256'), whatsapp.appSecret)) {
      return res.sendStatus(401);
    }
    res.sendStatus(200); // acknowledge fast; Meta retries slow webhooks
    for (const reply of parseWebhook(req.body)) {
      try {
        await service.handleReply(reply);
      } catch (err) {
        logger.error?.(`Webhook reply failed: ${err.message}`);
      }
    }
  });

  // ------------------------------------------------------------ access code
  const authToken = accessCode ? crypto.createHash('sha256').update(`attendance:${accessCode}`).digest('hex') : null;
  const isAuthed = (req) => !authToken || parseCookies(req.headers.cookie)[COOKIE] === authToken;

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/info', (req, res) => {
    res.json({ mode, tz: service.tz, authRequired: Boolean(authToken), authed: isAuthed(req), instituteName: service.getSettings().instituteName });
  });

  app.post('/api/login', (req, res) => {
    if (!authToken) return res.json({ ok: true });
    const given = String(req.body?.code ?? '');
    const a = Buffer.from(crypto.createHash('sha256').update(`attendance:${given}`).digest('hex'));
    if (!crypto.timingSafeEqual(a, Buffer.from(authToken))) throw new HttpError(401, 'Wrong access code');
    const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${authToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`);
    res.json({ ok: true });
  });

  app.use('/api', (req, _res, next) => {
    if (!isAuthed(req)) throw new HttpError(401, 'Access code required');
    next();
  });

  // ------------------------------------------------------------ live updates
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    hub.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    res.on('close', () => clearInterval(ping));
  });

  // ------------------------------------------------------------ settings, batches, students
  app.get('/api/settings', (_req, res) => res.json(service.getSettings()));
  app.patch('/api/settings', (req, res) => res.json(service.updateSettings(req.body)));

  app.get('/api/batches', (_req, res) => res.json(service.listBatches()));
  app.post('/api/batches', (req, res) => res.status(201).json(service.createBatch(req.body ?? {})));
  app.patch('/api/batches/:id', (req, res) => res.json(service.updateBatch(Number(req.params.id), req.body)));
  app.delete('/api/batches/:id', (req, res) => {
    service.deleteBatch(Number(req.params.id));
    res.sendStatus(204);
  });
  app.post('/api/batches/:id/today', (req, res) => {
    const s = service.ensureSession(Number(req.params.id));
    res.json(service.getSessionView(s.id));
  });

  app.get('/api/students', (req, res) => res.json(service.listStudents(req.query.batchId ? Number(req.query.batchId) : null)));
  app.post('/api/students', (req, res) => res.status(201).json(service.createStudent(req.body ?? {})));
  app.patch('/api/students/:id', (req, res) => res.json(service.updateStudent(Number(req.params.id), req.body)));
  app.delete('/api/students/:id', (req, res) => {
    service.deleteStudent(Number(req.params.id));
    res.sendStatus(204);
  });

  // ------------------------------------------------------------ attendance
  app.get('/api/board', (req, res) => {
    const date = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined;
    res.json(service.getBoard(date));
  });
  app.get('/api/sessions/:id', (req, res) => res.json(service.getSessionView(Number(req.params.id))));
  app.post('/api/sessions/:id/mark', async (req, res) => {
    const id = Number(req.params.id);
    await service.mark(id, Number(req.body?.studentId), req.body?.status);
    res.json(service.getSessionView(id));
  });
  app.post('/api/sessions/:id/mark-all', async (req, res) => {
    const id = Number(req.params.id);
    await service.markAll(id, req.body?.status ?? 'P');
    res.json(service.getSessionView(id));
  });
  app.post('/api/sessions/:id/verify', async (req, res) => {
    const id = Number(req.params.id);
    await service.verify(id);
    res.json(service.getSessionView(id));
  });
  app.post('/api/sessions/:id/start-now', (req, res) => {
    const id = Number(req.params.id);
    service.startNow(id);
    res.json(service.getSessionView(id));
  });

  // ------------------------------------------------------------ call tasks
  app.get('/api/tasks', (req, res) => res.json(service.listTasks(req.query.status === 'done' ? 'done' : 'open')));
  app.post('/api/tasks/:id/complete', (req, res) => {
    service.completeTask(Number(req.params.id), req.body ?? {});
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ messages
  app.get('/api/messages/threads', (_req, res) => res.json(service.listThreads()));
  app.get('/api/messages', (req, res) => res.json(service.listMessages(String(req.query.phone ?? ''))));
  app.post('/api/simulator/reply', async (req, res) => {
    if (mode !== 'simulator') throw new HttpError(404, 'The simulator is off because real WhatsApp is configured');
    const { phone, payload, text } = req.body ?? {};
    if (!phone || (!payload && !String(text ?? '').trim())) throw new HttpError(400, 'phone and a reply are required');
    res.json(await service.handleReply({ phone, payload, text }));
  });

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  // ------------------------------------------------------------ built frontend
  if (staticDir && fs.existsSync(path.join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/|webhooks\/).*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) logger.error?.(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });

  return app;
}
