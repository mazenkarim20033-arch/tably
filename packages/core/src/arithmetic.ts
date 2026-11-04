import type { Minor } from './money';
import type { ReceiptItem } from './receipt';

/**
 * Stage F: the receipt's own arithmetic, shared by every reader. It checks and explains; it never changes a printed
 * amount to make things add up. A correction is offered as a suggestion only when exactly one explanation fits.
 */

export interface Charges { subtotal?: Minor; tax?: Minor; service?: Minor; tip?: Minor }

/** Lines printed at 0.00 cannot be split between people: they are removed and named in a note. */
export function dropFreeLines(items: ReceiptItem[], uncertain: string[], notes: string[]): void {
  const free = items.filter((i) => i.lineTotal === 0);
  if (free.length > 0) {
    for (const f of free) {
      items.splice(items.indexOf(f), 1);
      for (let k = uncertain.length - 1; k >= 0; k--) if (uncertain[k]!.startsWith(`items.${f.id}.`)) uncertain.splice(k, 1);
    }
    notes.push(`Included at no charge, not listed: ${free.map((f) => f.description.replace(/\s+/g, ' ')).join(', ')}.`);
  }

}

export interface Settled {
  total: Minor | null;
  taxIncluded: boolean;
  /** exact: items add up as read; repaired: they do once one explained fix is accepted; unknown: nothing to check against */
  arith: 'exact' | 'repaired' | 'unknown' | 'broken';
}

/**
 * Check the items against the printed subtotal / total and explain any gap: per-unit prices, one misread digit, or a
 * stray row. Calculates a missing total from the subtotal and charges, and decides whether tax is included in the
 * prices. Items, notes and uncertain are updated in place (flags and suggestions only).
 */
export function settleArithmetic(input: {
  items: ReceiptItem[];
  totals: Charges;
  total: Minor | null;
  discounts: Minor;
  notes: string[];
  uncertain: string[];
  /** amounts the reader saw in the item area but could not tie to a name */
  loosePrices?: Minor[];
}): Settled {
  const { items, totals, discounts, notes, uncertain } = input;
  const loosePrices = input.loosePrices ?? [];
  let total = input.total;
  const extras = (totals.tax ?? 0) + (totals.service ?? 0) + (totals.tip ?? 0);
  const targets = itemTargets(totals, total, discounts);
  const sumOf = () => items.reduce((s, i) => s + (i.lineTotal ?? 0), 0);
  // exact: the items add up as read. repaired: they do once one explained fix is made. unknown: nothing to check against.
  let arith: 'exact' | 'repaired' | 'unknown' | 'broken' = targets.length === 0 ? 'unknown' : targets.includes(sumOf()) ? 'exact' : 'broken';

  if (targets.length > 0 && !targets.includes(sumOf())) {
    // (a) Per-unit prices: "2 x 15.00" printed without the line total. Exact arithmetic proves it, unless a single
    // misread digit would explain the gap just as well: then neither is applied and the mismatch stays visible.
    const perUnit = items.reduce((s, i) => s + (i.lineTotal ?? 0) * i.quantity, 0);
    const perUnitFits = items.some((i) => i.quantity > 1) && targets.includes(perUnit);
    if (perUnitFits && findMisreads(items, targets).length > 0) {
      notes.push('The items do not add up to the subtotal and more than one explanation fits (per-unit prices, or a misread price). Check them against the receipt.');
    } else if (perUnitFits) {
      for (const i of items) {
        if (i.quantity > 1 && i.lineTotal !== null) {
          i.unitPrice = i.lineTotal;
          i.lineTotal = i.lineTotal * i.quantity;
        }
      }
      notes.push('The prices on this receipt are per unit; they were multiplied by the quantity to match the subtotal.');
      arith = 'repaired';
    } else {
      // (b) One misread digit (6 read as 8, ...) or (c) one or two stray rows. Only when exactly one explanation
      // fits: if several do, guessing would send people a wrong number.
      const misreads = pickMisread(findMisreads(items, targets));
      const suspects = findSuspects(items, targets);
      if (misreads.length === 1 && suspects.length === 0) {
        const { item, value } = misreads[0]!;
        item.flags.push('maybe-misread');
        item.suggestedLineTotal = value;
        uncertain.push(`items.${item.id}.lineTotal`);
        arith = 'repaired';
      } else if (suspects.length === 1 && misreads.length === 0) {
        arith = 'repaired';
        for (const item of suspects[0]!) {
          item.flags.push('does-not-add-up');
          uncertain.push(`items.${item.id}.lineTotal`);
        }
      } else if (misreads.length + suspects.length > 0) {
        notes.push('The items do not add up to the subtotal and more than one price could be the cause. Check them against the receipt.');
      }
    }
  }

  let taxIncluded = false;
  if (total === null) {
    if (totals.subtotal !== undefined) {
      // No total line: the subtotal plus the printed charges is the amount to split. Said, flagged, editable.
      total = totals.subtotal + discounts + extras;
      notes.push(`No total line on the receipt; calculated ${(total / 100).toFixed(2)} from the subtotal and charges.`);
    } else {
      notes.push('No total on the receipt to check the items against.');
    }
    uncertain.push('total');
  } else if (totals.tax || totals.service) {
    // Prove, don't assume: if items alone already equal the printed total, tax/service are inclusive.
    const withTip = sumOf() + discounts + (totals.tip ?? 0);
    if (withTip + (totals.tax ?? 0) + (totals.service ?? 0) !== total && withTip === total) {
      taxIncluded = true;
      notes.push('Tax and service appear to be included in the item prices.');
    }
  }

  // Prices the scanner saw inside the table but could not tie to a name.
  const sum = sumOf();
  const target = targets[0];
  if (target !== undefined && sum < target) {
    if (loosePrices.some((v) => v === target - sum)) {
      notes.push(`A price of ${((target - sum) / 100).toFixed(2)} on the receipt was not matched to any item. Add the missing item.`);
    }
  }

  return { total, taxIncluded, arith };
}

