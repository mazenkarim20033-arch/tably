import { normalizeDigits, parseAmount, type Minor } from './money';
import type { ItemFlag, OcrLine, Receipt, ReceiptItem } from './receipt';

/**
 * Receipt parser: OCR lines in, a draft receipt out.
 *
 * Principles: read only what is printed; never invent a price; when something is inferred (a calculated total,
 * a guessed quantity) flag it and say so in `notes`; list rows that could not be used in `unparsed`.
 *
 * Pipeline: group fragments into visual rows -> join labels with amounts printed on the next line -> classify
 * each row (item / subtotal / tax / service / tip / discount / total / ignore) -> read items -> choose totals ->
 * fill a missing total from the subtotal -> flag rows that break the arithmetic.
 */

interface Row {
  text: string;
  confidence: number;
  y: number;
  /** average text height (normalized); store names are usually the largest text */
  h: number;
}

type Kind = 'subtotal' | 'tax' | 'service' | 'tip' | 'total' | 'discount' | 'ignore' | 'item';

const LETTER = /[A-Za-z؀-ۿ]/;
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
    /\b(cash|change|visa|master\s*card|mastercard|card|paid|tendered|receipt|invoice|order|table|cashier|casheir|cashir|tel|phone|mobile|thank|thanks|www|shift|server|waiter|guests?|covers?|pax|customer|ref|reference|terminal|auth|approval|tax\s*(id|no|reg))\b|نقد|الباقي|فيزا|شكرا|رقم|هاتف|كاشير|فاتوره|طاوله|العميل/i,
  ],
];

// "Total Qty: 4", "No. of items 3": counts, not money.
const COUNT_ROW = /\b(total\s*(qty|quantity|items?|pieces|pcs)|no\.?\s*of\s*items|items?\s*count|qty|quantity)\b|عدد الاصناف|الكميه/i;

// Strong total labels beat a plain "Total" when several total rows exist.
const STRONG_TOTAL = /\b(grand\s*total|total\s*due|amount\s*due|net\s*total|to\s*pay|balance\s*due)\b|الاجمالي المستحق|المطلوب|الصافي/i;

// Column headers of the item table ("Qty  Description  Price  Total").
const HEADER_WORDS = /^(qty|quantity|description|desc|item|items|price|unit|amount|total|value|rate|#|no\.?|الكميه|الصنف|البيان|السعر|القيمه|الاجمالي|الوحده)$/i;

// Words that sit at the top of receipts but are not the store's name.
const NOT_A_STORE = /\b(take\s*-?\s*away|takeaway|dine\s*-?\s*in|delivery|pick\s*-?\s*up|welcome|receipt|invoice|copy|duplicate|original|bill|check|order|table|cash|shift|morning|evening|night|cashier|casheir|customer|date|time|tax|vat|branch|tel|phone)\b|فاتوره|سفري|توصيل|صاله|اهلا/i;

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
    if (last) {
      // Compare with the group's average centre so slightly tilted photos still group correctly.
      const centre = last.reduce((s, g) => s + g.y + g.h / 2, 0) / last.length;
      const height = last.reduce((s, g) => s + g.h, 0) / last.length;
      if (Math.abs(l.y + l.h / 2 - centre) < Math.min(l.h, height) * 0.6) {
        last.push(l);
        continue;
      }
    }
    groups.push([l]);
  }
  return groups.map((g) => {
    const byX = [...g].sort((a, b) => a.x - b.x);
    return {
      text: byX.map((l) => l.text.trim()).join('  '),
      confidence: Math.min(...g.map((l) => l.confidence)),
      y: g[0]!.y,
      h: g.reduce((s, l) => s + l.h, 0) / g.length,
    };
  });
}

const NUM_TOKEN = /^[-(]?\d[\d.,]*\)?-?$/;

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
  // A lone small whole number at the right of an Arabic row is its quantity column, not a price.
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
    if (lead.length > 0) {
      // visual right-to-left columns -> logical order (qty, price, total)
      return { text: body.slice(i).join(' ').trim(), raw: lead.reverse(), values: lead.map(toValue) };
    }
  }
  return { text: rest.join(' ').trim(), raw, values: raw.map(toValue) };
}

