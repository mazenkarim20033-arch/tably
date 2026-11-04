import type { OcrLine } from '../src/receipt';
import type { Fixture, Truth } from './fixture';

/**
 * Independent synthetic receipts for evaluation. Written separately from the parser and its stress tests, with
 * layouts the parser was not tuned on (right-to-left tables, unit and amount columns, wrapped names, summary boxes,
 * "2 @ 15.00" lines, discounts and several total lines). Each page goes through a camera model (rotation, keystone,
 * paper curl, jitter) and is cut into fragments the way Vision does, with corners and word boxes.
 *
 * These are for measuring, not for tuning: a rule added to fix one of these is a rule fitted to this generator.
 * Synthetic results are never proof of real-world accuracy.
 */

type Rand = () => number;

export function rng(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const chance = (r: Rand, p: number) => r() < p;

// Page units: x 0..1 of the image width, y in multiples of a line; converted to image space by the camera.
const CHAR = 0.0115; // width of one character
const LINE = 1; // one printed line

interface Piece {
  text: string;
  /** left edge, or right edge when `right` is set */
  x: number;
  right?: boolean;
  /** text size relative to normal */
  size?: number;
}
type PrintedRow = Piece[];

const DISHES = [
  'Grilled Halloumi', 'Beef Shawarma Plate', 'Chicken Fajita', 'Molokhia Soup', 'Spaghetti Bolognese', 'Tuna Salad',
  'Mixed Grill Platter', 'Lentil Soup', 'Feteer Meshaltet', 'Hawawshi', 'Pepperoni Pizza', 'Iced Americano',
  'Fresh Lemon Juice', 'Sahlab', 'Om Ali', 'Basbousa', 'Turkish Coffee', 'Sparkling Water', 'Kofta Sandwich',
  'Shrimp Tagine', 'Grilled Sea Bass', 'Vegetable Rice', 'French Fries', 'Garden Salad', 'Mango Smoothie',
  'Chicken Liver', 'Stuffed Vine Leaves', 'Cheese Sambousek', 'Caramel Latte', 'Club Sandwich Deluxe',
];
const LONG_DISHES = [
  'Grilled Chicken Breast with Mushroom Sauce', 'Seafood Linguine in Garlic Cream Sauce', 'Mixed Shawarma Platter with Fries',
  'Chocolate Fudge Cake with Vanilla Ice Cream', 'Slow Cooked Lamb Shank with Rice', 'Smoked Turkey and Cheese Croissant',
];
const ARABIC_DISHES = ['فول بالزيت', 'طعمية', 'كشري كبير', 'شاورما فراخ', 'كفتة مشوية', 'رز بالخلطة', 'ملوخية', 'عصير قصب', 'شاي بالنعناع', 'بسبوسة', 'فطير مشلتت', 'حواوشي'];
const CAPTIONS = ['حلوم مشوي', 'شاورما لحم', 'عصير ليمون', 'شوربة عدس', 'قهوة تركي', 'مياه غازية', 'سلطة خضراء', 'بطاطس'];
const STORES = ['NILE GRILL', 'Cafe Corniche', 'ZAMALEK BISTRO', 'Al Fanar', 'The Daily Bread', 'KOSHARY HOUSE', 'Sea Breeze'];

function money(minor: number, r: Rand, style: { commas: boolean; suffix: string; arabicDigits: boolean }): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  let s = (abs / 100).toFixed(2);
  if (style.commas) s = s.replace(/\B(?=(\d{3})+(?!\d))/, ',');
  if (style.arabicDigits) s = s.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[+d]!).replace('.', '٫');
  if (neg) s = chance(r, 0.5) ? `-${s}` : `(${s})`;
  return style.suffix ? `${s} ${style.suffix}` : s;
}

interface Built {
  rows: PrintedRow[];
  truth: Truth;
  tags: string[];
}

interface Line { name: string; qty: number; unit: number }

function lines(r: Rand, n: number, pool: readonly string[]): Line[] {
  const names = [...pool].sort(() => r() - 0.5).slice(0, n);
  return names.map((name) => ({ name, qty: chance(r, 0.3) ? 2 + Math.floor(r() * 3) : 1, unit: (5 + Math.floor(r() * 60)) * 500 }));
}

