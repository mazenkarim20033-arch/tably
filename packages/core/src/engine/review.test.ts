import { describe, expect, it } from 'vitest';
import type { OcrLine, Receipt } from '../receipt';
import { setField, setItemLineTotal } from '../receiptEdit';
import { readReceipt } from './index';

/** Rows of [text, x] pieces on a straight page (negative x: right-aligned at -x); a third value sets confidence and
 *  a fourth gives runner-up readings with their confidences. */
type Piece = [string, number, number?, Array<[string, number]>?];
function page(rows: Piece[][]): OcrLine[] {
  const out: OcrLine[] = [];
  rows.forEach((row, n) => {
    for (const [text, x, conf, alts] of row) {
      const w = text.length * 0.012;
      out.push({
        text, x: x < 0 ? -x - w : x, y: 0.05 + n * 0.035, w, h: 0.016, confidence: conf ?? 0.95,
        ...(alts ? { alternates: alts.map((a) => a[0]), alternateConfidences: alts.map((a) => a[1]) } : {}),
      });
    }
  });
  return out;
}
const item = (rc: Receipt, name: string) => rc.items.find((i) => i.description.startsWith(name))!;

describe('disputed fields get a reason and one-tap choices, never a silent change', () => {
  it('names each price a misread digit could explain when there is more than one', () => {
    // The items come to 520.00 against a printed 500.00. 80.00 could be 60.00 and 385.00 could be 365.00: either
    // makes the subtotal, so the parser must not pick.
    const rc = readReceipt(page([
      [['CAFE', 0.3]],
      [['Tea', 0.06], ['80.00', -0.93]],
      [['Kofta', 0.06], ['385.00', -0.93]],
      [['Rice', 0.06], ['55.00', -0.93]],
      [['Subtotal', 0.3], ['500.00', -0.93]],
      [['Total', 0.3], ['500.00', -0.93]],
    ]));
    expect(item(rc, 'Tea').lineTotal).toBe(8000);
    expect(item(rc, 'Tea').choices).toContain(6000);
    expect(item(rc, 'Kofta').choices).toContain(36500);
    expect(rc.uncertain).toEqual(expect.arrayContaining([`items.${item(rc, 'Tea').id}.lineTotal`, `items.${item(rc, 'Kofta').id}.lineTotal`]));
    expect(rc.reasons?.[`items.${item(rc, 'Tea').id}.lineTotal`]).toMatch(/misread/);
  });

  it('offers quantity x unit price on a line total one digit away from it', () => {
    const rc = readReceipt(page([
      [['DELI', 0.3]],
      [['HAWAWSHI', 0.06], ['660.08', -0.93]],
      [['4 @ 165.00', 0.12]],
      [['CHIPS', 0.06], ['20.00', -0.93]],
      [['TOTAL', 0.35], ['680.00', -0.93]],
    ]));
    const h = item(rc, 'HAWAWSHI');
    expect(h.lineTotal).toBe(66008);
    expect(h.choices).toContain(66000);
    expect(rc.reasons?.[`items.${h.id}.lineTotal`]).toMatch(/4 x 165\.00 is 660\.00/);
  });

  it('flags a charge that is not the printed percentage of the subtotal', () => {
    const rc = readReceipt(page([
      [['GRILL', 0.3]],
      [['Burger', 0.06], ['150.00', -0.93]],
      [['Fries', 0.06], ['50.00', -0.93]],
      [['Subtotal', 0.3], ['200.00', -0.93]],
      [['Service 12%', 0.3], ['42.00', -0.93]],
      [['Total', 0.3], ['242.00', -0.93]],
    ]));
    expect(rc.service).toBe(4200);
    expect(rc.uncertain).toContain('service');
    expect(rc.reasons?.service).toMatch(/12%/);
  });

  it('does not flag a charge that matches its percentage', () => {
    const rc = readReceipt(page([
      [['GRILL', 0.3]],
      [['Burger', 0.06], ['150.00', -0.93]],
      [['Fries', 0.06], ['50.00', -0.93]],
      [['Subtotal', 0.3], ['200.00', -0.93]],
      [['Service 12%', 0.3], ['24.00', -0.93]],
      [['VAT 14%', 0.3], ['31.36', -0.93]],
      [['Total', 0.3], ['255.36', -0.93]],
    ]));
    expect(rc.uncertain).not.toContain('service');
    expect(rc.uncertain).not.toContain('tax');
  });

  it('suggests the one total field a misread digit would fix when subtotal and charges do not add up', () => {
    const rc = readReceipt(page([
      [['GRILL', 0.3]],
      [['Burger', 0.06], ['150.00', -0.93]],
      [['Fries', 0.06], ['50.00', -0.93]],
      [['Subtotal', 0.3], ['200.00', -0.93]],
      [['VAT', 0.3], ['26.00', -0.93]],
      [['Total', 0.3], ['228.00', -0.93]],
    ]));
    // 200 + 26 = 226, printed 228: the VAT may be 28.00 (6 read for 8), or the total 226.00 (8 read for 6).
    expect(rc.fieldChoices?.tax).toContain(2800);
    expect(rc.uncertain).toContain('tax');
  });

  it("turns the scanner's own near-tie runner-up into a choice", () => {
    const rc = readReceipt(page([
      [['CAFE', 0.3]],
      [['Latte', 0.06], ['60.00', -0.93, 0.8, [['80.00', 0.75]]]],
      [['Water', 0.06], ['20.00', -0.93]],
      [['Total', 0.3], ['80.00', -0.93]],
    ]));
    const l = item(rc, 'Latte');
    expect(l.choices).toEqual([8000]);
    expect(rc.uncertain).toContain(`items.${l.id}.lineTotal`);
  });

  it('accepting a choice settles the field', () => {
    const rc = readReceipt(page([
      [['CAFE', 0.3]],
      [['Latte', 0.06], ['60.00', -0.93, 0.8, [['80.00', 0.75]]]],
      [['Water', 0.06], ['20.00', -0.93]],
      [['Total', 0.3], ['80.00', -0.93]],
    ]));
    const l = item(rc, 'Latte');
    const next = setItemLineTotal(rc, l.id, 8000);
    expect(next.items.find((i) => i.id === l.id)!.choices).toBeUndefined();
    expect(next.uncertain).not.toContain(`items.${l.id}.lineTotal`);
    expect(next.reasons?.[`items.${l.id}.lineTotal`]).toBeUndefined();
    const withTotals = setField({ ...rc, fieldChoices: { tax: [100] }, uncertain: ['tax'], reasons: { tax: 'x' } }, 'tax', 100);
    expect(withTotals.fieldChoices?.tax).toBeUndefined();
    expect(withTotals.reasons?.tax).toBeUndefined();
  });
});
