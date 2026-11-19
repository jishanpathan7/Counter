import crypto from 'node:crypto';

/**
 * Error reporting to Sentry (or anything that accepts Sentry's envelope format, e.g. GlitchTip).
 * Set SENTRY_DSN to turn it on; without it errors are only logged.
 *
 * Deliberately small instead of the full SDK: it sends the error, where it happened and a few tags,
 * and never request bodies, cookies or headers. Phone numbers and long digit runs in messages are
 * masked, because parents' numbers must not leave the server in error reports.
 */
export function createErrorReporter({
  dsn = '',
  environment = 'production',
  release = null,
  fetchImpl = globalThis.fetch,
  logger = console,
  clock = () => Date.now(),
  maxPerMinute = 30,
} = {}) {
  const target = parseDsn(dsn);
  const recent = new Map(); // fingerprint -> last sent at
  let windowStart = 0;
  let sentInWindow = 0;
  const pending = new Set();

  const capture = (err, { tags = {}, extra = {}, request = null, level = 'error' } = {}) => {
    if (!target) return null;
    const error = err instanceof Error ? err : new Error(String(err));
    const now = clock();

    // The same failure every scheduler tick shouldn't flood the inbox: once a minute per kind.
    const fingerprint = `${error.name}:${error.message}:${(error.stack ?? '').split('\n')[1] ?? ''}`;
    if (now - (recent.get(fingerprint) ?? -Infinity) < 60_000) return null;
    if (now - windowStart >= 60_000) {
      windowStart = now;
      sentInWindow = 0;
    }
    if (sentInWindow >= maxPerMinute) return null;
    sentInWindow += 1;
    recent.set(fingerprint, now);
    if (recent.size > 500) recent.delete(recent.keys().next().value);

    const eventId = crypto.randomUUID().replaceAll('-', '');
    const event = {
      event_id: eventId,
      timestamp: now / 1000,
      platform: 'node',
      level,
      environment,
      ...(release ? { release } : {}),
      server_name: 'attendance-alert',
      tags: Object.fromEntries(Object.entries(tags).filter(([, v]) => v != null).map(([k, v]) => [k, scrub(String(v))])),
      extra: Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, scrub(typeof v === 'string' ? v : JSON.stringify(v))])),
      ...(request ? { request: { method: request.method, url: scrub(request.path ?? '') } } : {}),
      exception: { values: [{ type: error.name || 'Error', value: scrub(error.message), stacktrace: { frames: frames(error.stack) } }] },
    };
    const body = [JSON.stringify({ event_id: eventId, sent_at: new Date(now).toISOString() }), JSON.stringify({ type: 'event' }), JSON.stringify(event)].join('\n');
    const p = fetchImpl(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=attendance-alert/1.0, sentry_key=${target.publicKey}`,
      },
      body,
      signal: AbortSignal.timeout(5000),
    })
      .then((res) => {
        if (!res.ok) logger.warn?.(`Error report was not accepted (${res.status})`);
      })
      .catch((e) => logger.warn?.(`Couldn't send error report: ${e.message}`))
      .finally(() => pending.delete(p));
    pending.add(p);
    return eventId;
  };

  return {
    enabled: Boolean(target),
    capture,
    /** Wait for reports still being sent (on shutdown), at most `ms`. */
    flush: (ms = 3000) => Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, ms).unref())]),
  };
}

/** https://<key>@<host>/<project> -> where to send events. Returns null for an empty or bad DSN. */
export function parseDsn(dsn) {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.split('/').filter(Boolean).pop();
    if (!u.username || !projectId) return null;
    const prefix = u.pathname.slice(0, u.pathname.lastIndexOf('/'));
    return { publicKey: u.username, url: `${u.protocol}//${u.host}${prefix}/api/${projectId}/envelope/` };
  } catch {
    return null;
  }
}

/** Mask phone numbers and other long digit runs (a parent's number must never end up in Sentry). */
export function scrub(s) {
  return String(s ?? '')
    .replace(/\+?\d[\d\s-]{8,}\d/g, '[number]')
    .slice(0, 2000);
}

function frames(stack = '') {
  return String(stack)
    .split('\n')
    .slice(1, 30)
    .map((line) => {
      const m = line.match(/at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
      if (!m) return null;
      const file = m[2].replace(/^file:\/\//, '');
      return { function: m[1] || '?', filename: file.replace(/^.*?\/(server|api)\//, '$1/'), lineno: Number(m[3]), colno: Number(m[4]), in_app: !file.includes('node_modules') && !file.startsWith('node:') };
    })
    .filter(Boolean)
    .reverse(); // Sentry wants the innermost frame last
}
