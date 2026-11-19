/**
 * Plans, what happens when a payment is late, and GST invoices.
 *
 * Prices are before GST. The safety loop (marking, alerts, replies, calls) is never limited by
 * a plan or a late payment, except after a long lapse, when the agency is told well in advance.
 */
export const PLANS = {
  trial: { name: 'Trial', monthly: 0, students: 100, logins: 5, fullReports: true, days: 30 },
  starter: { name: 'Starter', monthly: 999, students: 100, logins: 3, fullReports: false },
  standard: { name: 'Standard', monthly: 1999, students: 300, logins: 10, fullReports: true },
  pro: { name: 'Pro', monthly: 3999, students: 1000, logins: 25, fullReports: true },
  // Agreed separately (big institutes, or institutes from before plans existed): no limits.
  custom: { name: 'Custom', monthly: null, students: null, logins: null, fullReports: true },
};
export const YEARLY_MONTHS = 10; // a year costs ten months
export const FAIR_USE_ALERTS_PER_STUDENT = 4; // WhatsApp included up to this many alerts per student per month
export const GRACE = { banner: 7, readOnly: 14 }; // days after the paid-until date

const DAY = 86_400_000;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
export const addDaysTo = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const addMonths = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
};

/** Price for one billing period, before GST. */
export function periodPrice(plan, cycle, override = null) {
  const monthly = override ?? PLANS[plan]?.monthly ?? 0;
  return cycle === 'yearly' ? monthly * YEARLY_MONTHS : monthly;
}

/**
 * Where an institute stands:
 *   ok        paid (or no due date set)
 *   trial     on the free trial
 *   due       up to 7 days past the paid-until date: a reminder banner
 *   readonly  8–14 days late: setup changes paused, attendance and alerts carry on
 *   lapsed    more than 14 days late: paused until paid
 */
export function billingState({ plan, paidUntil }, today) {
  if (!paidUntil) return { state: plan === 'trial' ? 'trial' : 'ok', daysLeft: null, daysLate: 0 };
  const left = daysBetween(today, paidUntil);
  if (left >= 0) return { state: plan === 'trial' ? 'trial' : 'ok', daysLeft: left, daysLate: 0 };
  const late = -left;
  return { state: late <= GRACE.banner ? 'due' : late <= GRACE.readOnly ? 'readonly' : 'lapsed', daysLeft: 0, daysLate: late };
}

/** Indian financial year of a date, e.g. "2026-27". */
export function financialYear(date) {
  const [y, m] = date.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** GST on a price: CGST + SGST within the same state, IGST across states, none if unregistered. */
export function gstFor(amount, { sellerGstin, sellerState, buyerState }) {
  if (!sellerGstin) return { lines: [], tax: 0, total: amount };
  const r = (n) => Math.round(n * 100) / 100;
  if (sellerState && buyerState && sellerState.trim().toLowerCase() === buyerState.trim().toLowerCase()) {
    return { lines: [{ label: 'CGST 9%', amount: r(amount * 0.09) }, { label: 'SGST 9%', amount: r(amount * 0.09) }], tax: r(amount * 0.18), total: r(amount * 1.18) };
  }
  return { lines: [{ label: 'IGST 18%', amount: r(amount * 0.18) }], tax: r(amount * 0.18), total: r(amount * 1.18) };
}

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function under1000(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const words = rest < 20 ? ONES[rest] : `${TENS[Math.floor(rest / 10)]}${rest % 10 ? `-${ONES[rest % 10]}` : ''}`;
  return [h ? `${ONES[h]} hundred` : '', words].filter(Boolean).join(' ');
}
/** 1234567.5 -> "Rupees twelve lakh thirty-four thousand five hundred sixty-seven and fifty paise only" */
export function rupeesInWords(amount) {
  let n = Math.floor(amount);
  const paise = Math.round((amount - n) * 100);
  const parts = [];
  for (const [size, label] of [[10_000_000, 'crore'], [100_000, 'lakh'], [1000, 'thousand']]) {
    if (n >= size) {
      parts.push(`${under1000(Math.floor(n / size))} ${label}`);
      n %= size;
    }
  }
  if (n) parts.push(under1000(n));
  const rupees = parts.join(' ') || 'zero';
  return `Rupees ${rupees}${paise ? ` and ${under1000(paise)} paise` : ''} only`;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A printable invoice page (Print → Save as PDF in the browser). */
export function invoiceHtml(p, seller) {
  const registered = Boolean(seller.gstin);
  const rows = [`<tr><td>${esc(p.description)}<div class="muted">SAC ${esc(seller.sac || '—')} · ${esc(p.periodFrom)} to ${esc(p.periodTo)}</div></td><td class="r">${money(p.baseAmount)}</td></tr>`]
    .concat(p.taxLines.map((t) => `<tr><td>${esc(t.label)}</td><td class="r">${money(t.amount)}</td></tr>`))
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${registered ? 'Tax invoice' : 'Invoice'} ${esc(p.invoiceNo)}</title>
<style>
body{font:15px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#13241a;max-width:760px;margin:32px auto;padding:0 16px}
h1{font-size:24px;margin:0 0 4px}.muted{color:#5d6a62;font-size:13px}table{width:100%;border-collapse:collapse;margin:20px 0}
td,th{padding:10px 8px;border-bottom:1px solid #e4e9e5;text-align:left;vertical-align:top}.r{text-align:right}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}.total td{font-weight:700;font-size:17px;border-bottom:2px solid #13241a}
.bar{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid #13241a;padding-bottom:12px}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #13241a;background:#fff;cursor:pointer}@media print{button{display:none}body{margin:0}}
</style></head><body>
<div class="bar"><div><h1>${registered ? 'Tax invoice' : 'Invoice'}</h1><div class="muted">No. ${esc(p.invoiceNo)} · Date ${esc(p.paidAt)}</div></div><button onclick="print()">Print / save as PDF</button></div>
<div class="grid" style="margin-top:16px">
<div><div class="muted">From</div><b>${esc(seller.legalName || 'Your business name (set it in the agency console)')}</b><div>${esc(seller.address || '')}</div>${registered ? `<div>GSTIN ${esc(seller.gstin)}</div>` : ''}<div>${esc(seller.state || '')}</div></div>
<div><div class="muted">Billed to</div><b>${esc(p.buyer.legalName || p.buyer.name)}</b><div>${esc(p.buyer.address || '')}</div>${p.buyer.gstin ? `<div>GSTIN ${esc(p.buyer.gstin)}</div>` : ''}<div>${esc(p.buyer.state || '')}${p.buyer.state ? ' (place of supply)' : ''}</div></div>
</div>
<table><thead><tr><th>Description</th><th class="r">Amount</th></tr></thead><tbody>${rows}
<tr class="total"><td>Total</td><td class="r">${money(p.totalAmount)}</td></tr></tbody></table>
<p>${esc(rupeesInWords(p.totalAmount))}.</p>
<p class="muted">Paid by ${esc(p.method || '—')}${p.reference ? `, reference ${esc(p.reference)}` : ''}.${registered ? '' : ' The supplier is not registered under GST, so no GST is charged.'}</p>
</body></html>`;
}
