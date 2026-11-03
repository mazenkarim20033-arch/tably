import type { Minor } from './money';
import type { Receipt, ReceiptItem } from './receipt';

/** Pure edit helpers. A field the user touches counts as confirmed, so it leaves `uncertain`. */

export function confirm(r: Receipt, ...paths: string[]): Receipt {
  const gone = new Set(paths);
  return { ...r, uncertain: r.uncertain.filter((p) => !gone.has(p)) };
}

export function emptyReceipt(): Receipt {
  return {
    merchant: null, date: null, currency: 'EGP', items: [], discounts: 0,
    subtotal: null, tax: null, service: null, tip: null, total: null,
    taxIncluded: false, uncertain: [], unparsed: [], notes: [],
  };
}

function unitFor(quantity: number, lineTotal: Minor | null): Minor | null {
  if (lineTotal === null || quantity <= 0) return null;
  return lineTotal % quantity === 0 ? lineTotal / quantity : null;
}

function patchItem(r: Receipt, id: string, fn: (i: ReceiptItem) => ReceiptItem, ...confirmed: string[]): Receipt {
  const next = { ...r, items: r.items.map((i) => (i.id === id ? fn(i) : i)) };
  return confirm(next, ...confirmed.map((c) => `items.${id}.${c}`));
}

export function setItemDescription(r: Receipt, id: string, description: string): Receipt {
  return patchItem(r, id, (i) => ({ ...i, description }), 'description');
}

export function setItemQuantity(r: Receipt, id: string, quantity: number): Receipt {
  const q = Math.max(1, Math.floor(quantity) || 1);
  return patchItem(r, id, (i) => ({
    ...i, quantity: q, unitPrice: unitFor(q, i.lineTotal),
    flags: i.flags.filter((f) => f !== 'quantity-inferred' && f !== 'unit-price-unknown'),
  }), 'quantity');
}

export function setItemLineTotal(r: Receipt, id: string, lineTotal: Minor | null): Receipt {
  return patchItem(r, id, (i) => ({
    ...i, lineTotal, unitPrice: unitFor(i.quantity, lineTotal),
    // Any edit settles the doubt about this price, so the suggestion and its flags go away.
    suggestedLineTotal: undefined,
    altLineTotals: undefined,
    flags: i.flags.filter((f) => !['price-unreadable', 'unit-price-unknown', 'low-ocr-confidence', 'maybe-misread', 'does-not-add-up'].includes(f)),
  }), 'lineTotal', 'description');
}

export function addItem(r: Receipt): Receipt {
  const n = r.items.reduce((m, i) => Math.max(m, Number(i.id.slice(1)) || 0), 0) + 1;
  const item: ReceiptItem = { id: `i${n}`, description: '', quantity: 1, unitPrice: null, lineTotal: null, confidence: 1, flags: [] };
  return { ...r, items: [...r.items, item] };
}

export function removeItem(r: Receipt, id: string): Receipt {
  const prefix = `items.${id}.`;
  return { ...r, items: r.items.filter((i) => i.id !== id), uncertain: r.uncertain.filter((p) => !p.startsWith(prefix)) };
}

export type HeaderField = 'merchant' | 'date' | 'currency' | 'discounts' | 'subtotal' | 'tax' | 'service' | 'tip' | 'total';

export function setField<K extends HeaderField>(r: Receipt, key: K, value: Receipt[K]): Receipt {
  return confirm({ ...r, [key]: value }, key);
}

export function setTaxIncluded(r: Receipt, taxIncluded: boolean): Receipt {
  return { ...r, taxIncluded };
}
