import type { Minor } from './money';
import type { ReceiptItem, TotalField } from './receipt';

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

/** Where findings are recorded: the paths to review, a short reason for each, and one-tap choices for totals. */
export interface Marks {
  uncertain: string[];
  reasons: Record<string, string>;
  fieldChoices: Partial<Record<TotalField, Minor[]>>;
}

export function mark(m: Marks, path: string, reason: string): void {
  if (!m.uncertain.includes(path)) m.uncertain.push(path);
  if (!m.reasons[path]) m.reasons[path] = reason;
}

const money = (v: Minor) => (v / 100).toFixed(2);

/** Up to this much (5 piastres) between a subtotal plus charges and the total is rounding. */
const ROUNDING = 5;

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
  /** rows left out of the items (see the stray-row rule) are added here so they stay visible */
  unparsed?: string[];
  uncertain: string[];
  /** amounts the reader saw in the item area but could not tie to a name */
  loosePrices?: Minor[];
  /** where reasons and choices for disputed fields go (optional for readers that do not show them) */
  reasons?: Record<string, string>;
  fieldChoices?: Partial<Record<TotalField, Minor[]>>;
  /** percentages printed next to a charge ("Service 12%"), to check the amount against */
  rates?: Partial<Record<'tax' | 'service', number>>;
}): Settled {
  const { items, totals, discounts, notes, uncertain } = input;
  const m: Marks = { uncertain, reasons: input.reasons ?? {}, fieldChoices: input.fieldChoices ?? {} };
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
        const gone = suspects[0]!;
        const echo = gone.length === 1 && gone[0]!.lineTotal !== null && gone[0]!.lineTotal === sumOf() - gone[0]!.lineTotal;
        if (echo) {
          // The row is worth exactly what all the other rows add up to: it is the subtotal line itself (its label too
          // garbled to read), not an item. Left out, and kept in the list of unused rows so it can be added back.
          const item = gone[0]!;
          items.splice(items.indexOf(item), 1);
          input.unparsed?.push(`${item.description} ${money(item.lineTotal ?? 0)}`.trim());
          notes.push(`Left out "${item.description.trim() || 'a row'}" (${money(item.lineTotal ?? 0)}): it is the same amount as all the other items together, so it is the subtotal, not an item.`);
          arith = 'exact';
        } else {
          // Another amount that would make the items add up if it were not there: flagged, never removed on a guess.
          arith = 'repaired';
          for (const item of gone) {
            item.flags.push('does-not-add-up');
            uncertain.push(`items.${item.id}.lineTotal`);
          }
        }
      } else if (misreads.length + suspects.length > 0) {
        notes.push('The items do not add up to the subtotal and more than one price could be the cause. Check them against the receipt.');
        // Say which prices: each one that a single misread digit would explain, with that value as a choice. With
        // more than three candidates the note alone is more useful than a screen full of warnings.
        const byItem = new Map<ReceiptItem, Minor[]>();
        for (const f of findMisreads(items, targets)) byItem.set(f.item, [...(byItem.get(f.item) ?? []), f.value]);
        if (byItem.size <= 3) {
          for (const [item, values] of byItem) {
            item.choices = [...new Set([...(item.choices ?? []), ...values])];
            mark(m, `items.${item.id}.lineTotal`, 'The items do not add up. This price may be misread.');
          }
        }
      }
    }
  }

  let taxIncluded = false;
  let corroborated = false;
  if (total === null) {
    if (totals.subtotal !== undefined) {
      // No total line: the subtotal plus the printed charges is the amount to split. Said, flagged, editable.
      total = totals.subtotal + discounts + extras;
      notes.push(`No total line on the receipt; calculated ${(total / 100).toFixed(2)} from the subtotal and charges.`);
      // The printed subtotal agrees with the items, so the calculated total is as good as a printed one: no warning.
      corroborated = sumOf() + discounts === totals.subtotal;
    } else {
      notes.push('No total on the receipt to check the items against.');
    }
    if (!corroborated) uncertain.push('total');
  } else if (totals.tax || totals.service) {
    // Prove, don't assume: if items alone already equal the printed total, tax/service are inclusive.
    const withTip = sumOf() + discounts + (totals.tip ?? 0);
    if (withTip + (totals.tax ?? 0) + (totals.service ?? 0) !== total && withTip === total) {
      taxIncluded = true;
      notes.push('Tax and service appear to be included in the item prices.');
    }
  }

  if (input.total !== null && totals.subtotal !== undefined && !taxIncluded) checkChain(totals, input.total, discounts, m);
  if (input.rates) checkRates(totals, sumOf(), discounts, input.rates, m);

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