/** Charges printed under the table, with consistent arithmetic. */
function charges(r: Rand, sub: number, rtl: boolean) {
  const discount = chance(r, 0.2) ? -Math.round(sub * pick(r, [0.05, 0.1, 0.15])) : 0;
  const service = chance(r, 0.6) ? Math.round((sub + discount) * pick(r, [0.1, 0.12])) : 0;
  const tax = chance(r, 0.75) ? Math.round((sub + discount + service) * 0.14) : 0;
  const tip = chance(r, 0.1) ? pick(r, [1000, 2000, 5000]) : 0;
  const total = sub + discount + service + tax + tip;
  const label = {
    subtotal: rtl ? pick(r, ['الاجمالي الفرعي', 'المجموع الفرعي']) : pick(r, ['Subtotal', 'Sub Total', 'SUB-TOTAL', 'Net Amount']),
    discount: rtl ? 'خصم' : pick(r, ['Discount', 'Promo', 'Disc 10%']),
    service: rtl ? 'خدمة' : pick(r, ['Service', 'Service Charge 12%', 'Svc Chg', 'Service 12%']),
    tax: rtl ? pick(r, ['ضريبة القيمة المضافة', 'ضريبة']) : pick(r, ['VAT 14%', 'Tax', 'V.A.T', 'Sales Tax']),
    tip: rtl ? 'بقشيش' : pick(r, ['Tip', 'Gratuity']),
    total: rtl ? pick(r, ['الاجمالي', 'المطلوب']) : pick(r, ['Total', 'TOTAL', 'Total Due', 'Amount Due', 'Grand Total']),
  };
  return { discount, service, tax, tip, total, label };
}

function header(r: Rand, rows: PrintedRow[], rtl: boolean) {
  rows.push([{ text: pick(r, STORES), x: 0.3, size: 1.6 }]);
  if (chance(r, 0.7)) rows.push([{ text: pick(r, ['26 July St, Zamalek', '14 Tahrir Square', 'Maadi, Road 9']), x: 0.2 }]);
  if (chance(r, 0.6)) rows.push([{ text: pick(r, ['Tel: 0227356841', '01012345678', 'Hotline 19555']), x: 0.25 }]);
  if (chance(r, 0.8)) rows.push([{ text: pick(r, ['Date: 12/03/2025', '2025-03-12', '12-Mar-2025']), x: 0.06 }, { text: pick(r, ['20:41', '08:15 PM', '13:02:55']), x: 0.94, right: true }]);
  if (chance(r, 0.5)) rows.push([{ text: rtl ? 'طاولة ٧' : pick(r, ['Table 7', 'Tbl 12', 'Order #4471']), x: 0.06 }, { text: pick(r, ['Waiter: Ahmed', 'Cashier: Mona', 'Guests: 3']), x: 0.94, right: true }]);
}

function footer(r: Rand, rows: PrintedRow[], total: number, fmt: (m: number) => string) {
  if (chance(r, 0.3)) {
    const paid = Math.ceil(total / 10000) * 10000;
    rows.push([{ text: 'Cash', x: 0.1 }, { text: fmt(paid), x: 0.9, right: true }]);
    rows.push([{ text: 'Change', x: 0.1 }, { text: fmt(paid - total), x: 0.9, right: true }]);
  }
  if (chance(r, 0.6)) rows.push([{ text: pick(r, ['Thank you! Come again', 'شكرا لزيارتكم', 'Follow us @nilegrill']), x: 0.2 }]);
}

function summaryRows(c: ReturnType<typeof charges>, sub: number, fmt: (m: number) => string, rtl: boolean, at: { label: number; value: number }): PrintedRow[] {
  const out: PrintedRow[] = [[{ text: c.label.subtotal, x: at.label }, { text: fmt(sub), x: at.value, right: true }]];
  const push = (label: string, v: number) => out.push([{ text: label, x: at.label }, { text: fmt(v), x: at.value, right: true }]);
  if (c.discount) push(c.label.discount, c.discount);
  if (c.service) push(c.label.service, c.service);
  if (c.tax) push(c.label.tax, c.tax);
  if (c.tip) push(c.label.tip, c.tip);
  out.push([{ text: c.label.total, x: at.label, size: 1.2 }, { text: fmt(c.total), x: at.value, right: true, size: 1.2 }]);
  if (rtl) for (const row of out) for (const p of row) if (!p.right) { p.x = 0.94; p.right = true; } else { p.x = 0.06 + p.text.length * CHAR; }
  return out;
}

