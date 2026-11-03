import { describe, expect, it } from 'vitest';
import { allocate, formatAmount, parseAmount } from './money';

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
