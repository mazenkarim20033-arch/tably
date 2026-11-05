import type { Receipt } from '@tably/core';
import { requireServer } from './config';

export interface CreatedBill {
  id: string;
  share_token: string;
  admin_token: string;
  share_expires_at: string;
}

export class MismatchError extends Error {
  constructor(public computed: number, public printed: number) {
    super('Items do not add up to the receipt total.');
  }
}

/** Map the edited receipt to the API payload. Throws a readable error if something required is missing. */
export interface Payee { payee_name: string; instapay_address?: string; instapay_phone?: string; instapay_link?: string; methods?: import('./myBills').PayeeMethod[] }

export function toPayload(r: Receipt, acceptMismatch: boolean, payee?: Payee) {
  const items = r.items.map((i) => {
    if (i.lineTotal === null) throw new Error(`"${i.description || 'An item'}" has no price.`);
    if (i.description.trim() === '') throw new Error('Every item needs a name.');
    return { description: i.description.trim(), quantity: i.quantity, line_total: i.lineTotal };
  });
  return {
    store: (r.merchant ?? '').trim() || 'Receipt',
    receipt_date: r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null,
    currency: r.currency,
    items,
    discounts: Math.min(0, r.discounts),
    tax: r.tax ?? 0,
    service: r.service ?? 0,
    tip: r.tip ?? 0,
    tax_included: r.taxIncluded,
    printed_total: r.total,
    accept_mismatch: acceptMismatch,
    ...(payee ? { payee } : {}),
  };
}