function truthOf(items: Line[], sub: number, c: ReturnType<typeof charges>): Truth {
  return {
    items: items.map((i) => ({ name: i.name, qty: i.qty, lineTotal: i.qty * i.unit })),
    subtotal: sub, tax: c.tax || null, service: c.service || null, tip: c.tip || null, discount: c.discount || null, total: c.total,
  };
}

const TEMPLATES: Record<string, (r: Rand) => Built> = {
  /** Name left, price right; the quantity as a column, a prefix, a suffix, or not printed. */
  'ltr-simple'(r) {
    const style = { commas: chance(r, 0.5), suffix: chance(r, 0.2) ? 'EGP' : '', arabicDigits: false };
    const fmt = (m: number) => money(m, r, style);
    const items = lines(r, 2 + Math.floor(r() * 8), DISHES);
    const rows: PrintedRow[] = [];
    header(r, rows, false);
    const qtyStyle = pick(r, ['column', 'prefix', 'suffix'] as const);
    if (chance(r, 0.5)) rows.push(qtyStyle === 'column' ? [{ text: 'Qty', x: 0.06 }, { text: 'Item', x: 0.18 }, { text: 'Amount', x: 0.92, right: true }] : [{ text: 'Description', x: 0.06 }, { text: 'Price', x: 0.92, right: true }]);
    for (const it of items) {
      const total = fmt(it.qty * it.unit);
      if (qtyStyle === 'column') rows.push([{ text: String(it.qty), x: 0.07 }, { text: it.name, x: 0.18 }, { text: total, x: 0.92, right: true }]);
      else if (qtyStyle === 'prefix') rows.push([{ text: it.qty > 1 ? `${it.qty} x ${it.name}` : it.name, x: 0.06 }, { text: total, x: 0.92, right: true }]);
      else rows.push([{ text: it.qty > 1 ? `${it.name} x${it.qty}` : it.name, x: 0.06 }, { text: total, x: 0.92, right: true }]);
    }
    const sub = items.reduce((s, i) => s + i.qty * i.unit, 0);
    const c = charges(r, sub, false);
    rows.push(...summaryRows(c, sub, fmt, false, { label: 0.3, value: 0.92 }));
    footer(r, rows, c.total, fmt);
    return { rows, truth: truthOf(items, sub, c), tags: ['ltr', `qty-${qtyStyle}`] };
  },

  /** Item | Qty | Unit price | Amount columns (both prices printed). */
  'unit-and-amount'(r) {
    const style = { commas: chance(r, 0.5), suffix: '', arabicDigits: false };
    const fmt = (m: number) => money(m, r, style);
    const items = lines(r, 3 + Math.floor(r() * 7), DISHES);
    const rows: PrintedRow[] = [];
    header(r, rows, false);
    const qtyFirst = chance(r, 0.4);
    const head = pick(r, [['Item', 'Qty', 'Price', 'Total'], ['Description', 'Qty', 'Rate', 'Amount'], ['Item', 'Qty', 'U.Price', 'Value']]);
    rows.push(qtyFirst
      ? [{ text: head[1]!, x: 0.05 }, { text: head[0]!, x: 0.14 }, { text: head[2]!, x: 0.72, right: true }, { text: head[3]!, x: 0.94, right: true }]
      : [{ text: head[0]!, x: 0.05 }, { text: head[1]!, x: 0.52 }, { text: head[2]!, x: 0.74, right: true }, { text: head[3]!, x: 0.94, right: true }]);
    for (const it of items) {
      rows.push(qtyFirst
        ? [{ text: String(it.qty), x: 0.06 }, { text: it.name, x: 0.14 }, { text: fmt(it.unit), x: 0.72, right: true }, { text: fmt(it.qty * it.unit), x: 0.94, right: true }]
        : [{ text: it.name, x: 0.05 }, { text: String(it.qty), x: 0.53 }, { text: fmt(it.unit), x: 0.74, right: true }, { text: fmt(it.qty * it.unit), x: 0.94, right: true }]);
    }
    const sub = items.reduce((s, i) => s + i.qty * i.unit, 0);
    const c = charges(r, sub, false);
    rows.push(...summaryRows(c, sub, fmt, false, { label: 0.45, value: 0.94 }));
    footer(r, rows, c.total, fmt);
    return { rows, truth: truthOf(items, sub, c), tags: ['ltr', 'unit-columns', qtyFirst ? 'qty-first' : 'qty-middle'] };
  },

  /** Arabic receipt laid out right to left: names on the right, amounts on the left, sometimes Arabic-Indic digits. */
  'rtl-arabic'(r) {
    const style = { commas: false, suffix: chance(r, 0.3) ? 'ج.م' : '', arabicDigits: chance(r, 0.4) };
    const fmt = (m: number) => money(m, r, style);
    const items = lines(r, 2 + Math.floor(r() * 7), ARABIC_DISHES);
    const rows: PrintedRow[] = [];
    header(r, rows, true);
    if (chance(r, 0.6)) rows.push([{ text: 'الصنف', x: 0.94, right: true }, { text: 'الكمية', x: 0.45 }, { text: 'السعر', x: 0.06 }]);
    for (const it of items) {
      const q = style.arabicDigits ? String(it.qty).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[+d]!) : String(it.qty);
      rows.push([{ text: it.name, x: 0.94, right: true }, { text: q, x: 0.47 }, { text: fmt(it.qty * it.unit), x: 0.06 }]);
    }
    const sub = items.reduce((s, i) => s + i.qty * i.unit, 0);
    const c = charges(r, sub, true);
    rows.push(...summaryRows(c, sub, fmt, true, { label: 0.3, value: 0.92 }));
    footer(r, rows, c.total, fmt);
    return { rows, truth: truthOf(items, sub, c), tags: ['rtl', 'arabic', style.arabicDigits ? 'arabic-digits' : 'latin-digits'] };
  },

  /** Long names that wrap onto a second line; the price sits on the first or on the last line. */
  'wrapped-names'(r) {
    const style = { commas: true, suffix: '', arabicDigits: false };
    const fmt = (m: number) => money(m, r, style);
    const items = lines(r, 2 + Math.floor(r() * 4), LONG_DISHES);
    const rows: PrintedRow[] = [];
    header(r, rows, false);
    const priceLast = chance(r, 0.5);
    for (const it of items) {
      const words = it.name.split(' ');
      const cut = Math.ceil(words.length / 2);
      const first = (it.qty > 1 ? `${it.qty} ` : '') + words.slice(0, cut).join(' ');
      const second = words.slice(cut).join(' ');
      const price: Piece = { text: fmt(it.qty * it.unit), x: 0.93, right: true };
      if (priceLast) rows.push([{ text: first, x: 0.06 }], [{ text: second, x: 0.1 }, price]);
      else rows.push([{ text: first, x: 0.06 }, price], [{ text: second, x: 0.1 }]);
    }
    const sub = items.reduce((s, i) => s + i.qty * i.unit, 0);
    const c = charges(r, sub, false);
    rows.push(...summaryRows(c, sub, fmt, false, { label: 0.35, value: 0.93 }));
    footer(r, rows, c.total, fmt);
    return { rows, truth: truthOf(items, sub, c), tags: ['ltr', 'wrapped', priceLast ? 'price-on-last-line' : 'price-on-first-line'] };
  },

  /** A box of figures above the table, each value printed under its label. */
  'summary-box'(r) {
    const style = { commas: false, suffix: '', arabicDigits: false };
    const fmt = (m: number) => money(m, r, style);
    const items = lines(r, 3 + Math.floor(r() * 6), DISHES);
    const sub = items.reduce((s, i) => s + i.qty * i.unit, 0);
    const c = charges(r, sub, false);
    const rows: PrintedRow[] = [];
    rows.push([{ text: pick(r, STORES), x: 0.3, size: 1.4 }]);
    rows.push([{ text: 'Covers', x: 0.1 }, { text: 'Min Charge', x: 0.42 }, { text: 'Table', x: 0.74 }]);
    rows.push([{ text: String(2 + Math.floor(r() * 4)), x: 0.14 }, { text: fmt(0), x: 0.44 }, { text: String(1 + Math.floor(r() * 30)), x: 0.78 }]);
    rows.push([{ text: 'Items', x: 0.1 }, { text: c.label.service, x: 0.42 }, { text: c.label.tax, x: 0.74 }]);
    rows.push([{ text: fmt(sub), x: 0.08 }, { text: fmt(c.service), x: 0.42 }, { text: fmt(c.tax), x: 0.72 }]);
    rows.push([{ text: 'Total :', x: 0.12, size: 1.5 }, { text: fmt(c.total), x: 0.5, size: 1.5 }]);
    rows.push([{ text: 'Item', x: 0.18 }, { text: 'Qty', x: 0.5 }, { text: 'Price', x: 0.6 }, { text: 'Total', x: 0.78 }]);
    for (const it of items) rows.push([{ text: it.name, x: 0.08 }, { text: String(it.qty), x: 0.52 }, { text: fmt(it.unit), x: 0.7, right: true }, { text: fmt(it.qty * it.unit), x: 0.88, right: true }]);
    const truth = truthOf(items, sub, { ...c, discount: 0, tip: 0, total: sub + c.service + c.tax });
    truth.total = sub + c.service + c.tax;
    rows[5]![1]!.text = fmt(truth.total);
    return { rows, truth, tags: ['ltr', 'summary-box', 'value-under-label'] };
  },

  /** "2 @ 15.00" on its own line under the item; the line total on the item's row. */
  'at-unit-lines'(r) {
    const style = { commas: chance(r, 0.5), suffix: '', arabicDigits: false };
    const fmt = (m: number) => money(m, r, style);
    const items = lines(r, 2 + Math.floor(r() * 6), DISHES).map((i) => ({ ...i, qty: chance(r, 0.6) ? 2 + Math.floor(r() * 3) : 1 }));
    const rows: PrintedRow[] = [];
    header(r, rows, false);
    for (const it of items) {
      rows.push([{ text: it.name.toUpperCase(), x: 0.06 }, { text: fmt(it.qty * it.unit), x: 0.93, right: true }]);
      if (it.qty > 1) rows.push([{ text: `${it.qty} @ ${fmt(it.unit)}`, x: 0.12 }]);
    }
    const sub = items.reduce((s, i) => s + i.qty * i.unit, 0);
    const c = charges(r, sub, false);
    rows.push(...summaryRows(c, sub, fmt, false, { label: 0.3, value: 0.93 }));
    footer(r, rows, c.total, fmt);
    const truth = truthOf(items, sub, c);
    truth.items = truth.items.map((t) => ({ ...t, name: t.name.toUpperCase() }));
    return { rows, truth, tags: ['ltr', 'at-unit-line'] };
  },

  /** English names with Arabic captions (beside or on the next line) and free lines at 0.00. */
  'bilingual-captions'(r) {
    const style = { commas: true, suffix: '', arabicDigits: false };
    const fmt = (m: number) => money(m, r, style);
    const items = lines(r, 3 + Math.floor(r() * 6), DISHES);
    const rows: PrintedRow[] = [];
    header(r, rows, false);
    rows.push([{ text: 'Qty', x: 0.06 }, { text: 'Item', x: 0.4 }, { text: 'Price', x: 0.92, right: true }]);
    const beside = chance(r, 0.5);
    for (const it of items) {
      const cap = pick(r, CAPTIONS);
      const row: PrintedRow = [{ text: String(it.qty), x: 0.07 }, { text: it.name, x: 0.16 }];
      if (beside) row.push({ text: cap, x: 0.16 + (it.name.length + 2) * CHAR });
      row.push({ text: fmt(it.qty * it.unit), x: 0.92, right: true });
      rows.push(row);
      if (!beside) rows.push([{ text: cap, x: 0.2 }]);
      if (chance(r, 0.15)) rows.push([{ text: '1', x: 0.07 }, { text: pick(r, ['Extra Bread', 'Water Cup', 'Lemon Slice']), x: 0.16 }, { text: fmt(0), x: 0.92, right: true }]);
    }
    const sub = items.reduce((s, i) => s + i.qty * i.unit, 0);
    const c = charges(r, sub, false);
    rows.push(...summaryRows(c, sub, fmt, false, { label: 0.25, value: 0.92 }));
    footer(r, rows, c.total, fmt);
    return { rows, truth: truthOf(items, sub, c), tags: ['ltr', 'bilingual', beside ? 'caption-beside' : 'caption-below'] };
  },

  /** Price printed before the name (some POS printers), quantity as "x2" at the end. */
  'price-first'(r) {
    const style = { commas: false, suffix: '', arabicDigits: false };
    const fmt = (m: number) => money(m, r, style);
    const items = lines(r, 2 + Math.floor(r() * 7), DISHES);
    const rows: PrintedRow[] = [];
    header(r, rows, false);
    for (const it of items) rows.push([{ text: fmt(it.qty * it.unit), x: 0.06 }, { text: it.qty > 1 ? `${it.name} x${it.qty}` : it.name, x: 0.3 }]);
    const sub = items.reduce((s, i) => s + i.qty * i.unit, 0);
    const c = charges(r, sub, false);
    rows.push(...summaryRows(c, sub, fmt, false, { label: 0.3, value: 0.92 }));
    footer(r, rows, c.total, fmt);
    return { rows, truth: truthOf(items, sub, c), tags: ['ltr', 'price-first'] };
  },
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

