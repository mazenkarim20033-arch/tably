import { File } from 'expo-file-system';
import type { Receipt } from '@tably/core';
import { API_URL } from './config';

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
export interface Payee { payee_name: string; instapay_address?: string; instapay_phone?: string; instapay_link?: string }

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
  const res = await fetch(`${API_URL}/api/bills`, {
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

/** Best effort: the bill works without the image, so a failed upload must not block sharing. */
export async function uploadImage(billId: string, adminToken: string, uri: string): Promise<boolean> {
  try {
    const file = new File(uri);
    const form = new FormData();
    form.append('file', { uri: file.uri, name: 'receipt.jpg', type: 'image/jpeg' } as unknown as Blob);
    const res = await fetch(`${API_URL}/api/bills/${billId}/image`, {
      method: 'POST',
      headers: { 'X-Admin-Token': adminToken },
      body: form,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface AdminPayment {
  id: string; status: string; amount: number; reference: string; participant_id: string;
  participant_name: string; payer_note: string | null; created_at: string;
}
export interface AdminBill {
  id: string; store: string; currency: string; share_token: string; status: string;
  totals: { total: number; assigned: number; unassigned: number; collected: number; awaiting: number; outstanding: number };
  participants: { id: string; name: string; total: number; payment: { status: string; amount: number } | null }[];
  payments: AdminPayment[];
  payee: { name: string | null } | null;
}

async function admin<T>(id: string, token: string, path = '', init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}/api/bills/${id}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    let msg = 'Request failed.';
    try {
      const d = (await res.json()).detail;
      msg = typeof d === 'string' ? d : d?.message ?? msg;
    } catch { /* keep default */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const getAdminBill = (id: string, token: string) => admin<AdminBill>(id, token);
export const confirmPayment = (id: string, token: string, paymentId: string) =>
  admin<AdminBill>(id, token, `/payments/${paymentId}/confirm`, { method: 'POST', body: JSON.stringify({ note: 'Confirmed in TABLY app' }) });
export const rejectPayment = (id: string, token: string, paymentId: string) =>
  admin<AdminBill>(id, token, `/payments/${paymentId}/reject`, { method: 'POST', body: JSON.stringify({ note: 'Not received' }) });
