import { normalizeDigits, parseAmount, type Minor } from './money';
import type { ItemFlag, OcrLine, Receipt, ReceiptItem } from './receipt';

interface Row {
  text: string;
  confidence: number;
  y: number;
}

type Kind = 'subtotal' | 'tax' | 'service' | 'tip' | 'total' | 'discount' | 'ignore' | 'item';

// Arabic is matched after normalizeArabic (no diacritics, unified alef/yeh/teh-marbuta).
const KEYWORDS: Array<[Kind, RegExp]> = [
  ['subtotal', /\b(sub\s*-?\s*total)\b|المجموع الفرعي|اجمالي فرعي/i],
  ['tax', /\b(vat|tax|gst)\b|ضريبه|ض\.?ق\.?م/i],
  ['service', /\b(service|svc|srv)\b|خدمه|رسوم الخدمه/i],
  ['tip', /\b(tip|gratuity)\b|بقشيش|اكراميه/i],
  ['discount', /\b(discount|disc|promo|offer|saving)\b|خصم/i],
  ['total', /\b(grand\s*total|total\s*due|amount\s*due|net\s*total|total)\b|الاجمالي|اجمالي|المجموع|المطلوب/i],
  ['ignore', /\b(cash|change|visa|master\s*card|card|paid|tendered|balance|receipt|invoice|order|table|cashier|tel|phone|thank|www|tax\s*(id|no|reg))\b|نقد|الباقي|فيزا|شكرا|رقم|هاتف|كاشير|فاتوره|طاوله/i],
];

const CURRENCIES: Array<[string, RegExp]> = [
  ['EGP', /\b(egp|le|l\.e)\b|ج\.?\s?م|جنيه/i],
  ['USD', /\busd\b|\$/i],
  ['EUR', /\beur\b|€/i],
  ['SAR', /\b(sar|sr)\b/i],
  ['AED', /\baed\b/i],
];

export function normalizeArabic(s: string): string {
  return s
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
}

/** Merge OCR fragments that sit on the same visual line (name on the left, price on the right). */
export function groupRows(lines: OcrLine[]): Row[] {
  const sorted = [...lines]
    .filter((l) => l.text.trim().length > 0)
    .sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  const groups: OcrLine[][] = [];
  for (const l of sorted) {
    const last = groups[groups.length - 1];
    const ref = last?.[0];
    if (last && ref && Math.abs(l.y + l.h / 2 - (ref.y + ref.h / 2)) < Math.min(l.h, ref.h) * 0.6) last.push(l);
    else groups.push([l]);
  }
  return groups.map((g) => {
    const byX = [...g].sort((a, b) => a.x - b.x);
    return {
      text: byX.map((l) => l.text.trim()).join('  '),
      confidence: Math.min(...g.map((l) => l.confidence)),
      y: g[0]!.y,
    };
  });
}

const NUM_TOKEN = /^[-(]?\d[\d.,]*\)?-?$/;

function stripCurrency(t: string): string {
  return t.replace(/^(egp|le|l\.e\.?|usd|eur|\$|€)/i, '').replace(/(egp|le|l\.e\.?|ج\.?م\.?)$/i, '');
}

interface Amounts {
  text: string; // row text without the trailing numeric tokens
  values: Array<Minor | null>; // null = looked numeric but ambiguous/unreadable
  raw: string[];
}

function splitTrailingAmounts(rowText: string): Amounts {
  const tokens = normalizeDigits(rowText).split(/\s+/).filter(Boolean);
  const raw: string[] = [];
  while (tokens.length) {
    const t = stripCurrency(tokens[tokens.length - 1]!);
    if (t === '') {
      tokens.pop();
      continue;
    }
    if (!NUM_TOKEN.test(t)) break;
    raw.unshift(t);
    tokens.pop();
  }
  return {
    text: tokens.join(' ').trim(),
    raw,
    values: raw.map((t) => {
      const neg = t.startsWith('(') || t.endsWith('-') || t.startsWith('-');
      const v = parseAmount(t.replace(/[()]/g, '').replace(/-$/, ''));
      return v === null ? null : neg ? -Math.abs(v) : v;
    }),
  };
}

function classify(text: string): Kind {
  const t = normalizeArabic(text);
  for (const [kind, re] of KEYWORDS) if (re.test(t)) return kind;
  return 'item';
}

function detectCurrency(rows: Row[]): string | null {
  const all = rows.map((r) => r.text).join('\n');
  for (const [code, re] of CURRENCIES) if (re.test(all)) return code;
  return null;
}

function detectDate(rows: Row[]): { iso: string | null; ambiguous: boolean } {
  for (const r of rows) {
    const t = normalizeDigits(r.text);
    let m = t.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
    if (m) return mk(+m[1]!, +m[2]!, +m[3]!, false);
    m = t.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/);
    if (m) {
      const a = +m[1]!;
      const b = +m[2]!;
      const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
      // Egyptian receipts are day-first. Only flag when the order genuinely could be swapped.
      return mk(y, b, a, a <= 12 && b <= 12 && a !== b);
    }
  }
  return { iso: null, ambiguous: false };

  function mk(y: number, mo: number, d: number, ambiguous: boolean) {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    const valid = dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
    return valid ? { iso: dt.toISOString().slice(0, 10), ambiguous } : { iso: null, ambiguous: false };
  }
}

/**
 * Turn OCR lines into a draft receipt. The parser only reports what it can read:
 * unreadable prices stay null, inferred values are flagged, unclassified rows are listed.
 */
