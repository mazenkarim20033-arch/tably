import { formatAmount } from '@tably/core';
import type { AdminBill, AdminPerson } from './billsApi';
import { shareUrl } from './myBills';
import { t } from './i18n';

/** People who still owe money: something to pay and not yet confirmed. */
export const owing = (bill: AdminBill): AdminPerson[] =>
  bill.participants.filter((p) => p.total > 0 && p.payment?.status !== 'verified');

export function reminderFor(bill: AdminBill, p: AdminPerson): string {
  const pay = bill.payee?.name ? t(' Pay {name} with InstaPay', { name: bill.payee.name }) : t(' Pay with InstaPay');
  return t('Hi {name}, your share of {store} is {amount}.{pay}; the details are here: {url}', { name: p.name, store: bill.store, amount: formatAmount(p.total, bill.currency), pay, url: shareUrl(bill.share_token) });
}

export function groupReminder(bill: AdminBill, people: AdminPerson[]): string {
  const lines = people.map((p) => `• ${p.name}: ${formatAmount(p.total, bill.currency)}`).join('\n');
  return t('Reminder for {store}. Still to pay:\n{lines}\nPay and mark it here: {url}', { store: bill.store, lines, url: shareUrl(bill.share_token) });
}

export function agoLabel(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 2) return t('just now');
  if (mins < 60) return t('{n} min ago', { n: mins });
  if (mins < 1440) return t('{n} h ago', { n: Math.round(mins / 60) });
  return t('{n} d ago', { n: Math.round(mins / 1440) });
}
