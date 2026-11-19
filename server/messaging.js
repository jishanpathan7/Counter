import crypto from 'node:crypto';

/** Meta removes Graph API v21.0 on 2027-01-21; override with WHATSAPP_GRAPH_VERSION. */
export const DEFAULT_GRAPH_VERSION = 'v26.0';

/** A send that failed. `retryable` = worth trying again (rate limit, Meta or network hiccup). */
export class WhatsAppError extends Error {
  constructor(message, { status = null, code = null, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

// Meta error codes that mean "try again shortly" rather than "this will never work".
const RETRYABLE_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131056, 133004]);

/**
 * Simulator: messages are only stored in the database (by the service) and shown in the
 * WhatsApp screen, where you can tap the reply buttons as the parent.
 */
export function createSimulatorMessenger() {
  return {
    mode: 'simulator',
    async send() {
      return { id: null };
    },
  };
}

/**
 * Meta WhatsApp Cloud API.
 *
 * Messages the institute starts (absence alerts, the owner's daily summary) need an approved
 * template, because the recipient usually hasn't messaged in the last 24 hours. Without an alert
 * template, alerts go out as interactive button messages, which only arrive inside that window
 * (fine for testing with your own number). The owner summary is never sent without its template.
 */
export function createWhatsAppMessenger({
  token,
  phoneNumberId,
  templates = {},
  templateLanguage = 'en',
  apiVersion = DEFAULT_GRAPH_VERSION,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  retryDelaysMs = [500, 2000],
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  if (!token || !phoneNumberId) throw new Error('WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required');
  const url = `https://graph.facebook.com/${apiVersion || DEFAULT_GRAPH_VERSION}/${phoneNumberId}/messages`;

  const attempt = async (payload) => {
    let res;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs);
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = controller.signal.aborted || err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new WhatsAppError(timedOut ? `WhatsApp didn't answer within ${timeoutMs / 1000} s` : `Couldn't reach WhatsApp: ${err.message}`, {
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { id: data?.messages?.[0]?.id ?? null };
    const code = data?.error?.code ?? null;
    throw new WhatsAppError(data?.error?.message || `WhatsApp API returned ${res.status}`, {
      status: res.status,
      code,
      retryable: res.status === 429 || res.status >= 500 || RETRYABLE_CODES.has(code),
    });
  };

  return {
    mode: 'whatsapp',
    /**
     * @param template 'alert' | 'digest' — which approved template to use, if configured
     * @param params   the template's body parameters, in order
     */
    async send({ to, text, buttons, template, params }) {
      const templateName = template ? templates[template] : '';
      if (template === 'digest' && !templateName) {
        throw new WhatsAppError('No owner-summary template is set up (Settings → WhatsApp), so the summary was not sent.');
      }
      const payload = buildPayload({ to, text, buttons, params, templateName, templateLanguage });
      for (let i = 0; ; i++) {
        try {
          return await attempt(payload);
        } catch (err) {
          if (!err.retryable || i >= retryDelaysMs.length) throw err;
          await sleep(retryDelaysMs.at(i));
        }
      }
    },
  };
}

/** Template parameters may not contain newlines, tabs or long runs of spaces. */
const cleanParam = (p) =>
  String(p ?? '')
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/ {4,}/g, '   ')
    .trim() || '-';

export function buildPayload({ to, text, buttons, params, templateName, templateLanguage = 'en' }) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  if (templateName && params) {
    return {
      ...base,
      type: 'template',
      template: {
        name: templateName,
        language: { code: templateLanguage },
        components: [
          { type: 'body', parameters: params.map((p) => ({ type: 'text', text: cleanParam(p) })) },
          ...(buttons ?? []).map((b, i) => ({
            type: 'button',
            sub_type: 'quick_reply',
            index: String(i),
            parameters: [{ type: 'payload', payload: b.id }],
          })),
        ],
      },
    };
  }
  if (buttons?.length) {
    return {
      ...base,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text },
        action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
      },
    };
  }
  return { ...base, type: 'text', text: { body: text } };
}

/**
 * Read a WhatsApp webhook body.
 * replies:  what parents sent (with Meta's message id, used to ignore retried deliveries)
 * statuses: what happened to messages we sent (sent / delivered / read / failed)
 */
export function parseWebhook(body) {
  const replies = [];
  const statuses = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      for (const m of value.messages ?? []) {
        const base = { id: m.id ?? null, phone: m.from };
        if (m.type === 'button') {
          replies.push({ ...base, payload: m.button?.payload ?? null, text: m.button?.text ?? '' });
        } else if (m.type === 'interactive') {
          const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
          replies.push({ ...base, payload: r?.id ?? null, text: r?.title ?? '' });
        } else if (m.type === 'text') {
          replies.push({ ...base, payload: null, text: m.text?.body ?? '' });
        } else if (m.type) {
          // Voice notes, photos, stickers: keep a record so staff can see the parent wrote back.
          replies.push({ ...base, payload: null, text: `[${m.type}]` });
        }
      }
      for (const s of value.statuses ?? []) {
        const e = s.errors?.[0];
        statuses.push({
          id: s.id ?? null,
          status: s.status,
          timestamp: s.timestamp ?? null,
          error: e ? { code: e.code ?? null, title: e.title || e.message || null } : null,
        });
      }
    }
  }
  return { replies, statuses };
}

/** Check Meta's X-Hub-Signature-256 header against the raw request body. */
export function verifySignature(rawBody, header, appSecret) {
  if (!rawBody || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`);
  const given = Buffer.from(header);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Real WhatsApp when the institute has Cloud API credentials, otherwise the simulator. */
export function messengerFromConfig(cfg = {}, { apiVersion } = {}) {
  if (cfg.token && cfg.phoneNumberId) {
    return createWhatsAppMessenger({
      token: cfg.token,
      phoneNumberId: cfg.phoneNumberId,
      templates: { alert: cfg.template, digest: cfg.digestTemplate },
      templateLanguage: cfg.templateLang || 'en',
      apiVersion,
    });
  }
  return createSimulatorMessenger();
}
