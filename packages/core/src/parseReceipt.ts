import { normalizeDigits, parseAmount, type Minor } from './money';
import type { ItemFlag, OcrLine, Receipt, ReceiptItem } from './receipt';

/**
 * Receipt parser: OCR lines in, a draft receipt out.
 *
 * Principles: read only what is printed; never invent a price; anything inferred (a calculated total, a repaired
 * digit) is flagged and explained in `notes`; rows that could not be used are listed, never dropped silently.
 *
 * Pipeline
 *   1. Photo geometry: estimate the tilt of the page and correct it, so a price printed at the right edge lines up
 *      with its name at the left edge even when the photo is crooked.
 *   2. Group fragments into visual rows; attach prices and quantities that ended up on rows of their own to the
 *      nearest name.
 *   3. Find the item table (below the Qty/Item/Price header, above the first subtotal/tax/total). Only rows inside it
 *      can become items, so addresses, staff names, dates and footers never do.
 *   4. Read items, charges and totals.
 *   5. Use the receipt's own arithmetic: calculate a missing total, notice per-unit prices, and suggest a fix when a
 *      single misread digit or a stray row explains why the items do not add up.
 */

interface Row {
  frags: OcrLine[];
  text: string;
  confidence: number;
  /** vertical centre after tilt correction (normalized 0..1) */
  yc: number;
  /** average text height */
  h: number;
  x0: number;
  x1: number;
}

type Kind = 'subtotal' | 'tax' | 'service' | 'tip' | 'total' | 'discount' | 'ignore' | 'item';

const LETTER = /[A-Za-z؀-ۿ]/;
const LATIN = /[A-Za-z]/;
const ARABIC = /[؀-ۿ]/;

// Arabic is matched after normalizeArabic (no diacritics, unified alef/yeh/teh-marbuta).
const KEYWORDS: Array<[Kind, RegExp]> = [
  ['subtotal', /\b(sub\s*-?\s*total|net\s*amount|items?\s*total)\b|المجموع الفرعي|اجمالي فرعي|الاجمالي الفرعي/i],
  ['tax', /\b(vat|tax|gst|taxes)\b|ضريبه|ض\.?ق\.?م/i],
  ['service', /\b(service|svc|srv|serv\.?\s*ch(arge)?)\b|خدمه|رسوم الخدمه/i],
  ['tip', /\b(tip|tips|gratuity)\b|بقشيش|اكراميه/i],
  ['discount', /\b(discount|disc|promo|offer|saving|savings|coupon)\b|خصم/i],
  ['total', /\b(grand\s*total|total\s*due|amount\s*due|net\s*total|to\s*pay|balance\s*due|total)\b|الاجمالي|اجمالي|المجموع|المطلوب|الصافي/i],
  [
    'ignore',
    /\b(cash|change|visa|master\s*card|mastercard|card|paid|tendered|receipt|invoice|inv|order|table|cashier|casheir|cashir|staff|tel|phone|mobile|thank|thanks|www|shift|server|waiter|guests?|covers?|pax|customer|ref|reference|terminal|auth|approval|website|visiting|tax\s*(id|no|reg))\b|نقد|الباقي|فيزا|شكرا|رقم|هاتف|كاشير|فاتوره|طاوله|العميل|الموظف/i,
  ],
];

// "Total Qty: 4", "No. of items 3": counts, not money.
const COUNT_ROW = /\b(total\s*(qty|quantity|items?|pieces|pcs)|no\.?\s*of\s*items|items?\s*count|qty|quantity)\b|عدد الاصناف|الكميه/i;

// Strong total labels beat a plain "Total" when several total rows exist.
const STRONG_TOTAL = /\b(grand\s*total|total\s*due|amount\s*due|net\s*total|to\s*pay|balance\s*due)\b|الاجمالي المستحق|المطلوب|الصافي/i;

// Column headers of the item table ("Qty  Item  Price").
const HEADER_WORDS = /^(qty|quantity|description|desc|item|items|price|unit|amount|total|value|rate|#|no\.?|الكميه|الصنف|البيان|السعر|القيمه|الاجمالي|الوحده)$/i;
const QTY_HEADER = /\b(qty|quantity)\b|الكميه/i;

// Words that sit at the top of receipts but are not the store's name.
const NOT_A_STORE = /\b(take\s*-?\s*away|takeaway|dine\s*-?\s*in|dine|delivery|pick\s*-?\s*up|welcome|receipt|invoice|inv|copy|duplicate|original|bill|check|order|table|cash|shift|morning|evening|night|cashier|casheir|customer|date|time|tax|vat|branch|tel|phone|staff|covers?|number)\b|فاتوره|سفري|توصيل|صاله|اهلا/i;

// Header and footer lines that are never items, whatever number they end with: a ZIP code, phone, web address, a time.
const NON_ITEM: RegExp[] = [
  /\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/, // US state + ZIP (case-sensitive on purpose)
  /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/, // phone number
  /\b0\d{9,10}\b/, // Egyptian phone number
  /\b(www\.|https?:)|\.(com|net|org|eg)\b/i,
  /\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm|a|p)?(?!\w)/i, // a time of day
  /\b(street|st\.|drive|avenue|ave\.|boulevard|blvd|road|rd\.)\b/i,
  /شارع|ميدان/,
];

