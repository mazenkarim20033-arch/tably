import { parseAmount, type Minor } from './money';
import { settleArithmetic } from './arithmetic';
import type { OcrLine, Receipt, ReceiptItem } from './receipt';
import { reconcile } from './reconcile';

/**
 * A vision model reads the photo as a whole, which helps with crumpled, tilted or badly lit receipts that character
 * recognition breaks apart. Models also make up digits, so its reading is only ever a suggestion: every amount is
 * checked against what the scanner saw and against the receipt's own arithmetic, and the person decides.
 */

/** What the model is asked to return. Amounts are text exactly as printed, so no arithmetic is done by the model. */
export interface VisionReading {
  merchant?: string | null;
  /** YYYY-MM-DD when printed in full */
  date?: string | null;
  currency?: string | null;
  items: Array<{ name: string; quantity?: number | null; amount?: string | null }>;
  subtotal?: string | null;
  tax?: string | null;
  service?: string | null;
  tip?: string | null;
  total?: string | null;
}

/** JSON schema handed to the model, and the instructions that go with it. */
export const VISION_SCHEMA = {
  type: 'object',
  properties: {
    merchant: { type: ['string', 'null'] },
    date: { type: ['string', 'null'] },
    currency: { type: ['string', 'null'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          quantity: { type: ['integer', 'null'] },
          amount: { type: ['string', 'null'] },
        },
        required: ['name', 'amount'],
      },
    },
    subtotal: { type: ['string', 'null'] },
    tax: { type: ['string', 'null'] },
    service: { type: ['string', 'null'] },
    tip: { type: ['string', 'null'] },
    total: { type: ['string', 'null'] },
  },
  required: ['items'],
} as const;

export const VISION_PROMPT =
  'Read this shop or restaurant receipt. Return JSON only. List every purchased item with its name, quantity and the ' +
  'line amount (the total for that line, not the unit price) exactly as printed, for example "1,250.00". Also return ' +
  'the printed subtotal, tax, service charge, tip and total, the shop name, the date as YYYY-MM-DD and the currency ' +
  'code. Copy digits exactly as you see them. Never calculate, correct, guess or invent a number: if an amount is ' +
  'unreadable or not printed, use null.';

/** Pull the JSON object out of a model reply (models sometimes wrap it in text or a code fence). */
export function parseVisionReply(reply: unknown): VisionReading | null {
  let obj: unknown = reply;
  if (typeof reply === 'string') {
    const a = reply.indexOf('{');
    const b = reply.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
      obj = JSON.parse(reply.slice(a, b + 1));
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray((obj as VisionReading).items)) return null;
  const r = obj as VisionReading;
  const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);
  return {
    merchant: text(r.merchant),
    date: text(r.date),
    currency: text(r.currency),
    items: r.items
      .filter((i) => i && typeof i.name === 'string')
      .slice(0, 200)
      .map((i) => ({ name: i.name.slice(0, 120), quantity: Number.isInteger(i.quantity) && i.quantity! > 0 && i.quantity! < 1000 ? i.quantity : 1, amount: text(i.amount) })),
    subtotal: text(r.subtotal), tax: text(r.tax), service: text(r.service), tip: text(r.tip), total: text(r.total),
  };
}

/** Every amount the scanner saw, including its runner-up readings: a model's number must be one of these to be trusted. */
export function amountsSeen(lines: OcrLine[]): Set<Minor> {
  const seen = new Set<Minor>();
  for (const l of lines) {
    for (const text of [l.text, ...(l.alternates ?? [])]) {
      for (const m of text.match(/\d[\d.,٠-٩]*\d|\d/g) ?? []) {
        const v = parseAmount(m);
        if (v !== null) seen.add(v);
      }
    }
  }
  return seen;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Build a receipt from the model's reading. Amounts the scanner never saw are flagged, not dropped. */
export function receiptFromVision(reading: VisionReading, ocr: OcrLine[] = []): Receipt {
  const seen = amountsSeen(ocr);
  const checkable = seen.size > 0;
  const uncertain: string[] = [];
  const reasons: Record<string, string> = {};
  const notes: string[] = ['Read by an AI model from the photo. Check the amounts against the receipt.'];
  const fieldChoices: Receipt['fieldChoices'] = {};
  const flag = (path: string, why: string) => {
    if (!uncertain.includes(path)) uncertain.push(path);
    reasons[path] = reasons[path] ?? why;
  };
  const amount = (s: string | null | undefined): Minor | null => (s ? parseAmount(s) : null);
  const unseen = (v: Minor) => checkable && !seen.has(v);

  const items: ReceiptItem[] = [];
  const unparsed: string[] = [];
  reading.items.forEach((it, n) => {
    const v = amount(it.amount);
    const id = `i${n + 1}`;
    if (v === null) {
      unparsed.push(it.amount ? `${it.name} ${it.amount}` : it.name);
      return;
    }
    const quantity = it.quantity ?? 1;
    items.push({
      id, description: it.name.trim(), quantity, unitPrice: quantity === 1 ? v : v % quantity === 0 ? v / quantity : null,
      lineTotal: v, confidence: unseen(v) ? 0.4 : 0.9, flags: unseen(v) ? ['low-ocr-confidence'] : [],
    });
    if (unseen(v)) flag(`items.${id}.lineTotal`, 'The AI read this price but the scanner did not see it. Check it.');
  });

  const totals: Partial<Record<'subtotal' | 'tax' | 'service' | 'tip' | 'total', Minor>> = {};
  for (const k of ['subtotal', 'tax', 'service', 'tip', 'total'] as const) {
    const v = amount(reading[k]);
    if (v === null) continue;
    totals[k] = v;
    if (unseen(v)) flag(k, 'The AI read this amount but the scanner did not see it. Check it.');
  }

  const settled = settleArithmetic({
    items, totals: { subtotal: totals.subtotal, tax: totals.tax, service: totals.service, tip: totals.tip },
    total: totals.total ?? null, discounts: 0, notes, uncertain, reasons, fieldChoices,
  });

  return {
    merchant: reading.merchant?.trim() || null,
    date: reading.date && DATE.test(reading.date) ? reading.date : null,
    currency: (reading.currency ?? '').trim().toUpperCase() || 'EGP',
    items, discounts: 0,
    subtotal: totals.subtotal ?? null, tax: totals.tax ?? null, service: totals.service ?? null, tip: totals.tip ?? null,
    total: settled.total, taxIncluded: settled.taxIncluded,
    uncertain, unparsed, notes, fieldChoices, reasons,
  };
}

/** How well a reading holds together; higher is better. */
export function readingScore(r: Receipt): number {
  if (r.items.length === 0) return -100;
  const status = reconcile(r).status;
  return (status === 'ok' ? 100 : status === 'incomplete' ? 20 : 0) - r.uncertain.length * 3 - r.unparsed.length;
}

export interface Chosen {
  receipt: Receipt;
  /** which reading was used */
  source: 'scanner' | 'ai';
  /** the other reading, when it exists and differs, so the person can compare */
  other?: Receipt;
}

/**
 * Pick between the scanner's reading and the AI's. The scanner's wins ties: it is deterministic and its digits are the
 * ones actually read from the pixels. The AI's is used only when it clearly holds together better.
 */
export function chooseReading(scanner: Receipt, ai: Receipt | null): Chosen {
  if (!ai) return { receipt: scanner, source: 'scanner' };
  const s = readingScore(scanner);
  const a = readingScore(ai);
  return a > s + 10 ? { receipt: ai, source: 'ai', other: scanner } : { receipt: scanner, source: 'scanner', other: ai };
}
