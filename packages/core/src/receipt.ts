import type { Minor } from './money';

/** One recognized text line from OCR. Coordinates are normalized 0..1 with the origin at the top-left. */
export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0..1 recognizer confidence */
  confidence: number;
}

export type ItemFlag =
  | 'low-ocr-confidence'
  | 'price-unreadable'
  | 'quantity-inferred'
  | 'unit-price-unknown';

export interface ReceiptItem {
  id: string;
  description: string;
  quantity: number;
  /** Per-unit price, or null when it cannot be derived exactly (never guessed). */
  unitPrice: Minor | null;
  /** Total for the line; null when the price could not be read. */
  lineTotal: Minor | null;
  confidence: number;
  flags: ItemFlag[];
}

/** Dotted paths the user should double-check, e.g. "merchant", "total", "items.i3.lineTotal". */
export type Uncertain = string[];

export interface Receipt {
  merchant: string | null;
  /** ISO date YYYY-MM-DD */
  date: string | null;
  currency: string;
  items: ReceiptItem[];
  /** Negative amount (total savings), 0 if none */
  discounts: Minor;
  subtotal: Minor | null;
  tax: Minor | null;
  service: Minor | null;
  tip: Minor | null;
  total: Minor | null;
  /** True only when reconciliation proves tax/service are already inside the item prices. */
  taxIncluded: boolean;
  uncertain: Uncertain;
  /** Receipt rows the parser could not classify; shown to the user, never dropped silently. */
  unparsed: string[];
}

export type ReconciliationStatus = 'ok' | 'mismatch' | 'incomplete';

export interface Reconciliation {
  status: ReconciliationStatus;
  itemsSum: Minor;
  computedTotal: Minor;
  printedTotal: Minor | null;
  /** printedTotal - computedTotal (0 when ok) */
  difference: Minor | null;
  message: string;
}
