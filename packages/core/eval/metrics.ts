import { normalizeArabic } from '../src/parseReceipt';
import type { Receipt } from '../src/receipt';
import type { Truth } from './fixture';

/**
 * Scores one reading against its answer key. Items are matched by name first, so a price that landed on the wrong
 * item counts as wrong even when the receipt adds up.
 */
export interface Score {
  truthItems: number;
  predItems: number;
  /** truth items found by name */
  matched: number;
  /** predicted items that match no truth item (addresses, staff, junk) */
  falseItems: number;
  qtyRight: number;
  priceRight: number;
  /** truth items whose printed price was read somewhere, but on another line */
  misassigned: number;
  nameScore: number; // sum of name similarity over matched items
  totals: Record<'subtotal' | 'tax' | 'service' | 'tip' | 'discount' | 'total', { checked: number; right: number }>;
  /** fields (item qty/price, totals) the reading got wrong without flagging them for review */
  silentWrong: number;
  /** fields flagged for review that were in fact right */
  flaggedRight: number;
  flaggedWrong: number;
  unflaggedRight: number;
  /** every item, quantity, price and printed total right */
  exact: boolean;
}

const words = (s: string) =>
  normalizeArabic(s.toLowerCase())
    .replace(/[^a-z0-9؀-ۿ\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);

/** Share of the truth name's words found in the prediction (which may add a caption). */
export function nameSimilarity(truth: string, pred: string): number {
  const t = words(truth);
  if (t.length === 0) return 0;
  const p = new Set(words(pred));
  const hit = t.filter((w) => p.has(w) || [...p].some((q) => q.length >= 4 && (q.startsWith(w.slice(0, 4)) || w.startsWith(q.slice(0, 4))))).length;
  return hit / t.length;
}

const blankCount = () => ({ checked: 0, right: 0 });

export function score(rc: Receipt, truth: Truth): Score {
  const s: Score = {
    truthItems: truth.items.length, predItems: rc.items.length, matched: 0, falseItems: 0, qtyRight: 0, priceRight: 0,
    misassigned: 0, nameScore: 0,
    totals: { subtotal: blankCount(), tax: blankCount(), service: blankCount(), tip: blankCount(), discount: blankCount(), total: blankCount() },
    silentWrong: 0, flaggedRight: 0, flaggedWrong: 0, unflaggedRight: 0, exact: false,
  };
  const flagged = (path: string) => rc.uncertain.includes(path);
  const judge = (right: boolean, isFlagged: boolean) => {
    if (right && isFlagged) s.flaggedRight += 1;
    else if (right) s.unflaggedRight += 1;
    else if (isFlagged) s.flaggedWrong += 1;
    else s.silentWrong += 1;
  };

  // Greedy matching by name similarity; equal similarity prefers the item with the same price.
  const pairs: Array<{ t: number; p: number; sim: number }> = [];
  truth.items.forEach((ti, t) =>
    rc.items.forEach((pi, p) => {
      const sim = nameSimilarity(ti.name, pi.description);
      if (sim >= 0.5) pairs.push({ t, p, sim: sim + (pi.lineTotal === ti.lineTotal ? 0.01 : 0) });
    }),
  );
  pairs.sort((a, b) => b.sim - a.sim);
  const tUsed = new Map<number, number>();
  const pUsed = new Set<number>();
  for (const pr of pairs) {
    if (tUsed.has(pr.t) || pUsed.has(pr.p)) continue;
    tUsed.set(pr.t, pr.p);
    pUsed.add(pr.p);
  }
  const predPrices = rc.items.map((i) => i.lineTotal);
  let itemsExact = truth.items.length === rc.items.length;
  truth.items.forEach((ti, t) => {
    const p = tUsed.get(t);
    if (p === undefined) {
      itemsExact = false;
      if (predPrices.includes(ti.lineTotal)) s.misassigned += 1;
      // A missing item is wrong twice (qty and price) and is never "flagged".
      s.silentWrong += 2;
      return;
    }
    const pi = rc.items[p]!;
    s.matched += 1;
    s.nameScore += Math.min(1, nameSimilarity(ti.name, pi.description));
    const qtyOk = pi.quantity === ti.qty;
    const priceOk = pi.lineTotal === ti.lineTotal;
    if (qtyOk) s.qtyRight += 1;
    if (priceOk) s.priceRight += 1;
    else if (predPrices.includes(ti.lineTotal)) s.misassigned += 1;
    if (!qtyOk || !priceOk) itemsExact = false;
    judge(qtyOk, flagged(`items.${pi.id}.quantity`));
    judge(priceOk, flagged(`items.${pi.id}.lineTotal`) || pi.flags.includes('maybe-misread') || pi.flags.includes('does-not-add-up'));
  });
  s.falseItems = rc.items.length - pUsed.size;
  if (s.falseItems > 0) itemsExact = false;

  // Charges: "not printed" and 0 are the same thing to the person splitting the bill.
  const same = (a: number | null, b: number | null) => (a ?? 0) === (b ?? 0);
  let totalsExact = true;
  const check = (key: keyof Score['totals'], got: number | null, want: number | null, path: string) => {
    if (want === null && key === 'total') return; // no printed total to compare with
    s.totals[key].checked += 1;
    const ok = key === 'total' ? got === want : same(got, want);
    if (ok) s.totals[key].right += 1;
    else totalsExact = false;
    judge(ok, flagged(path));
  };
  check('subtotal', rc.subtotal, truth.subtotal, 'subtotal');
  check('tax', rc.tax, truth.tax, 'tax');
  check('service', rc.service, truth.service, 'service');
  check('tip', rc.tip, truth.tip, 'tip');
  check('discount', rc.discounts === 0 ? null : rc.discounts, truth.discount, 'discounts');
  check('total', rc.total, truth.total, 'total');
  s.exact = itemsExact && totalsExact;
  return s;
}

/** Sum scores of many receipts and turn them into rates. */
export function summarize(scores: Array<{ s: Score; ms: number }>) {
  const sum = (f: (s: Score) => number) => scores.reduce((a, { s }) => a + f(s), 0);
  const rate = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
  const truthItems = sum((s) => s.truthItems);
  const matched = sum((s) => s.matched);
  const totalsKeys = ['subtotal', 'tax', 'service', 'tip', 'discount', 'total'] as const;
  const flaggedWrong = sum((s) => s.flaggedWrong);
  const silentWrong = sum((s) => s.silentWrong);
  const times = scores.map((x) => x.ms).sort((a, b) => a - b);
  return {
    receipts: scores.length,
    exactReceipts: rate(scores.filter((x) => x.s.exact).length, scores.length),
    itemRecall: rate(matched, truthItems),
    itemPrecision: rate(matched, sum((s) => s.predItems)),
    falseItems: sum((s) => s.falseItems),
    nameScore: rate(sum((s) => s.nameScore), matched),
    qtyAccuracy: rate(sum((s) => s.qtyRight), matched),
    priceAccuracy: rate(sum((s) => s.priceRight), matched),
    /** of the truth items, how many had their price read but put on another line */
    misassigned: sum((s) => s.misassigned),
    totals: Object.fromEntries(totalsKeys.map((k) => [k, rate(sum((s) => s.totals[k].right), sum((s) => s.totals[k].checked))])),
    /** of all wrong fields, the share that was flagged for review (higher is better) */
    errorsFlagged: rate(flaggedWrong, flaggedWrong + silentWrong),
    /** of all flagged fields, the share that was actually wrong (higher means fewer false alarms) */
    flagPrecision: rate(flaggedWrong, flaggedWrong + sum((s) => s.flaggedRight)),
    silentWrong,
    msMedian: times.length ? Math.round(times[Math.floor(times.length / 2)]! * 10) / 10 : null,
    msMax: times.length ? Math.round(times[times.length - 1]! * 10) / 10 : null,
  };
}
