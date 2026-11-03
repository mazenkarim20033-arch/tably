import type { Receipt, Reconciliation } from './receipt';

/**
 * Check that the receipt's parts add up to its printed total. Pure and cheap, so the
 * edit screen can call it on every keystroke. It reports; it never "fixes" numbers.
 */
export function reconcile(r: Receipt): Reconciliation {
  const itemsSum = r.items.reduce((s, i) => s + (i.lineTotal ?? 0), 0);
  const unreadable = r.items.some((i) => i.lineTotal === null);
  const extras = (r.taxIncluded ? 0 : (r.tax ?? 0) + (r.service ?? 0)) + (r.tip ?? 0);
  const computedTotal = itemsSum + r.discounts + extras;

  if (r.total === null) {
    return {
      status: 'incomplete', itemsSum, computedTotal, printedTotal: null, difference: null,
      message: 'No total found. Enter the receipt total to verify the items.',
    };
  }
  if (unreadable) {
    return {
      status: 'incomplete', itemsSum, computedTotal, printedTotal: r.total, difference: null,
      message: 'Some item prices are missing, so the total cannot be verified.',
    };
  }
  const difference = r.total - computedTotal;
  if (difference === 0) {
    return { status: 'ok', itemsSum, computedTotal, printedTotal: r.total, difference: 0, message: 'Items add up to the receipt total.' };
  }
  return {
    status: 'mismatch', itemsSum, computedTotal, printedTotal: r.total, difference,
    message: `Items add up to ${(computedTotal / 100).toFixed(2)} but the receipt total is ${(r.total / 100).toFixed(2)}.`,
  };
}
