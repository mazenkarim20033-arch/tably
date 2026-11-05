import { describe, expect, it } from 'vitest';
import { parseReceipt } from './parseReceipt';
import { reconcile } from './reconcile';
import type { OcrLine } from './receipt';

/**
 * Rows as Apple Vision returns them: each "|" separates fragments on the same line, placed left to right.
 * `h` lets a test make one row taller (bigger text), like a store name.
 */
function ocr(rows: Array<string | { text: string; h: number }>): OcrLine[] {
  const out: OcrLine[] = [];
  let y = 0.04;
  for (const row of rows) {
    const { text, h } = typeof row === 'string' ? { text: row, h: 0.022 } : row;
    text.split('|').forEach((part, j) => {
      out.push({ text: part, x: 0.05 + j * 0.24, y, w: 0.2, h, confidence: 0.95 });
    });
    y += h + 0.018;
  }
  return out;
}

const items = (r: ReturnType<typeof parseReceipt>) => r.items.map((i) => [i.description, i.quantity, i.lineTotal]);

describe('real receipt: TakeAway, Egypt (no total line, no store name, Qty/Description/Price/Total table)', () => {
  const r = parseReceipt(
    ocr([
      '27066|2',
      'TakeAway',
      '1',
      'Cash',
      'Shift: Morning',
      'Date: 15/11/2020|Time:05:25:09 a',
      'Casheir :User',
      'Qty|Description|Price|Total',
      '1.0|Ballston roll|69.00|69.00',
      '1.0|Fire roll 5 Pieces|50.00|50.00',
      '1.0|Crispy Oboro 4 Pieces|49.00|49.00',
      '1.0|Spicy Pinky 4 pieces|49.00|49.00',
      'Sub Total|217.00',
      'Tax|0.00',
      'DISC.|0.00',
    ]),
  );

  it('reads every item with its quantity, and ignores the header row', () => {
    expect(items(r)).toEqual([
      ['Ballston roll', 1, 6900],
      ['Fire roll 5 Pieces', 1, 5000],
      ['Crispy Oboro 4 Pieces', 1, 4900],
      ['Spicy Pinky 4 pieces', 1, 4900],
    ]);
    expect(r.unparsed.join(' ')).not.toMatch(/Description/);
  });

  it('calculates the missing total from the subtotal, says so, and reconciles', () => {
    expect(r.subtotal).toBe(21700);
    expect(r.total).toBe(21700);
    // the items add up to the printed subtotal, so the calculated total needs no warning
    expect(r.uncertain).not.toContain('total');
    expect(r.notes.join(' ')).toMatch(/No total line/);
    expect(reconcile(r).status).toBe('ok');
  });

  it('does not invent a store name from "TakeAway", "Cash" or "Shift"', () => {
    expect(r.merchant).toBeNull();
    expect(r.uncertain).toContain('merchant');
    expect(r.notes.join(' ')).toMatch(/No store name/);
  });

  it('reads the day-first date', () => {
    expect(r.date).toBe('2020-11-15');
  });
});

describe('Arabic receipt photographed right to left (prices first, then the name)', () => {
  const r = parseReceipt(
    ocr([
      { text: 'مطعم ابو طارق', h: 0.04 },
      'القاهرة',
      '٧٥٫٠٠|كشري كبير',
      '١٢٠٫٠٠|٦٠٫٠٠|عصير مانجو ٢',
      '١٩٥٫٠٠|الاجمالي',
    ]),
  );
  it('reads prices on the left and the quantity after the name', () => {
    expect(items(r)).toEqual([
      ['كشري كبير', 1, 7500],
      ['عصير مانجو', 2, 12000],
    ]);
    expect(r.items[1]!.unitPrice).toBe(6000);
    expect(r.total).toBe(19500);
    expect(r.merchant).toBe('مطعم ابو طارق');
    expect(reconcile(r).status).toBe('ok');
  });
});

describe('labels and amounts on separate lines', () => {
  it('joins "TOTAL" with the amount printed under it', () => {
    const r = parseReceipt(ocr(['CAFE X', 'Latte|60.00', 'Cake|40.00', 'TOTAL', '100.00']));
    expect(r.total).toBe(10000);
    expect(reconcile(r).status).toBe('ok');
  });
  it('does not glue a random number under a header word into an item', () => {
    const r = parseReceipt(ocr(['CAFE X', 'TakeAway', '1', 'Latte|60.00', 'Total|60.00']));
    expect(items(r)).toEqual([['Latte', 1, 6000]]);
  });
});

describe('choosing between several total lines', () => {
  it('prefers a strong label and ignores item counts', () => {
    const r = parseReceipt(
      ocr([
        'GRILL HOUSE',
        'Burger|150.00',
        'Fries|50.00',
        'Total Qty|2',
        'Total|200.00',
        'Service 12%|24.00',
        'VAT 14%|31.36',
        'Grand Total|255.36',
        'Cash|300.00',
        'Change|44.64',
      ]),
    );
    expect(r.total).toBe(25536);
    expect(reconcile(r).status).toBe('ok');
  });
});

describe('item column layouts', () => {
  it('reads [qty, unit price, line total] after the name', () => {
    const r = parseReceipt(ocr(['SHOP', 'Pepsi|2|15.00|30.00', 'Chips|1|20.00|20.00', 'Total|50.00']));
    expect(items(r)).toEqual([
      ['Pepsi', 2, 3000],
      ['Chips', 1, 2000],
    ]);
    expect(r.items[0]!.unitPrice).toBe(1500);
  });
  it('reads "2 x Item" and "Item x2"', () => {
    const r = parseReceipt(ocr(['SHOP', '2 x Tea|20.00', 'Coffee x3|45.00', 'Total|65.00']));
    expect(items(r)).toEqual([
      ['Tea', 2, 2000],
      ['Coffee', 3, 4500],
    ]);
  });
});

describe('store name', () => {
  it('picks the largest text at the top over smaller lines', () => {
    const r = parseReceipt(
      ocr(['Welcome to', { text: 'KAZOKU SUSHI', h: 0.045 }, '12 Nile St, Zamalek', 'Roll|90.00', 'Total|90.00']),
    );
    expect(r.merchant).toBe('KAZOKU SUSHI');
  });
});

describe('currency hints', () => {
  it('uses a printed currency and only assumes when nothing is printed', () => {
    expect(parseReceipt(ocr(['SHOP', 'Tea|20.00 EGP', 'Total|20.00 EGP'])).currency).toBe('EGP');
    const assumed = parseReceipt(ocr(['SHOP', 'Tea|20.00', 'Total|20.00']));
    expect(assumed.uncertain).toContain('currency');
    expect(assumed.notes.join(' ')).toMatch(/assumed EGP/);
  });
  it('guesses USD from a US address, and flags the guess', () => {
    const r = parseReceipt(ocr(['DINER', 'LAKE GENEVA, WI 53147', 'Pie|5.00', 'Total|5.00']));
    expect(r.currency).toBe('USD');
    expect(r.uncertain).toContain('currency');
  });
});