const CURRENCIES: Array<[string, RegExp]> = [
  ['EGP', /\b(egp|le|l\.e)\b|ج\.?\s?م|جنيه/i],
  ['USD', /\busd\b|\$/i],
  ['EUR', /\beur\b|€/i],
  ['GBP', /\bgbp\b|£/i],
  ['SAR', /\b(sar|sr)\b|ر\.?س/i],
  ['AED', /\baed\b|د\.?إ/i],
];

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function normalizeArabic(s: string): string {
  return s
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
}

// ---------------------------------------------------------------------------------------------------------------
// 1 + 2. Geometry: tilt correction, rows, orphan prices and quantities
// ---------------------------------------------------------------------------------------------------------------

const centreY = (l: OcrLine, slope: number) => l.y + l.h / 2 - slope * (l.x + l.w / 2);

/** Group fragments that sit on the same line once the page tilt (a vertical shear per unit of x) is removed. */
export function groupFragments(lines: OcrLine[], slope: number): OcrLine[][] {
  const sorted = [...lines].sort((a, b) => centreY(a, slope) - centreY(b, slope));
  const groups: Array<{ items: OcrLine[]; sum: number; hSum: number }> = [];
  for (const l of sorted) {
    const c = centreY(l, slope);
    const g = groups[groups.length - 1];
    if (g) {
      const mean = g.sum / g.items.length;
      const meanH = g.hSum / g.items.length;
      if (Math.abs(c - mean) < Math.min(l.h, meanH) * 0.6) {
        g.items.push(l);
        g.sum += c;
        g.hSum += l.h;
        continue;
      }
    }
    groups.push({ items: [l], sum: c, hSum: l.h });
  }
  return groups.map((g) => g.items);
}

/** How well a slope lines the page up: the number of rows, and how far fragments sit from their row's centre. */
function alignment(lines: OcrLine[], slope: number): { count: number; ss: number } {
  const groups = groupFragments(lines, slope);
  let ss = 0;
  for (const g of groups) {
    const cs = g.map((l) => centreY(l, slope));
    const mean = cs.reduce((a, b) => a + b, 0) / cs.length;
    for (const c of cs) ss += (c - mean) ** 2;
  }
  return { count: groups.length, ss };
}

/**
 * The tilt of the page: a crooked photo splits one printed line into several rows, a straight one does not.
 * Many slopes give the same row count (the grouping tolerance is wide), so among those the one that centres the
 * fragments best wins, then it is fine-tuned. A tiny improvement is not trusted: the page is treated as straight.
 */
export function estimateSlope(lines: OcrLine[]): number {
  if (lines.length < 6) return 0;
  const base = alignment(lines, 0);
  const better = (a: { count: number; ss: number }, b: { count: number; ss: number }) =>
    a.count < b.count || (a.count === b.count && a.ss < b.ss * 0.98);

  let best = { slope: 0, ...base };
  for (let step = 1; step <= 40; step++) {
    for (const sign of [1, -1]) {
      const slope = sign * step * 0.004; // up to +-0.16
      const a = alignment(lines, slope);
      if (better(a, best)) best = { slope, ...a };
    }
  }
  // Fine-tune around the best coarse slope.
  const centre = best.slope;
  for (let k = -4; k <= 4; k++) {
    const slope = centre + k * 0.001;
    const a = alignment(lines, slope);
    if (better(a, best)) best = { slope, ...a };
  }
  const clearlyBetter = best.count <= base.count * 0.97 || (best.count === base.count && best.ss <= base.ss * 0.5);
  return clearlyBetter ? best.slope : 0;
}

