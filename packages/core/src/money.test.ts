import { describe, expect, it } from 'vitest';
import { allocate, formatAmount, parseAmount, parseAmountSlipped } from './money';

describe('parseAmount', () => {
  it('parses plain and decimal amounts', () => {
    expect(parseAmount('125')).toBe(12500);
    expect(parseAmount('125.5')).toBe(12550);
    expect(parseAmount('1,250.75')).toBe(125075);
    expect(parseAmount('12,50')).toBe(1250);
  });
  it('parses Arabic-Indic digits', () => {
    expect(parseAmount('١٢٫٥٠')).toBe(1250);
    expect(parseAmount('١٬٢٥٠٫٧٥')).toBe(125075);
  });
  it('rejects ambiguous or non-numeric input instead of guessing', () => {
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('1,250')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });
  it('handles negatives (discounts)', () => {
    expect(parseAmount('-10.00')).toBe(-1000);
  });
});

describe('allocate', () => {
  it('always sums exactly to the total', () => {
    const parts = allocate(10000, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(parts).toEqual([3334, 3333, 3333]);
  });
  it('is proportional', () => {
    expect(allocate(1000, [3, 1])).toEqual([750, 250]);
  });
  it('handles zero-weight members and negative totals', () => {
    expect(allocate(500, [0, 1])).toEqual([0, 500]);
    expect(allocate(-100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(-100);
  });
  it('rejects invalid weights', () => {
    expect(() => allocate(100, [0, 0])).toThrow();
    expect(() => allocate(100, [-1, 2])).toThrow();
  });
});

describe('formatAmount', () => {
  it('shows fractions only when needed', () => {
    expect(formatAmount(12500)).toBe('125 EGP');
    expect(formatAmount(12550)).toBe('125.50 EGP');
  });
});

describe('parseAmount rejects OCR garbage instead of guessing', () => {
  it('rejects irregular digit groups', () => {
    for (const bad of ['31.50831.50', '1.2.3', '12,34,56', '1,2345.00', '7..50', '3.150.83']) {
      expect(parseAmount(bad)).toBeNull();
    }
  });
  it('still reads every valid shape', () => {
    expect(parseAmount('1,735.00')).toBe(173500);
    expect(parseAmount('1.735,00')).toBe(173500);
    expect(parseAmount('2,215.25')).toBe(221525);
    expect(parseAmount('1,000,000.5')).toBe(100000050);
    expect(parseAmount('75')).toBe(7500);
    expect(parseAmount('0.00')).toBe(0);
  });
});

describe('parseAmountSlipped', () => {
  it('reads a thousands comma recognized as a dot, and nothing else', () => {
    expect(parseAmountSlipped('11.185.00EGP')).toBe(1118500);
    expect(parseAmountSlipped('3.150.83')).toBe(315083);
    expect(parseAmountSlipped('1,250,00')).toBe(125000);
    expect(parseAmountSlipped('1,250.00')).toBeNull(); // already a valid amount
    expect(parseAmountSlipped('31.50831.50')).toBeNull();
    expect(parseAmountSlipped('1.25.00')).toBeNull();
  });
});
