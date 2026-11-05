import { Hono } from 'hono';
import { newId, newToken, sha256Hex, tokenMatches } from './crypto';
import { bump, linkProblem, loadBundle, pinnedAmounts } from './data';
import { extrasTotal } from './money';
import {
  PROVIDERS, WebhookRejected, applyProviderEvent, createPayment, expireStale, markPaidByPayer, transition,
} from './payments';
import {
  HttpError, adminBundle, applyClaim, checkPayee, freshBundle, isUnique, parse, participantOf, rateLimit, requireOpen,
  requireUnlocked, sharedBundle, type C,
} from './http';
import type { Bundle, Env, PaymentRow } from './types';
import {
  BillCreate, BillEdit, ClaimSet, CloseBody, LinkUpdate, PaidBody, ParticipantCreate, PayeeIn, PaymentCreate, ReminderLog,
  ReviewBody, SummaryRequest, TransferCreate,
} from './validate';
import { adminView, publicView, type EventRow } from './views';

export { HttpError } from './http';

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

// ---------- shared helpers ----------

/** Expire stale attempts; if anything changed, hand back a fresh copy so the response is never out of date. */
async function settled(c: C, b: Bundle): Promise<Bundle> {
  return (await expireStale(c.env.DB, b)) ? freshBundle(c, b.bill.id) : b;
}

async function adminResponse(c: C, b: Bundle) {
  const fresh = await settled(c, b);
  const events = (
    await c.env.DB
      .prepare(
        'SELECT e.payment_id, e.at, e.actor, e.from_status, e.to_status, e.note FROM payment_events e ' +
          'JOIN payments p ON p.id = e.payment_id WHERE p.bill_id = ?1 ORDER BY e.at, e.rowid',
      )
      .bind(fresh.bill.id)
      .all()
  ).results as unknown as EventRow[];
  return adminView(fresh, events);
}

const payload = (b: Bundle, pay: PaymentRow) => {
  const prov = PROVIDERS[pay.provider];
  return {
    payment: { id: pay.id, status: pay.status, amount: pay.amount, currency: pay.currency, reference: pay.reference, provider: pay.provider },
    instructions: prov?.instructions ? prov.instructions(b.bill, pay) : {},
  };
};

function paymentOf(b: Bundle, personId: string, paymentId: string): PaymentRow {
  const pay = b.payments.find((p) => p.id === paymentId && p.participant_id === personId);
  if (!pay) throw new HttpError(404, 'Payment not found.');
  return pay;
}

// ---------- routes: health ----------

app.get('/api/health', (c) => c.json({ ok: true }));

// ---------- routes: creator ----------

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
          'payee_name, instapay_address, instapay_phone, instapay_link, payee_extra, version, share_token, share_disabled, share_expires_at, admin_token_hash, created_at) ' +
          "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'open',?11,?12,?13,?14,?15,0,?16,0,?17,?18,?19)",
      )
      .bind(
        id, body.store, body.receipt_date ?? null, body.currency, body.discounts, body.tax, body.service, body.tip,
        body.tax_included ? 1 : 0, body.printed_total ?? null, payee?.payee_name ?? null, payee?.instapay_address?.toLowerCase() ?? null,
        payee?.instapay_phone ?? null, payee?.instapay_link ?? null, payee?.methods?.length ? JSON.stringify(payee.methods) : null,
        shareToken, expires, await sha256Hex(adminToken), now.toISOString(),
      ),
    ...body.items.map((it, n) =>
      db
        .prepare('INSERT INTO items (id, bill_id, position, description, quantity, line_total) VALUES (?1,?2,?3,?4,?5,?6)')
        .bind(newId(), id, n, it.description, it.quantity, it.line_total),
    ),
  ]);
  return c.json({ id, share_token: shareToken, admin_token: adminToken, share_expires_at: expires }, 201);
});

// One-call history for the phone: it sends the admin tokens it holds and gets one line per bill.
app.post('/api/bills/summaries', async (c) => {
  await rateLimit(c, 'summaries', 60, 600);
  const body = await parse(c, SummaryRequest);
  const out: unknown[] = [];
  for (const ref of body.bills) {
    const { bundle } = await loadBundle(c.env.DB, 'id', ref.id ?? '');
    if (!bundle || !(await tokenMatches(ref.admin_token, bundle.bill.admin_token_hash))) {
      out.push({ id: ref.id ?? null, missing: true });
      continue;
    }
    const v = publicView(await settled(c, bundle));
    out.push({
      id: bundle.bill.id, store: bundle.bill.store, date: bundle.bill.receipt_date, currency: bundle.bill.currency,
      status: bundle.bill.status, total: v.totals.total, collected: v.totals.collected, outstanding: v.totals.outstanding,
      people: v.participants.length,
      waiting: v.participants.filter((p) => p.payment?.status === 'awaiting_confirmation').length,
      link_disabled: bundle.bill.share_disabled === 1,
    });
  }
  return c.json({ bills: out });
});

