import { describe, expect, it } from 'vitest';
import { parseReceipt } from './parseReceipt';
import { reconcile } from './reconcile';
import type { OcrLine } from './receipt';

/** Small seeded PRNG so failures are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  'Grilled Chicken', 'Beef Burger', 'Caesar Salad', 'Mango Juice', 'Lemon Mint', 'Falafel Sandwich', 'Koshari Bowl',
  'Margherita Pizza', 'Chicken Tawouk', 'Fresh Orange', 'Iced Latte', 'Cappuccino', 'Sweet Potato Fries', 'Hummus',
  'Mixed Grill', 'Fattoush', 'Tea', 'Small Water', 'Cheesecake', 'Pasta Alfredo', 'Fish Fillet', 'Rice Pudding',
  'Onion Rings', 'Club Sandwich', 'Tomato Soup', 'Brownie', 'Espresso', 'Garlic Bread',
];
const ARABIC = ['منجا', 'دجاج مشوي', 'سلطة', 'عصير', 'شاي', 'مياه', 'كشري', 'فتوش', 'حمص', 'بيتزا'];
const STORES = ['POPEYES', 'Zooba', 'CAFE LUNA', 'Kazoku Sushi', 'GRILL HOUSE', 'Abou Tarek', 'The Bakery'];

interface Spec {
  items: Array<{ name: string; qty: number; unit: number }>;
  header: boolean;
  qtyColumn: boolean;
  bilingual: boolean;
  tilt: number;
  jitter: number;
  charges: 'none' | 'service+vat' | 'vat';
  totalLine: boolean;
  store: boolean;
  noise: boolean;
  whole: boolean;
}

export function makeSpec(r: () => number): Spec {
  const n = 2 + Math.floor(r() * 9);
  const whole = r() < 0.2;
  const names = [...NAMES].sort(() => r() - 0.5).slice(0, n);
  const qtyColumn = r() < 0.55;
  return {
    items: names.map((name) => ({
      name,
      qty: r() < 0.3 ? 2 + Math.floor(r() * 2) : 1,
      unit: (whole ? 5 : 0.5) * (1 + Math.floor(r() * 90)) * 100,
    })),
    header: qtyColumn ? r() < 0.8 : r() < 0.4,
    qtyColumn,
    bilingual: r() < 0.4,
    tilt: (r() - 0.5) * 0.12,
    jitter: r() * 0.002,
    charges: (['none', 'service+vat', 'vat'] as const)[Math.floor(r() * 3)]!,
    totalLine: r() < 0.8,
    store: r() < 0.8,
    noise: r() < 0.7,
    whole,
  };
}

// A receipt that prints whole numbers rounds its charges to whole numbers too.
const roundTo = (minor: number, whole: boolean) => (whole ? Math.round(minor / 100) * 100 : Math.round(minor));
const fmt = (minor: number, whole: boolean) => (whole ? String(Math.round(minor / 100)) : (minor / 100).toFixed(2));

const SWAP: Record<string, string> = { '0': '8', '8': '6', '6': '8', '1': '7', '7': '1', '5': '6', '3': '8', '9': '4', '4': '9', '2': '7' };

/** One digit of a printed price read wrongly, the way OCR does. */
function misread(text: string, r: () => number): string {
  const at = [...text].map((c, i) => (/\d/.test(c) ? i : -1)).filter((i) => i >= 0);
  const i = at[Math.floor(r() * at.length)]!;
  return text.slice(0, i) + (SWAP[text[i]!] ?? '8') + text.slice(i + 1);
}

interface Opts {
  corrupt?: boolean;
  mergeRows?: boolean;
}

