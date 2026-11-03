import { formatAmount } from '@tably/core';
import type { AdminBill, AdminPerson } from './billsApi';
import { shareUrl } from './myBills';

/** People who still owe money: something to pay and not yet confirmed. */
export const owing = (bill: AdminBill): AdminPerson[] =>
  bill.participants.filter((p) => p.total > 0 && p.payment?.status !== 'verified');

export function reminderFor(bill: AdminBill, p: AdminPerson): string {
  const pay = bill.payee?.name ? ` Pay ${bill.payee.name} with InstaPay` : ' Pay with InstaPay';
  return `Hi ${p.name}, your share of ${bill.store} is ${formatAmount(p.total, bill.currency)}.${pay}; the details are here: ${shareUrl(bill.share_token)}`;
}

export function groupReminder(bill: AdminBill, people: AdminPerson[]): string {
  const lines = people.map((p) => `• ${p.name}: ${formatAmount(p.total, bill.currency)}`).join('\n');
  return `Reminder for ${bill.store}. Still to pay:\n${lines}\nPay and mark it here: ${shareUrl(bill.share_token)}`;
}

export function agoLabel(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}
