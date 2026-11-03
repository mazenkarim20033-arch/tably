import { allocate } from './money';
import type { Bundle } from './types';

/**
 * Per-item holders, per-person totals and bill totals. A line-for-line port of service.compute_state.
 *
 * Per item: exclusive units are priced per unit; the remaining units form a pool split equally among the people
 * sharing it (or stay unclaimed). Discounts, tax, service and tip are then split in proportion to each person's
 * item subtotal, with the unclaimed subtotal as a bucket, so what someone owes does not move when others claim
 * more. Creator transfers then move money between people without changing the bill total. Every split sums exactly.
 */
export function computeState(b: Bundle, pinned: Map<string, number> = new Map()) {
  const { bill, items, people, claims, transfers } = b;
  const index = new Map(people.map((p, n) => [p.id, n]));
  const held = new Map<string, Map<string, { units: number; shared: boolean }>>();
  for (const c of claims) {
    if (!index.has(c.participant_id)) continue;
    const m = held.get(c.item_id) ?? new Map();
    m.set(c.participant_id, { units: c.units, shared: c.shared === 1 });
    held.set(c.item_id, m);
  }

  const base = people.map(() => 0);
  let unassignedBase = 0;
  const itemsOut = items.map((it) => {
    const holders = held.get(it.id) ?? new Map<string, { units: number; shared: boolean }>();
    const excl = people.map((p) => {
      const h = holders.get(p.id);
      return h && !h.shared ? h.units : 0;
    });
    const sharers = people.flatMap((p, n) => (holders.get(p.id)?.shared ? [n] : []));
    const poolUnits = it.quantity - excl.reduce((a, c) => a + c, 0);
    const shares = allocate(it.line_total, [...excl, poolUnits]);
    shares.slice(0, -1).forEach((s, n) => (base[n]! += s));
    const poolAmount = shares[shares.length - 1]!;
    if (sharers.length > 0) {
      allocate(poolAmount, sharers.map(() => 1)).forEach((s, k) => (base[sharers[k]!]! += s));
    } else {
      unassignedBase += poolAmount;
    }
    return {
      id: it.id,
      description: it.description,
      quantity: it.quantity,
      line_total: it.line_total,
      exclusive: excl.reduce((a, c) => a + c, 0),
      remaining: sharers.length > 0 ? 0 : poolUnits,
      claims: [...holders.entries()].map(([participant_id, h]) => ({ participant_id, units: h.units, shared: h.shared })),
    };
  });

  const inc = bill.tax_included === 1;
  const extras = {
    discounts: bill.discounts,
    tax: inc ? 0 : bill.tax,
    service: inc ? 0 : bill.service,
    tip: bill.tip,
  };
  const weights = [...base, unassignedBase];
  const weightSum = weights.reduce((a, c) => a + c, 0);
  const parts: Record<string, number[]> = {};
  for (const [kind, amount] of Object.entries(extras)) {
    parts[kind] = amount !== 0 && weightSum > 0 ? allocate(amount, weights) : weights.map(() => 0);
  }

  const totals = people.map((_, n) => base[n]! + Object.keys(extras).reduce((s, k) => s + parts[k]![n]!, 0));
  const adjustment = people.map(() => 0);
  const transfersOut: Array<{ id: string; payer_id: string; beneficiary_id: string; amount: number; note: string }> = [];
  for (const t of transfers) {
    const a = index.get(t.payer_id);
    const c = index.get(t.beneficiary_id);
    if (a === undefined || c === undefined) continue;
    const moved = Math.max(0, Math.min(t.amount, totals[c]!)); // cannot relieve someone of more than they owe
    totals[a]! += moved;
    totals[c]! -= moved;
    adjustment[a]! += moved;
    adjustment[c]! -= moved;
    transfersOut.push({ id: t.id, payer_id: t.payer_id, beneficiary_id: t.beneficiary_id, amount: moved, note: t.note });
  }

  // Someone who has started or finished paying owes exactly what they were asked to pay. Any cent of rounding
  // drift this causes lands in "unassigned" rather than moving their number.
  people.forEach((p, n) => {
    const pin = pinned.get(p.id);
    if (pin !== undefined) totals[n] = pin;
  });

  const itemsSum = items.reduce((s, i) => s + i.line_total, 0);
  const participants = people.map((p, n) => ({
    id: p.id,
    name: p.name,
    items_total: base[n]!,
    discounts: parts.discounts![n]!,
    tax: parts.tax![n]!,
    service: parts.service![n]!,
    tip: parts.tip![n]!,
    adjustment: adjustment[n]!,
    total: totals[n]!,
    pinned: pinned.has(p.id),
  }));
  const assigned = totals.reduce((a, c) => a + c, 0);
  const total = itemsSum + Object.values(extras).reduce((a, c) => a + c, 0);
  return {
    items: itemsOut,
    participants,
    transfers: transfersOut,
    totals: { items: itemsSum, ...extras, total, assigned, unassigned: total - assigned },
  };
}

export type State = ReturnType<typeof computeState>;