function makeRow(frags: OcrLine[], slope: number): Row {
  const byX = [...frags].sort((a, b) => a.x - b.x);
  // A second-language caption must not make a clear English row look doubtful: judge digits and Latin text.
  const key = byX.filter((l) => /[0-9A-Za-z٠-٩]/.test(l.text));
  const conf = Math.min(...(key.length ? key : byX).map((l) => l.confidence));
  return {
    frags: byX,
    text: byX.map((l) => l.text.trim()).join('  '),
    confidence: conf,
    yc: byX.reduce((s, l) => s + centreY(l, slope), 0) / byX.length,
    h: byX.reduce((s, l) => s + l.h, 0) / byX.length,
    x0: Math.min(...byX.map((l) => l.x)),
    x1: Math.max(...byX.map((l) => l.x + l.w)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading amounts out of text
// ---------------------------------------------------------------------------------------------------------------

const NUM_TOKEN = /^[-(]?\d[\d.,]*\)?-?$/;
const isDecimal = (raw: string) => /[.,]\d{2}$/.test(raw);

function stripCurrency(t: string): string {
  return t
    .replace(/^(egp|le|l\.e\.?|usd|eur|gbp|sar|aed|\$|€|£)/i, '')
    .replace(/(egp|le|l\.e\.?|ج\.?م\.?|\$|€|£)$/i, '');
}

interface Amounts {
  text: string; // row text without the amount tokens
  values: Array<Minor | null>; // null = looked numeric but ambiguous/unreadable
  raw: string[];
}

function toValue(t: string): Minor | null {
  const neg = t.startsWith('(') || t.endsWith('-') || t.startsWith('-');
  const v = parseAmount(t.replace(/[()]/g, '').replace(/-$/, ''));
  return v === null ? null : neg ? -Math.abs(v) : v;
}

/**
 * Amounts at the end of a row. Arabic rows read right to left, so OCR often puts their prices first
 * ("75.00  كشري"); then the leading numbers are used, reordered to match left-to-right columns.
 */
function splitAmounts(rowText: string): Amounts {
  const tokens = normalizeDigits(rowText).split(/\s+/).filter(Boolean);
  const raw: string[] = [];
  const rest = [...tokens];
  while (rest.length) {
    const t = stripCurrency(rest[rest.length - 1]!);
    if (t === '') {
      rest.pop();
      continue;
    }
    if (!NUM_TOKEN.test(t)) break;
    raw.unshift(t);
    rest.pop();
  }
  // Arabic rows photographed right to left put the price first ("75.00  كشري") and the quantity last ("كشري  2").
  const onlySmallQty = raw.length === 1 && /^\d{1,3}$/.test(raw[0]!);
  if ((raw.length === 0 || onlySmallQty) && ARABIC.test(rowText)) {
    const body = onlySmallQty ? [...rest, raw[0]!] : rest;
    const lead: string[] = [];
    let i = 0;
    for (; i < body.length; i++) {
      const t = stripCurrency(body[i]!);
      if (t === '') continue;
      if (!NUM_TOKEN.test(t)) break;
      lead.push(t);
    }
    // A lone small number at the end is a quantity only when a real price (with decimals) leads the row;
    // "1  كشري كبير  75" is a left-to-right row whose 75 is the price.
    const swap = lead.length > 0 && (raw.length === 0 || lead.some(isDecimal));
    if (swap) {
      // visual right-to-left columns -> logical order (qty, price, total)
      return { text: body.slice(i).join(' ').trim(), raw: lead.reverse(), values: lead.map(toValue) };
    }
  }
  return { text: rest.join(' ').trim(), raw, values: raw.map(toValue) };
}

const hasDecimalAmount = (text: string) => splitAmounts(text).raw.some(isDecimal);

function isAmountOnly(text: string): boolean {
  const a = splitAmounts(text);
  return a.raw.length > 0 && a.text === '' && a.raw.some(isDecimal);
}

function isQtyOnly(text: string): boolean {
  return /^\d{1,2}([.,]0{1,3})?$/.test(normalizeDigits(text).trim());
}

function isHeaderish(text: string): boolean {
  const words = normalizeArabic(text).split(/[\s|:]+/).filter(Boolean);
  if (words.length === 0 || !words.every((w) => HEADER_WORDS.test(w))) return false;
  // "Total" and "Amount" alone are labels of a total row, not a column header.
  return !(words.length === 1 && /^(total|amount|الاجمالي)$/i.test(words[0]!));
}

function isHeaderRow(text: string): boolean {
  const words = normalizeArabic(text).split(/[\s|:]+/).filter(Boolean);
  const hits = words.filter((w) => HEADER_WORDS.test(w)).length;
  return words.length >= 2 && hits >= 2 && hits >= words.length - 1;
}

function classify(text: string): Kind {
  const t = normalizeArabic(text);
  // Table and check numbers ("Tbl 52/1 Chk 5453 Gst 2"): "Gst" there means guests, not tax.
  if (/\b(tbl|chk)\b/i.test(t)) return 'ignore';
  if (isHeaderRow(text)) return 'ignore';
  for (const [kind, re] of KEYWORDS) {
    if (!re.test(t)) continue;
    if ((kind === 'total' || kind === 'subtotal') && COUNT_ROW.test(t)) return 'ignore';
    return kind;
  }
  if (NON_ITEM.some((re) => re.test(text))) return 'ignore';
  return 'item';
}

/**
 * Prices and quantities that landed on rows of their own (tilt, curved paper, a column OCR read separately) are
 * attached to the nearest name within about one line. Nearest-first, each name takes at most one price.
 */
function attachOrphans(rows: Row[], from: number, slope: number): Row[] {
  const out = [...rows];
  const gone = new Set<number>();
  const near = (a: Row, b: Row) => Math.abs(a.yc - b.yc) / Math.max(a.h, b.h);

  const isLabel = (i: number) => {
    const r = out[i]!;
    return (
      i >= from && !gone.has(i) && LETTER.test(r.text) && splitAmounts(r.text).raw.length === 0 &&
      classify(r.text) !== 'ignore' && !isHeaderish(r.text)
    );
  };

  const pairs: Array<{ d: number; orphan: number; label: number }> = [];
  out.forEach((r, a) => {
    if (a < from || !isAmountOnly(r.text)) return;
    out.forEach((_, j) => {
      if (j === a || !isLabel(j)) return;
      const d = near(r, out[j]!);
      if (d <= 2.4) pairs.push({ d: d + (LATIN.test(out[j]!.text) ? 0 : 0.3), orphan: a, label: j });
    });
  });
  pairs.sort((p, q) => p.d - q.d);
  const takenLabel = new Set<number>();
  for (const p of pairs) {
    if (gone.has(p.orphan) || takenLabel.has(p.label)) continue;
    out[p.label] = makeRow([...out[p.label]!.frags, ...out[p.orphan]!.frags], slope);
    gone.add(p.orphan);
    takenLabel.add(p.label);
  }

  // Quantities on their own row: attach to the nearest priced name that sits to their right.
  const qtyPairs: Array<{ d: number; orphan: number; label: number }> = [];
  out.forEach((r, q) => {
    if (q < from || gone.has(q) || !isQtyOnly(r.text)) return;
    out.forEach((l, j) => {
      if (j === q || gone.has(j) || j < from) return;
      if (!hasDecimalAmount(l.text) || !LETTER.test(l.text) || l.x0 <= r.x0) return;
      const d = near(r, l);
      if (d <= 2.4) qtyPairs.push({ d, orphan: q, label: j });
    });
  });
  qtyPairs.sort((p, q) => p.d - q.d);
  const qtyTaken = new Set<number>();
  for (const p of qtyPairs) {
    if (gone.has(p.orphan) || qtyTaken.has(p.label)) continue;
    out[p.label] = makeRow([...out[p.label]!.frags, ...out[p.orphan]!.frags], slope);
    gone.add(p.orphan);
    qtyTaken.add(p.label);
  }
  return out.filter((_, i) => !gone.has(i));
}

// ---------------------------------------------------------------------------------------------------------------
// Header fields
// ---------------------------------------------------------------------------------------------------------------

function detectCurrency(rows: Row[]): { code: string; sure: boolean } {
  const all = rows.map((r) => r.text).join('\n');
  for (const [code, re] of CURRENCIES) if (re.test(all)) return { code, sure: true };
  if (/\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/.test(all)) return { code: 'USD', sure: false }; // a US address
  return { code: 'EGP', sure: false };
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
      // Day-first (Egypt) unless only month-first makes sense (06/25/21). Flag when both readings are possible.
      if (a <= 12 && b > 12) return mk(y, a, b, false);
      return mk(y, b, a, a <= 12 && b <= 12 && a !== b);
    }
    // 21-Sep-2024, 21 September 2024
    m = t.match(/\b(\d{1,2})[-\s/.,]*([A-Za-z]{3,9})[-\s/.,]*(\d{4}|\d{2})\b/);
    if (m && MONTHS[m[2]!.slice(0, 3).toLowerCase()]) {
      const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
      return mk(y, MONTHS[m[2]!.slice(0, 3).toLowerCase()]!, +m[1]!, false);
    }
    // Sep 21, 2024
    m = t.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
    if (m && MONTHS[m[1]!.slice(0, 3).toLowerCase()]) return mk(+m[3]!, MONTHS[m[1]!.slice(0, 3).toLowerCase()]!, +m[2]!, false);
  }
  return { iso: null, ambiguous: false };

  function mk(y: number, mo: number, d: number, ambiguous: boolean) {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    const valid = dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
    return valid ? { iso: dt.toISOString().slice(0, 10), ambiguous } : { iso: null, ambiguous: false };
  }
}

/** The store name: the largest text above the item table that is a name, not a label, number, address or date. */
function detectMerchant(rows: Row[], limit: number): Row | null {
  const top = rows.slice(0, Math.max(0, Math.min(limit, 10)));
  const candidates = top.filter((r) => {
    const t = r.text.trim();
    const letters = (t.match(/[A-Za-z؀-ۿ]/g) ?? []).length;
    if (letters < 3 || letters < t.replace(/\s/g, '').length * 0.5) return false; // mostly letters
    if (splitAmounts(t).raw.length > 0 || /\d{4,}/.test(normalizeDigits(t))) return false;
    if (classify(t) !== 'item' || NOT_A_STORE.test(normalizeArabic(t))) return false;
    if (/[:/]/.test(t)) return false; // "Shift: Morning", dates
    return true;
  });
  if (candidates.length === 0) return null;
  const tallest = Math.max(...candidates.map((c) => c.h));
  // Prefer the biggest text; among similar sizes, the first one.
  return candidates.find((c) => c.h >= tallest * 0.9) ?? candidates[0]!;
}

function parseQuantity(token: string): number | null {
  const q = Number(token.replace(',', '.'));
  return Number.isFinite(q) && q >= 1 && q <= 999 && Number.isInteger(q) ? q : null;
}

// ---------------------------------------------------------------------------------------------------------------
// 3 + 4. Table region, items, totals
// ---------------------------------------------------------------------------------------------------------------

export function parseWithSlope(clean: OcrLine[], slope: number): { receipt: Receipt; score: number } {
  let rows = groupFragments(clean, slope).map((g) => makeRow(g, slope));

  // Price style: if the receipt prints decimals (12.50), a bare integer at the end of a row is not a price
  // (a ZIP code, a guest count, a reference number). Receipts that print whole numbers keep accepting them.
  let withDecimals = 0;
  let wholeOnly = 0;
  for (const r of rows) {
    if (classify(r.text) === 'ignore') continue;
    const raws = splitAmounts(r.text).raw;
    const last = raws[raws.length - 1];
    if (!last) continue;
    if (isDecimal(last)) withDecimals += 1;
    else if (/^\d+$/.test(last)) wholeOnly += 1;
  }
  const decimalStyle = withDecimals >= 2 && withDecimals >= wholeOnly;
  const priceLike = (text: string) => (decimalStyle ? hasDecimalAmount(text) : splitAmounts(text).raw.length > 0);

  // Where the item table starts: after its column header, else at the first priced row.
  const firstPriced = rows.findIndex((r) => {
    const k = classify(r.text);
    return (k === 'item' || k === 'subtotal' || k === 'total') && priceLike(r.text) && !NON_ITEM.some((re) => re.test(r.text));
  });
  let headerIdx = -1;
  rows.forEach((r, i) => {
    if (firstPriced >= 0 && i >= firstPriced) return;
    const strong = isHeaderRow(r.text);
    const lone = isHeaderish(r.text) && i >= firstPriced - 6 && firstPriced >= 0;
    if (strong || lone) headerIdx = i;
  });
  const headerText = rows.slice(Math.max(0, headerIdx - 3), headerIdx + 1).map((r) => r.text).join(' ');
  const qtyColumn = headerIdx >= 0 && QTY_HEADER.test(normalizeArabic(headerText));
  const from = headerIdx >= 0 ? headerIdx + 1 : Math.max(0, firstPriced - 1);

  rows = attachOrphans(rows, from, slope);
  const classes = rows.map((r) => classify(r.text));

  const start = headerIdx >= 0 ? rows.findIndex((r, i) => i > headerIdx && !isHeaderish(r.text)) : from;
  const tableStart = start < 0 ? 0 : start;
  const endIdx = rows.findIndex((r, i) => {
    if (i < tableStart) return false;
    const k = classes[i]!;
    return ['subtotal', 'tax', 'service', 'tip', 'total', 'discount'].includes(k) && splitAmounts(r.text).raw.length > 0;
  });
  const tableEnd = endIdx < 0 ? rows.length : endIdx;

  const uncertain: string[] = [];
  const unparsed: string[] = [];
  const notes: string[] = [];
  const items: ReceiptItem[] = [];
  const totals: Partial<Record<Exclude<Kind, 'total' | 'ignore' | 'item' | 'discount'>, Minor>> = {};
  const totalCandidates: Array<{ value: Minor; strong: boolean; order: number }> = [];
  let discounts = 0;
  let nextId = 1;

  const date = detectDate(rows);
  if (date.iso === null || date.ambiguous) uncertain.push('date');

  const currency = detectCurrency(rows);
  if (!currency.sure) {
    uncertain.push('currency');
    notes.push(`No currency printed; assumed ${currency.code}.`);
  }

  const merchantRow = detectMerchant(rows, headerIdx >= 0 ? headerIdx : Math.max(firstPriced, 0));
  const merchant = merchantRow ? merchantRow.text.replace(/\s{2,}/g, ' ').trim() : null;
  if (!merchant) {
    uncertain.push('merchant');
    notes.push('No store name found on the receipt. Type it in.');
  } else if (merchantRow!.confidence < 0.6) uncertain.push('merchant');

  let lastWasItem = false;
  rows.forEach((row, order) => {
    const kind = classes[order]!;
    const inTable = order >= tableStart && order < tableEnd;
    const amt = splitAmounts(row.text);
    const lastRaw = amt.raw[amt.raw.length - 1] ?? '';
    const hasPrice = amt.raw.length > 0 && !(kind === 'item' && decimalStyle && !/[.,]\d{1,2}$/.test(lastRaw));

    if (kind === 'ignore' || row === merchantRow) {
      lastWasItem = false;
      return;
    }
    if (kind !== 'item') {
      lastWasItem = false;
      const v = amt.values[amt.values.length - 1];
      if (!hasPrice || v === null || v === undefined) return; // "TAX INVOICE": a title, not a charge
      const t = normalizeArabic(row.text);
      if (kind === 'discount') discounts += v > 0 ? -v : v;
      else if (kind === 'total') totalCandidates.push({ value: v, strong: STRONG_TOTAL.test(t), order });
      else if (totals[kind] === undefined || (kind === 'tax' && /total/i.test(t))) totals[kind] = v;
      if (row.confidence < 0.6) uncertain.push(kind);
      return;
    }
    if (!inTable) {
      lastWasItem = false; // address, staff, date, footer: never an item
      return;
    }

    // Item candidate
    if (!hasPrice) {
      const t = row.text.trim();
      const prev = items[items.length - 1];
      // A second-language caption or a wrapped description: no digits, directly after an item.
      if (lastWasItem && prev && /^[^\d]+$/.test(t) && t.length < 60 && LETTER.test(t)) {
        prev.description = `${prev.description} ${t}`;
        return;
      }
      if (/[A-Za-z؀-ۿ]{3,}/.test(t) && !/\d{2}[:/.-]\d{2}/.test(normalizeDigits(t))) unparsed.push(t);
      lastWasItem = false;
      return;
    }

    const flags: ItemFlag[] = [];
    let description = normalizeDigits(amt.text);
    let quantity = 1;
    let qtyKnown = false;

    // "2 x Juice", "Juice x2", "1.0  Ballston roll", "2 BEER"
    const lead = description.match(/^(\d{1,3})\s*[xX×*]\s*(.+)$/);
    const trail = description.match(/^(.+?)\s*[xX×*]\s*(\d{1,3})$/);
    const pos = description.match(/^(\d{1,3}(?:[.,]0{1,3})?)\s+(?=[A-Za-z؀-ۿ])(.+)$/);
    const posEnd = ARABIC.test(description) && !LATIN.test(description) ? description.match(/^(.+?)\s+(\d{1,3}(?:[.,]0{1,3})?)$/) : null;
    if (lead && parseQuantity(lead[1]!)) {
      quantity = parseQuantity(lead[1]!)!;
      description = lead[2]!;
      qtyKnown = true;
    } else if (trail && parseQuantity(trail[2]!)) {
      quantity = parseQuantity(trail[2]!)!;
      description = trail[1]!;
      qtyKnown = true;
    } else if (pos && parseQuantity(pos[1]!)) {
      quantity = parseQuantity(pos[1]!)!;
      description = pos[2]!;
      qtyKnown = true;
      if (quantity > 1 && !qtyColumn) flags.push('quantity-inferred');
    } else if (posEnd && parseQuantity(posEnd[2]!)) {
      quantity = parseQuantity(posEnd[2]!)!; // Arabic row: the quantity column ends up after the name
      description = posEnd[1]!;
      qtyKnown = true;
      if (quantity > 1) flags.push('quantity-inferred');
    }

    const values = amt.values;
    const lineTotal = values[values.length - 1] ?? null;
    let unitPrice: Minor | null = null;

    // Columns: [qty, unit price, line total], [unit price, line total] or [qty, line total].
    if (values.length >= 3 && !qtyKnown) {
      const q = parseQuantity(amt.raw[values.length - 3]!);
      const unit = values[values.length - 2];
      if (q && unit !== null && unit !== undefined && lineTotal !== null && unit * q === lineTotal) {
        quantity = q;
        unitPrice = unit;
        qtyKnown = true;
      }
    }
    if (unitPrice === null && values.length >= 2 && lineTotal !== null) {
      const prev = values[values.length - 2];
      const prevRaw = amt.raw[amt.raw.length - 2]!;
      if (!qtyKnown && /^\d{1,2}$/.test(prevRaw) && values.length === 2) {
        // "Pepsi 2 90.00": a bare small integer before the price is probably the quantity.
        quantity = +prevRaw;
        flags.push('quantity-inferred');
      } else if (prev !== null && prev !== undefined && prev * quantity === lineTotal) {
        unitPrice = prev;
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
    if (description === '' || !LETTER.test(description)) {
      if (LETTER.test(row.text)) unparsed.push(row.text);
      return;
    }
    // Other prices this line could be, from the recognizer's runner-up readings of any fragment on the row.
    const alts = new Set<number>();
    for (const frag of row.frags) {
      for (const alt of frag.alternates ?? []) {
        const swapped = row.frags.map((f) => (f === frag ? alt : f.text.trim())).join('  ');
        const vals = splitAmounts(swapped).values;
        const v = vals[vals.length - 1];
        if (v !== null && v !== undefined && v !== lineTotal) alts.add(v);
      }
    }
    const id = `i${nextId++}`;
    items.push({
      id, description, quantity, unitPrice, lineTotal, confidence: row.confidence, flags,
      ...(alts.size > 0 ? { altLineTotals: [...alts] } : {}),
    });
    for (const f of flags) {
      const field = f === 'price-unreadable' || f === 'unit-price-unknown' ? 'lineTotal' : f === 'quantity-inferred' ? 'quantity' : 'description';
      uncertain.push(`items.${id}.${field}`);
    }
    lastWasItem = true;
  });

  // Lines printed at 0.00 (an included cup, free bread) cannot be split between people. Say so, do not list them.
  const free = items.filter((i) => i.lineTotal === 0);
  if (free.length > 0) {
    for (const f of free) {
      items.splice(items.indexOf(f), 1);
      for (let k = uncertain.length - 1; k >= 0; k--) if (uncertain[k]!.startsWith(`items.${f.id}.`)) uncertain.splice(k, 1);
    }
    notes.push(`Included at no charge, not listed: ${free.map((f) => f.description.replace(/\s+/g, ' ')).join(', ')}.`);
  }

  // Several total rows: a strong label wins ("Total Due"), otherwise the last one printed.
  const strong = totalCandidates.filter((c) => c.strong);
  const chosen = (strong.length ? strong : totalCandidates).sort((a, b) => b.order - a.order)[0];
  let total: Minor | null = chosen ? chosen.value : null;

  const extras = (totals.tax ?? 0) + (totals.service ?? 0) + (totals.tip ?? 0);

  // ------------------------------------------------------------------------------------------------------------
  // 5. The receipt's own arithmetic
  // ------------------------------------------------------------------------------------------------------------
  const targets = itemTargets(totals, total, discounts);
  const sumOf = () => items.reduce((s, i) => s + (i.lineTotal ?? 0), 0);
  // exact: the items add up as read. repaired: they do once one explained fix is made. unknown: nothing to check against.
  let arith: 'exact' | 'repaired' | 'unknown' | 'broken' = targets.length === 0 ? 'unknown' : targets.includes(sumOf()) ? 'exact' : 'broken';

  if (targets.length > 0 && !targets.includes(sumOf())) {
    // (a) Per-unit prices: "2 x 15.00" printed without the line total. Exact arithmetic proves it.
    const perUnit = items.reduce((s, i) => s + (i.lineTotal ?? 0) * i.quantity, 0);
    if (items.some((i) => i.quantity > 1) && targets.includes(perUnit)) {
      for (const i of items) {
        if (i.quantity > 1 && i.lineTotal !== null) {
          i.unitPrice = i.lineTotal;
          i.lineTotal = i.lineTotal * i.quantity;
        }
      }
      notes.push('The prices on this receipt are per unit; they were multiplied by the quantity to match the subtotal.');
      arith = 'repaired';
    } else {
      // (b) One misread digit (6 read as 8, ...) or (c) one or two stray rows. Only when exactly one explanation
      // fits: if several do, guessing would send people a wrong number.
      const misreads = pickMisread(findMisreads(items, targets));
      const suspects = findSuspects(items, targets);
      if (misreads.length === 1 && suspects.length === 0) {
        const { item, value } = misreads[0]!;
        item.flags.push('maybe-misread');
        item.suggestedLineTotal = value;
        uncertain.push(`items.${item.id}.lineTotal`);
        arith = 'repaired';
      } else if (suspects.length === 1 && misreads.length === 0) {
        arith = 'repaired';
        for (const item of suspects[0]!) {
          item.flags.push('does-not-add-up');
          uncertain.push(`items.${item.id}.lineTotal`);
        }
      } else if (misreads.length + suspects.length > 0) {
        notes.push('The items do not add up to the subtotal and more than one price could be the cause. Check them against the receipt.');
      }
    }
  }

  let taxIncluded = false;
  if (total === null) {
    if (totals.subtotal !== undefined) {
      // No total line: the subtotal plus the printed charges is the amount to split. Said, flagged, editable.
      total = totals.subtotal + discounts + extras;
      notes.push(`No total line on the receipt; calculated ${(total / 100).toFixed(2)} from the subtotal and charges.`);
    } else {
      notes.push('No total on the receipt to check the items against.');
    }
    uncertain.push('total');
  } else if (totals.tax || totals.service) {
    // Prove, don't assume: if items alone already equal the printed total, tax/service are inclusive.
    const withTip = sumOf() + discounts + (totals.tip ?? 0);
    if (withTip + (totals.tax ?? 0) + (totals.service ?? 0) !== total && withTip === total) {
      taxIncluded = true;
      notes.push('Tax and service appear to be included in the item prices.');
    }
  }

  // Prices the scanner saw inside the table but could not tie to a name.
  const sum = sumOf();
  const target = targets[0];
  if (target !== undefined && sum < target) {
    const loose = rows
      .map((r, i) => ({ r, i }))
      .filter(({ r, i }) => i >= tableStart && i < tableEnd && classes[i] === 'item' && isAmountOnly(r.text))
      .map(({ r }) => splitAmounts(r.text).values[0]);
    if (loose.some((v) => v === target - sum)) {
      notes.push(`A price of ${((target - sum) / 100).toFixed(2)} on the receipt was not matched to any item. Add the missing item.`);
    }
  }

  const receipt: Receipt = {
    merchant,
    date: date.iso,
    currency: currency.code,
    items,
    discounts,
    subtotal: totals.subtotal ?? null,
    tax: totals.tax ?? null,
    service: totals.service ?? null,
    tip: totals.tip ?? null,
    total,
    taxIncluded,
    uncertain,
    unparsed: unparsed.slice(0, 8),
    notes,
  };

  // How believable this reading is. Arithmetic that works out is strong evidence that prices were paired with the
  // right names, so it is rewarded. A receipt whose printed numbers genuinely do not add up is not punished: that
  // would let a wrong tilt that merely loses the totals outrank the honest reading.
  const bonus = { exact: 100, repaired: 40, unknown: 0, broken: 0 }[arith];
  // Only arithmetic that works out can lift a candidate above the geometrically best tilt. Nothing else counts:
  // item counts, leftover rows or flagged prices would let a wrong tilt that loses information look "cleaner".
  return { receipt, score: bonus };
}

/**
 * Tilts implied by pairs of fragments that sit on one printed line. Every row votes for the true tilt with every
 * pair of its columns (qty-name-price), while the alternative "prices paired with the row below" tilts differ per
 * column pair and do not pile up. Works for mixtures of merged and separate fragments too.
 */
function pairSlopePeaks(lines: OcrLine[]): number[] {
  const BIN = 0.002;
  const votes = new Map<number, { n: number; sum: number }>();
  const pts = lines.map((l) => ({ x: l.x + l.w / 2, y: l.y + l.h / 2 }));
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j]!.x - pts[i]!.x;
      if (Math.abs(dx) < 0.15) continue;
      const dy = pts[j]!.y - pts[i]!.y;
      const slope = dy / dx;
      if (Math.abs(dy) > 0.06 || Math.abs(slope) > 0.12) continue;
      const bin = Math.round(slope / BIN);
      const v = votes.get(bin) ?? { n: 0, sum: 0 };
      v.n += 1;
      v.sum += slope;
      votes.set(bin, v);
    }
  }
  if (votes.size === 0) return [];
  const smooth = (b: number) => (votes.get(b - 1)?.n ?? 0) + 2 * (votes.get(b)?.n ?? 0) + (votes.get(b + 1)?.n ?? 0);
  const scored = [...votes.keys()].map((b) => ({ b, score: smooth(b) })).sort((a, c) => c.score - a.score);
  const peaks: Array<{ b: number; score: number }> = [];
  for (const c of scored) {
    if (c.score < scored[0]!.score * 0.5) break;
    if (peaks.every((p) => Math.abs(p.b - c.b) > 3)) peaks.push(c);
    if (peaks.length === 3) break;
  }
  return peaks.map((p) => {
    let n = 0;
    let sum = 0;
    for (let b = p.b - 2; b <= p.b + 2; b++) {
      const v = votes.get(b);
      if (v) {
        n += v.n;
        sum += v.sum;
      }
    }
    return n ? sum / n : p.b * BIN;
  });
}

