import * as SecureStore from 'expo-secure-store';
import { Directory, File, Paths } from 'expo-file-system';
import { WEB_URL } from './config';

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

export const shareUrl = (token: string) => `${WEB_URL}/s/${token}`;