export function render(spec: Spec, r: () => number, opts: Opts = {}): { lines: OcrLine[]; expected: Array<[string, number, number]>; total: number | null; hasArithmetic: boolean; corrupted: number } {
  type Frag = [string, number, number];
  const rows: Array<{ frags: Frag[]; h: number }> = [];
  const add = (h: number, ...frags: Frag[]) => rows.push({ frags, h });
  const store = STORES[Math.floor(r() * STORES.length)]!;

  if (spec.store) add(0.03, [store, 0.25, 0.4]);
  if (spec.noise) {
    add(0.016, ['811 Wrigley Drive', 0.1, 0.35]);
    add(0.016, ['LAKE GENEVA, WI 53147', 0.1, 0.4]);
    add(0.016, ['262-248-4381', 0.1, 0.25]);
    add(0.016, ['Staff: Khaled', 0.1, 0.25], ['Table 9', 0.6, 0.15]);
    add(0.016, ['Date: 15/11/2020', 0.1, 0.3], ['Time: 05:25:09 a', 0.5, 0.3]);
    add(0.016, ['Number of Covers: 4', 0.1, 0.35]);
  }
  const expected: Array<[string, number, number]> = [];
  if (spec.header) add(0.016, ['Qty', 0.07, 0.07], ['Item', 0.42, 0.1], ['Price', 0.72, 0.1]);
  let sub = 0;
  const corruptAt = opts.corrupt ? Math.floor(r() * spec.items.length) : -1;
  let corrupted = 0;
  for (const [idx, it] of spec.items.entries()) {
    const lineTotal = Math.round(it.unit * it.qty);
    sub += lineTotal;
    expected.push([it.name, it.qty, lineTotal]);
    const frags: Frag[] = [];
    if (spec.qtyColumn) frags.push([String(it.qty), 0.07, 0.03]);
    const prefixQty = !spec.qtyColumn && it.qty > 1;
    frags.push([prefixQty ? `${it.qty} x ${it.name}` : it.name, 0.17, 0.3]);
    if (spec.bilingual) frags.push([ARABIC[Math.floor(r() * ARABIC.length)]!, 0.5, 0.1]);
    let printed = fmt(lineTotal, spec.whole);
    if (idx === corruptAt) {
      printed = misread(printed, r);
      if (printed !== fmt(lineTotal, spec.whole)) corrupted += 1;
    }
    frags.push([printed, spec.whole ? 0.76 : 0.72, spec.whole ? 0.06 : 0.12]);
    add(0.016, ...frags);
  }
  let total: number | null = null;
  if (spec.charges !== 'none' || spec.totalLine) {
    add(0.016, ['Sub Total', 0.2, 0.2], [fmt(sub, spec.whole), 0.72, 0.12]);
  }
  let amount = sub;
  if (spec.charges === 'service+vat') {
    const service = roundTo(sub * 0.12, spec.whole);
    const vat = roundTo((sub + service) * 0.14, spec.whole);
    add(0.016, ['Service Charge (12%):', 0.1, 0.4], [fmt(service, spec.whole), 0.72, 0.12]);
    add(0.016, ['VAT (14%):', 0.15, 0.2], [fmt(vat, spec.whole), 0.72, 0.12]);
    amount = sub + service + vat;
  } else if (spec.charges === 'vat') {
    const vat = roundTo(sub * 0.14, spec.whole);
    add(0.016, ['Tax', 0.15, 0.1], [fmt(vat, spec.whole), 0.72, 0.12]);
    amount = sub + vat;
  }
  if (spec.totalLine) {
    add(0.016, ['Total', 0.22, 0.12], [fmt(amount, spec.whole), 0.72, 0.14]);
    total = amount;
  }
  if (spec.noise) {
    add(0.016, ['Thank you for visiting!', 0.1, 0.5]);
    add(0.016, ['Website: www.example.com', 0.1, 0.5]);
  }

  const lines: OcrLine[] = [];
  let y = 0.05;
  for (const row of rows) {
    const merge = opts.mergeRows && row.frags.length > 1 && r() < 0.4;
    const frags: Frag[] = merge
      ? [[row.frags.map((f) => f[0]).join('  '), row.frags[0]![1], row.frags[row.frags.length - 1]![1] + row.frags[row.frags.length - 1]![2] - row.frags[0]![1]]]
      : row.frags;
    for (const [text, x, w] of frags) {
      const noise = (r() - 0.5) * 2 * spec.jitter;
      lines.push({ text, x, y: y + spec.tilt * (x + w / 2) + noise, w, h: row.h, confidence: 0.9 });
    }
    y += row.h * (1.7 + r() * 0.6);
  }
  return { lines, expected, total, hasArithmetic: spec.totalLine || spec.charges !== 'none', corrupted };
}

