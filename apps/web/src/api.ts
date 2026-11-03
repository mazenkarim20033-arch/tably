export interface Holder { participant_id: string; units: number; shared: boolean }
export interface BillItem {
  id: string; description: string; quantity: number; line_total: number;
  /** whole units held exclusively by someone */
  exclusive: number;
  /** units nobody has claimed (0 once anyone shares the item) */
  remaining: number;
  claims: Holder[];
}
export type PaymentStatus = "initiated" | "awaiting_confirmation" | "verified" | "failed" | "expired" | "cancelled";
export interface PaymentSummary { id: string; status: PaymentStatus; amount: number; reference: string; provider: string }
export interface Payee { name: string | null; instapay_address: string | null; instapay_phone: string | null; instapay_link: string | null }
export interface PaymentMethod { key: string; label: string; automated: boolean; enabled: boolean; reason: string }
export interface PersonTotal {
  id: string; name: string; items_total: number; discounts: number; tax: number; service: number; tip: number;
  /** money moved to or from this person by the bill creator (+ covers others, − is covered) */
  adjustment: number;
  total: number;
  /** true once this person has started paying: their amount no longer moves */
  pinned: boolean;
  payment: PaymentSummary | null;
}
export interface Transfer { id: string; payer_id: string; beneficiary_id: string; amount: number; note: string }
export interface BillView {
  store: string; date: string | null; currency: string; status: 'open' | 'closed';
  items: BillItem[]; participants: PersonTotal[]; transfers: Transfer[];
  totals: { items: number; discounts: number; tax: number; service: number; tip: number; total: number; assigned: number; unassigned: number; collected: number; awaiting: number; outstanding: number };
  payee: Payee | null; payment_methods: PaymentMethod[];
}
export interface Me { id: string; token: string; name: string }

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let msg = 'Something went wrong. Please try again.';
    let code: string | undefined;
    try {
      const body = await res.json();
      const d = body.detail;
      if (typeof d === 'string') msg = d;
      else if (d?.message) { msg = d.message; code = d.code; }
    } catch { /* keep default */ }
    throw new ApiError(res.status, msg, code);
  }
  return res.json() as Promise<T>;
}

export const getBill = (token: string) => call<BillView>(`/api/s/${encodeURIComponent(token)}`);

/** One cheap query: has anything on this bill changed since the version I last saw? */
export const getVersion = (token: string) =>
  call<{ version: number; status: string }>(`/api/s/${encodeURIComponent(token)}/version`);

export const join =(token: string, name: string) =>
  call<{ participant_id: string; participant_token: string; name: string }>(
    `/api/s/${encodeURIComponent(token)}/participants`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) },
  );

export type ClaimChange = { units: number } | { share: boolean };

export const setClaim = (token: string, me: Me, itemId: string, change: ClaimChange) =>
  call<BillView>(`/api/s/${encodeURIComponent(token)}/claims`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Participant-Id': me.id, 'X-Participant-Token': me.token },
    body: JSON.stringify({ item_id: itemId, ...change }),
  });

export interface PaymentDetails {
  payment: PaymentSummary & { currency: string };
  instructions: { payee_name?: string | null; instapay_address?: string | null; instapay_phone?: string | null; instapay_link?: string | null; steps?: string[] };
}

const authHeaders = (me: Me) => ({ "Content-Type": "application/json", "X-Participant-Id": me.id, "X-Participant-Token": me.token });
const pay = (token: string) => `/api/s/${encodeURIComponent(token)}/payments`;

export const startPayment = (token: string, me: Me, idempotencyKey: string) =>
  call<PaymentDetails>(pay(token), { method: "POST", headers: { ...authHeaders(me), "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ provider: "manual_instapay" }) });

export const getPayment = (token: string, me: Me, id: string) =>
  call<PaymentDetails>(`${pay(token)}/${id}`, { headers: authHeaders(me) });

export const markPaid = (token: string, me: Me, id: string, payerNote: string) =>
  call<PaymentDetails>(`${pay(token)}/${id}/paid`, { method: "POST", headers: authHeaders(me), body: JSON.stringify(payerNote ? { payer_note: payerNote } : {}) });

export const cancelPayment = (token: string, me: Me, id: string) =>
  call<PaymentDetails>(`${pay(token)}/${id}/cancel`, { method: "POST", headers: authHeaders(me) });