/** The camera: where a point of the printed page lands in the photo (normalized), and how text gets cut up. */
interface Camera { deg: number; keystone: number; curl: number; jitter: number; merge: number; aspect: number }

function camera(r: Rand): Camera {
  return {
    deg: (r() * 2 - 1) * 6,
    keystone: (r() * 2 - 1) * 0.25,
    curl: r() * 0.012,
    jitter: r() * 0.0015,
    merge: pick(r, [0, 0.3, 0.8]), // chance that neighbouring fragments come back as one observation
    aspect: 1.5,
  };
}

function render(rows: PrintedRow[], cam: Camera, r: Rand): { lines: OcrLine[]; rowOf: number[] } {
  const pitch = 0.026;
  const top = 0.06;
  const map = (x: number, y: number): [number, number] => {
    // page -> pixels (width 1000) with curl and keystone, then rotation about the centre
    const W = 1000;
    const H = W * cam.aspect;
    let X = x * W;
    let Y = y * H + cam.curl * H * Math.sin(Math.PI * x);
    X = W / 2 + (X - W / 2) * (1 + cam.keystone * (Y - H / 2) / H);
    const th = (cam.deg * Math.PI) / 180;
    const dx = X - W / 2;
    const dy = Y - H / 2;
    return [(W / 2 + dx * Math.cos(th) - dy * Math.sin(th)) / W, (H / 2 + dx * Math.sin(th) + dy * Math.cos(th)) / H];
  };
  const out: OcrLine[] = [];
  const rowIds: number[] = [];
  let y = top;
  for (const [rowIndex, row] of rows.entries()) {
    const size = Math.max(...row.map((p) => p.size ?? 1));
    // Pieces left to right with their page extents.
    const placed = row
      .map((p) => {
        const w = p.text.length * CHAR * (p.size ?? 1);
        const x0 = p.right ? p.x - w : p.x;
        return { text: p.text, x0, x1: x0 + w, h: 0.014 * (p.size ?? 1) };
      })
      .sort((a, b) => a.x0 - b.x0);
    // Vision returns close neighbours as one observation, sometimes.
    const groups: typeof placed[] = [];
    for (const p of placed) {
      const g = groups[groups.length - 1];
      if (g && p.x0 - g[g.length - 1]!.x1 < 0.12 && chance(r, cam.merge)) g.push(p);
      else groups.push([p]);
    }
    for (const g of groups) {
      const x0 = g[0]!.x0;
      const x1 = g[g.length - 1]!.x1;
      const h = Math.max(...g.map((p) => p.h));
      const yTop = y + (r() * 2 - 1) * cam.jitter;
      const corners = [map(x0, yTop), map(x1, yTop), map(x1, yTop + h), map(x0, yTop + h)];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const words = g.flatMap((p) => {
        let at = p.x0;
        return p.text.split(' ').filter(Boolean).map((word) => {
          const wx0 = at;
          const wx1 = at + word.length * CHAR * (p.x1 - p.x0) / Math.max(1, p.text.length * CHAR);
          at = wx1 + CHAR;
          const c = [map(wx0, yTop), map(wx1, yTop), map(wx1, yTop + h), map(wx0, yTop + h)];
          const minX = Math.min(...c.map((q) => q[0]));
          const minY = Math.min(...c.map((q) => q[1]));
          return { text: word, x: minX, y: minY, w: Math.max(...c.map((q) => q[0])) - minX, h: Math.max(...c.map((q) => q[1])) - minY };
        });
      });
      out.push({
        text: g.map((p) => p.text).join(' '),
        x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
        confidence: 0.75 + r() * 0.25,
        quad: corners.flat(),
        words,
      });
      rowIds.push(rowIndex);
    }
    y += pitch * LINE * Math.max(1, size * 0.9);
  }
  // Vision does not return observations in reading order.
  const order = out.map((_, i) => i).sort(() => r() - 0.5);
  return { lines: order.map((i) => out[i]!), rowOf: order.map((i) => rowIds[i]!) };
}