const isAmountOnly = (text: string) => {
  const a = splitAmounts(text);
  return a.raw.length > 0 && a.text === '';
};

function isHeaderRow(text: string): boolean {
  const words = normalizeArabic(text).split(/[\s|:]+/).filter(Boolean);
  if (words.length < 2) return false;
  const hits = words.filter((w) => HEADER_WORDS.test(w)).length;
  return hits >= 2 && hits >= words.length - 1;
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
 * Some receipts print a label and its amount on separate lines ("TOTAL" then "250.00"), and on tilted photos the
 * price column can drift onto its own row. Join a text row with an amount-only row right below it when the amount
 * looks like money (has decimals) or the label is a totals keyword.
 */
function joinSplitRows(rows: Row[]): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const next = rows[i + 1];
    const label = splitAmounts(row.text);
    if (next && label.raw.length === 0 && LETTER.test(row.text) && isAmountOnly(next.text)) {
      const close = next.y - row.y < Math.max(row.h, next.h) * 2.2;
      const money = splitAmounts(next.text).raw.some((r) => /[.,]\d{2}$/.test(r));
      const kind = classify(row.text);
      if (close && (money || (kind !== 'item' && kind !== 'ignore'))) {
        out.push({ ...row, text: `${row.text}  ${next.text}`, confidence: Math.min(row.confidence, next.confidence) });
        i += 1;
        continue;
      }
    }
    out.push(row);
  }
  return out;
}

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
  }
  return { iso: null, ambiguous: false };

  function mk(y: number, mo: number, d: number, ambiguous: boolean) {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    const valid = dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
    return valid ? { iso: dt.toISOString().slice(0, 10), ambiguous } : { iso: null, ambiguous: false };
  }
}

