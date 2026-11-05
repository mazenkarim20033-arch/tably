/**
 * Payment state machine and the operations on it.
 *
 * Statuses: initiated, awaiting_confirmation, verified, failed, expired, cancelled. "Unpaid" means no row.
 *
 * The one rule that matters: a payment becomes `verified` only through the creator's review or an authenticated
 * provider event. The payer can move their own payment to awaiting_confirmation or cancel it, and that is all.
 */
import { newId } from './crypto';
import { bumpIfChanged, pinnedAmounts } from './data';
import { computeState } from './compute';
import { HttpError, isUnique } from './http';
import type { Bundle, Env, ParticipantRow, PaymentRow } from './types';
import { extraMethods } from './views';
import { PINNING } from './types';

const ALLOWED: Record<string, string[]> = {
  'initiated>awaiting_confirmation': ['payer'],
  'initiated>cancelled': ['payer'],
  'initiated>expired': ['system', 'provider'],
  'initiated>verified': ['creator', 'provider'],
  'initiated>failed': ['creator', 'provider'],
  'awaiting_confirmation>verified': ['creator', 'provider'],
  'awaiting_confirmation>failed': ['creator', 'provider'],
  'awaiting_confirmation>expired': ['provider'],
  'expired>verified': ['creator', 'provider'], // money arrived after the attempt timed out
  'failed>verified': ['creator'], // creator corrects a mistaken rejection
};

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid misreading