/** OCR damage: one digit of one amount misread (with the right reading as a runner-up, sometimes), a lost fragment. */
function corrupt(lines: OcrLine[], r: Rand): { lines: OcrLine[]; tags: string[] } {
  const tags: string[] = [];
  let out = lines;
  if (chance(r, 0.15)) {
    const amounts = out.filter((l) => /\d+[.,٫]\d\d/.test(l.text));
    const victim = amounts.length ? pick(r, amounts) : undefined;
    if (victim) {
      const swap: Record<string, string> = { '0': '8', '8': '6', '6': '8', '1': '7', '7': '1', '5': '6', '3': '8', '9': '4', '4': '9', '2': '7' };
      const at = [...victim.text].map((c, i) => (/\d/.test(c) ? i : -1)).filter((i) => i >= 0);
      const i = pick(r, at);
      const text = victim.text.slice(0, i) + (swap[victim.text[i]!] ?? '8') + victim.text.slice(i + 1);
      const keep = chance(r, 0.5);
      // Word boxes carry the same (wrong) reading as the line: the scanner derives them from one string.
      const parts = text.split(' ').filter(Boolean);
      const words = victim.words?.length === parts.length ? victim.words.map((w, k) => ({ ...w, text: parts[k]! })) : victim.words;
      out = out.map((l) => (l === victim ? { ...l, text, words, confidence: 0.5 + r() * 0.3, ...(keep ? { alternates: [victim.text], alternateConfidences: [0.4] } : {}) } : l));
      tags.push(keep ? 'misread-with-runner-up' : 'misread');
    }
  }
  if (chance(r, 0.05) && out.length > 10) {
    const gone = Math.floor(r() * out.length);
    out = out.filter((_, i) => i !== gone);
    tags.push('lost-fragment');
  }
  return { lines: out, tags };
}