app.get('/api/bills/:id', async (c) => c.json(await adminResponse(c, await adminBundle(c, c.req.param('id')))));

app.put('/api/bills/:id/payee', async (c) => {
  await rateLimit(c, 'payee', 30, 3600);
  const b = await adminBundle(c, c.req.param('id'));
  const body = await parse(c, PayeeIn);
  checkPayee(c, body);
  // Changing where money goes after someone started paying would misdirect or confuse them.
  if (pinnedAmounts(b).size > 0) throw new HttpError(409, 'Someone has already started paying. Payment details can no longer change.');
  const db = c.env.DB;
  await db.batch([
    db
      .prepare('UPDATE bills SET payee_name = ?1, instapay_address = ?2, instapay_phone = ?3, instapay_link = ?4, payee_extra = ?5 WHERE id = ?6')
      .bind(
        body.payee_name, body.instapay_address?.toLowerCase() ?? null, body.instapay_phone ?? null, body.instapay_link ?? null,
        body.methods?.length ? JSON.stringify(body.methods) : null, b.bill.id,
      ),
    bump(db, b.bill.id),
  ]);
  return c.json(await adminResponse(c, await freshBundle(c, b.bill.id)));
});

async function review(c: C, to: 'verified' | 'failed') {
  await rateLimit(c, 'review', 120, 3600);
  const b = await adminBundle(c, c.req.param('id')!);
  const body = await parse(c, ReviewBody);
  const pay = b.payments.find((p) => p.id === c.req.param('paymentId'));
  if (!pay) throw new HttpError(404, 'Payment not found.');
  await transition(c.env.DB, pay, to, 'creator', body.note || (to === 'verified' ? 'Confirmed by the bill creator' : 'Rejected by the bill creator'));
  return c.json(await adminResponse(c, await freshBundle(c, b.bill.id)));
}
// Manual reconciliation: the creator checked their own bank and saw the money arrive.
app.post('/api/bills/:id/payments/:paymentId/confirm', (c) => review(c, 'verified'));
app.post('/api/bills/:id/payments/:paymentId/reject', (c) => review(c, 'failed'));

// Link controls (turn off, extend, replace)
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

// Adjustments: the creator moves money between two people.
app.post('/api/bills/:id/transfers', async (c) => {
  await rateLimit(c, 'transfer', 60, 3600);
  const b = await adminBundle(c, c.req.param('id'));
  const body = await parse(c, TransferCreate);
  const ids = new Set(b.people.map((p) => p.id));
  if (body.payer_id === body.beneficiary_id || !ids.has(body.payer_id) || !ids.has(body.beneficiary_id)) {
    throw new HttpError(422, 'Pick two different people on this bill.');
  }
  const locked = pinnedAmounts(b);
  if (locked.has(body.payer_id) || locked.has(body.beneficiary_id)) {
    throw new HttpError(409, 'One of them has already started paying, so their amount is locked.');
  }
  const db = c.env.DB;
  await db.batch([
    db
      .prepare('INSERT INTO transfers (id, bill_id, payer_id, beneficiary_id, amount, note, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)')
      .bind(newId(), b.bill.id, body.payer_id, body.beneficiary_id, body.amount, body.note, new Date().toISOString()),
    bump(db, b.bill.id),
  ], );
  return c.json(publicView(await freshBundle(c, b.bill.id)), 201);
});

app.delete('/api/bills/:id/transfers/:transferId', async (c) => {
  const b = await adminBundle(c, c.req.param('id'));
  const t = b.transfers.find((x) => x.id === c.req.param('transferId'));
  if (!t) throw new HttpError(404, 'Adjustment not found.');
  const locked = pinnedAmounts(b);
  if (locked.has(t.payer_id) || locked.has(t.beneficiary_id)) {
    throw new HttpError(409, 'Someone involved has already started paying, so this is locked.');
  }
  await c.env.DB.batch([c.env.DB.prepare('DELETE FROM transfers WHERE id = ?1').bind(t.id), bump(c.env.DB, b.bill.id)]);
  return c.json(publicView(await freshBundle(c, b.bill.id)));
});