/**
 * The printed subtotal plus the printed charges should be the printed total. When they are not, each single-digit
 * misreading of one of those numbers that would make them agree is offered on that field (up to three fields).
 */
function checkChain(totals: Charges, total: Minor, discounts: Minor, m: Marks): void {
  const fields: Array<[TotalField, Minor]> = (['subtotal', 'tax', 'service', 'tip'] as const)
    .filter((k) => totals[k] !== undefined)
    .map((k) => [k, totals[k]!] as [TotalField, Minor]);
  const sumWith = (f: TotalField | null, v: Minor) =>
    fields.reduce((s, [k, x]) => s + (k === f ? v : x), 0) + discounts;
  // Shops round each line separately, so a few piastres of difference is rounding, not a misread amount.
  if (Math.abs(sumWith(null, 0) - total) <= ROUNDING) return;
  const fixes: Array<[TotalField, Minor]> = [];
  for (const [k, x] of fields) for (const v of digitVariants(x)) if (sumWith(k, v) === total) fixes.push([k, v]);
  for (const v of digitVariants(total)) if (sumWith(null, 0) === v) fixes.push(['total', v]);
  const fieldsHit = new Set(fixes.map((f) => f[0]));
  if (fixes.length === 0 || fieldsHit.size > 3) return;
  for (const [k, v] of fixes) {
    m.fieldChoices[k] = [...new Set([...(m.fieldChoices[k] ?? []), v])];
    mark(m, k, 'The subtotal and charges do not add up to the total. This amount may be misread.');
  }
}

/**
 * A charge printed with its rate ("VAT 14%") should be that share of what it applies to: the subtotal, after any
 * discount, plus the service charge when tax is charged on service. Rounding differs between shops, so up to one
 * pound either way counts as a match.
 */
function checkRates(totals: Charges, itemsSum: Minor, discounts: Minor, rates: Partial<Record<'tax' | 'service', number>>, m: Marks): void {
  const sub = totals.subtotal ?? itemsSum;
  for (const key of ['service', 'tax'] as const) {
    const rate = rates[key];
    const value = totals[key];
    if (!rate || value === undefined || value === 0) continue;
    const bases = [sub, sub + discounts, sub + discounts + (key === 'tax' ? (totals.service ?? 0) : 0)];
    const fits = (v: Minor) => bases.some((b) => Math.abs(Math.round((b * rate) / 100) - v) <= 100);
    if (fits(value)) continue;
    const fixes = digitVariants(value).filter(fits);
    if (fixes.length) m.fieldChoices[key] = [...new Set([...(m.fieldChoices[key] ?? []), ...fixes])];
    mark(m, key, `This is not ${rate}% of the subtotal. Check it against the receipt${fixes.length ? '' : ` (${rate}% would be about ${money(Math.round((bases[bases.length - 1]! * rate) / 100))})`}.`);
  }
}

/** Every number one commonly-confused digit away from v. */
export function digitVariants(v: Minor): Minor[] {
  if (v <= 0) return [];
  const digits = String(v).split('');
  const out = new Set<Minor>();
  digits.forEach((d, pos) => {
    for (const alt of CONFUSABLE[d] ?? []) {
      const c = Number([...digits.slice(0, pos), alt, ...digits.slice(pos + 1)].join(''));
      if (c > 0) out.add(c);
    }
  });
  return [...out];
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
