import { computeState } from './compute';
import { pinnedAmounts } from './data';
import type { Bundle, Env, PaymentRow } from './types';

const summary = (p: PaymentRow | undefined) =>
  p ? { id: p.id, status: p.status, amount: p.amount, reference: p.reference, provider: p.provider } : null;

/** Per participant: the verified payment, else the live one, else the most recent attempt. */
function relevantPayments(payments: PaymentRow[]): Map<string, PaymentRow> {
  const rank: Record<string, number> = { verified: 3, awaiting_confirmation: 2, initiated: 2 };
  const best = new Map<string, PaymentRow>();
  for (const p of payments) {
    const cur = best.get(p.participant_id);
    if (!cur || (rank[p.status] ?? 1) >= (rank[cur.status] ?? 1)) best.set(p.participant_id, p);
  }
  return best;
}

/** The stored list of other ways to pay; anything unreadable counts as none. */
export function extraMethods(json: string | null): Array<{ kind: string; label?: string | null; value?: string }> {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function paymentMethods(hasPayee: boolean) {
  return [
    {
      key: 'manual_instapay', label: 'InstaPay (manual)', automated: false, enabled: hasPayee,
      reason: hasPayee ? '' : 'The bill creator has not added payment details yet.',
    },
    {
      key: 'kashier', label: 'InstaPay via Kashier (automatic)', automated: true, enabled: false,
      reason: 'Needs a Kashier merchant account and credentials. Not implemented yet.',
    },
    { key: 'telda', label: 'Telda', automated: false, enabled: false, reason: 'No public Telda merchant API is available, so this is not supported.' },
  ];
}

export function publicView(b: Bundle) {
  const state = computeState(b, pinnedAmounts(b));
  const best = relevantPayments(b.payments);
  const participants = state.participants.map((row) => ({ ...row, payment: summary(best.get(row.id)) }));
  const collected = b.payments.filter((p) => p.status === 'verified').reduce((s, p) => s + p.amount, 0);
  const awaiting = b.payments.filter((p) => p.status === 'awaiting_confirmation').reduce((s, p) => s + p.amount, 0);
  const methods = extraMethods(b.bill.payee_extra);
  const hasPayee = !!(b.bill.instapay_address || b.bill.instapay_phone || b.bill.instapay_link || methods.length > 0);
  return {
    store: b.bill.store,
    date: b.bill.receipt_date,
    currency: b.bill.currency,
    status: b.bill.status,
    ...state,
    participants,
    totals: { ...state.totals, collected, awaiting, outstanding: state.totals.total - collected },
    payee: hasPayee
      ? {
          name: b.bill.payee_name,
          instapay_address: b.bill.instapay_address,
          instapay_phone: b.bill.instapay_phone,
          instapay_link: b.bill.instapay_link,
          methods,
        }
      : null,
    payment_methods: paymentMethods(hasPayee),
  };
}

export interface EventRow { payment_id: string; at: string; actor: string; from_status: string | null; to_status: string; note: string }

export function adminView(b: Bundle, events: EventRow[] = []) {
  const view = publicView(b);
  const names = new Map(b.people.map((p) => [p.id, p.name]));
  const reminders = new Map(b.people.map((p) => [p.id, p]));
  return {
    ...view,
    participants: view.participants.map((row) => ({
      ...row,
      last_reminded_at: reminders.get(row.id)?.last_reminded_at ?? null,
      reminder_count: reminders.get(row.id)?.reminder_count ?? 0,
    })),
    id: b.bill.id,
    share_token: b.bill.share_token,
    share_disabled: b.bill.share_disabled === 1,
    share_expires_at: b.bill.share_expires_at,
    printed_total: b.bill.printed_total,
    tax_included: b.bill.tax_included === 1,
    receipt: { discounts: b.bill.discounts, tax: b.bill.tax, service: b.bill.service, tip: b.bill.tip },
    has_image: false, // photos stay on the phone
    created_at: b.bill.created_at,
    payments: b.payments.map((p) => ({
      ...summary(p),
      participant_id: p.participant_id,
      participant_name: names.get(p.participant_id) ?? '?',
      payer_note: p.payer_note,
      created_at: p.created_at,
      events: events
        .filter((e) => e.payment_id === p.id)
        .map((e) => ({ at: e.at, actor: e.actor, from: e.from_status, to: e.to_status, note: e.note })),
    })),
  };
}

export type { Env };
