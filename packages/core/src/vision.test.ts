import { describe, expect, it } from 'vitest';
import { chooseReading, parseVisionReply, receiptFromVision, readingScore } from './vision';
import { reconcile } from './reconcile';
import type { OcrLine } from './receipt';

const line = (text: string, alternates?: string[]): OcrLine => ({ text, x: 0, y: 0, w: 1, h: 0.02, confidence: 0.9, alternates });

describe('parseVisionReply', () => {
  it('reads JSON wrapped in text or a code fence', () => {
    const r = parseVisionReply('Here you go:\n```json\n{"items":[{"name":"Tea","amount":"10.00"}],"total":"10.00"}\n```');
    expect(r?.items[0]).toMatchObject({ name: 'Tea', amount: '10.00', quantity: 1 });
  });
  it('rejects replies without items', () => {
    expect(parseVisionReply('sorry')).toBeNull();
    expect(parseVisionReply({ total: '1' })).toBeNull();
  });
  it('accepts numbers as amounts', () => {
    expect(parseVisionReply({ items: [{ name: 'a', amount: 5 }], total: 5 })?.total).toBe('5');
  });
});

describe('receiptFromVision', () => {
  const reading = {
    merchant: 'Cafe', date: '2026-03-04', currency: 'egp',
    items: [{ name: 'Tea', quantity: 2, amount: '20.00' }, { name: 'Cake', quantity: 1, amount: '55.00' }],
    subtotal: '75.00', tax: null, service: '7.50', total: '82.50',
  };
  it('builds a receipt that adds up and trusts amounts the scanner also saw', () => {
    const ocr = ['Tea 20.00', 'Cake 55.00', 'Subtotal 75.00', 'Service 7.50', 'Total 82.50'].map((t) => line(t));
    const r = receiptFromVision(reading, ocr);
    expect(r.currency).toBe('EGP');
    expect(reconcile(r).status).toBe('ok');
    expect(r.uncertain).toEqual([]);
  });
  it('flags an amount the scanner never saw', () => {
    const ocr = ['Tea 20.00', 'Subtotal 75.00', 'Service 7.50', 'Total 82.50'].map((t) => line(t));
    const r = receiptFromVision(reading, ocr);
    expect(r.uncertain).toContain('items.i2.lineTotal');
  });
  it('counts a scanner runner-up reading as seen', () => {
    const ocr = [line('Tea 20.00'), line('Cake 85.00', ['Cake 55.00']), line('Subtotal 75.00'), line('Service 7.50'), line('Total 82.50')];
    expect(receiptFromVision(reading, ocr).uncertain).toEqual([]);
  });
  it('keeps unreadable amounts out of the items but shows them', () => {
    const r = receiptFromVision({ items: [{ name: 'Blurry', amount: 'x?' }, { name: 'Tea', amount: '5.00' }], total: '5.00' });
    expect(r.items).toHaveLength(1);
    expect(r.unparsed).toEqual(['Blurry x?']);
  });
  it('never invents a date', () => {
    expect(receiptFromVision({ items: [], date: 'yesterday' }).date).toBeNull();
  });
});

describe('chooseReading', () => {
  const good = receiptFromVision({ items: [{ name: 'Tea', amount: '10.00' }], total: '10.00' });
  const bad = receiptFromVision({ items: [{ name: 'Tea', amount: '10.00' }], total: '99.00' });
  it('keeps the scanner reading when both hold together', () => {
    expect(chooseReading(good, good).source).toBe('scanner');
  });
  it('uses the AI reading only when it is clearly better', () => {
    expect(readingScore(good)).toBeGreaterThan(readingScore(bad));
    const c = chooseReading(bad, good);
    expect(c.source).toBe('ai');
    expect(c.other).toBe(bad);
  });
  it('falls back to the scanner without an AI reading', () => {
    expect(chooseReading(bad, null)).toEqual({ receipt: bad, source: 'scanner' });
  });
});
