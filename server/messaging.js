import crypto from 'node:crypto';

/**
 * Simulator: messages are only stored in the database (by the service) and shown in the
 * "Parent WhatsApp" screen, where you can tap the reply buttons as the parent.
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
 * Messages a business starts (our absence alerts) must use an approved template when the
 * parent has not messaged in the last 24 hours. Set WHATSAPP_TEMPLATE to send alerts as that
 * template. Without it, alerts go out as interactive button messages, which only arrive inside
 * the 24-hour window (fine for testing with your own number).
 */
export function createWhatsAppMessenger({
  token,
  phoneNumberId,
  templateName = '',
  templateLanguage = 'en',
  apiVersion = 'v21.0',
  fetchImpl = globalThis.fetch,
}) {
  if (!token || !phoneNumberId) throw new Error('WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required');
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  return {
    mode: 'whatsapp',
    async send({ to, text, buttons, params }) {
      const payload = buildPayload({ to, text, buttons, params, templateName, templateLanguage });
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `WhatsApp API returned ${res.status}`);
      return { id: data?.messages?.[0]?.id ?? null };
    },
  };
}

export function buildPayload({ to, text, buttons, params, templateName, templateLanguage = 'en' }) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  if (buttons?.length && templateName && params) {
    return {
      ...base,
      type: 'template',
      template: {
        name: templateName,
        language: { code: templateLanguage },
        components: [
          { type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) },
          ...buttons.map((b, i) => ({
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

/** Pull the parent replies out of a WhatsApp webhook body. */
export function parseWebhook(body) {
  const replies = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const m of change?.value?.messages ?? []) {
        if (m.type === 'button') {
          replies.push({ phone: m.from, payload: m.button?.payload ?? null, text: m.button?.text ?? '' });
        } else if (m.type === 'interactive') {
          const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
          replies.push({ phone: m.from, payload: r?.id ?? null, text: r?.title ?? '' });
        } else if (m.type === 'text') {
          replies.push({ phone: m.from, payload: null, text: m.text?.body ?? '' });
        }
      }
    }
  }
  return replies;
}

/** Check Meta's X-Hub-Signature-256 header against the raw request body. */
export function verifySignature(rawBody, header, appSecret) {
  if (!rawBody || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`);
  const given = Buffer.from(header);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Real WhatsApp when the institute has Cloud API credentials, otherwise the simulator. */
export function messengerFromConfig(cfg = {}) {
  if (cfg.token && cfg.phoneNumberId) {
    return createWhatsAppMessenger({
      token: cfg.token,
      phoneNumberId: cfg.phoneNumberId,
      templateName: cfg.template,
      templateLanguage: cfg.templateLang || 'en',
    });
  }
  return createSimulatorMessenger();
}
