/**
 * Metrics for comparing ways of reading a receipt field (see docs/advanced-scan-plan.md, section 6).
 *
 * One `Outcome` is one field on one receipt: what is really printed, and what each arm of the comparison read.
 * An arm is a complete way of reading (OCR alone, OCR plus arithmetic checks, plus a specialist model, ...).
 * Nothing here knows how an arm works, so any experimental model can be scored the same way.
 */

export type FieldName = 'total' | 'subtotal' | 'tax' | 'discount' | 'item' | 'quantity' | 'date';

/** What an arm said about a field: a value, or null when it declined to answer. */
export interface Reading {
  value: number | string | null;
  /** The arm's own probability that `value` is right, when it has one (for calibration). */
  confidence?: number;
}

export interface Outcome {
  receiptId: string;
  /** which shop, so results can be broken down and a shop never appears in both training and test */
  shop: string;
  field: FieldName;
  truth: number | string;
  arms: Record<string, Reading>;
}

const same = (a: Reading['value'], b: number | string): boolean => a !== null && a === b;

/** Share of fields an arm read exactly right. A declined answer counts as wrong. */
export function exactAccuracy(outcomes: Outcome[], arm: string): number {
  const rows = outcomes.filter((o) => arm in o.arms);
  return rows.length === 0 ? NaN : rows.filter((o) => same(o.arms[arm]!.value, o.truth)).length / rows.length;
}

export interface Correction {
  /** fields that were wrong before and are right after, over fields that were wrong before */
  correctionRate: number;
  /** fields that were right before and are wrong after, over fields that were right before: the safety number */
  falseCorrectionRate: number;
  /** fields that were wrong before and are still wrong after */
  missed: number;
  /** how many fields were wrong / right before (so a reader can see how few errors the rates rest on) */
  wrongBefore: number;
  rightBefore: number;
}

/** What changing from the `before` arm to the `after` arm did: errors fixed, and right answers broken. */
export function correction(outcomes: Outcome[], before: string, after: string): Correction {
  const rows = outcomes.filter((o) => before in o.arms && after in o.arms);
  const wrong = rows.filter((o) => !same(o.arms[before]!.value, o.truth));
  const right = rows.filter((o) => same(o.arms[before]!.value, o.truth));
  const fixed = wrong.filter((o) => same(o.arms[after]!.value, o.truth)).length;
  const broken = right.filter((o) => !same(o.arms[after]!.value, o.truth)).length;
  return {
    correctionRate: wrong.length === 0 ? NaN : fixed / wrong.length,
    falseCorrectionRate: right.length === 0 ? NaN : broken / right.length,
    missed: wrong.length - fixed,
    wrongBefore: wrong.length,
    rightBefore: right.length,
  };
}

/** Share of fields an arm declined to answer (a model that says "cannot tell" is behaving as intended). */
export function declineRate(outcomes: Outcome[], arm: string): number {
  const rows = outcomes.filter((o) => arm in o.arms);
  return rows.length === 0 ? NaN : rows.filter((o) => o.arms[arm]!.value === null).length / rows.length;
}

export interface Calibration {
  /** expected calibration error: the average gap between stated confidence and actual accuracy, weighted by bin size */
  ece: number;
  bins: Array<{ from: number; to: number; count: number; meanConfidence: number; accuracy: number }>;
}

/** Does "90% sure" mean right 90% of the time? Only fields where the arm gave a value and a confidence are counted. */
export function calibration(outcomes: Outcome[], arm: string, binCount = 10): Calibration {
  const rows = outcomes.filter((o) => {
    const r = o.arms[arm];
    return r !== undefined && r.value !== null && r.confidence !== undefined;
  });
  const bins = Array.from({ length: binCount }, (_, k) => ({ from: k / binCount, to: (k + 1) / binCount, count: 0, sumConf: 0, sumRight: 0 }));
  for (const o of rows) {
    const r = o.arms[arm]!;
    const k = Math.min(binCount - 1, Math.floor(r.confidence! * binCount));
    bins[k]!.count++;
    bins[k]!.sumConf += r.confidence!;
    bins[k]!.sumRight += same(r.value, o.truth) ? 1 : 0;
  }
  let ece = 0;
  const out = bins.map((b) => {
    const meanConfidence = b.count ? b.sumConf / b.count : 0;
    const accuracy = b.count ? b.sumRight / b.count : 0;
    if (rows.length) ece += (b.count / rows.length) * Math.abs(meanConfidence - accuracy);
    return { from: b.from, to: b.to, count: b.count, meanConfidence, accuracy };
  });
  return { ece: rows.length ? ece : NaN, bins: out };
}

/** Wilson 95% interval for a rate, so a result on few errors is never shown as a single confident number. */
export function wilson(successes: number, total: number): [number, number] {
  if (total === 0) return [NaN, NaN];
  const z = 1.96;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Fail loudly if any shop appears in both the training list and the test list. */
export function assertShopSplit(trainShops: Iterable<string>, testShops: Iterable<string>): void {
  const train = new Set([...trainShops].map(normalizeShop));
  const clash = [...new Set([...testShops].map(normalizeShop))].filter((s) => train.has(s));
  if (clash.length > 0) throw new Error(`Shops in both training and test: ${clash.join(', ')}`);
}

export const normalizeShop = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
