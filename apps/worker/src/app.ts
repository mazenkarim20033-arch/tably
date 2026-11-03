import { Hono, type Context } from 'hono';
import type { ZodType } from 'zod';
import { newId, newToken, sha256Hex, tokenMatches } from './crypto';
import { bump, bumpIfChanged, linkProblem, loadBundle, pinnedAmounts } from './data';
import { extrasTotal } from './money';
import type { Bundle, Env } from './types';
import { BillCreate, ClaimSet, LinkUpdate, ParticipantCreate, validationDetail, type PayeeInput } from './validate';
import { adminView, publicView } from './views';

type C = Context<{ Bindings: Env }>;

export class HttpError extends Error {
  constructor(public status: number, public detail: unknown, public headers: Record<string, string> = {}) {
    super(typeof detail === 'string' ? detail : 'http error');
  }
}

const MAX_JSON_BYTES = 256 * 1024;
const MAX_PARTICIPANTS = 50;

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export const app = new Hono<{ Bindings: Env }>();

// ---------- cross-cutting protections ----------

app.use('*', async (c, next) => {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_JSON_BYTES) throw new HttpError(413, 'Request body too large.');
  await next();
  const h = c.res.headers;
  // Share tokens live in URLs, so never leak them through Referer; never cache bill data.
  h.set('Referrer-Policy', 'no-referrer');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  h.set('Content-Security-Policy', CSP);
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (c.req.path.startsWith('/api/')) h.set('Cache-Control', 'no-store');
});

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ detail: err.detail }, err.status as 400, err.headers);
  console.error('unhandled', err instanceof Error ? err.message : String(err));
  return c.json({ detail: 'Something went wrong. Please try again.' }, 500);
});

const clientIp = (c: C) => c.req.header('cf-connecting-ip') ?? 'unknown';
const windowOf = (seconds: number) => Math.floor(Date.now() / 1000 / seconds) * seconds;