/**
 * Plausible page tilts: the best by row count, the strongest by pair votes, and straight. A crooked photo can look
 * equally tidy when every price is paired with the row above or below, so geometry alone cannot always decide:
 * each candidate is parsed and the receipt's arithmetic chooses (ties keep the first).
 */
export function candidateSlopes(lines: OcrLine[]): number[] {
  if (lines.length < 6) return [0];
  const all = [estimateSlope(lines), ...pairSlopePeaks(lines), 0].filter((s) => Math.abs(s) <= 0.12);
  // Drop near-duplicates, keeping the first of each.
  return all.filter((s, i) => all.findIndex((t) => Math.abs(t - s) < 0.003) === i);
}

/** Turn OCR lines into a draft receipt. See the notes at the top of this file for the pipeline. */
export function parseReceipt(lines: OcrLine[]): Receipt {
  const clean = lines.filter((l) => l.text.trim().length > 0);
  let best: { receipt: Receipt; score: number } | null = null;
  for (const slope of candidateSlopes(clean)) {
    const attempt = parseWithSlope(clean, slope);
    if (!best || attempt.score > best.score + 1e-9) best = attempt; // ties keep the geometrically best tilt
  }
  return best!.receipt;
}

/** What the items should add up to: the printed subtotal, else the total minus its charges. */
function itemTargets(
  totals: { subtotal?: Minor; tax?: Minor; service?: Minor; tip?: Minor },
  total: Minor | null,
  discounts: Minor,
): Minor[] {
  if (totals.subtotal !== undefined) return [totals.subtotal];
  if (total === null) return [];
  const extras = (totals.tax ?? 0) + (totals.service ?? 0) + (totals.tip ?? 0);
  return [total - extras - discounts, total - (totals.tip ?? 0) - discounts];
}

