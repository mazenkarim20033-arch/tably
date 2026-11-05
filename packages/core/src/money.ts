/** All money in TABLY is integer minor units (piastres for EGP). Never floats. */

export type Minor = number;

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXT_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

export function normalizeDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(EXT_ARABIC_INDIC.indexOf(d)))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');
}

/**
 * Parse a user- or OCR-supplied amount ("1,250.50", "١٢٫٥", "12,5") into minor units.
 * Returns null when the text is not an unambiguous amount; callers must flag it, not guess.
 */
export function parseAmount(input: string): Minor | null {
  const s = normalizeDigits(input).replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return null;
  const negative = s.startsWith('-');
  const body = s.replace(/-/g, '');
  // Only these shapes are amounts: 1250, 12.5, 1,250.00, 1.250,00. Irregular groups ("31.50831.50") are
  // OCR garbage, and guessing would invent money.
  if (!/^\d+$/.test(body) && !/^\d+[.,]\d{1,2}$/.test(body) && !/^\d{1,3}([.,]\d{3})+([.,]\d{1,2})?$/.test(body)) return null;
  const separators = body.match(/[.,]/g) ?? [];
  if (separators.length >= 2) {
    const lastMark = separators[separators.length - 1]!;
    const lastGroup = body.slice(body.lastIndexOf(lastMark) + 1);
    const grouping = lastGroup.length === 3 ? separators : separators.slice(0, -1); // 3 digits: a thousands group
    if (new Set(grouping).size > 1) return null; // the grouping mark must be one consistent character
    if (lastGroup.length <= 2 && lastMark === separators[0]) return null; // decimal mark cannot equal grouping mark
  }
  const lastDot = body.lastIndexOf('.');
  const lastComma = body.lastIndexOf(',');
  const sepIdx = Math.max(lastDot, lastComma);
  let whole = body;
  let frac = '';
  if (sepIdx >= 0) {
    const tail = body.slice(sepIdx + 1);
    const hasOtherSep = /[.,]/.test(body.slice(0, sepIdx));
    // "1,250" with exactly 3 trailing digits and no other separator is ambiguous: reject.
    if (tail.length === 3 && !hasOtherSep && lastDot !== lastComma) {
      return null;
    }
    if (tail.length <= 2) {
      whole = body.slice(0, sepIdx);
      frac = tail;
    } else if (tail.length === 3) {
      whole = body;
    } else {
      return null;
    }
  }
  whole = whole.replace(/[.,]/g, '');
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return null;
  const minor = Number(whole || '0') * 100 + Number(frac.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(minor)) return null;
  return negative ? -minor : minor;
}

export function formatAmount(minor: Minor, currency = 'EGP', locale = 'en-EG'): string {
  const value = minor / 100;
  const hasFraction = minor % 100 !== 0;
  const num = new Intl.NumberFormat(locale, {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(value);
  return `${num} ${currency}`;
}

/**
 * Split `total` across `weights` so the parts sum exactly to `total`
 * (largest-remainder; ties broken by lowest index, so it is deterministic).
 */
export function allocate(total: Minor, weights: number[]): Minor[] {
  if (weights.length === 0) return [];
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new RangeError('weights must be finite and non-negative');
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) throw new RangeError('at least one weight must be positive');
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = weights.map((w) => (abs * w) / sum);
  const floors = raw.map(Math.floor);
  let left = abs - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left -= 1;
  }
  return floors.map((f) => f * sign);
}

/**
 * "11.185.00" for a printed "11,185.00": thousands groups of three and two decimals with the same mark everywhere. A
 * comma was read as a dot. `parseAmount` rejects it (irregular groups are usually garbage), so this is a separate,
 * explicit second reading: it is only used where the receipt's own arithmetic can confirm it, and is flagged when not.
 */
export function parseAmountSlipped(input: string): Minor | null {
  const s = normalizeDigits(input).replace(/[^\d.,]/g, '');
  const m = /^(\d{1,3}(?:([.,])\d{3})+)\2(\d{2})$/.exec(s);
  if (!m) return null;
  const minor = Number(m[1]!.replace(/[.,]/g, '')) * 100 + Number(m[3]);
  return Number.isSafeInteger(minor) ? minor : null;
}