/** A fixed, reproducible synthetic set: `count` receipts spread over every template. */
export function syntheticSet(count: number, seed = 20251103): Fixture[] {
  const out: Fixture[] = [];
  for (let n = 0; n < count; n++) {
    const r = rng(seed + n * 7919);
    const name = TEMPLATE_NAMES[n % TEMPLATE_NAMES.length]!;
    const built = TEMPLATES[name]!(r);
    const cam = camera(r);
    const damaged = corrupt(render(built.rows, cam, r).lines, r);
    const tilt = Math.abs(cam.deg) > 3 || Math.abs(cam.keystone) > 0.15 || cam.curl > 0.008 ? 'distorted' : 'mild';
    out.push({
      id: `synthetic-${name}-${n}`,
      source: 'synthetic',
      split: 'holdout',
      description: `${name}, ${cam.deg.toFixed(1)} deg, keystone ${cam.keystone.toFixed(2)}, curl ${cam.curl.toFixed(3)}, merge ${cam.merge}`,
      reviewed: true,
      tags: [name, ...built.tags, tilt, ...damaged.tags],
      input: { kind: 'dump', dump: { v: 2, w: 1000, h: 1500, lines: damaged.lines.map(toDump) } },
      truth: built.truth,
    });
  }
  return out;
}

function toDump(l: OcrLine) {
  return {
    t: l.text, x: l.x, y: l.y, w: l.w, h: l.h, c: l.confidence,
    ...(l.alternates ? { a: l.alternates, ac: l.alternateConfidences } : {}),
    ...(l.quad ? { q: l.quad } : {}),
    ...(l.words ? { wd: l.words.map((w) => [w.text, w.x, w.y, w.w, w.h]) } : {}),
  };
}

/** Pages for testing layout: the observations and, for each, the printed row it came from. */
export function syntheticPages(count: number, seed = 777): Array<{ name: string; lines: OcrLine[]; rowOf: number[]; cam: Camera }> {
  return Array.from({ length: count }, (_, n) => {
    const r = rng(seed + n * 104729);
    const name = TEMPLATE_NAMES[n % TEMPLATE_NAMES.length]!;
    const built = TEMPLATES[name]!(r);
    const cam = camera(r);
    return { name, cam, ...render(built.rows, cam, r) };
  });
}
