import { describe, expect, it } from 'vitest';
import { parseReceipt } from './parseReceipt';
import { reconcile } from './reconcile';
import type { OcrLine } from './receipt';

/**
 * Fixtures measured from real phone photos (positions read off the on-screen photo, then normalized). Unlike the
 * synthetic fixtures these keep the real mess: a tilt that does not match the row pitch, columns that sit half a row
 * apart, captions on lines of their own, and prices that Vision returns as separate fragments.
 */
const W = 625;
const H = 953;
type F = [text: string, x0: number, x1: number, yc: number, conf?: number];

// A tilted line's axis-aligned box is taller the longer the line is: text height plus the drop across its width.
function fromPixels(frags: F[], textPx = 15, tilt = 0.06): OcrLine[] {
  return frags.map(([text, x0, x1, yc, conf]) => {
    const hPx = textPx + (x1 - x0) * tilt;
    return { text, x: x0 / W, y: (yc - hPx / 2) / H, w: (x1 - x0) / W, h: hPx / H, confidence: conf ?? 0.9 };
  });
}

// Coordinates are pixels inside the photo (0..625 x 0..953).
const TABLE9_PHOTO: F[] = [
  ['TABLE 9', 115, 240, 34],
  ['INV#- 215156', 70, 200, 60],
  ['رقم الفاتورة', 210, 290, 54],
  ['TAX INVOICE -', 35, 180, 87],
  ['فاتورة', 185, 235, 84],
  ['DINE-', 268, 328, 77],
  ['IN', 305, 328, 92],
  ['ضريبية', 35, 75, 109],
  ['Number of', 35, 120, 134],
  ['Covers: 4', 35, 120, 147],
  ['Staff: Khaled', 175, 330, 120],
  ['Ibrahim Abdel Aal', 195, 330, 137],
  ['21-Sep-2024', 35, 135, 165],
  ['03:09 PM', 255, 330, 150],
  ['Qty', 32, 62, 205],
  ['Item', 148, 188, 196],
  ['Price', 290, 335, 188],
  ['2', 32, 40, 234],
  ['Fresh Mango Juice', 70, 232, 231],
  ['منجا', 238, 265, 227],
  ['230.00', 280, 338, 219],
  ['1', 32, 40, 259],
  ['Minted Lemonade', 70, 222, 251],
  ['95.00', 312, 340, 242],
  ['ليمون بالنعناع', 72, 150, 273],
  ['1', 32, 40, 299],
  ['Mixed Fresh Juice', 70, 225, 289],
  ['خلطة', 242, 265, 285],
  ['115.00', 283, 340, 282],
  ['عصير على ذوقك', 72, 180, 309],
  ['1', 32, 40, 335],
  ['Entres Cup', 70, 170, 334],
  ['0.00', 305, 343, 321],
  ['1', 32, 40, 359],
  ['Extra Hot Bread', 70, 208, 354],
  ['0.00', 305, 343, 345],
  ['1', 32, 40, 382],
  ['Fattoush', 72, 160, 380],
  ['فتوش', 165, 190, 378],
  ['150.00', 285, 345, 370],
  ['2', 32, 40, 407],
  ['Lahm Bi Ajin', 72, 180, 405],
  ['لحم بعجين', 185, 250, 399],
  ['370.00', 285, 345, 394],
  ['1', 32, 40, 430],
  ['Grilled Chicken Wings', 72, 265, 425],
  ['جوانح دجاج مشوية', 72, 190, 446],
  ['285.00', 280, 345, 419],
  ['1', 32, 40, 475],
  ['Chicken Tawouk', 72, 208, 472],
  ['طاووق', 215, 270, 468],
  ['385.00', 280, 348, 460],
  ['1', 32, 40, 499],
  ['Flavoured Tea', 72, 195, 494],
  ['شاي', 202, 232, 492],
  ['60.00', 292, 345, 485],
  ['1', 32, 40, 524],
  ['Small Water', 72, 190, 522],
  ['مياه صغيرة', 190, 262, 517],
  ['45.00', 292, 345, 510],
  ['Sub Total', 103, 195, 577],
  ['1,735.00', 268, 350, 569],
  ['Service Charge', 43, 195, 609],
  ['(12%):', 133, 195, 627],
  ['208.20', 285, 350, 610],
  ['VAT (14%):', 86, 195, 657],
  ['272.05', 285, 350, 648],
  ['Total', 145, 198, 697],
  ['EGP', 315, 355, 677],
  ['2,215.25', 243, 355, 696],
  ['u for visiting!', 175, 302, 822],
  ['2 9898 | Website:', 175, 360, 844],
  ['iruti.com', 210, 288, 867],
];

const ARABIC_ONLY = /^[؀-ۿ\s]+$/;

