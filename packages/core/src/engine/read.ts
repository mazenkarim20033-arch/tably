import { type Minor, normalizeDigits, parseAmount } from '../money';
import type { ItemFlag, OcrLine, Receipt, ReceiptItem } from '../receipt';
import { detectCurrency, detectDate, detectMerchant, normalizeArabic } from '../parseReceipt';
import { digitVariants, dropFreeLines, mark, settleArithmetic, type Marks, type Settled } from '../arithmetic';
import type { Layout, Line, Token } from './layout';

/**
 * Stages D (meaning) and E (pairing) on top of the reconstructed layout.
 *
 * Every rule here is a general property of printed receipts, not of one shop:
 *  - A line's role comes from its words, checked from the most specific meaning to the least ("Total Qty" is a count
 *    before it is a total; "Tax Total" is tax). Punctuation inside words is ignored ("V.A.T" is "vat").
 *  - Labels printed above their values (a summary box) pair with the value under them, by horizontal overlap.
 *  - In the item table, the line total is the amount column whose values are quantity x another column, else the
 *    column at the end of the reading direction (right for English, left for Arabic).
 *  - An item starts at the edge where item names start; an indented line continues the item above; a line in another
 *    script under an item is its caption; "2 @ 15.00" under an item gives that item's quantity and unit price.
 *  - Several readings are built (how loose text lines attach, which column is the line total) and the one whose
 *    numbers add up wins. Readings that add up equally but disagree mark the disputed items for review.
 */

type Role = 'header' | 'count' | 'meta' | 'subtotal' | 'tax' | 'service' | 'tip' | 'discount' | 'payment' | 'total' | 'text';
type MoneyRole = 'subtotal' | 'tax' | 'service' | 'tip' | 'discount' | 'total';
const MONEY: Role[] = ['subtotal', 'tax', 'service', 'tip', 'discount', 'total'];

const HEADER_WORD = /^(qty|quantity|description|desc|item|items|price|unit|u ?price|amount|total|value|rate|no|الكميه|الصنف|البيان|السعر|القيمه|الاجمالي|الوحده)$/;
const STRONG_META = /\b(tbl|chk|table no|order no|tax (invoice|id|no|reg|number|registration)|invoice|inv|vat (no|reg|number))\b|فاتوره|رقم/;
const COUNT = /\b(total (qty|quantity|items?|pcs|pieces)|no of items|items? count|qty total|min(imum)?( charge)?|total min|covers?|guests?|pax)\b|عدد الاصناف|الحد الادني/;
const SUBTOTAL = /\b(sub ?total|net amount|items? total|total before tax|net sales)\b|^items$|المجموع الفرعي|الاجمالي الفرعي|اجمالي فرعي/;
const CHARGES: Array<[MoneyRole, RegExp]> = [
  ['tax', /\b(vat|tax|taxes|gst|tva)\b|ضريبه|القيمه المضافه/],
  ['service', /\b(service|svc|srv|serv)\b|خدمه/],
  ['tip', /\b(tip|tips|gratuity)\b|بقشيش|اكراميه/],
  ['discount', /\b(discount|disc|promo|offer|coupon|savings?)\b|خصم/],
];
const PAYMENT = /\b(cash|change|visa|master ?card|card|paid|tendered|credit|debit|instapay|wallet)\b|نقدي|نقدا|الباقي|فيزا|المدفوع/;
const TOTAL = /\b(total|grand total|total due|amount due|to pay|balance due|net total)\b|الاجمالي|اجمالي|المطلوب|المجموع|الصافي/;
const STRONG_TOTAL = /\b(grand total|total due|amount due|to pay|balance due|net total)\b|المطلوب|الصافي/;
const META = /\b(table|order|receipt|cashier|casheir|cashir|waiter|server|staff|tel|phone|mobile|hotline|www|website|thank|thanks|visiting|come again|shift|terminal|ref|auth|date|time|follow us|welcome|branch|customer|takeaway|take away|dine in|delivery)\b|شكرا|هاتف|طاوله|كاشير|العميل|الموظف|لزيارتكم/;
// Lines that are never items whatever number they carry: phone numbers, web addresses, times, street addresses.
const NON_ITEM = [/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/, /\b0\d{9,10}\b/, /\b(www\.|https?:)|\.(com|net|org|eg)\b/i, /\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm|a|p)?(?!\w)/i, /\b[A-Z]{2}\s+\d{5}\b/, /\b(street|st\.|road|rd\.|avenue|ave\.|drive)\b/i, /شارع|ميدان/];
const CURRENCY_WORD = /^(egp|le|l\.e\.?|usd|eur|gbp|sar|aed|\$|€|£|ج\.?م\.?|جنيه)$/i;
const PERCENT = /^\(?\d{1,2}([.,]\d+)?\s?%\)?:?$/;
const TIMES = /^[x×*]$/i;
const ARABIC = /[؀-ۿ]/;
const LATIN = /[A-Za-z]/;
const LETTER = /[A-Za-z؀-ۿ]/;