// Digits OCR commonly confuses, in a printed price.
const CONFUSABLE: Record<string, string[]> = {
  '0': ['8', '6'],
  '8': ['0', '6', '3'],
  '6': ['8', '5', '0'],
  '1': ['7'],
  '7': ['1'],
  '5': ['6', '3'],
  '3': ['8', '5'],
  '9': ['4', '8'],
  '4': ['9'],
};

/**
 * Every way a single digit of a single price could have been misread that makes the items match the printed subtotal.
 * Used only when there is exactly one such way and no other explanation: then it is offered as a one-tap suggestion.
 */
function findMisreads(items: ReceiptItem[], targets: Minor[]): Array<{ item: ReceiptItem; value: Minor }> {
  const sum = items.reduce((s, i) => s + (i.lineTotal ?? 0), 0);
  const found: Array<{ item: ReceiptItem; value: Minor }> = [];

  // First choice: the recognizer's own runner-up readings. If one of them makes the items add up, that is evidence
  // from the scanner itself, far stronger than a guess about which digits look alike.
  const fromAlternates: Array<{ item: ReceiptItem; value: Minor }> = [];
  for (const item of items) {
    if (item.lineTotal === null) continue;
    for (const alt of item.altLineTotals ?? []) {
      if (alt > 0 && alt !== item.lineTotal && targets.includes(sum - item.lineTotal + alt)) fromAlternates.push({ item, value: alt });
    }
  }
  if (fromAlternates.length > 0) return fromAlternates;

  for (const item of items) {
    if (item.lineTotal === null || item.lineTotal <= 0) continue;
    const digits = String(item.lineTotal).split('');
    digits.forEach((d, pos) => {
      for (const alt of CONFUSABLE[d] ?? []) {
        const candidate = Number([...digits.slice(0, pos), alt, ...digits.slice(pos + 1)].join(''));
        if (candidate > 0 && targets.includes(sum - item.lineTotal! + candidate)) {
          if (!found.some((f) => f.item === item && f.value === candidate)) found.push({ item, value: candidate });
        }
      }
    });
  }
  return found;
}

