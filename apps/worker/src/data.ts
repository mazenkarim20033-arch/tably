import type { BillRow, Bundle, ClaimRow, ItemRow, ParticipantRow, PaymentRow, TransferRow } from './types';
import { PINNING } from './types';

/**
 * Load one bill and everything attached to it in a SINGLE D1 round trip (a batch of selects). Each D1 call costs a
 * network hop, so the number of round trips, not the number of queries, is what makes a request fast.
 */
export async function loadBundle(
  db: D1Database,
  by: 'id' | 'share_token',
  value: string,
  strike?: { ip: string; window: number },
): Promise<{ bundle: Bundle | null; strikes: number }> {
  const bid = by === 'id' ? '?1' : '(SELECT id FROM bills WHERE share_token = ?1)';
  const statements = [
    db.prepare(`SELECT * FROM bills WHERE ${by} = ?1`).bind(value),
    db.prepare(`SELECT * FROM items WHERE bill_id = ${bid} ORDER BY position`).bind(value),
    db.prepare(`SELECT * FROM participants WHERE bill_id = ${bid} ORDER BY created_at, rowid`).bind(value),
    db.prepare(`SELECT c.* FROM claims c JOIN items i ON i.id = c.item_id WHERE i.bill_id = ${bid}`).bind(value),
    db.prepare(`SELECT * FROM transfers WHERE bill_id = ${bid} ORDER BY created_at, rowid`).bind(value),
    db.prepare(`SELECT * FROM payments WHERE bill_id = ${bid} ORDER BY created_at, rowid`).bind(value),
  ];
  if (strike) {
    statements.push(
      db.prepare(`SELECT hits FROM rate_hits WHERE bucket = 'badtoken' AND key = ?1 AND window = ?2`).bind(strike.ip, strike.window),
    );
  }
  const res = await db.batch(statements);
  const bill = (res[0]!.results[0] as BillRow | undefined) ?? null;
  const strikes = strike ? ((res[6]!.results[0] as { hits: number } | undefined)?.hits ?? 0) : 0;
  if (!bill) return { bundle: null, strikes };
  return {
    bundle: {
      bill,
      items: res[1]!.results as unknown as ItemRow[],
      people: res[2]!.results as unknown as ParticipantRow[],
      claims: res[3]!.results as unknown as ClaimRow[],
      transfers: res[4]!.results as unknown as TransferRow[],
      payments: res[5]!.results as unknown as PaymentRow[],
    },
    strikes,
  };
}

/** Participants whose total is frozen because they have a live or settled payment. */
export function pinnedAmounts(b: Bundle): Map<string, number> {
  return new Map(
    b.payments.filter((p) => (PINNING as readonly string[]).includes(p.status)).map((p) => [p.participant_id, p.amount]),
  );
}

export function linkProblem(bill: BillRow, now = new Date()): { status: 403 | 410; message: string } | null {
  if (bill.share_disabled === 1) return { status: 403, message: 'This link has been turned off by the person who created the bill.' };
  if (bill.share_expires_at && new Date(bill.share_expires_at) <= now) return { status: 410, message: 'This link has expired.' };
  return null;
}

/** Add `changes() > 0` so the version only moves when the statement before it really changed something. */
export const bumpIfChanged = (db: D1Database, billId: string) =>
  db.prepare('UPDATE bills SET version = version + 1 WHERE id = ?1 AND changes() > 0').bind(billId);

export const bump = (db: D1Database, billId: string) =>
  db.prepare('UPDATE bills SET version = version + 1 WHERE id = ?1').bind(billId);