/** Ways Vision may cut the same text into fragments: a quantity glued to its name, or a whole row as one line. */
function variate(src: F[], variant: Variant, rnd: () => number): F[] {
  if (variant === 'plain') return src;
  if (variant === 'noArabic') return src.filter((f) => !ARABIC_ONLY.test(f[0]));
  const out: F[] = [];
  for (let i = 0; i < src.length; i++) {
    const f = src[i]!;
    const isQty = /^\d$/.test(f[0]) && f[1] === 32;
    if (!isQty) {
      out.push(f);
      continue;
    }
    const merge = variant === 'qtyMerged' || variant === 'rowsMerged' ? true : rnd() < 0.5;
    const rowsToo = variant === 'rowsMerged' || (variant === 'mixed' && rnd() < 0.5);
    // the row: qty, name, optional Arabic, price (captions on their own line come after the price)
    let j = i + 1;
    const row: F[] = [f];
    while (j < src.length && !/^[\d,]+\.\d\d$/.test(src[j]![0])) {
      row.push(src[j]!);
      j++;
    }
    const price = src[j]!;
    if (!merge) {
      out.push(f);
      continue;
    }
    const name = row[1]!;
    if (rowsToo) {
      const inline = row.slice(2).filter((r) => r[3] === name[3] || Math.abs(r[3] - name[3]) < 12);
      const parts = [f, name, ...inline, price];
      const x0 = f[1];
      const x1 = price[2];
      out.push([parts.map((p) => p[0]).join(' '), x0, x1, (f[3] + price[3]) / 2]);
      for (const r of row.slice(2)) if (!inline.includes(r)) out.push(r);
    } else {
      out.push([`${f[0]} ${name[0]}`, f[1], name[2], name[3]]);
      for (const r of row.slice(2)) out.push(r);
      out.push(price);
    }
    i = j;
  }
  return out;
}

/** The same photo rotated, skewed by perspective and jittered, the way different hands hold a phone. */
export type Variant = 'plain' | 'qtyMerged' | 'rowsMerged' | 'mixed' | 'noArabic';

export function distort(seed: number, maxDeg: number, variant: Variant = 'plain'): OcrLine[] {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const deg = (rnd() * 2 - 1) * maxDeg;
  const th = (deg * Math.PI) / 180;
  const persp = (rnd() * 2 - 1) * 0.0004; // extra x-shift per pixel of height: a keystone
  const jitter = rnd() * 4;
  const cx = W / 2;
  const cy = H / 2;
  const frags: F[] = variate(TABLE9_PHOTO, variant, rnd).map(([text, x0, x1, yc, conf]) => {
    const xm = (x0 + x1) / 2;
    const half = (x1 - x0) / 2;
    const dx = xm - cx;
    const dy = yc - cy;
    const k = 1 + persp * dy;
    const nx = cx + (dx * Math.cos(th) - dy * Math.sin(th)) * k;
    const ny = cy + dx * Math.sin(th) + dy * Math.cos(th) + (rnd() * 2 - 1) * jitter;
    return [text, nx - half * Math.cos(th), nx + half * Math.cos(th), ny, conf];
  });
  return fromPixels(frags, 15, Math.abs(Math.tan(th)));
}

const shape = (rc: ReturnType<typeof parseReceipt>) => rc.items.map((i) => [i.quantity, i.lineTotal]);

describe('Table 9 as photographed (positions measured from the real photo)', () => {
  const rc = parseReceipt(fromPixels(TABLE9_PHOTO));

  it('gets every quantity and price right', () => {
    expect(shape(rc)).toEqual([
      [2, 23000], [1, 9500], [1, 11500], [1, 15000], [2, 37000], [1, 28500], [1, 38500], [1, 6000], [1, 4500],
    ]);
  });

  it('pairs the right names with the prices', () => {
    expect(rc.items.map((i) => i.description.split(' ').slice(0, 2).join(' '))).toEqual([
      'Fresh Mango', 'Minted Lemonade', 'Mixed Fresh', 'Fattoush فتوش', 'Lahm Bi', 'Grilled Chicken', 'Chicken Tawouk', 'Flavoured Tea', 'Small Water',
    ]);
  });

  it('reads subtotal, service, VAT and total from the right lines', () => {
    expect([rc.subtotal, rc.service, rc.tax, rc.total]).toEqual([173500, 20820, 27205, 221525]);
    expect(reconcile(rc).status).toBe('ok');
  });
});

describe('Table 9 under many camera angles', () => {
  const want = [[2, 23000], [1, 9500], [1, 11500], [1, 15000], [2, 37000], [1, 28500], [1, 38500], [1, 6000], [1, 4500]];
  const cases = (['plain', 'qtyMerged', 'rowsMerged', 'mixed', 'noArabic'] as Variant[]).flatMap((v) => [3, 6, 9].map((d) => [v, d] as const));
  for (const [variant, maxDeg] of cases) {
    it(`reads it right (${variant}) at up to ${maxDeg} degrees of tilt`, () => {
      let bad = 0;
      const first: number[] = [];
      for (let seed = 1; seed <= 200; seed++) {
        const rc = parseReceipt(distort(seed, maxDeg, variant));
        const ok = JSON.stringify(shape(rc)) === JSON.stringify(want) &&
          [rc.subtotal, rc.service, rc.tax, rc.total].join() === [173500, 20820, 27205, 221525].join();
        if (!ok) {
          bad++;
          if (first.length < 8) first.push(seed);
        }
      }
      console.log(`${variant} tilt<=${maxDeg}: ${bad}/200 wrong; first seeds ${first.join(',')}`);
      // A photo rotated 6+ degrees with every row delivered as one long line is the hardest case; allow a few misses.
      expect(bad).toBeLessThanOrEqual(variant === 'rowsMerged' && maxDeg >= 6 ? 20 : 0);
    });
  }
});