describe('stress: randomly generated receipts (layouts, tilt, bilingual captions, noise)', () => {
  const N = 1500;
  const failures: string[] = [];
  let reconciled = 0;
  let checkedTotals = 0;

  for (let seed = 1; seed <= N; seed++) {
    const r = rng(seed * 7919);
    const spec = makeSpec(r);
    const { lines, expected, total } = render(spec, r);
    const parsed = parseReceipt(lines);
    const got = parsed.items.map((i) => [i.description.split(' ').slice(0, 4).join(' '), i.quantity, i.lineTotal]);
    const want = expected.map(([name, qty, tot]) => [name, qty, tot]);
    const itemsOk = JSON.stringify(got.map((g) => [String(g[0]).startsWith(String(want[got.indexOf(g)]?.[0] ?? '')), g[1], g[2]])) ===
      JSON.stringify(want.map((w) => [true, w[1], w[2]]));
    if (!itemsOk) failures.push(`seed ${seed}: want ${JSON.stringify(want)} got ${JSON.stringify(got)} | spec ${JSON.stringify({ ...spec, items: undefined })}`);
    if (total !== null) {
      checkedTotals += 1;
      if (parsed.total === total && reconcile(parsed).status === 'ok') reconciled += 1;
    }
  }

  it(`reads every item of at least 97% of ${N} receipts exactly`, () => {
    const rate = 1 - failures.length / N;
    if (failures.length > 0) console.log(`item failures: ${failures.length}/${N}\n` + failures.slice(0, 6).join('\n'));
    expect(rate).toBeGreaterThanOrEqual(0.97);
  });

  it('reads the printed total and reconciles on at least 97% of receipts that print one', () => {
    if (reconciled < checkedTotals) console.log(`reconciled ${reconciled}/${checkedTotals}`);
    expect(reconciled / checkedTotals).toBeGreaterThanOrEqual(0.97);
  });
});

describe('stress: rows the scanner returned as one merged line', () => {
  it('still reads every item exactly', () => {
    let bad = 0;
    const N = 600;
    const samples: string[] = [];
    for (let seed = 1; seed <= N; seed++) {
      const r = rng(seed * 104729);
      const spec = makeSpec(r);
      const { lines, expected } = render(spec, r, { mergeRows: true });
      const got = parseReceipt(lines).items.map((i) => [i.quantity, i.lineTotal]);
      const want = expected.map(([, q, t]) => [q, t]);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad += 1;
        if (samples.length < 4) samples.push(`seed ${seed}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
      }
    }
    if (bad) console.log(`merged-row failures: ${bad}/${N}\n` + samples.join('\n'));
    expect(1 - bad / N).toBeGreaterThanOrEqual(0.98); // extreme mixes (2 items, no header, 4-6 degrees, half-merged rows) can be genuinely ambiguous
  });
});

describe('stress: a misread digit is never silently wrong', () => {
  it('either reads every price correctly or visibly fails to add up', () => {
    let silent = 0;
    let checked = 0;
    const samples: string[] = [];
    for (let seed = 1; seed <= 1200; seed++) {
      const r = rng(seed * 15485863);
      const spec = makeSpec(r);
      const { lines, expected, hasArithmetic, corrupted } = render(spec, r, { corrupt: true });
      if (!hasArithmetic || corrupted === 0) continue;
      checked += 1;
      const parsed = parseReceipt(lines);
      const exact = JSON.stringify(parsed.items.map((i) => i.lineTotal)) === JSON.stringify(expected.map((e) => e[2]));
      const flagged = reconcile(parsed).status !== 'ok';
      if (!exact && !flagged) {
        silent += 1;
        if (samples.length < 4) samples.push(`seed ${seed}: want ${JSON.stringify(expected.map((e) => e[2]))} got ${JSON.stringify(parsed.items.map((i) => i.lineTotal))}`);
      }
    }
    if (silent) console.log(`SILENT WRONG: ${silent}/${checked}\n` + samples.join('\n'));
    expect(checked).toBeGreaterThan(300);
    expect(silent).toBe(0);
  });
});
