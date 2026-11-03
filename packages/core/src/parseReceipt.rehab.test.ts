import { describe, expect, it } from 'vitest';
import { parseReceipt } from './parseReceipt';
import { reconcile } from './reconcile';
import type { OcrLine } from './receipt';
import { RAW } from './rehab.fixture';

/** Rehab City: real scanner output. A summary box (minimum, items, service, tax) with each value under its label sits
 *  above the table, and the table has both a unit price and a line total column. */
function lines(deg = 0): OcrLine[] {
  const th = (deg * Math.PI) / 180;
  return RAW.map((r) => {
    const w = Math.max(0.03, r.t.length * r.h * 0.66);
    const dx = r.x + w / 2 - 0.5;
    const dy = r.y + r.h / 2 - 0.5;
    const cx = 0.5 + dx * Math.cos(th) - dy * Math.sin(th);
    const cy = 0.5 + dx * Math.sin(th) + dy * Math.cos(th);
    return { text: r.t, x: cx - w / 2, y: cy - r.h / 2, w, h: r.h, confidence: r.c };
  });
}

describe('Rehab City receipt', () => {
  for (const deg of [0, 1, -1, 2, -2, 3]) {
    it(`reads items, quantities, tax and total (page turned ${deg} degrees)`, () => {
      const rc = parseReceipt(lines(deg));
      expect(rc.items.map((i) => [i.quantity, i.lineTotal])).toEqual([
        [1, 13500], [3, 26400], [4, 13200], [3, 9900], [1, 6500], [1, 8500], [1, 8800], [1, 7700], [2, 4000],
      ]);
      expect([rc.tax, rc.total]).toEqual([13790, 112290]);
      expect(rc.items.every((i) => i.flags.length === 0)).toBe(true);
      expect(reconcile(rc).status).toBe('ok');
    });
  }

  it('takes the shop name from under the table and ignores scanner noise at the top', () => {
    expect(parseReceipt(lines()).merchant).toBe('Rehab City');
  });

  it('does not read the minimum charge or the cover count as money', () => {
    const rc = parseReceipt(lines());
    expect(rc.service === null || rc.service === 0).toBe(true);
    expect(rc.items.map((i) => i.description).join(' ')).not.toMatch(/Minimum|Cover|Total/);
  });
});
