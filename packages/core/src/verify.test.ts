import { describe, expect, it } from 'vitest';
import { applyAnswers, parseVerifyReply, verifyTargets } from './verify';
import { reconcile } from './reconcile';
import { emptyReceipt } from './receiptEdit';
import type { OcrLine, Receipt, ReceiptItem } from './receipt';

const line = (text: string, y: number, alternates?: string[]): OcrLine => ({ text, x: 0.1, y, w: 0.8, h: 0.03, confidence: 0.9, alternates });
const item = (id: string, description: string, lineTotal: number, extra: Partial<ReceiptItem> = {}): ReceiptItem =>
  ({ id, description, quantity: 1, unitPrice: lineTotal, lineTotal, confidence: 0.9, flags: [], ...extra });

/** Tea 20.00, Cake read as 85.00 but printed 55.00; total 75.00. */
function receipt(): Receipt {
  return {
    ...emptyReceipt(), total: 7500, subtotal: 7500,
    items: [item('i1', 'Tea', 2000), item('i2', 'Cake', 8500, { choices: [5500] })],
    uncertain: ['items.i2.lineTotal'],
  };
}
const ocr = [line('Tea 20.00', 0.1), line('Cake 85.00', 0.2, ['Cake 55.00']), line('Total 75.00', 0.5)];

describe('parseVerifyReply', () => {
  it('reads an amount from JSON in text', () => {
    expect(parseVerifyReply('```json\n{"amount":"55.00"}\n```')).toBe(5500);
    expect(parseVerifyReply({ amount: 55 })).toBe(5500);
  });
  it('gives null for nothing readable', () => {
    expect(parseVerifyReply('{"amount":null}')).toBeNull();
    expect(parseVerifyReply('no idea')).toBeNull();
  });
});

describe('verifyTargets', () => {
  it('picks the row of a doubtful price and offers its rival values', () => {
    const t = verifyTargets(receipt(), ocr);
    expect(t[0]!.open).toBeUndefined(); // rivals first; open questions about the mismatch come after
    expect(t[0]!.path).toBe('items.i2.lineTotal');
    expect(t[0]!.candidates).toEqual([8500, 5500]);
    expect(t[0]!.box.y).toBeLessThan(0.2);
    expect(t[0]!.box.y + t[0]!.box.h).toBeGreaterThan(0.2);
  });
  it('has nothing to verify when nothing is in doubt', () => {
    expect(verifyTargets({ ...receipt(), uncertain: [], total: 2000, items: [item('i1', 'Tea', 2000)] }, ocr)).toEqual([]);
  });
  it('leaves out a doubt whose row cannot be found', () => {
    expect(verifyTargets(receipt(), [line('nothing here', 0.1)])).toEqual([]);
  });
});

describe('applyAnswers', () => {
  const targets = verifyTargets(receipt(), ocr);
  it('applies an answer that makes the items add up', () => {
    const out = applyAnswers(receipt(), targets, { 'items.i2.lineTotal': 5500 });
    expect(out.applied).toBe(true);
    expect(out.receipt.items[1]!.lineTotal).toBe(5500);
    expect(reconcile(out.receipt).status).toBe('ok');
    expect(out.receipt.uncertain).not.toContain('items.i2.lineTotal');
  });
  it('ignores an answer that is not a candidate', () => {
    const out = applyAnswers(receipt(), targets, { 'items.i2.lineTotal': 5600 });
    expect(out.changed).toBe(false);
    expect(out.receipt.items[1]!.lineTotal).toBe(8500);
  });
  it('only suggests when the answer does not make it add up', () => {
    const r = { ...receipt(), total: 9999 };
    const out = applyAnswers(r, verifyTargets(r, ocr), { 'items.i2.lineTotal': 5500 });
    expect(out.applied).toBe(false);
    expect(out.changed).toBe(true);
    expect(out.receipt.items[1]!.lineTotal).toBe(8500);
    expect(out.receipt.reasons?.['items.i2.lineTotal']).toContain('55.00');
  });
  it('changes nothing when the model agrees with the scan', () => {
    expect(applyAnswers(receipt(), targets, { 'items.i2.lineTotal': 8500 }).changed).toBe(false);
  });
  it('changes nothing when the receipt already adds up', () => {
    const ok: Receipt = { ...receipt(), items: [item('i1', 'Tea', 2000), item('i2', 'Cake', 5500, { choices: [8500] })], uncertain: ['items.i2.lineTotal'] };
    const out = applyAnswers(ok, verifyTargets(ok, ocr), { 'items.i2.lineTotal': 8500 });
    expect(out.applied).toBe(false);
    expect(out.receipt.items[1]!.lineTotal).toBe(5500);
  });
  it('does not guess between two fixes that both fit', () => {
    // Either cake could be the misread one, and fixing either makes the total match.
    const r: Receipt = { ...emptyReceipt(), total: 14000, items: [item('a', 'Cake', 8500, { choices: [5500] }), item('b', 'Cake', 8500, { choices: [5500] })], uncertain: ['items.a.lineTotal', 'items.b.lineTotal'] };
    const o = [line('Cake 85.00', 0.1, ['Cake 55.00']), line('Cake 85.00', 0.2, ['Cake 55.00'])];
    const out = applyAnswers(r, verifyTargets(r, o), { 'items.a.lineTotal': 5500, 'items.b.lineTotal': 5500 });
    expect(out.applied).toBe(false);
  });
});

describe('open targets (the receipt does not add up and nothing says why)', () => {
  // Cake was read as 95.00 with no rival value; the total says 75.00.
  const r: Receipt = { ...emptyReceipt(), total: 7500, items: [item('i1', 'Tea', 2000), item('i2', 'Cake', 9500)] };
  const o = [line('Tea 20.00', 0.1), line('Cake 95.00', 0.2), line('Total 75.00', 0.5)];
  it('asks about the total and the priciest items', () => {
    const t = verifyTargets(r, o);
    expect(t.map((x) => x.path)).toEqual(['total', 'items.i2.lineTotal', 'items.i1.lineTotal']);
    expect(t.every((x) => x.open)).toBe(true);
  });
  it('asks nothing when the receipt adds up', () => {
    expect(verifyTargets({ ...r, total: 11500 }, o)).toEqual([]);
  });
  it('applies an answer outside the candidates when it makes the items add up', () => {
    const out = applyAnswers(r, verifyTargets(r, o), { 'items.i2.lineTotal': 5500 });
    expect(out.applied).toBe(true);
    expect(out.receipt.items[1]!.lineTotal).toBe(5500);
  });
  it('drops an outside answer that does not make it add up', () => {
    const out = applyAnswers(r, verifyTargets(r, o), { 'items.i2.lineTotal': 5600 });
    expect(out.changed).toBe(false);
    expect(out.receipt.items[1]!.lineTotal).toBe(9500);
  });
});
