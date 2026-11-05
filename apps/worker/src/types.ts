export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SHARE_LINK_DAYS?: string;
  PAYMENT_LINK_HOSTS?: string;
  /** Workers AI, for reading receipts with a vision model. Optional: the app works without it. */
  AI?: Ai;
  SCAN_ENABLED?: string;
  SCAN_MODEL?: string;
  SCAN_DAILY_CAP?: string;
  SCAN_MONTHLY_CAP?: string;
  SCAN_USER_MONTHLY?: string;
}

export interface BillRow {
  id: string;
  store: string;
  receipt_date: string | null;
  currency: string;
  discounts: number;
  tax: number;
  service: number;
  tip: number;
  tax_included: number;
  printed_total: number | null;
  status: 'open' | 'closed';
  payee_name: string | null;
  instapay_address: string | null;
  instapay_phone: string | null;
  instapay_link: string | null;
  /** JSON list of other ways to pay, or null */
  payee_extra: string | null;
  version: number;
  share_token: string;
  share_disabled: number;
  share_expires_at: string | null;
  admin_token_hash: string;
  created_at: string;
}
export interface ItemRow { id: string; bill_id: string; position: number; description: string; quantity: number; line_total: number }
export interface ParticipantRow {
  id: string; bill_id: string; name: string; name_key: string; secret_hash: string; created_at: string;
  last_reminded_at: string | null; reminder_count: number;
}
export interface ClaimRow { participant_id: string; item_id: string; units: number; shared: number }
export interface TransferRow { id: string; bill_id: string; payer_id: string; beneficiary_id: string; amount: number; note: string; created_at: string }
export interface PaymentRow {
  id: string; bill_id: string; participant_id: string; provider: string; amount: number; currency: string; status: string;
  reference: string; external_id: string | null; payer_note: string | null; idempotency_key: string | null;
  created_at: string; expires_at: string | null;
}

/** Everything one bill needs, loaded in a single D1 round trip. */
export interface Bundle {
  bill: BillRow;
  items: ItemRow[];
  people: ParticipantRow[];
  claims: ClaimRow[];
  transfers: TransferRow[];
  payments: PaymentRow[];
}

export const PINNING = ['initiated', 'awaiting_confirmation', 'verified'] as const;