/** Count a hit for this client and refuse once the limit is passed. Best effort: it protects the free allowance. */
async function rateLimit(c: C, bucket: string, limit: number, seconds: number): Promise<void> {
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

async function parse<T>(c: C, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(422, [{ msg: 'Invalid JSON.' }]);
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(422, validationDetail(r.error));
  return r.data;
}

// ---------- loading + authorization ----------

async function adminBundle(c: C, id: string): Promise<Bundle> {
  const { bundle } = await loadBundle(c.env.DB, 'id', id);
  // The same answer for "no such bill" and "wrong key", so ids cannot be probed.
  if (!bundle || !(await tokenMatches(c.req.header('x-admin-token'), bundle.bill.admin_token_hash))) throw new HttpError(404, 'Bill not found.');
  return bundle;
}

async function sharedBundle(c: C, token: string): Promise<Bundle> {
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

async function participantOf(c: C, b: Bundle) {
  const p = b.people.find((x) => x.id === c.req.header('x-participant-id'));
  if (!p || !(await tokenMatches(c.req.header('x-participant-token'), p.secret_hash))) throw new HttpError(401, 'Join the bill first.');
  return p;
}

function linkHostAllowed(c: C, url: string): boolean {
  try {
    const u = new URL(url);
    const allowed = (c.env.PAYMENT_LINK_HOSTS ?? 'ipn.eg').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    return u.protocol === 'https:' && !u.username && !u.password && allowed.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function checkPayee(c: C, payee: PayeeInput | null | undefined): void {
  if (payee?.instapay_link && !linkHostAllowed(c, payee.instapay_link)) {
    throw new HttpError(422, [{ msg: 'payment link must be an https link on an allowed InstaPay host' }]);
  }
}

// ---------- routes ----------

app.get('/api/health', (c) => c.json({ ok: true }));

// Creator: create a bill
app.post('/api/bills', async (c) => {
  await rateLimit(c, 'create', 20, 3600);
  const body = await parse(c, BillCreate);
  checkPayee(c, body.payee);

  const itemsSum = body.items.reduce((s, i) => s + i.line_total, 0);
  const computed = itemsSum + extrasTotal(body.discounts, body.tax, body.service, body.tip, body.tax_included);
  if (itemsSum <= 0 || computed <= 0) throw new HttpError(422, 'The bill total must be greater than zero.');
  if (body.printed_total != null && body.printed_total !== computed && !body.accept_mismatch) {
    throw new HttpError(422, { code: 'mismatch', computed_total: computed, printed_total: body.printed_total, message: 'Items do not add up to the receipt total.' });
  }

  const db = c.env.DB;
  const id = newId();
  const adminToken = newToken(32);
  const shareToken = newToken(24);
  const now = new Date();
  const days = Number(c.env.SHARE_LINK_DAYS ?? 30);
  const expires = new Date(now.getTime() + days * 86_400_000).toISOString();
  const payee = body.payee;
  await db.batch([
    db
      .prepare(
        'INSERT INTO bills (id, store, receipt_date, currency, discounts, tax, service, tip, tax_included, printed_total, status, ' +
          'payee_name, instapay_address, instapay_phone, instapay_link, version, share_token, share_disabled, share_expires_at, admin_token_hash, created_at) ' +
          "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'open',?11,?12,?13,?14,0,?15,0,?16,?17,?18)",
      )
      .bind(
        id, body.store, body.receipt_date ?? null, body.currency, body.discounts, body.tax, body.service, body.tip,
        body.tax_included ? 1 : 0, body.printed_total ?? null, payee?.payee_name ?? null, payee?.instapay_address?.toLowerCase() ?? null,
        payee?.instapay_phone ?? null, payee?.instapay_link ?? null, shareToken, expires, await sha256Hex(adminToken), now.toISOString(),
      ),
    ...body.items.map((it, n) =>
      db
        .prepare('INSERT INTO items (id, bill_id, position, description, quantity, line_total) VALUES (?1,?2,?3,?4,?5,?6)')
        .bind(newId(), id, n, it.description, it.quantity, it.line_total),
    ),
  ]);
  return c.json({ id, share_token: shareToken, admin_token: adminToken, share_expires_at: expires }, 201);
});

// Creator: full view
app.get('/api/bills/:id', async (c) => c.json(adminView(await adminBundle(c, c.req.param('id')))));

// Creator: link controls (turn off, extend, replace)
app.post('/api/bills/:id/link', async (c) => {
  await rateLimit(c, 'link', 60, 3600);
  const b = await adminBundle(c, c.req.param('id'));
  const body = await parse(c, LinkUpdate);
  const disabled = body.disabled == null ? b.bill.share_disabled : body.disabled ? 1 : 0;
  const token = body.rotate ? newToken(24) : b.bill.share_token; // the old link stops working at once
  const expires = body.extend_days ? new Date(Date.now() + body.extend_days * 86_400_000).toISOString() : b.bill.share_expires_at;
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE bills SET share_disabled = ?1, share_token = ?2, share_expires_at = ?3 WHERE id = ?4').bind(disabled, token, expires, b.bill.id),
    bump(c.env.DB, b.bill.id),
  ]);
  return c.json({ share_token: token, share_disabled: disabled === 1, share_expires_at: expires });
});

// Public: the bill
app.get('/api/s/:token', async (c) => c.json(publicView(await sharedBundle(c, c.req.param('token')))));

// Public: a one-query change check, so pages can poll cheaply instead of holding a stream open
app.get('/api/s/:token/version', async (c) => {
  const row = await c.env.DB
    .prepare('SELECT version, status, share_disabled, share_expires_at FROM bills WHERE share_token = ?1')
    .bind(c.req.param('token'))
    .first<{ version: number; status: string; share_disabled: number; share_expires_at: string | null }>();
  if (!row) throw new HttpError(404, 'Bill not found.');
  const problem = linkProblem({ share_disabled: row.share_disabled, share_expires_at: row.share_expires_at } as never);
  if (problem) throw new HttpError(problem.status, problem.message);
  return c.json({ version: row.version, status: row.status });
});

// Public: join as a participant
app.post('/api/s/:token/participants', async (c) => {
  await rateLimit(c, 'join', 20, 600);
  const b = await sharedBundle(c, c.req.param('token'));
  const body = await parse(c, ParticipantCreate);
  if (b.bill.status !== 'open') throw new HttpError(409, 'This bill is closed.');
  if (b.people.length >= MAX_PARTICIPANTS) throw new HttpError(409, 'This bill has too many people.');
  const secret = newToken(24);
  const id = newId();
  try {
    await c.env.DB.batch([
      c.env.DB
        .prepare('INSERT INTO participants (id, bill_id, name, name_key, secret_hash, created_at) VALUES (?1,?2,?3,?4,?5,?6)')
        .bind(id, b.bill.id, body.name, body.name.toLowerCase(), await sha256Hex(secret), new Date().toISOString()),
      bump(c.env.DB, b.bill.id),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new HttpError(409, 'Someone already uses that name on this bill. Try adding an initial.');
    throw e;
  }
  // The secret is shown once; it lets this browser edit only this person's selections.
  return c.json({ participant_id: id, participant_token: secret, name: body.name }, 201);
});

// Public: pick or release items. Every change is ONE conditional statement, so two people can never both take the
// last unit: D1 runs writes one at a time, and the capacity check and the write happen in the same statement.
app.put('/api/s/:token/claims', async (c) => {
  const b = await sharedBundle(c, c.req.param('token'));
  if (b.bill.status !== 'open') throw new HttpError(409, 'This bill is closed.');
  const me = await participantOf(c, b);
  const body = await parse(c, ClaimSet);
  const item = b.items.find((i) => i.id === body.item_id);
  if (!item) throw new HttpError(404, 'Item not found.');

  // Once someone has started paying, their amount (and any item they share) is frozen.
  const locked = pinnedAmounts(b);
  const lockedSharer = b.claims.some((cl) => cl.item_id === item.id && cl.shared === 1 && locked.has(cl.participant_id));
  if (locked.has(me.id) || lockedSharer) {
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
      .bind(me.id, item.id, b.bill.id);
  } else if (body.units != null && body.units > 0) {
    write = db
      .prepare(
        `INSERT INTO claims (participant_id, item_id, units, shared) SELECT ?1, ?2, ?3, 0 ` +
          `WHERE ?3 <= (SELECT quantity FROM items WHERE id = ?2 AND bill_id = ?4) - ${othersExclusive} - (CASE WHEN ${otherSharer} THEN 1 ELSE 0 END) ` +
          `ON CONFLICT (participant_id, item_id) DO UPDATE SET units = excluded.units, shared = 0`,
      )
      .bind(me.id, item.id, body.units, b.bill.id);
  } else if (body.share === false) {
    write = db.prepare('DELETE FROM claims WHERE participant_id = ?1 AND item_id = ?2 AND shared = 1').bind(me.id, item.id);
  } else {
    write = db.prepare('DELETE FROM claims WHERE participant_id = ?1 AND item_id = ?2').bind(me.id, item.id);
  }

  const res = await db.batch([write, bumpIfChanged(db, b.bill.id)]);
  const changed = res[0]!.meta.changes ?? 0;
  const wantsSeat = body.share === true || (body.units != null && body.units > 0);
  if (wantsSeat && changed === 0) {
    const mine = b.claims.filter((cl) => cl.item_id === item.id && cl.participant_id !== me.id);
    const exclusive = mine.filter((cl) => cl.shared === 0).reduce((s, cl) => s + cl.units, 0);
    const available = Math.max(0, item.quantity - exclusive - (mine.some((cl) => cl.shared === 1) && body.share !== true ? 1 : 0));
    throw new HttpError(409, { code: 'taken', available: body.share === true ? 0 : available, message: 'Someone else already took that.' });
  }

  const fresh = await loadBundle(db, 'id', b.bill.id);
  return c.json(publicView(fresh.bundle!));
});

// The shared page and the app are served by the static assets binding for everything else.
app.all('/api/*', () => {
  throw new HttpError(404, 'Not found.');
});
