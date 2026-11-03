/** Money maths. Amounts are integer minor units (piastres). Mirrors apps/api/tably_api/money.py. */

/**
 * Split `total` by integer `weights` so the parts sum exactly (largest remainder, ties by index).
 * BigInt keeps `total * weight` exact: those products can pass 2^53 for large bills.
 */
export function allocate(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  if (weights.some((w) => w < 0 || !Number.isInteger(w))) throw new RangeError('weights must be non-negative integers');
  const w = weights.map(BigInt);
  const wsum = w.reduce((a, b) => a + b, 0n);
  if (wsum === 0n) throw new RangeError('at least one weight must be positive');
  const sign = total < 0 ? -1n : 1n;
  const abs = BigInt(Math.abs(total));
  const floors = w.map((x) => (abs * x) / wsum);
  const remainders = w.map((x) => (abs * x) % wsum);
  let left = abs - floors.reduce((a, b) => a + b, 0n);
  const order = weights.map((_, i) => i).sort((i, j) => {
    const d = remainders[j]! - remainders[i]!;
    return d > 0n ? 1 : d < 0n ? -1 : i - j;
  });
  for (const i of order) {
    if (left <= 0n) break;
    floors[i] = floors[i]! + 1n;
    left -= 1n;
  }
  return floors.map((f) => Number(f * sign));
}

export const extrasTotal = (discounts: number, tax: number, service: number, tip: number, taxIncluded: boolean): number =>
  discounts + tip + (taxIncluded ? 0 : tax + service);