/**
 * Several prices could each be the misread one. If the scanner was clearly less sure of exactly one of those lines,
 * that line is the likely culprit; otherwise (or if one line has several candidate values) there is no safe pick.
 */
function pickMisread(found: Array<{ item: ReceiptItem; value: Minor }>): Array<{ item: ReceiptItem; value: Minor }> {
  const byItem = new Map<ReceiptItem, Array<{ item: ReceiptItem; value: Minor }>>();
  for (const f of found) byItem.set(f.item, [...(byItem.get(f.item) ?? []), f]);
  const lines = [...byItem.entries()];
  if (lines.length <= 1) return found.length === 1 ? found : [];
  const ranked = lines.sort((a, b) => a[0].confidence - b[0].confidence);
  const [first, second] = ranked;
  if (first![1].length === 1 && second![0].confidence - first![0].confidence >= 0.08) return first![1];
  return found; // several equally plausible lines: let the caller treat it as ambiguous
}

/**
 * The smallest sets (one or two rows) whose removal makes the items match the printed subtotal. Several sets, or
 * none, mean there is no safe answer. A unique one flags those rows (never removes them) so the person decides.
 */
function findSuspects(items: ReceiptItem[], targets: Minor[]): ReceiptItem[][] {
  const priced = items.filter((i) => i.lineTotal !== null);
  const sum = priced.reduce((s, i) => s + (i.lineTotal as number), 0);
  if (priced.length > 40) return [];
  const solutions: number[][] = [];
  for (let i = 0; i < priced.length; i++) {
    if (targets.includes(sum - (priced[i]!.lineTotal as number))) solutions.push([i]);
    for (let j = i + 1; j < priced.length; j++) {
      if (targets.includes(sum - (priced[i]!.lineTotal as number) - (priced[j]!.lineTotal as number))) solutions.push([i, j]);
    }
  }
  if (solutions.length === 0) return [];
  const size = Math.min(...solutions.map((s) => s.length));
  return solutions.filter((s) => s.length === size).map((s) => s.map((idx) => priced[idx]!));
}