export function newReference(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return 'TBL-' + [...bytes].map((b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
}

// ---------- providers ----------

export interface ProviderEvent {
  event_id: string;
  reference: string;
  status: 'paid' | 'failed' | 'expired';
  amount: number;
  currency: string;
}

export class WebhookRejected extends Error {}

export interface Provider {
  key: string;
  label: string;
  automated: boolean;
  availability(bill: Bundle['bill']): { enabled: boolean; reason: string };
  instructions?(bill: Bundle['bill'], payment: PaymentRow): Record<string, unknown>;
  verifyWebhook?(headers: Headers, rawBody: string): Promise<ProviderEvent>;
}

/**
 * Honest status of each adapter. manual_instapay WORKS but is manual: the payer sends money in their own banking app
 * and the creator confirms receipt. Kashier (automatic InstaPay) and Telda are NOT implemented: they need a merchant
 * account / have no public API. No provider here talks to a private or undocumented InstaPay interface.
 */
export const PROVIDERS: Record<string, Provider> = {
  manual_instapay: {
    key: 'manual_instapay',
    label: 'InstaPay (manual)',
    automated: false,
    availability: (bill) =>
      bill.instapay_address || bill.instapay_phone || bill.instapay_link || extraMethods(bill.payee_extra).length > 0
        ? { enabled: true, reason: '' }
        : { enabled: false, reason: 'The bill creator has not added payment details yet.' },
    instructions: (bill, payment) => ({
      provider: 'manual_instapay',
      payee_name: bill.payee_name,
      instapay_address: bill.instapay_address,
      instapay_phone: bill.instapay_phone,
      instapay_link: bill.instapay_link,
      methods: extraMethods(bill.payee_extra),
      amount: payment.amount,
      currency: payment.currency,
      reference: payment.reference,
      steps: [
        `Open your banking app or InstaPay and send exactly the amount to ${bill.payee_name ?? 'the bill creator'}.`,
        `Put ${payment.reference} in the transfer note so they can match it.`,
        'Come back here and tap "I\'ve paid". It is only marked paid once they confirm they received it.',
      ],
    }),
  },
  kashier: {
    key: 'kashier',
    label: 'InstaPay via Kashier (automatic)',
    automated: true,
    availability: () => ({ enabled: false, reason: 'Needs a Kashier merchant account and credentials. Not implemented yet.' }),
    verifyWebhook: async () => {
      throw new WebhookRejected('kashier webhook verification is not implemented');
    },
  },
  telda: {
    key: 'telda',
    label: 'Telda',
    automated: false,
    availability: () => ({ enabled: false, reason: 'No public Telda merchant API is available, so this is not supported.' }),
    verifyWebhook: async () => {
      throw new WebhookRejected('telda has no webhook');
    },
  },
};

// ---------- transitions ----------

const now = () => new Date().toISOString();

/**
 * Move a payment to a new status. The status change, its audit event and the version bump are one D1 batch, and the
 * UPDATE only matches the status we read, so two simultaneous reviews cannot both succeed.
 */
export async function transition(
  db: D1Database, p: PaymentRow, to: string, actor: string, note = '', providerEventId: string | null = null,
): Promise<void> {
  if (!(ALLOWED[`${p.status}>${to}`] ?? []).includes(actor)) {
    throw new HttpError(409, { code: 'bad_transition', message: `A payment that is ${p.status.replace(/_/g, ' ')} cannot be changed that way.` });
  }
  let res;
  try {
    res = await db.batch([
      db.prepare('UPDATE payments SET status = ?1 WHERE id = ?2 AND status = ?3').bind(to, p.id, p.status),
      db
        .prepare(
          'INSERT INTO payment_events (id, payment_id, at, actor, from_status, to_status, note, provider_event_id) ' +
            'SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE changes() > 0',
        )
        .bind(newId(), p.id, now(), actor, p.status, to, note.slice(0, 200), providerEventId),
      bumpIfChanged(db, p.bill_id),
    ]);
  } catch (e) {
    // Reviving an old attempt while the person already has a newer live one would break "one live payment each".
    if (/payments\.participant_id|uq_payment_one_live/.test(String(e))) {
      throw new HttpError(409, { code: 'bad_transition', message: 'This person has a newer payment attempt. Deal with that one instead.' });
    }
    throw e;
  }
  if ((res[0]!.meta.changes ?? 0) === 0) {
    throw new HttpError(409, { code: 'bad_transition', message: 'This payment was just changed by someone else. Reload and try again.' });
  }
  p.status = to;
}

/** An unfinished attempt past its deadline becomes `expired`. Returns true if anything changed. */
export async function expireStale(db: D1Database, b: Bundle): Promise<boolean> {
  let changed = false;
  for (const p of b.payments) {
    if (p.status === 'initiated' && p.expires_at && new Date(p.expires_at) <= new Date()) {
      try {
        await transition(db, p, 'expired', 'system', 'Attempt timed out');
        changed = true;
      } catch {
        // someone else moved it first; fine
      }
    }
  }
  return changed;
}

export async function createPayment(
  db: D1Database, env: Env, b: Bundle, person: ParticipantRow, providerKey: string, idempotencyKey: string | null,
): Promise<PaymentRow> {
  const provider = PROVIDERS[providerKey];
  if (!provider) throw new HttpError(422, 'Unknown payment method.');
  const avail = provider.availability(b.bill);
  if (!avail.enabled) throw new HttpError(409, { code: 'unavailable', message: avail.reason || 'This payment method is not available.' });
  if (b.bill.status !== 'open') throw new HttpError(409, 'This bill is closed.');

  if (idempotencyKey) {
    const same = b.payments.find((p) => p.participant_id === person.id && p.idempotency_key === idempotencyKey);
    if (same) return same;
  }
  const live = b.payments.find((p) => p.participant_id === person.id && (PINNING as readonly string[]).includes(p.status));
  if (live) {
    if (live.status === 'verified') throw new HttpError(409, { code: 'already_paid', message: 'Your share is already paid.' });
    return live; // an attempt is already open; reuse it instead of creating a duplicate
  }

  const row = computeState(b, pinnedAmounts(b)).participants.find((r) => r.id === person.id);
  if (!row || row.total <= 0) throw new HttpError(409, { code: 'nothing_due', message: 'You have nothing to pay yet. Pick your items first.' });

  const hours = Number((env as unknown as { PAYMENT_INITIATED_HOURS?: string }).PAYMENT_INITIATED_HOURS ?? 24);
  for (let attempt = 0; attempt < 5; attempt++) {
    const payment: PaymentRow = {
      id: newId(), bill_id: b.bill.id, participant_id: person.id, provider: providerKey, amount: row.total, currency: b.bill.currency,
      status: 'initiated', reference: newReference(), external_id: null, payer_note: null, idempotency_key: idempotencyKey,
      created_at: now(), expires_at: new Date(Date.now() + hours * 3_600_000).toISOString(),
    };
    try {
      await db.batch([
        db
          .prepare(
            'INSERT INTO payments (id, bill_id, participant_id, provider, amount, currency, status, reference, external_id, payer_note, idempotency_key, created_at, expires_at) ' +
              "VALUES (?1,?2,?3,?4,?5,?6,'initiated',?7,NULL,NULL,?8,?9,?10)",
          )
          .bind(payment.id, payment.bill_id, payment.participant_id, providerKey, payment.amount, payment.currency, payment.reference, idempotencyKey, payment.created_at, payment.expires_at),
        db
          .prepare("INSERT INTO payment_events (id, payment_id, at, actor, from_status, to_status, note, provider_event_id) VALUES (?1, ?2, ?3, 'payer', NULL, 'initiated', '', NULL)")
          .bind(newId(), payment.id, payment.created_at),
        db.prepare('UPDATE bills SET version = version + 1 WHERE id = ?1').bind(b.bill.id),
      ]);
      return payment;
    } catch (e) {
      if (!isUnique(e)) throw e;
      // Either a simultaneous start by the same person (the one-live-payment index), or a reference collision.
      const again = await db
        .prepare("SELECT * FROM payments WHERE participant_id = ?1 AND status IN ('initiated','awaiting_confirmation','verified')")
        .bind(person.id)
        .first<PaymentRow>();
      if (again) return again;
    }
  }
  throw new HttpError(500, 'Could not allocate a payment reference.');
}

/** The payer says they sent the money. This asks for confirmation; it does not confirm anything. */
export async function markPaidByPayer(db: D1Database, p: PaymentRow, payerNote: string | null | undefined): Promise<void> {
  if (payerNote) await db.prepare('UPDATE payments SET payer_note = ?1 WHERE id = ?2').bind(payerNote.slice(0, 80), p.id).run();
  await transition(db, p, 'awaiting_confirmation', 'payer', payerNote ?? '');
}

/** Apply an already-authenticated provider event. Returns: applied | duplicate | ignored | mismatch. */
export async function applyProviderEvent(db: D1Database, providerKey: string, ev: ProviderEvent): Promise<'applied' | 'duplicate' | 'ignored' | 'mismatch'> {
  const seen = await db.prepare('SELECT 1 AS x FROM payment_events WHERE provider_event_id = ?1').bind(ev.event_id).first();
  if (seen) return 'duplicate';
  const matches = (await db.prepare('SELECT * FROM payments WHERE provider = ?1 AND reference = ?2 LIMIT 2').bind(providerKey, ev.reference).all()).results as unknown as PaymentRow[];
  if (matches.length !== 1) return 'ignored'; // nothing matches, or the reference is ambiguous across bills
  const p = matches[0]!;
  const target = { paid: 'verified', failed: 'failed', expired: 'expired' }[ev.status];
  if (target === 'verified' && (ev.amount !== p.amount || ev.currency !== p.currency)) {
    // Money arrived but not the amount we asked for. Never auto-verify; leave it for the creator.
    try {
      await db
        .prepare("INSERT INTO payment_events (id, payment_id, at, actor, from_status, to_status, note, provider_event_id) VALUES (?1,?2,?3,'provider',?4,?4,?5,?6)")
        .bind(newId(), p.id, now(), p.status, `Amount mismatch: provider says ${ev.amount} ${ev.currency}, expected ${p.amount} ${p.currency}`, ev.event_id)
        .run();
    } catch (e) {
      if (isUnique(e)) return 'duplicate';
      throw e;
    }
    return 'mismatch';
  }
  try {
    await transition(db, p, target, 'provider', `Provider event ${ev.status}`, ev.event_id);
  } catch (e) {
    if (e instanceof HttpError) return 'ignored';
    if (isUnique(e)) return 'duplicate';
    throw e;
  }
  return 'applied';
}
