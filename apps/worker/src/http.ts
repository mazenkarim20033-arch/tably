import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { tokenMatches } from './crypto';
import { bumpIfChanged, linkProblem, loadBundle, pinnedAmounts } from './data';
import type { Bundle, Env, ParticipantRow } from './types';
import { validationDetail, type PayeeInput } from './validate';

export type C = Context<{ Bindings: Env }>;

export class HttpError extends Error {
  constructor(public status: number, public detail: unknown, public headers: Record<string, string> = {}) {
    super(typeof detail === 'string' ? detail : 'http error');
  }
}

export const clientIp = (c: C) => c.req.header('cf-connecting-ip') ?? 'unknown';
export const windowOf = (seconds: number) => Math.floor(Date.now() / 1000 / seconds) * seconds;
export const isUnique = (e: unknown) => /UNIQUE/i.test(String(e));

/** Count a hit for this client and refuse once the limit is passed. Best effort: it protects the free allowance. */
export async function rateLimit(c: C, bucket: string, limit: number, seconds: number): Promise<void> {
  const db = c.env.DB;
  const win = windowOf(seconds);
  const row = await db
    .prepare(
      'INSERT INTO rate_hits(bucket, key, window, hits) VALUES (?1, ?2, ?3, 1) ' +
        'ON CONFLICT(bucket, key, window) DO UPDATE SET hits = hits + 1 RETURNING hits',
    )
    .bind(bucket, clientIp(c), win)
    .first<{ hits: number }>();
  if (Math.random() < 0.01) {
    // Housekeeping must never break a request: run it after the response when possible, and ignore its failures.
    const prune = db.prepare('DELETE FROM rate_hits WHERE window < ?1').bind(Math.floor(Date.now() / 1000) - 86_400).run().catch(() => undefined);
    try {
      c.executionCtx.waitUntil(prune);
    } catch {
      await prune; // no execution context (tests)
    }
  }
  if ((row?.hits ?? 0) > limit) {
    throw new HttpError(429, 'Too many requests. Please slow down.', { 'Retry-After': String(Math.max(1, win + seconds - Math.floor(Date.now() / 1000))) });
  }
}

export async function parse<T>(c: C, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    // A body without Content-Length (chunked) is not caught by the header check, so measure what actually arrived.
    const text = await c.req.text();
    if (text.length > 256 * 1024) throw new HttpError(413, 'Request body too large.');
    raw = JSON.parse(text);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(422, [{ msg: 'Invalid JSON.' }]);
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(422, validationDetail(r.error));
  return r.data;
}

// ---------- loading + authorization ----------

export async function adminBundle(c: C, id: string): Promise<Bundle> {
  const { bundle } = await loadBundle(c.env.DB, 'id', id);
  // The same answer for "no such bill" and "wrong key", so ids cannot be probed.
  if (!bundle || !(await tokenMatches(c.req.header('x-admin-token'), bundle.bill.admin_token_hash))) throw new HttpError(404, 'Bill not found.');
  return bundle;
}

export async function sharedBundle(c: C, token: string): Promise<Bundle> {
  const ip = clientIp(c);
  const win = windowOf(300);
  const { bundle, strikes } = await loadBundle(c.env.DB, 'share_token', token, { ip, window: win });
  if (strikes >= 30) throw new HttpError(429, 'Too many requests. Please slow down.', { 'Retry-After': '60' }); // someone is guessing links
  if (!bundle) {
    await c.env.DB.prepare("INSERT INTO rate_hits(bucket, key, window, hits) VALUES ('badtoken', ?1, ?2, 1) ON CONFLICT(bucket, key, window) DO UPDATE SET hits = hits + 1").bind(ip, win).run();
    throw new HttpError(404, 'Bill not found.');
  }
  const problem = linkProblem(bundle.bill);
  if (problem) throw new HttpError(problem.status, problem.message);
  return bundle;
}

export async function participantOf(c: C, b: Bundle): Promise<ParticipantRow> {
  const p = b.people.find((x) => x.id === c.req.header('x-participant-id'));
  if (!p || !(await tokenMatches(c.req.header('x-participant-token'), p.secret_hash))) throw new HttpError(401, 'Join the bill first.');
  return p;
}