export function parseReceipt(lines: OcrLine[]): Receipt {
  const rows = groupRows(lines);
  const uncertain: string[] = [];
  const unparsed: string[] = [];
  const items: ReceiptItem[] = [];
  const totals: Partial<Record<Kind, Minor>> = {};
  let discounts = 0;
  let nextId = 1;

  const date = detectDate(rows);
  if (date.iso === null) uncertain.push('date');
  else if (date.ambiguous) uncertain.push('date');

  const detected = detectCurrency(rows);
  if (!detected) uncertain.push('currency');

  let merchant: string | null = null;
  for (const r of rows.slice(0, 6)) {
    const a = splitTrailingAmounts(r.text);
    const hasLetters = /[A-Za-z؀-ۿ]{3,}/.test(r.text);
    if (hasLetters && a.raw.length === 0 && classify(r.text) === 'item' && !/\d{4,}/.test(normalizeDigits(r.text))) {
      merchant = r.text.replace(/\s{2,}/g, ' ');
      if (r.confidence < 0.6) uncertain.push('merchant');
      break;
    }
  }
  if (!merchant) uncertain.push('merchant');

  let lastWasItem = false;
  for (const row of rows) {
    const kind = classify(row.text);
    const amt = splitTrailingAmounts(row.text);
    const hasPrice = amt.raw.length > 0;

    if (kind === 'ignore' || row.text === merchant) {
      lastWasItem = false;
      continue;
    }
    if (kind !== 'item') {
      lastWasItem = false;
      const v = amt.values[amt.values.length - 1];
      if (!hasPrice || v === null || v === undefined) {
        unparsed.push(row.text);
        continue;
      }
      if (kind === 'discount') discounts += v > 0 ? -v : v;
      else if (totals[kind] === undefined || kind === 'total') totals[kind] = v;
      if (row.confidence < 0.6) uncertain.push(kind);
      continue;
    }

    // Item candidate
    if (!hasPrice) {
      const t = row.text.trim();
      const prev = items[items.length - 1];
      // A wrapped description: letters only, directly after an item, no digits.
      if (lastWasItem && prev && /^[^\d]+$/.test(t) && t.length < 40 && /[A-Za-z؀-ۿ]/.test(t)) {
        prev.description = `${prev.description} ${t}`;
        continue;
      }
      if (/[A-Za-z؀-ۿ]{3,}/.test(t) && !/\d{2}[:/.-]\d{2}/.test(normalizeDigits(t))) unparsed.push(t);
      lastWasItem = false;
      continue;
    }

    const flags: ItemFlag[] = [];
    let description = amt.text;
    let quantity = 1;
    let qtyExplicit = false;

    const lead = normalizeDigits(description).match(/^(\d{1,3})\s*[xX×*]\s*(.+)$/);
    const trail = normalizeDigits(description).match(/^(.+?)\s*[xX×*]\s*(\d{1,3})$/);
    if (lead) {
      quantity = +lead[1]!;
      description = lead[2]!;
      qtyExplicit = true;
    } else if (trail) {
      quantity = +trail[2]!;
      description = trail[1]!;
      qtyExplicit = true;
    }

    const lineTotal = amt.values[amt.values.length - 1] ?? null;
    let unitPrice: Minor | null = null;
    const prevVal = amt.values.length >= 2 ? amt.values[amt.values.length - 2] : undefined;

    if (amt.values.length >= 2 && lineTotal !== null && prevVal !== undefined && prevVal !== null) {
      const prevRaw = amt.raw[amt.raw.length - 2]!;
      const isPlainInt = /^\d{1,2}$/.test(prevRaw);
      if (!qtyExplicit && isPlainInt && amt.values.length === 2) {
        // "Pepsi 2 90.00": a bare small integer before the price is probably the quantity.
        quantity = +prevRaw;
        flags.push('quantity-inferred');
      } else if (prevVal * quantity === lineTotal) {
        unitPrice = prevVal;
      }
    }
    if (unitPrice === null && lineTotal !== null) {
      if (quantity === 1) unitPrice = lineTotal;
      else if (lineTotal % quantity === 0) unitPrice = lineTotal / quantity;
      else flags.push('unit-price-unknown');
    }
    if (lineTotal === null) flags.push('price-unreadable');
    if (row.confidence < 0.6) flags.push('low-ocr-confidence');

    description = description.replace(/\s{2,}/g, ' ').replace(/^[-•*.\s]+/, '').trim();
    if (description === '') {
      unparsed.push(row.text);
      continue;
    }
    const id = `i${nextId++}`;
    items.push({ id, description, quantity, unitPrice, lineTotal, confidence: row.confidence, flags });
    for (const f of flags) uncertain.push(`items.${id}.${f === 'price-unreadable' || f === 'unit-price-unknown' ? 'lineTotal' : f === 'quantity-inferred' ? 'quantity' : 'description'}`);
    lastWasItem = true;
  }

  const receipt: Receipt = {
    merchant,
    date: date.iso,
    currency: detected ?? 'EGP',
    items,
    discounts,
    subtotal: totals.subtotal ?? null,
    tax: totals.tax ?? null,
    service: totals.service ?? null,
    tip: totals.tip ?? null,
    total: totals.total ?? null,
    taxIncluded: false,
    uncertain,
    unparsed,
  };

  // Prove, don't assume: if items alone already equal the printed total, tax/service are inclusive.
  const itemsSum = items.reduce((s, i) => s + (i.lineTotal ?? 0), 0);
  if (receipt.total !== null && (receipt.tax || receipt.service)) {
    const withTip = itemsSum + discounts + (receipt.tip ?? 0);
    const withExtras = withTip + (receipt.tax ?? 0) + (receipt.service ?? 0);
    if (withExtras !== receipt.total && withTip === receipt.total) receipt.taxIncluded = true;
  }
  if (receipt.total === null) uncertain.push('total');
  return receipt;
}