/** Lower case, Arabic letter forms unified, dots inside words dropped ("v.a.t" -> "vat"), other punctuation spaced. */
export function normalizeLabel(s: string): string {
  return normalizeArabic(s.toLowerCase())
    .replace(/(\p{L})\.(?=\p{L})/gu, '$1')
    .replace(/[^\p{L}\p{N}%\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function roleOf(rawText: string, hasAmount: boolean): Role {
  const t = normalizeLabel(rawText);
  if (t === '') return 'text';
  const words = t.split(' ');
  if (!hasAmount && words.length >= 2 && words.filter((w) => HEADER_WORD.test(w)).length >= Math.max(2, words.length - 1)) return 'header';
  if (STRONG_META.test(t)) return 'meta';
  if (COUNT.test(t)) return 'count';
  if (SUBTOTAL.test(t)) return 'subtotal';
  // Several charge words on one line: the first one printed names it ("Service tax 12%" is a service charge).
  let best: { role: MoneyRole; at: number } | null = null;
  for (const [role, re] of CHARGES) {
    const m = re.exec(t);
    if (m && (!best || m.index < best.at)) best = { role, at: m.index };
  }
  if (best) return best.role;
  if (PAYMENT.test(t)) return 'payment';
  if (TOTAL.test(t)) return 'total';
  if (META.test(t) || NON_ITEM.some((re) => re.test(rawText))) return 'meta';
  return 'text';
}

const isQtyDecimal = (t: string) => /^\d{1,2}[.,]0{1,2}$/.test(normalizeDigits(t));

interface LineInfo {
  i: number;
  line: Line;
  amounts: Token[];
  ints: Token[];
  /** tokens that can be part of a name (words and numbers inside words) */
  nameTokens: Token[];
  role: Role;
  script: 'latin' | 'arabic' | 'none';
  /** left and right edge of the name tokens */
  x0: number;
  x1: number;
  letters: number;
}

function describeLines(layout: Layout, decimalStyle: boolean): LineInfo[] {
  return layout.lines.map((line, i) => {
    const amounts = line.tokens.filter((t) => t.kind === 'amount' || (!decimalStyle && t.kind === 'integer' && (t.value ?? 0) >= 5));
    const ints = line.tokens.filter((t) => t.kind === 'integer' || isQtyDecimal(t.text));
    const nameTokens = line.tokens.filter((t) => !amounts.includes(t) && !CURRENCY_WORD.test(t.text) && !PERCENT.test(t.text));
    const words = nameTokens.filter((t) => LETTER.test(t.text));
    const wordText = words.map((t) => t.text).join(' ');
    const arabic = (wordText.match(/[؀-ۿ]/g) ?? []).length;
    const latin = (wordText.match(/[A-Za-z]/g) ?? []).length;
    const labelText = line.tokens.filter((t) => !amounts.includes(t)).map((t) => t.text).join(' ');
    const named = words.length ? words : nameTokens;
    return {
      i, line, amounts, ints, nameTokens,
      role: roleOf(labelText, amounts.length > 0),
      script: arabic + latin === 0 ? 'none' : arabic > latin ? 'arabic' : 'latin',
      x0: named.length ? Math.min(...named.map((t) => t.x)) : Infinity,
      x1: named.length ? Math.max(...named.map((t) => t.x + t.w)) : -Infinity,
      letters: arabic + latin,
    };
  });
}

interface ItemRecord {
  lines: LineInfo[];
  price: Token | null;
  unit: Token | null;
  qty: number | null;
  qtySource: 'column' | 'detail' | 'pattern' | 'leading' | 'unit' | null;
  consumed: Set<Token>;
}

interface Reading {
  receipt: Receipt;
  arith: Settled['arith'];
  score: number;
}

/** One complete interpretation of the receipt, for one choice of the ambiguous decisions. */
function interpret(input: OcrLine[], layout: Layout, opts: { attach: 'indent' | 'previous'; totalColumn: number | null }): Reading {
  const decimalStyle = layout.tokens.filter((t) => t.kind === 'amount').length >= 2;
  const info = describeLines(layout, decimalStyle);
  const uncertain: string[] = [];
  const notes: string[] = [];
  const unparsed: string[] = [];
  const marks: Marks = { uncertain, reasons: {}, fieldChoices: {} };
  const rates: Partial<Record<'tax' | 'service', number>> = {};

  // ---- regions -------------------------------------------------------------------------------------------------
  const header = info.findIndex((l, k) => l.role === 'header' && info.slice(k + 1, k + 4).some((n) => n.role === 'text' && n.amounts.length > 0));
  const priced = (l: LineInfo) => l.role === 'text' && l.amounts.length > 0 && (l.letters > 0 || l.ints.length > 0);
  const first = info.findIndex((l, k) => k > header && priced(l));
  let end = info.length;
  if (first >= 0) {
    const stop = info.findIndex((l, k) => k > first && (MONEY.includes(l.role) || l.role === 'payment'));
    if (stop >= 0) end = stop;
  }
  let regionStart = first < 0 ? info.length : header >= 0 ? header + 1 : first;
  if (header < 0 && first > 0) {
    // No column header: the first item may begin on a text line above its priced line (a wrapped name). Such a line
    // starts further out than the priced line and sits right above it.
    const edge = (l: LineInfo) => (l.script === 'arabic' ? -l.x1 : l.x0);
    for (let k = first - 1; k >= Math.max(0, first - 2); k--) {
      const l = info[k]!;
      const below = info[k + 1]!;
      const close = below.line.v - l.line.v < layout.textHeight * 2.6;
      if (l.role !== 'text' || l.amounts.length > 0 || l.letters === 0 || !close || edge(l) > edge(info[first]!) - Math.max(0.015, layout.textHeight)) break;
      regionStart = k;
    }
  }
  const region = info.slice(regionStart, end);

  // Reading direction of the item names.
  const arabicNames = region.filter((l) => l.script === 'arabic' && l.amounts.length > 0).length;
  const latinNames = region.filter((l) => l.script === 'latin' && l.amounts.length > 0).length;
  const rtl = arabicNames > latinNames;
  const mainScript = rtl ? 'arabic' : 'latin';

  // ---- columns -------------------------------------------------------------------------------------------------
  const regionLines = new Set(region.map((l) => l.i));
  const amountCols = layout.columns
    .map((c, id) => ({ c, id, n: c.tokens.filter((t) => regionLines.has(lineIndexOf(layout, t))).length }))
    .filter((x) => x.c.role === 'amount' && x.n >= 2);
  // A number between two words of one name ("Fire roll 5 Pieces") is part of the name, never a quantity column.
  const insideName = (t: Token) => {
    const toks = layout.lines[lineIndexOf(layout, t)]!.tokens.filter((o) => o.obs === t.obs);
    const k = toks.indexOf(t);
    return k > 0 && k < toks.length - 1 && LETTER.test(toks[k - 1]!.text) && LETTER.test(toks[k + 1]!.text);
  };
  const qtyCol = layout.columns
    .map((c, id) => ({ c, id, n: c.tokens.filter((t) => regionLines.has(lineIndexOf(layout, t)) && (t.value ?? 99) < 100 && !insideName(t)).length }))
    .filter((x) => x.c.role === 'integer' && x.n >= 2)
    .sort((a, b) => b.n - a.n)[0]?.id ?? -1;
  let totalCol = opts.totalColumn;
  let unitCol = -1;
  if (totalCol === null && amountCols.length >= 2) {
    // The line total is the column that equals quantity x another column on most lines.
    let best = { col: -1, unit: -1, hits: 0 };
    for (const A of amountCols) {
      for (const B of amountCols) {
        if (A === B) continue;
        let hits = 0;
        for (const l of region) {
          const a = l.amounts.find((t) => t.column === A.id);
          const b = l.amounts.find((t) => t.column === B.id);
          if (!a || !b || a.value === null || b.value === null || b.value === 0) continue;
          const q = l.ints.find((t) => t.column === qtyCol)?.value ?? null;
          if (q ? a.value === q * b.value : a.value % b.value === 0 && a.value >= b.value) hits++;
        }
        if (hits > best.hits) best = { col: A.id, unit: B.id, hits };
      }
    }
    if (best.hits >= 2) {
      totalCol = best.col;
      unitCol = best.unit;
    }
  }
  if (totalCol === null && amountCols.length > 0) {
    // Otherwise the column at the end of the reading direction.
    const edge = (id: number) => median(layout.columns[id]!.tokens.map((t) => t.x + t.w / 2));
    totalCol = [...amountCols].sort((a, b) => (rtl ? edge(a.id) - edge(b.id) : edge(b.id) - edge(a.id)))[0]!.id;
  }
  const lineTotalOf = (l: LineInfo): Token | null => {
    if (l.amounts.length === 0) return null;
    const inCol = totalCol !== null ? l.amounts.find((t) => t.column === totalCol) : undefined;
    if (inCol) return inCol;
    const notUnit = l.amounts.filter((t) => unitCol < 0 || t.column !== unitCol);
    if (notUnit.length === 0) return null;
    // the amount at the end of the reading direction
    return rtl ? notUnit[0]! : notUnit[notUnit.length - 1]!;
  };

  // ---- item records --------------------------------------------------------------------------------------------
  const isDetail = (l: LineInfo) => {
    const toks = l.line.tokens;
    const k = toks.findIndex((t) => t.text === '@' || TIMES.test(t.text) || /^\d{1,3}[@x×]$/i.test(t.text));
    return k >= 0 && l.amounts.length === 1 && l.letters <= 1 && (totalCol === null || l.amounts[0]!.column !== totalCol) && l.ints.length >= 1;
  };
  // Where item names start (or end, right to left), as a line that may slant down the page.
  const edgeOf = (l: LineInfo) => (rtl ? l.x1 : l.x0);
  // Fitted through every line with words in the table; the fit follows the outermost edge, so indented lines
  // (continuations, captions) do not move it.
  const baseLines = region.filter((l) => l.letters > 0 && Number.isFinite(edgeOf(l)) && l.role === 'text');
  const base = fitEdge(baseLines.map((l) => [l.line.v, edgeOf(l)]));
  const indent = (l: LineInfo) => (rtl ? base(l.line.v) - edgeOf(l) : edgeOf(l) - base(l.line.v));
  const indentTol = Math.max(0.015, layout.textHeight);

  const records: ItemRecord[] = [];
  const newRecord = (l: LineInfo, price: Token | null): ItemRecord => ({ lines: [l], price, unit: null, qty: null, qtySource: null, consumed: new Set(price ? [price] : []) });
  const leftovers: LineInfo[] = [];
  for (const l of region) {
    if (l.role === 'meta' || l.role === 'count' || l.role === 'header') continue;
    const last = records[records.length - 1];
    if (isDetail(l)) {
      if (last) {
        last.lines.push(l);
        const q = l.ints.find((t) => !l.amounts.includes(t));
        if (q && q.value) {
          last.qty = q.value;
          last.qtySource = 'detail';
        }
        last.unit = l.amounts[0]!;
        for (const t of l.line.tokens) last.consumed.add(t);
      }
      continue;
    }
    const price = lineTotalOf(l);
    if (price) {
      const continues = last && last.price === null && (opts.attach === 'previous' || indent(l) > indentTol);
      if (continues) {
        last.lines.push(l);
        last.price = price;
        last.consumed.add(price);
      } else records.push(newRecord(l, price));
      const r = records[records.length - 1]!;
      const unit = unitCol >= 0 ? l.amounts.find((t) => t.column === unitCol) : undefined;
      if (unit) {
        r.unit = unit;
        r.consumed.add(unit);
      }
      for (const t of l.amounts) r.consumed.add(t);
      continue;
    }
    if (l.letters === 0) continue;
    // Text only: a caption or the rest of a wrapped name joins the item above; a line at the name edge starts one.
    const joinsAbove = last && (opts.attach === 'previous' || indent(l) > indentTol || (l.script !== mainScript && l.script !== 'none'));
    if (joinsAbove) last.lines.push(l);
    else if (opts.attach === 'indent') records.push(newRecord(l, null));
    else leftovers.push(l);
  }

  // ---- each record into an item --------------------------------------------------------------------------------
  const items: ReceiptItem[] = [];
  const qtyHeader = header >= 0 && /\b(qty|quantity)\b|الكميه/.test(normalizeLabel(info[header]!.line.text));
  let nextId = 1;
  for (const r of records) {
    const text = r.lines.map((l) => l.line.text).join(' ');
    if (!r.price || r.price.value === null) {
      if ((text.match(/[A-Za-z؀-ۿ]/g) ?? []).length >= 3) unparsed.push(text.trim());
      continue;
    }
    const flags: ItemFlag[] = [];
    const firstLine = r.lines[0]!;
    // Quantity: the quantity column, a "2 @ 15.00" line, "2 x Name" / "Name x2", or a bare leading number.
    const colQty = firstLine.ints.find((t) => t.column === qtyCol && qtyCol >= 0 && !r.consumed.has(t));
    if (r.qty === null && colQty) {
      r.qty = Number(normalizeDigits(colQty.text).replace(',', '.'));
      r.qtySource = 'column';
      r.consumed.add(colQty);
      // "3 x Name": the multiplication sign after the quantity belongs to it, not to the name.
      const after = firstLine.line.tokens[firstLine.line.tokens.indexOf(colQty) + 1];
      if (after && TIMES.test(after.text)) r.consumed.add(after);
    }
    const nameToks = orderedNameTokens(r, rtl).filter((t) => !r.consumed.has(t));
    if (r.qty === null && nameToks.length >= 2) {
      const [a, b] = [nameToks[0]!, nameToks[1]!];
      const lastTok = nameToks[nameToks.length - 1]!;
      const prevTok = nameToks[nameToks.length - 2];
      const glued = /^(\d{1,3})[x×*]$/i.exec(a.text) ?? /^[x×*](\d{1,3})$/i.exec(lastTok.text);
      if (glued) {
        r.qty = Number(glued[1]);
        r.qtySource = 'pattern';
        r.consumed.add(/^\d/.test(a.text) && glued.input === a.text ? a : lastTok);
      } else if (a.kind === 'integer' && TIMES.test(b.text)) {
        r.qty = a.value;
        r.qtySource = 'pattern';
        r.consumed.add(a).add(b);
      } else if (lastTok.kind === 'integer' && prevTok && TIMES.test(prevTok.text)) {
        r.qty = lastTok.value;
        r.qtySource = 'pattern';
        r.consumed.add(lastTok).add(prevTok);
      } else if ((a.kind === 'integer' || isQtyDecimal(a.text)) && LETTER.test(b.text)) {
        r.qty = Math.round(Number(normalizeDigits(a.text).replace(',', '.')));
        r.qtySource = 'leading';
        r.consumed.add(a);
      }
    }
    const total = r.price.value;
    const unitValue = r.unit?.value ?? null;
    if (r.qty === null && unitValue && total % unitValue === 0 && total / unitValue <= 99) {
      r.qty = total / unitValue;
      r.qtySource = 'unit';
    }
    let qty = r.qty !== null && r.qty >= 1 && r.qty <= 999 ? r.qty : 1;
    if (r.qtySource === 'leading' && qty > 1 && !qtyHeader) flags.push('quantity-inferred');
    let unitPrice: Minor | null = null;
    if (unitValue !== null && unitValue * qty === total) unitPrice = unitValue;
    else if (unitValue !== null && r.qtySource !== 'column' && r.qtySource !== 'detail' && total % unitValue === 0) {
      qty = total / unitValue;
      unitPrice = unitValue;
    } else if (total % qty === 0) unitPrice = total / qty;
    if (unitValue !== null && unitPrice !== unitValue) flags.push('unit-price-unknown');
    else if (unitPrice === null) flags.push('unit-price-unknown');

    const description = orderedNameTokens(r, rtl)
      .filter((t) => !r.consumed.has(t))
      .map((t) => t.text)
      .join(' ')
      .replace(/^[-•*.:\s]+|[-•*.:\s]+$/g, '')
      .replace(/\s{2,}/g, ' ');
    if (!LETTER.test(description)) {
      unparsed.push(text.trim());
      continue;
    }
    const obsConf = input[r.price.obs]?.confidence ?? 1;
    if (obsConf < 0.6) flags.push('low-ocr-confidence');
    const alts = alternatesOf(input, layout, r.price).filter((a) => a.value !== total);
    // A runner-up reading nearly as sure as the chosen one means the scanner itself could not decide.
    const close = alts.filter((a) => obsConf < 0.6 || a.confidence >= obsConf * 0.85);
    const id = `i${nextId++}`;
    items.push({
      id, description, quantity: qty, unitPrice, lineTotal: total, confidence: obsConf, flags,
      ...(alts.length ? { altLineTotals: alts.map((a) => a.value) } : {}),
      ...(close.length ? { choices: close.map((a) => a.value) } : {}),
    });
    if (flags.includes('quantity-inferred')) mark(marks, `items.${id}.quantity`, 'The quantity was read from a number before the name.');
    if (close.length) mark(marks, `items.${id}.lineTotal`, 'The scanner was not sure how to read this price.');
    else if (flags.includes('low-ocr-confidence')) mark(marks, `items.${id}.lineTotal`, 'Hard to read on the photo.');
    if (flags.includes('unit-price-unknown') && unitValue !== null) {
      // Quantity x unit price is printed evidence of what the line total should be. When it is one misread digit
      // away from the line total, offer it on the price; otherwise the quantity is the doubtful part.
      const product = qty * unitValue;
      if (digitVariants(total).includes(product)) {
        const item = items[items.length - 1]!;
        item.choices = [...new Set([...(item.choices ?? []), product])];
        mark(marks, `items.${id}.lineTotal`, `${qty} x ${(unitValue / 100).toFixed(2)} is ${(product / 100).toFixed(2)}. This price may be misread.`);
      } else {
        mark(marks, `items.${id}.quantity`, `The quantity times the unit price (${(unitValue / 100).toFixed(2)}) is not the line total.`);
      }
    }
  }
  for (const l of leftovers) if (l.letters >= 3) unparsed.push(l.line.text);

  // ---- charges and totals --------------------------------------------------------------------------------------
  const inRecords = new Set(records.flatMap((r) => r.lines.map((l) => l.i)));
  const totals: { subtotal?: Minor; tax?: Minor; service?: Minor; tip?: Minor } = {};
  const totalCandidates: Array<{ value: Minor; strong: boolean; order: number }> = [];
  let discounts = 0;
  const take = (role: MoneyRole, value: Minor, label: string, order: number, tok: Token) => {
    const conf = input[tok.obs]?.confidence ?? 1;
    const isNew = role === 'discount' || role === 'total' || totals[role] === undefined;
    if (role === 'discount') discounts += value > 0 ? -value : value;
    else if (role === 'total') totalCandidates.push({ value, strong: STRONG_TOTAL.test(normalizeLabel(label)), order });
    else if (totals[role] === undefined) totals[role] = value;
    if (!isNew) return;
    const rate = /(\d{1,2}(?:[.,]\d+)?)\s?%/.exec(normalizeDigits(label));
    if (rate && (role === 'tax' || role === 'service')) rates[role] = Number(rate[1]!.replace(',', '.'));
    const path = role === 'discount' ? 'discounts' : role;
    const close = alternatesOf(input, layout, tok).filter((a) => a.value !== value && (conf < 0.6 || a.confidence >= conf * 0.85));
    if (close.length && role !== 'discount') {
      marks.fieldChoices[role] = close.map((a) => a.value);
      mark(marks, path, 'The scanner was not sure how to read this amount.');
    } else if (conf < 0.6) mark(marks, path, 'Hard to read on the photo.');
  };
  const usedValues = new Set<Token>();
  info.forEach((l, k) => {
    if (inRecords.has(l.i)) return;
    if (MONEY.includes(l.role) && l.amounts.length > 0) {
      const v = rtl || l.script === 'arabic' ? l.amounts[0]! : l.amounts[l.amounts.length - 1]!;
      if (v.value !== null) take(l.role as MoneyRole, v.value, l.line.text, k, v);
      usedValues.add(v);
      return;
    }
    // Labels printed above their values: each label phrase takes the amount under it.
    if (l.amounts.length > 0 || l.letters === 0) return;
    const below = info.slice(k + 1, k + 3).find((n) => n.amounts.length > 0 && n.letters === 0 && n.line.v - l.line.v < layout.textHeight * 3.2);
    if (!below) return;
    for (const obs of l.line.obs) {
      const phrase = input[obs]!;
      const role = roleOf(phrase.text, false);
      if (!MONEY.includes(role)) continue;
      const mid = phrase.x + phrase.w / 2;
      const under = below.amounts
        .filter((t) => !usedValues.has(t) && Math.abs(t.x + t.w / 2 - mid) < Math.max(0.08, phrase.w))
        .sort((a, b) => Math.abs(a.x + a.w / 2 - mid) - Math.abs(b.x + b.w / 2 - mid))[0];
      if (under && under.value !== null) {
        usedValues.add(under);
        take(role as MoneyRole, under.value, phrase.text, k, under);
      }
    }
  });

  dropFreeLines(items, uncertain, notes);
  const itemsSum = items.reduce((s, i) => s + (i.lineTotal ?? 0), 0);
  const charges = (totals.tax ?? 0) + (totals.service ?? 0) + (totals.tip ?? 0) + discounts;
  // Several total lines: the one that equals the subtotal plus the charges, else a strong label, else the last one.
  const consistent = totalCandidates.filter((c) => c.value === (totals.subtotal ?? itemsSum) + charges);
  const strong = totalCandidates.filter((c) => c.strong);
  const pool = consistent.length ? consistent : strong.length ? strong : totalCandidates;
  const chosen = [...pool].sort((a, b) => b.order - a.order)[0];
  const loosePrices = region.flatMap((l) => l.amounts).filter((t) => !records.some((r) => r.consumed.has(t))).map((t) => t.value).filter((v): v is number => v !== null);
  const settled = settleArithmetic({
    items, totals, total: chosen ? chosen.value : null, discounts, notes, uncertain, loosePrices,
    reasons: marks.reasons, fieldChoices: marks.fieldChoices, rates,
  });

  // ---- store, date, currency -----------------------------------------------------------------------------------
  const rows = info.map((l) => ({ text: l.line.text, h: Math.max(...l.line.obs.map((o) => input[o]!.h)), confidence: Math.min(...l.line.obs.map((o) => input[o]!.confidence)), i: l.i }));
  const date = detectDate(rows);
  if (date.iso === null || date.ambiguous) uncertain.push('date');
  const currency = detectCurrency(rows);
  if (!currency.sure) {
    uncertain.push('currency');
    notes.push(`No currency printed; assumed ${currency.code}.`);
  }
  const limit = header >= 0 ? header : first >= 0 ? first : rows.length;
  let merchantRow = detectMerchant(rows.filter((r) => r.confidence >= 0.5), limit);
  if (!merchantRow) {
    // Some receipts print the shop's name under the table instead.
    const after = rows.slice(end, end + 4).concat(rows.slice(Math.max(...[...inRecords, -1]) + 1).slice(0, 3));
    merchantRow = after.find((r) => r.confidence >= 0.8 && /^[A-Za-z][A-Za-z' &.-]{2,28}$/.test(r.text.trim()) && r.text.trim().split(/\s+/).length <= 4 && roleOf(r.text, false) === 'text') ?? null;
  }
  const merchant = merchantRow ? merchantRow.text.replace(/\s{2,}/g, ' ').trim() : null;
  if (!merchant) {
    uncertain.push('merchant');
    notes.push('No store name found on the receipt. Type it in.');
  }

  const receipt: Receipt = {
    merchant, date: date.iso, currency: currency.code, items, discounts,
    subtotal: totals.subtotal ?? null, tax: totals.tax ?? null, service: totals.service ?? null, tip: totals.tip ?? null,
    total: settled.total, taxIncluded: settled.taxIncluded, uncertain, unparsed: unparsed.slice(0, 8), notes,
    reasons: marks.reasons, fieldChoices: marks.fieldChoices,
  };
  const score = { exact: 100, repaired: 40, unknown: 0, broken: 0 }[settled.arith] - unparsed.length - (items.length === 0 ? 50 : 0);
  return { receipt, arith: settled.arith, score };
}

function lineIndexOf(layout: Layout, t: Token): number {
  // tokens keep their line's unbent height; lines are few, a scan is cheap
  return layout.lines.findIndex((l) => l.tokens.includes(t));
}

/** Name tokens of a record in reading order: lines top to bottom; observations by reading direction; words as printed. */
function orderedNameTokens(r: ItemRecord, rtl: boolean): Token[] {
  const out: Token[] = [];
  for (const l of r.lines) {
    const byObs = new Map<number, Token[]>();
    for (const t of l.nameTokens) byObs.set(t.obs, [...(byObs.get(t.obs) ?? []), t]);
    const groups = [...byObs.values()].sort((a, b) => (rtl ? b[0]!.x - a[0]!.x : a[0]!.x - b[0]!.x));
    for (const g of groups) {
      const arabic = g.some((t) => ARABIC.test(t.text)) && !g.some((t) => LATIN.test(t.text));
      out.push(...[...g].sort((a, b) => (arabic ? b.x - a.x : a.x - b.x)));
    }
  }
  return out;
}

/** Other amounts the scanner thought this price could be, from its runner-up readings of the observation. */
function alternatesOf(input: OcrLine[], layout: Layout, t: Token): Array<{ value: Minor; confidence: number }> {
  const obs = input[t.obs];
  if (!obs?.alternates?.length) return [];
  const words = obs.text.split(/\s+/).filter(Boolean);
  const k = words.indexOf(t.text);
  const out: Array<{ value: Minor; confidence: number }> = [];
  obs.alternates.forEach((alt, n) => {
    const aw = alt.split(/\s+/).filter(Boolean);
    const cand = aw.length === words.length && k >= 0 ? aw[k]! : aw.find((w) => /\d[.,]\d\d/.test(w));
    const v = cand ? parseAmount(normalizeDigits(cand)) : null;
    // Runner-ups without a recorded confidence (older scans) count as much less sure than the reading itself.
    if (v !== null && !out.some((o) => o.value === v)) out.push({ value: v, confidence: obs.alternateConfidences?.[n] ?? 0 });
  });
  void layout;
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? 0 : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** A robust straight line through (v, edge) points: where item names start, allowing for a slanted (keystoned) page. */
function fitEdge(pts: Array<[number, number]>): (v: number) => number {
  if (pts.length === 0) return () => 0;
  if (pts.length < 3) {
    const m = median(pts.map((p) => p[1]));
    return () => m;
  }
  // Most item names start at the edge; indented ones are fewer. Fit through the lower half of the residuals.
  const mv = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const me = median(pts.map((p) => p[1]));
  const svv = pts.reduce((s, p) => s + (p[0] - mv) ** 2, 0);
  let b = svv > 1e-9 ? pts.reduce((s, p) => s + (p[0] - mv) * (p[1] - me), 0) / svv : 0;
  if (Math.abs(b) > 0.3) b = 0;
  const resid = pts.map((p) => p[1] - (me + b * (p[0] - mv)));
  const low = median(resid.filter((r) => r <= median(resid)));
  return (v) => me + low + b * (v - mv);
}

/**
 * Read a receipt from its layout. Builds the readings that differ in the genuinely ambiguous choices, keeps the one
 * whose numbers add up, and marks items on which equally good readings disagree.
 */
export function readLayout(input: OcrLine[], layout: Layout): { receipt: Receipt; arith: Settled['arith'] } {
  const amountCols = layout.columns.map((c, id) => ({ c, id })).filter((x) => x.c.role === 'amount');
  const choices: Array<{ attach: 'indent' | 'previous'; totalColumn: number | null }> = [
    { attach: 'indent', totalColumn: null },
    { attach: 'previous', totalColumn: null },
  ];
  // When several amount columns exist, each could be the line total.
  if (amountCols.length >= 2) for (const { id } of amountCols.slice(-3)) choices.push({ attach: 'indent', totalColumn: id });
  const readings = choices.map((o) => interpret(input, layout, o));
  const best = readings.reduce((a, b) => (b.score > a.score ? b : a));
  // Equally good readings that disagree about items: mark the items that differ.
  const rivals = readings.filter((r) => r !== best && r.score === best.score && best.arith !== 'unknown');
  const marks: Marks = { uncertain: best.receipt.uncertain, reasons: best.receipt.reasons ?? {}, fieldChoices: best.receipt.fieldChoices ?? {} };
  for (const rival of rivals) {
    const key = (i: ReceiptItem) => `${i.description}|${i.quantity}|${i.lineTotal}`;
    const theirs = new Set(rival.receipt.items.map(key));
    for (const item of best.receipt.items) {
      if (theirs.has(key(item))) continue;
      // The rival's reading of the same item, if it has one, becomes a choice.
      const same = rival.receipt.items.find((o) => o.description === item.description);
      if (same?.lineTotal != null && same.lineTotal !== item.lineTotal) item.choices = [...new Set([...(item.choices ?? []), same.lineTotal])];
      mark(marks, `items.${item.id}.lineTotal`, 'Two readings of the receipt disagree about this line.');
      if (!same || same.quantity !== item.quantity) mark(marks, `items.${item.id}.quantity`, 'Two readings of the receipt disagree about this line.');
    }
  }
  best.receipt.reasons = marks.reasons;
  return { receipt: best.receipt, arith: best.arith };
}