export function linkHostAllowed(c: C, url: string): boolean {
  try {
    const u = new URL(url);
    const allowed = (c.env.PAYMENT_LINK_HOSTS ?? 'ipn.eg').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    return u.protocol === 'https:' && !u.username && !u.password && allowed.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function checkPayee(c: C, payee: PayeeInput | null | undefined): void {
  if (payee?.instapay_link && !linkHostAllowed(c, payee.instapay_link)) {
    throw new HttpError(422, [{ msg: 'payment link must be an https link on an allowed InstaPay host' }]);
  }
}

export const requireOpen = (b: Bundle) => {
  if (b.bill.status !== 'open') throw new HttpError(409, { code: 'closed', message: 'This bill is closed. Reopen it to make changes.' });
};

export const requireUnlocked = (b: Bundle) => {
  if (pinnedAmounts(b).size > 0) {
    throw new HttpError(409, {
      code: 'locked',
      message: 'Someone has started or finished paying, so this can no longer be edited. Use an adjustment to move money between people instead.',
    });
  }
};

export async function freshBundle(c: C, billId: string): Promise<Bundle> {
  return (await loadBundle(c.env.DB, 'id', billId)).bundle!;
}

// ---------- claims (used by the participant route and the creator's "assign for them") ----------

export interface ClaimChange {
  item_id: string;
  units?: number | null;
  share?: boolean | null;
}

/**
 * Apply one change to one person's hold on an item. Every change is ONE conditional statement, so two people can
 * never both take the last unit: D1 runs writes one at a time, and the capacity check and the write are the same
 * statement. Capacity: exclusive units across everyone never exceed the quantity, and when anyone shares, at least
 * one unit stays in the pool so sharers are never left holding nothing.
 */
export async function applyClaim(c: C, b: Bundle, person: ParticipantRow, body: ClaimChange): Promise<void> {
  const item = b.items.find((i) => i.id === body.item_id);
  if (!item) throw new HttpError(404, 'Item not found.');

  // Once someone has started paying, their amount (and any item they share) is frozen.
  const locked = pinnedAmounts(b);
  const lockedSharer = b.claims.some((cl) => cl.item_id === item.id && cl.shared === 1 && locked.has(cl.participant_id));
  if (locked.has(person.id) || lockedSharer) {
    throw new HttpError(409, { code: 'locked', message: "Payment for this has started, so it can't change. Ask the bill creator." });
  }

  const db = c.env.DB;
  const othersExclusive = `(SELECT COALESCE(SUM(units), 0) FROM claims WHERE item_id = ?2 AND participant_id != ?1 AND shared = 0)`;
  const otherSharer = `EXISTS (SELECT 1 FROM claims WHERE item_id = ?2 AND participant_id != ?1 AND shared = 1)`;
  let write: D1PreparedStatement;
  if (body.share === true) {
    write = db
      .prepare(
        `INSERT INTO claims (participant_id, item_id, units, shared) SELECT ?1, ?2, 0, 1 ` +
          `WHERE (SELECT quantity FROM items WHERE id = ?2 AND bill_id = ?3) - ${othersExclusive} >= 1 ` +
          `ON CONFLICT (participant_id, item_id) DO UPDATE SET units = 0, shared = 1`,
      )
      .bind(person.id, item.id, b.bill.id);
  } else if (body.units != null && body.units > 0) {
    write = db
      .prepare(
        `INSERT INTO claims (participant_id, item_id, units, shared) SELECT ?1, ?2, ?3, 0 ` +
          `WHERE ?3 <= (SELECT quantity FROM items WHERE id = ?2 AND bill_id = ?4) - ${othersExclusive} - (CASE WHEN ${otherSharer} THEN 1 ELSE 0 END) ` +
          `ON CONFLICT (participant_id, item_id) DO UPDATE SET units = excluded.units, shared = 0`,
      )
      .bind(person.id, item.id, body.units, b.bill.id);
  } else if (body.share === false) {
    write = db.prepare('DELETE FROM claims WHERE participant_id = ?1 AND item_id = ?2 AND shared = 1').bind(person.id, item.id);
  } else {
    write = db.prepare('DELETE FROM claims WHERE participant_id = ?1 AND item_id = ?2').bind(person.id, item.id);
  }

  const res = await db.batch([write, bumpIfChanged(db, b.bill.id)]);
  const wantsSeat = body.share === true || (body.units != null && body.units > 0);
  if (wantsSeat && (res[0]!.meta.changes ?? 0) === 0) {
    const mine = b.claims.filter((cl) => cl.item_id === item.id && cl.participant_id !== person.id);
    const exclusive = mine.filter((cl) => cl.shared === 0).reduce((s, cl) => s + cl.units, 0);
    const available = body.share === true ? 0 : Math.max(0, item.quantity - exclusive - (mine.some((cl) => cl.shared === 1) ? 1 : 0));
    throw new HttpError(409, { code: 'taken', available, message: 'Someone else already took that.' });
  }
}