/** What the items should add up to: the printed subtotal, else the total minus its charges. */
export function itemTargets(
  totals: { subtotal?: Minor; tax?: Minor; service?: Minor; tip?: Minor },
  total: Minor | null,
  discounts: Minor,
): Minor[] {
  if (totals.subtotal !== undefined) return [totals.subtotal];
  if (total === null) return [];
  const extras = (totals.tax ?? 0) + (totals.service ?? 0) + (totals.tip ?? 0);
  return [total - extras - discounts, total - (totals.tip ?? 0) - discounts];
}

// Digits OCR commonly confuses, in a printed price.
const CONFUSABLE: Record<string, string[]> = {
  '0': ['8', '6'],
  '8': ['0', '6', '3'],
  '6': ['8', '5', '0'],
  '1': ['7'],
  '7': ['1'],
  '5': ['6', '3'],
  '3': ['8', '5'],
  '9': ['4', '8'],
  '4': ['9'],
};

/**
 * Every way a single digit of a single price could have been misread that makes the items match the printed subtotal.
 * Used only when there is exactly one such way and no other explanation: then it is offered as a one-tap suggestion.
 */
export function findMisreads(items: ReceiptItem[], targets: Minor[]): Array<{ item: ReceiptItem; value: Minor }> {
  const sum = items.reduce((s, i) => s + (i.lineTotal ?? 0), 0);
  const found: Array<{ item: ReceiptItem; value: Minor }> = [];

  // First choice: the recognizer's own runner-up readings. If one of them makes the items add up, that is evidence
  // from the scanner itself, far stronger than a guess about which digits look alike.
  const fromAlternates: Array<{ item: ReceiptItem; value: Minor }> = [];
  for (const item of items) {
    if (item.lineTotal === null) continue;
    for (const alt of item.altLineTotals ?? []) {
      if (alt > 0 && alt !== item.lineTotal && targets.includes(sum - item.lineTotal + alt)) fromAlternates.push({ item, value: alt });
    }
  }
  if (fromAlternates.length > 0) return fromAlternates;

  for (const item of items) {
    if (item.lineTotal === null || item.lineTotal <= 0) continue;
    const digits = String(item.lineTotal).split('');
    digits.forEach((d, pos) => {
      for (const alt of CONFUSABLE[d] ?? []) {
        const candidate = Number([...digits.slice(0, pos), alt, ...digits.slice(pos + 1)].join(''));
        if (candidate > 0 && targets.includes(sum - item.lineTotal! + candidate)) {
          if (!found.some((f) => f.item === item && f.value === candidate)) found.push({ item, value: candidate });
        }
      }
    });
  }
  return found;
}

/**
 * Several prices could each be the misread one. If the scanner was clearly less sure of exactly one of those lines,
 * that line is the likely culprit; otherwise (or if one line has several candidate values) there is no safe pick.
 */
function pickMisread(found: Array<{ item: ReceiptItem; value: Minor }>): Array<{ item: ReceiptItem; value: Minor }> {
  const byItem = new Map<ReceiptItem, Array<{ item: ReceiptItem; value: Minor }>>();
  for (const f of found) byItem.set(f.item, [...(byItem.get(f.item) ?? []), f]);
  const lines = [...byItem.entries()];
  if (lines.length <= 1) return found.length === 1 ? found : [];
  const ranked = lines.sort((a, b) => a[0].confidence - b[0].confidence);
  const [first, second] = ranked;
  if (first![1].length === 1 && second![0].confidence - first![0].confidence >= 0.08) return first![1];
  return found; // several equally plausible lines: let the caller treat it as ambiguous
}

/**
 * The smallest sets (one or two rows) whose removal makes the items match the printed subtotal. Several sets, or
 * none, mean there is no safe answer. A unique one flags those rows (never removes them) so the person decides.
 */
function findSuspects(items: ReceiptItem[], targets: Minor[]): ReceiptItem[][] {
  const priced = items.filter((i) => i.lineTotal !== null);
  const sum = priced.reduce((s, i) => s + (i.lineTotal as number), 0);
  if (priced.length > 40) return [];
  const solutions: number[][] = [];
  for (let i = 0; i < priced.length; i++) {
    if (targets.includes(sum - (priced[i]!.lineTotal as number))) solutions.push([i]);
    for (let j = i + 1; j < priced.length; j++) {
      if (targets.includes(sum - (priced[i]!.lineTotal as number) - (priced[j]!.lineTotal as number))) solutions.push([i, j]);
    }
  }
  if (solutions.length === 0) return [];
  const size = Math.min(...solutions.map((s) => s.length));
  return solutions.filter((s) => s.length === size).map((s) => s.map((idx) => priced[idx]!));
}