// Edit an unfinalized receipt. Blocked once any payment has started; after that, use adjustments.
app.patch('/api/bills/:id/receipt', async (c) => {
  await rateLimit(c, 'edit', 60, 3600);
  const b = await adminBundle(c, c.req.param('id'));
  const body = await parse(c, BillEdit);
  requireOpen(b);
  requireUnlocked(b);

  const itemsSum = body.items.reduce((s, i) => s + i.line_total, 0);
  const computed = itemsSum + extrasTotal(body.discounts, body.tax, body.service, body.tip, body.tax_included);
  if (itemsSum <= 0 || computed <= 0) throw new HttpError(422, 'The bill total must be greater than zero.');
  if (body.printed_total != null && body.printed_total !== computed && !body.accept_mismatch) {
    throw new HttpError(422, { code: 'mismatch', computed_total: computed, printed_total: body.printed_total, message: 'Items do not add up to the receipt total.' });
  }

  const existing = new Map(b.items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const finalItems: Array<{ id: string; isNew: boolean; description: string; quantity: number; line_total: number }> = [];
  for (const e of body.items) {
    if (e.id != null) {
      if (!existing.has(e.id) || seen.has(e.id)) throw new HttpError(422, 'Unknown or repeated item.');
      seen.add(e.id);
      finalItems.push({ id: e.id, isNew: false, description: e.description, quantity: e.quantity, line_total: e.line_total });
    } else {
      finalItems.push({ id: newId(), isNew: true, description: e.description, quantity: e.quantity, line_total: e.line_total });
    }
  }

  // Existing claims must still fit the edited quantities; otherwise the creator fixes assignments first.
  const conflicts: string[] = [];
  for (const it of finalItems) {
    if (it.isNew) continue;
    const rows = b.claims.filter((cl) => cl.item_id === it.id);
    const excl = rows.filter((cl) => cl.shared === 0).reduce((s, cl) => s + cl.units, 0);
    if (excl > it.quantity - (rows.some((cl) => cl.shared === 1) ? 1 : 0)) conflicts.push(it.description);
  }
  if (conflicts.length) {
    throw new HttpError(409, {
      code: 'claims_conflict', items: conflicts,
      message: 'More of these are claimed than the new quantity: ' + conflicts.join(', ') + '. Change who has what first.',
    });
  }

  const db = c.env.DB;
  const removed = b.items.filter((i) => !seen.has(i.id));
  await db.batch([
    // Removed items take their claims with them (ON DELETE CASCADE).
    ...removed.map((i) => db.prepare('DELETE FROM items WHERE id = ?1 AND bill_id = ?2').bind(i.id, b.bill.id)),
    ...finalItems.map((it, n) =>
      it.isNew
        ? db.prepare('INSERT INTO items (id, bill_id, position, description, quantity, line_total) VALUES (?1,?2,?3,?4,?5,?6)').bind(it.id, b.bill.id, n, it.description, it.quantity, it.line_total)
        : db.prepare('UPDATE items SET position = ?1, description = ?2, quantity = ?3, line_total = ?4 WHERE id = ?5 AND bill_id = ?6').bind(n, it.description, it.quantity, it.line_total, it.id, b.bill.id),
    ),
    db
      .prepare('UPDATE bills SET store = ?1, receipt_date = ?2, discounts = ?3, tax = ?4, service = ?5, tip = ?6, tax_included = ?7, printed_total = ?8 WHERE id = ?9')
      .bind(body.store, body.receipt_date ?? null, body.discounts, body.tax, body.service, body.tip, body.tax_included ? 1 : 0, body.printed_total ?? null, b.bill.id),
    bump(db, b.bill.id),
  ]);
  return c.json(await adminResponse(c, await freshBundle(c, b.bill.id)));
});

// Add someone who is not using the link; the creator assigns their items for them.
app.post('/api/bills/:id/participants', async (c) => {
  await rateLimit(c, 'people', 60, 3600);
  const b = await adminBundle(c, c.req.param('id'));
  const body = await parse(c, ParticipantCreate);
  requireOpen(b);
  if (b.people.length >= MAX_PARTICIPANTS) throw new HttpError(409, 'This bill has too many people.');
  const key = body.name.toLowerCase();
  if (b.people.some((p) => p.name_key === key)) throw new HttpError(409, 'Someone already uses that name on this bill.');
  try {
    // No usable secret is handed out, so only the creator can change this person's selections.
    await c.env.DB.batch([
      c.env.DB
        .prepare('INSERT INTO participants (id, bill_id, name, name_key, secret_hash, created_at) VALUES (?1,?2,?3,?4,?5,?6)')
        .bind(newId(), b.bill.id, body.name, key, await sha256Hex(newToken(32)), new Date().toISOString()),
      bump(c.env.DB, b.bill.id),
    ]);
  } catch (e) {
    if (isUnique(e)) throw new HttpError(409, 'Someone already uses that name on this bill.');
    throw e;
  }
  return c.json(await adminResponse(c, await freshBundle(c, b.bill.id)), 201);
});

app.delete('/api/bills/:id/participants/:pid', async (c) => {
  const b = await adminBundle(c, c.req.param('id'));
  requireOpen(b);
  const p = b.people.find((x) => x.id === c.req.param('pid'));
  if (!p) throw new HttpError(404, 'Person not found.');
  if (pinnedAmounts(b).has(p.id)) {
    throw new HttpError(409, { code: 'locked', message: 'This person has started or finished paying. Reject or cancel their payment first.' });
  }
  // Their claims, any adjustments involving them and past payment attempts go with them (ON DELETE CASCADE).
  await c.env.DB.batch([c.env.DB.prepare('DELETE FROM participants WHERE id = ?1 AND bill_id = ?2').bind(p.id, b.bill.id), bump(c.env.DB, b.bill.id)]);
  return c.json(await adminResponse(c, await freshBundle(c, b.bill.id)));
});

// Creator corrects an assignment on someone's behalf. Same capacity and lock rules as the person's own change.
app.put('/api/bills/:id/participants/:pid/claims', async (c) => {
  await rateLimit(c, 'assign', 240, 3600);
  const b = await adminBundle(c, c.req.param('id'));
  const body = await parse(c, ClaimSet);
  requireOpen(b);
  const p = b.people.find((x) => x.id === c.req.param('pid'));
  if (!p) throw new HttpError(404, 'Person not found.');
  await applyClaim(c, b, p, body);
  return c.json(await adminResponse(c, await freshBundle(c, b.bill.id)));
});

function settledProblem(v: ReturnType<typeof publicView>): string {
  if (!v.participants.length) return 'Nobody has joined this bill yet.';
  if (v.totals.unassigned !== 0) return 'Some of the bill is still unclaimed.';
  const unpaid = v.participants.filter((p) => p.total > 0 && p.payment?.status !== 'verified').map((p) => p.name);
  return unpaid.length ? 'Not confirmed paid yet: ' + unpaid.join(', ') + '.' : '';
}

app.post('/api/bills/:id/close', async (c) => {
  const b = await adminBundle(c, c.req.param('id'));
  const body = await parse(c, CloseBody);
  if (b.bill.status === 'closed') return c.json(await adminResponse(c, b));
  const fresh = await settled(c, b);
  const why = settledProblem(publicView(fresh));
  if (why && !body.force) throw new HttpError(409, { code: 'unsettled', message: why });
  await c.env.DB.batch([c.env.DB.prepare("UPDATE bills SET status = 'closed' WHERE id = ?1").bind(b.bill.id), bump(c.env.DB, b.bill.id)]);
  return c.json(await adminResponse(c, await freshBundle(c, b.bill.id)));
});

app.post('/api/bills/:id/reopen', async (c) => {
  const b = await adminBundle(c, c.req.param('id'));
  await c.env.DB.batch([c.env.DB.prepare("UPDATE bills SET status = 'open' WHERE id = ?1").bind(b.bill.id), bump(c.env.DB, b.bill.id)]);
  return c.json(await adminResponse(c, await freshBundle(c, b.bill.id)));
});

// Record that the creator sent reminders. TABLY sends nothing itself: the app opens the share sheet and the creator
// sends the message.
app.post('/api/bills/:id/reminders', async (c) => {
  await rateLimit(c, 'remind', 120, 3600);
  const b = await adminBundle(c, c.req.param('id'));
  const body = await parse(c, ReminderLog);
  const now = new Date().toISOString();
  const mine = new Set(b.people.map((p) => p.id));
  const db = c.env.DB;
  const ids = [...new Set(body.participant_ids)].filter((id) => mine.has(id));
  if (ids.length) {
    await db.batch(
      ids.map((id) => db.prepare('UPDATE participants SET last_reminded_at = ?1, reminder_count = reminder_count + 1 WHERE id = ?2 AND bill_id = ?3').bind(now, id, b.bill.id)),
    );
  }
  return c.json(await adminResponse(c, await freshBundle(c, b.bill.id)));
});

// ---------- routes: the shared link ----------

app.get('/api/s/:token', async (c) => c.json(publicView(await settled(c, await sharedBundle(c, c.req.param('token'))))));

// A one-query change check, so pages can poll cheaply instead of holding a stream open
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
    if (isUnique(e)) throw new HttpError(409, 'Someone already uses that name on this bill. Try adding an initial.');
    throw e;
  }
  // The secret is shown once; it lets this browser edit only this person's selections.
  return c.json({ participant_id: id, participant_token: secret, name: body.name }, 201);
});

