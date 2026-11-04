import { describe, expect, it } from 'vitest';
import { syntheticPages } from '../../eval/synthetic';
import type { OcrLine } from '../receipt';
import { buildLayout } from './layout';

/** Share of printed rows whose observations all landed on one reconstructed line, alone. */
function rowAccuracy(lines: OcrLine[], rowOf: number[]) {
  const lay = buildLayout(lines);
  const lineOf = new Map<number, number>();
  lay.lines.forEach((ln, k) => ln.obs.forEach((i) => lineOf.set(i, k)));
  const rows = new Map<number, Set<number>>();
  rowOf.forEach((row, i) => rows.set(row, (rows.get(row) ?? new Set()).add(lineOf.get(i)!)));
  const ok = [...rows.entries()].filter(([row, ls]) => ls.size === 1 && [...lay.lines[[...ls][0]!]!.obs].every((i) => rowOf[i] === row));
  return { ok: ok.length, total: rows.size, oriented: lay.oriented };
}

describe('layout: printed lines from distorted photos', () => {
  const pages = syntheticPages(240);

  it('rebuilds at least 98% of printed rows exactly, across rotation, keystone and curl', () => {
    let ok = 0;
    let total = 0;
    for (const p of pages) {
      const a = rowAccuracy(p.lines, p.rowOf);
      ok += a.ok;
      total += a.total;
    }
    console.log(`layout rows exact: ${ok}/${total}`);
    expect(ok / total).toBeGreaterThanOrEqual(0.98);
  });

  it('is much better than assuming a straight page on the strongly distorted ones', () => {
    const hard = pages.filter((p) => Math.abs(p.cam.deg) > 3);
    const flat = (l: OcrLine): OcrLine => ({ text: l.text, x: l.x, y: l.y, w: l.w, h: l.h, confidence: l.confidence });
    let withGeometry = 0;
    let without = 0;
    for (const p of hard) {
      withGeometry += rowAccuracy(p.lines, p.rowOf).ok;
      without += rowAccuracy(p.lines.map(flat), p.rowOf).ok;
    }
    expect(withGeometry).toBeGreaterThan(without * 1.2);
  });

  it('still rebuilds 95% of rows when the corners and word boxes are noisy, as real scanner output is', () => {
    let seed = 99;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const shake = (l: OcrLine): OcrLine => ({
      ...l,
      quad: l.quad?.map((q) => q + rnd() * 0.002),
      words: l.words?.map((w) => ({ ...w, y: w.y + rnd() * 0.002, x: w.x + rnd() * 0.002 })),
    });
    let ok = 0;
    let total = 0;
    for (const p of pages) {
      const a = rowAccuracy(p.lines.map(shake), p.rowOf);
      ok += a.ok;
      total += a.total;
    }
    console.log(`layout rows exact with noisy geometry: ${ok}/${total}`);
    expect(ok / total).toBeGreaterThanOrEqual(0.95);
  });

  it('says when the scanner gave no geometry to go on', () => {
    const flat = pages[0]!.lines.map((l) => ({ text: l.text, x: l.x, y: l.y, w: l.w, h: l.h, confidence: l.confidence }));
    expect(buildLayout(flat).oriented).toBe(false);
    expect(buildLayout(pages[0]!.lines).oriented).toBe(true);
  });
});

describe('layout: columns', () => {
  it('finds a slanted price column (keystone) and a quantity column, one number per line', () => {
    // Prices right-aligned at x = 0.9 at the top drifting to 0.86 at the bottom; quantities at x = 0.1.
    const lines: OcrLine[] = [];
    for (let k = 0; k < 8; k++) {
      const y = 0.2 + k * 0.04;
      const right = 0.9 - k * 0.006;
      lines.push({ text: String(1 + (k % 3)), x: 0.08, y, w: 0.015, h: 0.015, confidence: 1 });
      lines.push({ text: `Dish ${'abcdefgh'[k]}`, x: 0.15, y, w: 0.2, h: 0.015, confidence: 1 });
      lines.push({ text: `${10 + k}5.00`, x: right - 0.1, y, w: 0.1, h: 0.015, confidence: 1 });
    }
    const lay = buildLayout(lines);
    const prices = lay.columns.find((c) => c.role === 'amount')!;
    const qty = lay.columns.find((c) => c.role === 'integer')!;
    expect(prices.tokens).toHaveLength(8);
    expect(qty.tokens).toHaveLength(8);
    expect(prices.b).toBeLessThan(0);
  });
});
