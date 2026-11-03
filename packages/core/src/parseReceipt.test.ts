import { describe, expect, it } from 'vitest';
import { parseReceipt } from './parseReceipt';
import { reconcile } from './reconcile';
import type { OcrLine } from './receipt';

/** Build OCR lines from plain text rows; a "|" splits a row into left/right fragments like Vision does. */
function ocr(rows: string[], conf = 0.95): OcrLine[] {
  const out: OcrLine[] = [];
  rows.forEach((row, i) => {
    const y = 0.05 + i * 0.04;
    const parts = row.split('|');
    parts.forEach((p, j) =>
      out.push({ text: p, x: j === 0 ? 0.05 : 0.7, y, w: 0.3, h: 0.025, confidence: conf }),
    );
  });
  return out;
}

describe('parseReceipt (English, tax added on top)', () => {
  const r = parseReceipt(
    ocr([
      'ZOOBA ZAMALEK',
      'Date: 03/11/2026 21:14',
      'Falafel Sandwich|85.00',
      '2 x Mango Juice|120.00',
      'Koshari Bowl|75.00',
      'Subtotal|280.00',
      'Service 12%|33.60',
      'VAT 14%|39.20',
      'Total|352.80',
      'Cash|400.00',
      'Change|47.20',
    ]),
  );
  it('reads header fields', () => {
    expect(r.merchant).toBe('ZOOBA ZAMALEK');
    expect(r.date).toBe('2026-11-03');
  });
  it('reads items with quantities', () => {
    expect(r.items.map((i) => [i.description, i.quantity, i.lineTotal])).toEqual([
      ['Falafel Sandwich', 1, 8500],
      ['Mango Juice', 2, 12000],
      ['Koshari Bowl', 1, 7500],
    ]);
    expect(r.items[1]!.unitPrice).toBe(6000);
  });
  it('reads totals and ignores payment rows', () => {
    expect([r.subtotal, r.service, r.tax, r.total]).toEqual([28000, 3360, 3920, 35280]);
    expect(r.items.some((i) => /cash|change/i.test(i.description))).toBe(false);
  });
  it('reconciles', () => {
    expect(reconcile(r).status).toBe('ok');
  });
});

describe('parseReceipt (Arabic digits and keywords)', () => {
  const r = parseReceipt(
    ocr(['مطعم الشاطر', 'التاريخ ٠٣/١١/٢٠٢٦', 'كشري|٧٥٫٠٠', 'عصير مانجو|٦٠٫٥٠', 'ضريبة|١٩٫٠٠', 'الاجمالي|١٥٤٫٥٠']),
  );
  it('parses', () => {
    expect(r.merchant).toBe('مطعم الشاطر');
    expect(r.date).toBe('2026-11-03');
    expect(r.items.map((i) => i.lineTotal)).toEqual([7500, 6050]);
    expect(r.tax).toBe(1900);
    expect(r.total).toBe(15450);
    expect(reconcile(r).status).toBe('ok');
  });
});

describe('inclusive tax detection', () => {
  const r = parseReceipt(ocr(['CAFE X', 'Latte|60.00', 'Cake|40.00', 'VAT 14% included|12.28', 'Total|100.00']));
  it('only marks tax included when the numbers prove it', () => {
    expect(r.taxIncluded).toBe(true);
    expect(reconcile(r).status).toBe('ok');
  });
});

describe('honesty about bad input', () => {
  it('reports a mismatch instead of fixing it', () => {
    const r = parseReceipt(ocr(['CAFE X', 'Latte|60.00', 'Cake|40.00', 'Total|110.00']));
    const rec = reconcile(r);
    expect(rec.status).toBe('mismatch');
    expect(rec.difference).toBe(1000);
  });
  it('keeps unreadable prices null and flagged', () => {
    const r = parseReceipt(ocr(['CAFE X', 'Latte|6O.00', 'Cake|40.00', 'Total|100.00']));
    expect(r.unparsed.join(' ')).toContain('Latte');
    expect(r.items).toHaveLength(1);
    expect(reconcile(r).status).toBe('mismatch');
  });
  it('does not invent unit price when not divisible', () => {
    const r = parseReceipt(ocr(['CAFE X', '3 x Juice|100.00', 'Total|100.00']));
    expect(r.items[0]!.unitPrice).toBeNull();
    expect(r.items[0]!.flags).toContain('unit-price-unknown');
  });
  it('flags missing total and ambiguous date', () => {
    const r = parseReceipt(ocr(['CAFE X', '04/05/2026', 'Latte|60.00']));
    expect(r.total).toBeNull();
    expect(r.uncertain).toContain('total');
    expect(r.uncertain).toContain('date');
    expect(reconcile(r).status).toBe('incomplete');
  });
  it('flags low-confidence rows', () => {
    const r = parseReceipt(ocr(['CAFE X', 'Latte|60.00', 'Total|60.00'], 0.4));
    expect(r.items[0]!.flags).toContain('low-ocr-confidence');
  });
});
