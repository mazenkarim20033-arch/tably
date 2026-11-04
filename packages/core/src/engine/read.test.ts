import { describe, expect, it } from 'vitest';
import type { OcrLine } from '../receipt';
import { reconcile } from '../reconcile';
import { readReceipt, roleOf } from './index';

/**
 * Rows of [text, x-left] pieces on a straight page; each piece is one scanner observation. A negative x means
 * right-aligned at -x (prices, right-to-left names).
 */
function page(rows: Array<Array<[string, number]>>, pitch = 0.035): OcrLine[] {
  const out: OcrLine[] = [];
  rows.forEach((row, n) => {
    for (const [text, x] of row) {
      const w = text.length * 0.012;
      out.push({ text, x: x < 0 ? -x - w : x, y: 0.05 + n * pitch, w, h: 0.016, confidence: 0.95 });
    }
  });
  return out;
}
const items = (lines: OcrLine[]) => readReceipt(lines).items.map((i) => [i.description, i.quantity, i.lineTotal]);

describe('line roles: from the most specific meaning to the least', () => {
  it.each([
    ['V.A.T 14%', true, 'tax'],
    ['Tax Total', true, 'tax'],
    ['Total Qty', true, 'count'],
    ['Min Charge', true, 'count'],
    ['Sub-Total', true, 'subtotal'],
    ['Total Due', true, 'total'],
    ['Service Charge 12%', true, 'service'],
    ['Tbl 52/1 Chk 5453 Gst 2', false, 'meta'],
    ['TAX INVOICE', false, 'meta'],
    ['Cash', true, 'payment'],
    ['ضريبة القيمة المضافة', true, 'tax'],
    ['الاجمالي', true, 'total'],
    ['Item Qty Price Total', false, 'header'],
    ['Grilled Chicken', true, 'text'],
  ])('%s -> %s', (text, hasAmount, role) => {
    expect(roleOf(text, hasAmount)).toBe(role);
  });
});

describe('pairing on the reconstructed lines', () => {
  it('reads a price printed before the name, with "x2" quantities', () => {
    const r = page([
      [['CAFE', 0.3]],
      [['45.00', 0.06], ['Iced Latte x3', 0.3]],
      [['20.00', 0.06], ['Water', 0.3]],
      [['Subtotal', 0.3], ['65.00', -0.92]],
      [['Total', 0.3], ['65.00', -0.92]],
    ]);
    expect(items(r)).toEqual([['Iced Latte', 3, 4500], ['Water', 1, 2000]]);
  });

  it('takes the line total from the column that is quantity x unit price', () => {
    const r = page([
      [['SHOP', 0.3]],
      [['Item', 0.05], ['Qty', 0.5], ['Price', 0.66], ['Total', 0.84]],
      [['Falafel', 0.05], ['4', 0.52], ['33.00', -0.74], ['132.00', -0.94]],
      [['Tea', 0.05], ['2', 0.52], ['15.00', -0.74], ['30.00', -0.94]],
      [['Total', 0.4], ['162.00', -0.94]],
    ]);
    expect(items(r)).toEqual([['Falafel', 4, 13200], ['Tea', 2, 3000]]);
  });

  it('joins a wrapped name whose price is on its last line', () => {
    const r = page([
      [['BISTRO', 0.3]],
      [['2 Chocolate Fudge Cake with', 0.06]],
      [['Vanilla Ice Cream', 0.1], ['190.00', -0.93]],
      [['Lentil Soup', 0.06], ['60.00', -0.93]],
      [['Total', 0.35], ['250.00', -0.93]],
    ]);
    expect(items(r)).toEqual([['Chocolate Fudge Cake with Vanilla Ice Cream', 2, 19000], ['Lentil Soup', 1, 6000]]);
  });

  it('gives an item the quantity and unit price of the "2 @ 15.00" line under it', () => {
    const r = page([
      [['DELI', 0.3]],
      [['PEPSI', 0.06], ['30.00', -0.93]],
      [['2 @ 15.00', 0.12]],
      [['CHIPS', 0.06], ['20.00', -0.93]],
      [['TOTAL', 0.35], ['50.00', -0.93]],
    ]);
    const rc = readReceipt(r);
    expect(rc.items.map((i) => [i.description, i.quantity, i.lineTotal, i.unitPrice])).toEqual([['PEPSI', 2, 3000, 1500], ['CHIPS', 1, 2000, 2000]]);
  });

  it('pairs each value with the label printed above it in a summary box', () => {
    const r = page([
      [['Items', 0.1], ['Service', 0.42], ['Tax', 0.74]],
      [['985.00', 0.08], ['0.00', 0.44], ['137.90', 0.72]],
      [['Total :', 0.12], ['1122.90', 0.5]],
      [['Item', 0.18], ['Qty', 0.5], ['Price', 0.6], ['Total', 0.78]],
      [['Club Sandwich', 0.08], ['1', 0.52], ['135.00', -0.7], ['135.00', -0.88]],
      [['Omelette', 0.08], ['10', 0.52], ['85.00', -0.7], ['850.00', -0.88]],
    ]);
    const rc = readReceipt(r);
    expect([rc.subtotal, rc.tax, rc.total]).toEqual([98500, 13790, 112290]);
    expect(rc.items.map((i) => [i.quantity, i.lineTotal])).toEqual([[1, 13500], [10, 85000]]);
    expect(reconcile(rc).status).toBe('ok');
  });

  it('keeps numbers inside a name in the name', () => {
    const r = page([
      [['Qty', 0.05], ['Description', 0.29], ['Price', 0.53], ['Total', 0.77]],
      [['1.0', 0.05], ['Fire roll 5 Pieces', 0.29], ['50.00', 0.53], ['50.00', 0.77]],
      [['1.0', 0.05], ['Crispy Oboro 4 Pieces', 0.29], ['49.00', 0.53], ['49.00', 0.77]],
      [['Sub Total', 0.05], ['99.00', 0.53]],
    ]);
    expect(items(r)).toEqual([['Fire roll 5 Pieces', 1, 5000], ['Crispy Oboro 4 Pieces', 1, 4900]]);
  });

  it('reads a right-to-left Arabic table: names on the right, amounts on the left', () => {
    const r = page([
      [['مطعم النيل', -0.7]],
      [['طعمية', -0.94], ['2', 0.47], ['20.00', 0.06]],
      [['فول بالزيت', -0.94], ['1', 0.47], ['25.00', 0.06]],
      [['الاجمالي', -0.94], ['45.00', 0.06]],
    ]);
    expect(items(r)).toEqual([['طعمية', 2, 2000], ['فول بالزيت', 1, 2500]]);
  });

  it('does not turn addresses, phones, dates or payment lines into items', () => {
    const r = page([
      [['NILE GRILL', 0.3]],
      [['14 Tahrir Square', 0.2]],
      [['Tel: 0227356841', 0.25]],
      [['Date: 12/03/2025', 0.06], ['20:41', -0.94]],
      [['Kofta', 0.06], ['120.00', -0.93]],
      [['Total', 0.3], ['120.00', -0.93]],
      [['Cash', 0.1], ['200.00', -0.93]],
      [['Change', 0.1], ['80.00', -0.93]],
    ]);
    expect(items(r)).toEqual([['Kofta', 1, 12000]]);
    expect(readReceipt(r).total).toBe(12000);
  });
});
