export interface Holder { participant_id: string; units: number }
export interface BillItem {
  id: string; description: string; quantity: number; line_total: number; remaining: number; claims: Holder[];
}
export interface PersonTotal {
  id: string; name: string; items_total: number; discounts: number; tax: number; service: number; tip: number; total: number;
}
export interface BillView {
  store: string; date: string | null; currency: string; status: 'open' | 'closed';
  items: BillItem[]; participants: PersonTotal[];
  totals: { items: number; discounts: number; tax: number; service: number; tip: number; total: number; assigned: number; unassigned: number };
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

export const join = (token: string, name: string) =>
  call<{ participant_id: string; participant_token: string; name: string }>(
    `/api/s/${encodeURIComponent(token)}/participants`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) },
  );

export const setClaim = (token: string, me: Me, itemId: string, units: number) =>
  call<BillView>(`/api/s/${encodeURIComponent(token)}/claims`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Participant-Id': me.id, 'X-Participant-Token': me.token },
    body: JSON.stringify({ item_id: itemId, units }),
  });