/** The store name: the largest text near the top that is a name, not a label, number, address or date. */
function detectMerchant(rows: Row[]): Row | null {
  const firstItem = rows.findIndex((r) => classify(r.text) === 'item' && splitAmounts(r.text).raw.length > 0);
  const top = rows.slice(0, Math.min(firstItem >= 0 ? firstItem : 10, 10));
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

export function parseReceipt(lines: OcrLine[]): Receipt {
  const rows = joinSplitRows(groupRows(lines));
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

  const merchantRow = detectMerchant(rows);
  const merchant = merchantRow ? merchantRow.text.replace(/\s{2,}/g, ' ').trim() : null;
  if (!merchant) {
    uncertain.push('merchant');
    notes.push('No store name found on the receipt. Type it in.');
  } else if (merchantRow!.confidence < 0.6) uncertain.push('merchant');

  // If the receipt prints prices with decimals (12.50), a bare integer at the end of a row is not a price
  // (a ZIP code, a guest count, a reference number). Receipts that print whole numbers keep accepting them.
  let withDecimals = 0;
  let wholeOnly = 0;
  for (const r of rows) {
    if (classify(r.text) === 'ignore') continue;
    const raws = splitAmounts(r.text).raw;
    const last = raws[raws.length - 1];
    if (!last) continue;
    if (/[.,]\d{2}$/.test(last)) withDecimals += 1;
    else if (/^\d+$/.test(last)) wholeOnly += 1;
  }
  const decimalStyle = withDecimals >= 2 && withDecimals >= wholeOnly;

  let lastWasItem = false;
  rows.forEach((row, order) => {
    const kind = classify(row.text);
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
      if (!hasPrice || v === null || v === undefined) {
        unparsed.push(row.text);
        return;
      }
      const t = normalizeArabic(row.text);
      if (kind === 'discount') discounts += v > 0 ? -v : v;
      else if (kind === 'total') totalCandidates.push({ value: v, strong: STRONG_TOTAL.test(t), order });
      else if (totals[kind] === undefined || (kind === 'tax' && /total/i.test(t))) totals[kind] = v;
      if (row.confidence < 0.6) uncertain.push(kind);
      return;
    }

    // Item candidate
    if (!hasPrice) {
      const t = row.text.trim();
      const prev = items[items.length - 1];
      // A wrapped description: letters only, directly after an item, no digits.
      if (lastWasItem && prev && /^[^\d]+$/.test(t) && t.length < 40 && LETTER.test(t)) {
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
    const posEnd = ARABIC.test(description) ? description.match(/^(.+?)\s+(\d{1,3}(?:[.,]0{1,3})?)$/) : null;
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
      if (quantity > 1) flags.push('quantity-inferred');
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
    const id = `i${nextId++}`;
    items.push({ id, description, quantity, unitPrice, lineTotal, confidence: row.confidence, flags });
    for (const f of flags) {
      const field = f === 'price-unreadable' || f === 'unit-price-unknown' ? 'lineTotal' : f === 'quantity-inferred' ? 'quantity' : 'description';
      uncertain.push(`items.${id}.${field}`);
    }
    lastWasItem = true;
  });

  // Several total rows: a strong label wins ("Total Due"), otherwise the last one printed.
  const strong = totalCandidates.filter((c) => c.strong);
  const chosen = (strong.length ? strong : totalCandidates).sort((a, b) => b.order - a.order)[0];
  let total: Minor | null = chosen ? chosen.value : null;

  const itemsSum = items.reduce((s, i) => s + (i.lineTotal ?? 0), 0);
  const extras = (totals.tax ?? 0) + (totals.service ?? 0) + (totals.tip ?? 0);

  flagSuspects(items, uncertain, totals, total, discounts);

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
    const withTip = itemsSum + discounts + (totals.tip ?? 0);
    if (withTip + (totals.tax ?? 0) + (totals.service ?? 0) !== total && withTip === total) {
      taxIncluded = true;
      notes.push('Tax and service appear to be included in the item prices.');
    }
  }

  return {
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
    unparsed,
    notes,
  };
}

/**
 * If the items do not add up to the printed subtotal (or the total minus tax/service/tip), look for one or two
 * rows whose removal fixes it exactly. Only when that answer is unique are those rows flagged, never removed:
 * the person decides. This catches stray rows (a reference number, a stray digit) that the row rules missed.
 */
function flagSuspects(
  items: ReceiptItem[],
  uncertain: string[],
  totals: { subtotal?: Minor; tax?: Minor; service?: Minor; tip?: Minor },
  total: Minor | null,
  discounts: Minor,
): void {
  const priced = items.filter((i) => i.lineTotal !== null);
  const sum = priced.reduce((s, i) => s + (i.lineTotal as number), 0);
  const targets: number[] = [];
  if (totals.subtotal !== undefined) targets.push(totals.subtotal);
  else if (total !== null) {
    const extras = (totals.tax ?? 0) + (totals.service ?? 0) + (totals.tip ?? 0);
    targets.push(total - extras - discounts, total - (totals.tip ?? 0) - discounts);
  }
  if (targets.length === 0 || targets.includes(sum) || priced.length > 40) return;

  const solutions: number[][] = [];
  for (let i = 0; i < priced.length; i++) {
    if (targets.includes(sum - (priced[i]!.lineTotal as number))) solutions.push([i]);
    for (let j = i + 1; j < priced.length; j++) {
      if (targets.includes(sum - (priced[i]!.lineTotal as number) - (priced[j]!.lineTotal as number))) solutions.push([i, j]);
    }
  }
  const smallest = solutions.filter((s) => s.length === Math.min(...solutions.map((x) => x.length)));
  if (smallest.length !== 1) return; // no answer, or several: do not guess
  for (const idx of smallest[0]!) {
    const item = priced[idx]!;
    item.flags.push('does-not-add-up');
    uncertain.push(`items.${item.id}.lineTotal`);
  }
}
