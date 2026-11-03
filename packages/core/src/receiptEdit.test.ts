import { describe, expect, it } from 'vitest';
import { addItem, emptyReceipt, removeItem, setField, setItemLineTotal, setItemQuantity } from './receiptEdit';
import { reconcile } from './reconcile';

describe('receiptEdit', () => {
  it('manual entry reconciles', () => {
    let r = addItem(emptyReceipt());
    r = setItemLineTotal(r, 'i1', 5000);
    r = setField(r, 'total', 5000);
    expect(reconcile(r).status).toBe('ok');
  });
  it('editing confirms uncertain fields', () => {
    let r = { ...addItem(emptyReceipt()), uncertain: ['total', 'items.i1.lineTotal'] };
    r = setField(r, 'total', 100);
    r = setItemLineTotal(r, 'i1', 100);
    expect(r.uncertain).toEqual([]);
  });
  it('unit price is only set when exact', () => {
    let r = setItemLineTotal(addItem(emptyReceipt()), 'i1', 10000);
    r = setItemQuantity(r, 'i1', 3);
    expect(r.items[0]!.unitPrice).toBeNull();
    r = setItemQuantity(r, 'i1', 4);
    expect(r.items[0]!.unitPrice).toBe(2500);
  });
  it('removeItem drops its flags', () => {
    const r = removeItem({ ...addItem(emptyReceipt()), uncertain: ['items.i1.lineTotal'] }, 'i1');
    expect(r.items).toEqual([]);
    expect(r.uncertain).toEqual([]);
  });
});
