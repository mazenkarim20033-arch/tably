import { updatePayee } from './billsApi';
import { getAdminToken, listBills, type SavedPayee } from './myBills';

/**
 * Give every bill on this phone the saved payment details. A bill where someone has already started paying keeps its
 * old details (the server refuses to move money instructions under a payer), and so does a bill that is gone.
 */
export async function applyPayeeToBills(payee: SavedPayee): Promise<{ updated: number; skipped: number }> {
  let updated = 0;
  let skipped = 0;
  for (const b of await listBills()) {
    const token = await getAdminToken(b.id);
    if (!token) { skipped += 1; continue; }
    try {
      await updatePayee(b.id, token, payee);
      updated += 1;
    } catch {
      skipped += 1;
    }
  }
  return { updated, skipped };
}