app.put('/api/s/:token/claims', async (c) => {
  const b = await sharedBundle(c, c.req.param('token'));
  if (b.bill.status !== 'open') throw new HttpError(409, 'This bill is closed.');
  const me = await participantOf(c, b);
  const body = await parse(c, ClaimSet);
  await applyClaim(c, b, me, body);
  return c.json(publicView(await freshBundle(c, b.bill.id)));
});

// ---------- routes: payments (participant, via the share link) ----------

app.post('/api/s/:token/payments', async (c) => {
  await rateLimit(c, 'pay', 30, 600);
  const b0 = await sharedBundle(c, c.req.param('token'));
  const me = await participantOf(c, b0);
  const body = await parse(c, PaymentCreate);
  const key = c.req.header('idempotency-key') ?? null;
  if (key && key.length > 64) throw new HttpError(422, [{ msg: 'Idempotency-Key is too long.' }]);
  const b = await settled(c, b0);
  const pay = await createPayment(c.env.DB, c.env, b, me, body.provider, key);
  return c.json(payload(b, pay), 201);
});

app.get('/api/s/:token/payments/:paymentId', async (c) => {
  await rateLimit(c, 'view', 600, 60);
  const b0 = await sharedBundle(c, c.req.param('token'));
  const me = await participantOf(c, b0);
  const b = await settled(c, b0);
  return c.json(payload(b, paymentOf(b, me.id, c.req.param('paymentId'))));
});

