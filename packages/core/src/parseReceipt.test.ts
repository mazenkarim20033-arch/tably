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

describe('real receipt: Popeyes, Lake Geneva (US, month-first date, POS style rows)', () => {
  // Rows as Apple Vision reads them from the photo: item names left, prices right.
  const r = parseReceipt(
    ocr([
      'POPEYES',
      '811 WRIGLEY DRIVE',
      'LAKE GENEVA, WI 53147',
      '262-248-4381',
      'WWW.POPEYESLKG.COM',
      '1488 1488Kale',
      "Tbl 52/1  Chk 5453  Gst 2",
      "Jun25'21 07:21PM",
      '1 SANGRIA|11.99',
      '1 TITO VODKA|8.99',
      '1 CRAB LEG 1.5LB|200.00',
      '1 PORK BBQ SAND|15.99',
      'Subtotal|236.97',
      'Tax Total|13.03',
      '08:01PM Total Due|250.00',
      'THANK YOU FOR JOINING US',
      'PLEASE PAY YOUR SERVER',
      'WWW.POPEYESLKG.COM',
      'SIGN UP FOR OUR VIP LIST',
      'FRI:06/25/21 19:21:31',
    ]),
  );
  it('does not turn the ZIP code or the guest count into items or tax', () => {
    expect(r.items.map((i) => [i.description, i.quantity, i.lineTotal])).toEqual([
      ['SANGRIA', 1, 1199],
      ['TITO VODKA', 1, 899],
      ['CRAB LEG 1.5LB', 1, 20000],
      ['PORK BBQ SAND', 1, 1599],
    ]);
  });
  it('reads the totals, the date and reconciles exactly', () => {
    expect([r.subtotal, r.tax, r.total]).toEqual([23697, 1303, 25000]);
    expect(r.merchant).toBe('POPEYES');
    expect(r.date).toBe('2021-06-25');
    expect(reconcile(r).status).toBe('ok');
  });
});

describe('stray rows', () => {
  it('flags a lone row whose removal makes the items match the subtotal, but keeps it', () => {
    const r = parseReceipt(ocr(['CAFE X', 'Latte|60.00', 'Cake|40.00', 'Mystery thing|25.00', 'Subtotal|100.00', 'Total|100.00']));
    const mystery = r.items.find((i) => i.description === 'Mystery thing')!;
    expect(r.items).toHaveLength(3); // an unrelated amount is never removed on a guess
    expect(mystery.flags).toContain('does-not-add-up');
    expect(r.uncertain).toContain(`items.${mystery.id}.lineTotal`);
    expect(r.items.filter((i) => i.flags.includes('does-not-add-up'))).toHaveLength(1);
  });
  it('leaves out a row that is the same amount as all the other items together: it is the subtotal itself', () => {
    const r = parseReceipt(ocr(['CAFE X', 'Latte|60.00', 'Cake|40.00', 'Subtota|100.00', 'Subtotal|100.00', 'Total|100.00']));
    expect(r.items.map((i) => i.description)).toEqual(['Latte', 'Cake']);
    expect(r.notes.join(' ')).toMatch(/Left out "Subtota" \(100\.00\)/);
    expect(r.unparsed.join(' ')).toMatch(/Subtota 100\.00/); // still listed, so it can be added back
    expect(reconcile(r).status).toBe('ok');
  });
  it('does not guess when more than one explanation fits', () => {
    // Removing A and B fits, but so does reading C as 30.00: two explanations, so neither is offered.
    const r = parseReceipt(ocr(['CAFE X', 'A|10.00', 'B|10.00', 'C|50.00', 'Subtotal|50.00', 'Total|50.00']));
    expect(r.items.some((i) => i.flags.includes('does-not-add-up') || i.flags.includes('maybe-misread'))).toBe(false);
    expect(r.notes.join(' ')).toMatch(/more than one price/);
    // Removing any one of A, B or C fits: ambiguous.
    const r2 = parseReceipt(ocr(['CAFE X', 'A|10.00', 'B|10.00', 'C|10.00', 'Subtotal|20.00', 'Total|20.00']));
    expect(r2.items.some((i) => i.flags.includes('does-not-add-up'))).toBe(false);
  });
  it('leaves receipts that already add up alone', () => {
    const r = parseReceipt(ocr(['CAFE X', 'Latte|60.00', 'Cake|40.00', 'Subtotal|100.00', 'Total|100.00']));
    expect(r.items.some((i) => i.flags.includes('does-not-add-up'))).toBe(false);
  });
});

describe('whole-number prices still work', () => {
  it('accepts integers on receipts that print no decimals', () => {
    const r = parseReceipt(ocr(['مطعم', 'كشري|75', 'عصير|60', 'الاجمالي|135']));
    expect(r.items.map((i) => i.lineTotal)).toEqual([7500, 6000]);
    expect(reconcile(r).status).toBe('ok');
  });
});

describe('dates', () => {
  it('reads US month-first when only that is valid, and flags truly ambiguous ones', () => {
    expect(parseReceipt(ocr(['CAFE X', '06/25/2021', 'Latte|60.00'])).date).toBe('2021-06-25');
    expect(parseReceipt(ocr(['CAFE X', '25/06/2021', 'Latte|60.00'])).date).toBe('2021-06-25');
    expect(parseReceipt(ocr(['CAFE X', '04/05/2021', 'Latte|60.00'])).uncertain).toContain('date');
  });
});
