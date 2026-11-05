import { describe, expect, it } from 'vitest';
import { assertShopSplit, calibration, correction, declineRate, exactAccuracy, wilson, type Outcome } from './metrics';

const o = (truth: number, ocr: number | null, model: number | null, confidence?: number): Outcome => ({
  receiptId: 'r', shop: 's', field: 'total', truth,
  arms: { ocr: { value: ocr }, model: { value: model, confidence } },
});

describe('exactAccuracy', () => {
  it('counts a declined answer as wrong', () => {
    expect(exactAccuracy([o(100, 100, null), o(200, 200, 200)], 'model')).toBe(0.5);
  });
});

describe('correction', () => {
  const rows = [
    o(100, 100, 100), // right, kept
    o(200, 200, 250), // right, broken by the model (a false correction)
    o(300, 330, 300), // wrong, fixed
    o(400, 440, 440), // wrong, missed
    o(500, 550, null), // wrong, model declined
  ];
  it('separates errors fixed from right answers broken', () => {
    const c = correction(rows, 'ocr', 'model');
    expect(c.wrongBefore).toBe(3);
    expect(c.rightBefore).toBe(2);
    expect(c.correctionRate).toBeCloseTo(1 / 3);
    expect(c.falseCorrectionRate).toBeCloseTo(1 / 2);
    expect(c.missed).toBe(2);
  });
  it('reports the decline rate', () => {
    expect(declineRate(rows, 'model')).toBeCloseTo(1 / 5);
  });
  it('gives NaN, not a made-up number, when there is nothing to measure', () => {
    expect(correction([o(1, 1, 1)], 'ocr', 'model').correctionRate).toBeNaN();
  });
});

describe('calibration', () => {
  it('is zero for a model whose confidence matches how often it is right', () => {
    const rows = [...Array(10)].map((_, k) => o(1, 1, k < 8 ? 1 : 2, 0.8));
    expect(calibration(rows, 'model').ece).toBeCloseTo(0, 5);
  });
  it('flags a confidently wrong model', () => {
    const rows = [...Array(10)].map(() => o(1, 1, 2, 0.95));
    expect(calibration(rows, 'model').ece).toBeCloseTo(0.95, 5);
  });
});

describe('wilson', () => {
  it('widens when there are few cases', () => {
    const [a, b] = wilson(9, 10);
    const [c, d] = wilson(900, 1000);
    expect(b - a).toBeGreaterThan(d - c);
  });
});

describe('assertShopSplit', () => {
  it('rejects a shop that is in both lists', () => {
    expect(() => assertShopSplit(['Abu Auf', 'Spinneys'], ['abu-auf'])).toThrow(/abu auf/);
  });
  it('accepts disjoint shops', () => {
    expect(() => assertShopSplit(['Abu Auf'], ['Carrefour'])).not.toThrow();
  });
});