// The payer reports they sent the money. The payment becomes "awaiting confirmation", never "verified".
app.post('/api/s/:token/payments/:paymentId/paid', async (c) => {
  await rateLimit(c, 'pay', 30, 600);
  const b0 = await sharedBundle(c, c.req.param('token'));
  const me = await participantOf(c, b0);
  const body = await parse(c, PaidBody);
  const b = await settled(c, b0);
  const pay = paymentOf(b, me.id, c.req.param('paymentId'));
  await markPaidByPayer(c.env.DB, pay, body.payer_note);
  return c.json(payload(b, pay));
});

app.post('/api/s/:token/payments/:paymentId/cancel', async (c) => {
  await rateLimit(c, 'pay', 30, 600);
  const b0 = await sharedBundle(c, c.req.param('token'));
  const me = await participantOf(c, b0);
  const b = await settled(c, b0);
  const pay = paymentOf(b, me.id, c.req.param('paymentId'));
  await transition(c.env.DB, pay, 'cancelled', 'payer', 'Cancelled by payer');
  return c.json(payload(b, pay));
});

// ---------- routes: provider webhooks ----------

// Provider -> TABLY. The signature is checked on the raw body before anything is read from it.
app.post('/api/webhooks/:provider', async (c) => {
  await rateLimit(c, 'webhook', 300, 60);
  const provider = PROVIDERS[c.req.param('provider')];
  if (!provider) throw new HttpError(404, 'Unknown provider.');
  const raw = await c.req.text();
  if (raw.length > 64_000) throw new HttpError(413, 'Body too large.');
  let event;
  try {
    if (!provider.verifyWebhook) throw new WebhookRejected('no webhook');
    event = await provider.verifyWebhook(c.req.raw.headers, raw);
  } catch (e) {
    if (e instanceof WebhookRejected) throw new HttpError(401, 'Invalid signature.');
    throw e;
  }
  return c.json({ result: await applyProviderEvent(c.env.DB, provider.key, event) }); // 200 for duplicates too, so the provider stops retrying
});

// The shared page and the app are served by the static assets binding for everything else.
app.all('/api/*', () => {
  throw new HttpError(404, 'Not found.');
});