export async function createBill(r: Receipt, acceptMismatch = false, payee?: Payee): Promise<CreatedBill> {
  const res = await fetch(`${requireServer()}/api/bills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toPayload(r, acceptMismatch, payee)),
  });
  if (res.ok) return res.json();
  let detail: unknown;
  try {
    detail = (await res.json()).detail;
  } catch {
    /* non-JSON error */
  }
  if (res.status === 422 && typeof detail === 'object' && detail && (detail as { code?: string }).code === 'mismatch') {
    const d = detail as { computed_total: number; printed_total: number };
    throw new MismatchError(d.computed_total, d.printed_total);
  }
  if (Array.isArray(detail) && detail[0]?.msg) throw new Error(String(detail[0].msg).replace(/^Value error, /, ''));
  throw new Error(typeof detail === 'string' ? detail : 'Could not create the bill. Check your connection and try again.');
}

export interface AdminPayment {
  id: string; status: string; amount: number; reference: string; participant_id: string;
  participant_name: string; payer_note: string | null; created_at: string;
}
export interface AdminItem {
  id: string; description: string; quantity: number; line_total: number; exclusive: number; remaining: number;
  claims: { participant_id: string; units: number; shared: boolean }[];
}
export interface AdminPerson {
  id: string; name: string; total: number; items_total: number; adjustment: number; pinned: boolean;
  payment: { status: string; amount: number; reference: string } | null;
  last_reminded_at: string | null; reminder_count: number;
}
export interface AdminBill {
  id: string; store: string; date: string | null; currency: string; share_token: string; status: string;
  share_disabled: boolean; share_expires_at: string | null; tax_included: boolean; printed_total: number | null;
  receipt: { discounts: number; tax: number; service: number; tip: number };
  totals: { total: number; assigned: number; unassigned: number; collected: number; awaiting: number; outstanding: number };
  items: AdminItem[]; participants: AdminPerson[];
  transfers: { id: string; payer_id: string; beneficiary_id: string; amount: number; note: string }[];
  payments: AdminPayment[];
  payee: { name: string | null } | null;
}

export class ApiProblem extends Error {
  constructor(message: string, public code?: string, public status?: number) {
    super(message);
  }
}

async function admin<T>(id: string, token: string, path = "", init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${requireServer()}/api/bills/${id}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-Admin-Token": token, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    let msg = "Request failed.";
    let code: string | undefined;
    try {
      const d = (await res.json()).detail;
      if (typeof d === "string") msg = d;
      else if (Array.isArray(d) && d[0]?.msg) msg = String(d[0].msg).replace(/^Value error, /, "");
      else if (d?.message) { msg = d.message; code = d.code; }
    } catch { /* keep default */ }
    throw new ApiProblem(msg, code, res.status);
  }
  return res.json() as Promise<T>;
}

const post = (body: unknown = {}) => ({ method: "POST", body: JSON.stringify(body) });
export type ClaimChange = { units: number } | { share: boolean };

export const getAdminBill = (id: string, t: string) => admin<AdminBill>(id, t);
export const confirmPayment = (id: string, t: string, paymentId: string) =>
  admin<AdminBill>(id, t, `/payments/${paymentId}/confirm`, post({ note: "Confirmed in TABLY app" }));
export const rejectPayment = (id: string, t: string, paymentId: string) =>
  admin<AdminBill>(id, t, `/payments/${paymentId}/reject`, post({ note: "Not received" }));
export const closeBill = (id: string, t: string, force = false) => admin<AdminBill>(id, t, "/close", post({ force }));
export const reopenBill = (id: string, t: string) => admin<AdminBill>(id, t, "/reopen", post());
export const addPerson = (id: string, t: string, name: string) => admin<AdminBill>(id, t, "/participants", post({ name }));
export const removePerson = (id: string, t: string, pid: string) => admin<AdminBill>(id, t, `/participants/${pid}`, { method: "DELETE" });
export const assignFor = (id: string, t: string, pid: string, itemId: string, change: ClaimChange) =>
  admin<AdminBill>(id, t, `/participants/${pid}/claims`, { method: "PUT", body: JSON.stringify({ item_id: itemId, ...change }) });
export const logReminders = (id: string, t: string, ids: string[]) => admin<AdminBill>(id, t, "/reminders", post({ participant_ids: ids }));
export const addTransfer = (id: string, t: string, payer: string, beneficiary: string, amount: number, note = "") =>
  admin<AdminBill>(id, t, "/transfers", post({ payer_id: payer, beneficiary_id: beneficiary, amount, note }));
export const removeTransfer = (id: string, t: string, transferId: string) => admin<AdminBill>(id, t, `/transfers/${transferId}`, { method: "DELETE" });
export const updateLink = (id: string, t: string, change: { disabled?: boolean; rotate?: boolean; extend_days?: number }) =>
  admin<{ share_token: string; share_disabled: boolean; share_expires_at: string }>(id, t, "/link", post(change));

export const editReceipt = (id: string, t: string, r: Receipt, acceptMismatch = false) =>
  admin<AdminBill>(id, t, "/receipt", { method: "PATCH", body: JSON.stringify(toEditPayload(r, acceptMismatch)) });

/** Same shape as creating, but items keep their server id so claims survive the edit. */
export function toEditPayload(r: Receipt, acceptMismatch: boolean) {
  const { payee: _ignored, items, ...rest } = toPayload(r, acceptMismatch);
  void _ignored;
  return {
    ...rest,
    items: items.map((it, n) => ({ ...it, ...(/^[a-f0-9]{32}$/.test(r.items[n]!.id) ? { id: r.items[n]!.id } : {}) })),
  };
}

export interface BillSummary {
  id: string; missing?: boolean; store?: string; date?: string | null; currency?: string; status?: string;
  total?: number; collected?: number; outstanding?: number; people?: number; waiting?: number; link_disabled?: boolean;
}
export async function fetchSummaries(refs: { id: string; admin_token: string }[]): Promise<BillSummary[]> {
  if (refs.length === 0) return [];
  const res = await fetch(`${requireServer()}/api/bills/summaries`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bills: refs.slice(0, 50) }),
  });
  if (!res.ok) throw new Error("Could not load your bills.");
  return (await res.json()).bills;
}
