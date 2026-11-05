import * as SecureStore from 'expo-secure-store';
import { Directory, File, Paths } from 'expo-file-system';
import { webUrl } from './config';

/** Bills this phone created. Admin tokens live in the keychain; only display data is in the JSON index. */
export interface MyBill {
  id: string;
  store: string;
  currency: string;
  total: number;
  shareToken: string;
  createdAt: string;
}

const tokenKey = (id: string) => `tably.admin.${id}`;

function indexFile(): File {
  const dir = new Directory(Paths.document, 'bills');
  dir.create({ intermediates: true, idempotent: true });
  return new File(dir, 'index.json');
}

export async function listBills(): Promise<MyBill[]> {
  try {
    const f = indexFile();
    if (!f.exists) return [];
    return JSON.parse(await f.text()) as MyBill[];
  } catch {
    return [];
  }
}

export async function saveBill(bill: MyBill, adminToken: string): Promise<void> {
  await SecureStore.setItemAsync(tokenKey(bill.id), adminToken);
  const all = [bill, ...(await listBills()).filter((b) => b.id !== bill.id)];
  const f = indexFile();
  f.create({ overwrite: true });
  await f.write(JSON.stringify(all));
}

export const getAdminToken = (id: string) => SecureStore.getItemAsync(tokenKey(id));

export const shareUrl = (token: string) => `${webUrl()}/s/${token}`;

/** The last payment details used, so the next bill is one tap faster. Not secret, but personal: stays on the phone. */
/** Another way to be paid besides InstaPay. Mirrors what the server accepts. */
export type PayeeMethod =
  | { kind: 'telda'; value: string }
  | { kind: 'wallet'; value: string; label?: string }
  | { kind: 'cash' }
  | { kind: 'other'; label: string; value: string };

export interface SavedPayee { payee_name: string; instapay_address?: string; instapay_phone?: string; instapay_link?: string; methods?: PayeeMethod[] }

function payeeFile(): File {
  const dir = new Directory(Paths.document, 'bills');
  dir.create({ intermediates: true, idempotent: true });
  return new File(dir, 'payee.json');
}

export async function loadPayee(): Promise<SavedPayee | null> {
  try {
    const f = payeeFile();
    return f.exists ? (JSON.parse(await f.text()) as SavedPayee) : null;
  } catch {
    return null;
  }
}

export async function savePayee(p: SavedPayee): Promise<void> {
  try {
    const f = payeeFile();
    f.create({ overwrite: true });
    await f.write(JSON.stringify(p));
  } catch { /* best effort */ }
}

export async function updateShareToken(id: string, shareToken: string): Promise<void> {
  const all = (await listBills()).map((b) => (b.id === id ? { ...b, shareToken } : b));
  const f = indexFile();
  f.create({ overwrite: true });
  await f.write(JSON.stringify(all));
}

export async function forgetBill(id: string): Promise<void> {
  const all = (await listBills()).filter((b) => b.id !== id);
  const f = indexFile();
  f.create({ overwrite: true });
  await f.write(JSON.stringify(all));
  try {
    await SecureStore.deleteItemAsync(tokenKey(id));
  } catch { /* already gone */ }
}
