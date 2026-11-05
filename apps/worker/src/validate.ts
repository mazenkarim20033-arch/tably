import { z } from 'zod';

const MAX_MINOR = 100_000_000_00; // 100M major units: every sum stays far inside what a JS number holds exactly
const money = z.number().int().min(0).max(MAX_MINOR);

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);

/** Other ways to get paid besides InstaPay. Each is shown to the friend with what to send to. */
export const ExtraMethod = z.discriminatedUnion('kind', [
  // A Telda @tag or the phone number it is tied to.
  z.strictObject({ kind: z.literal('telda'), value: z.string().trim().regex(/^(@?[A-Za-z0-9._]{2,30}|01[0125]\d{8})$/) }),
  // A mobile wallet number (Vodafone Cash, Orange Cash, Etisalat Cash, ...), with an optional name for it.
  z.strictObject({ kind: z.literal('wallet'), value: z.string().regex(/^01[0125]\d{8}$/), label: trimmed(1, 30).nullish() }),
  // Pay in person; the creator marks it paid.
  z.strictObject({ kind: z.literal('cash') }),
  z.strictObject({ kind: z.literal('other'), label: trimmed(1, 30), value: trimmed(1, 80) }),
]);
export type ExtraMethodInput = z.infer<typeof ExtraMethod>;

export const PayeeIn = z
  .strictObject({
    payee_name: trimmed(1, 60),
    instapay_address: z.string().regex(/^[A-Za-z0-9._-]{2,40}@[A-Za-z]{2,20}$/).nullish(),
    instapay_phone: z.string().regex(/^01[0125]\d{8}$/).nullish(),
    instapay_link: z.string().max(300).nullish(),
    methods: z.array(ExtraMethod).max(6).nullish(),
  })
  .refine((p) => p.instapay_address || p.instapay_phone || p.instapay_link || (p.methods?.length ?? 0) > 0, {
    message: 'add at least one way to be paid',
  })
  .refine((p) => new Set((p.methods ?? []).filter((m) => m.kind === 'telda' || m.kind === 'cash').map((m) => m.kind)).size === (p.methods ?? []).filter((m) => m.kind === 'telda' || m.kind === 'cash').length, {
    message: 'each of Telda and cash can be listed once',
  });
export type PayeeInput = z.infer<typeof PayeeIn>;

export const BillCreate = z.strictObject({
  store: trimmed(1, 120),
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  items: z
    .array(z.strictObject({ description: trimmed(1, 160), quantity: z.number().int().min(1).max(999), line_total: money }))
    .min(1)
    .max(200),
  discounts: z.number().int().min(-MAX_MINOR).max(0).default(0), // negative = savings
  tax: money.default(0),
  service: money.default(0),
  tip: money.default(0),
  tax_included: z.boolean().default(false),
  printed_total: money.nullish(),
  accept_mismatch: z.boolean().default(false),
  payee: PayeeIn.nullish(),
});
export type BillCreateInput = z.infer<typeof BillCreate>;

export const ParticipantCreate = z.strictObject({ name: trimmed(1, 40) });

export const ClaimSet = z
  .strictObject({
    item_id: z.string().min(1).max(32),
    units: z.number().int().min(0).max(999).nullish(),
    share: z.boolean().nullish(),
  })
  .refine((c) => (c.units == null) !== (c.share == null), { message: 'send either units or share' });

export const LinkUpdate = z.strictObject({
  disabled: z.boolean().nullish(),
  extend_days: z.number().int().min(1).max(365).nullish(),
  rotate: z.boolean().default(false),
});

export const PaymentCreate = z.strictObject({ provider: z.string().max(30).default('manual_instapay') });
export const PaidBody = z.strictObject({ payer_note: trimmed(0, 80).nullish() });
export const ReviewBody = z.strictObject({ note: trimmed(0, 200).default('') });
export const TransferCreate = z.strictObject({
  payer_id: z.string().min(1).max(32),
  beneficiary_id: z.string().min(1).max(32),
  amount: z.number().int().min(1).max(MAX_MINOR),
  note: trimmed(0, 80).default(''),
});
export const BillEdit = z.strictObject({
  store: trimmed(1, 120),
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  items: z
    .array(
      z.strictObject({
        id: z.string().max(32).nullish(), // omit for a new item
        description: trimmed(1, 160),
        quantity: z.number().int().min(1).max(999),
        line_total: money,
      }),
    )
    .min(1)
    .max(200),
  discounts: z.number().int().min(-MAX_MINOR).max(0).default(0),
  tax: money.default(0),
  service: money.default(0),
  tip: money.default(0),
  tax_included: z.boolean().default(false),
  printed_total: money.nullish(),
  accept_mismatch: z.boolean().default(false),
});
export const CloseBody = z.strictObject({ force: z.boolean().default(false) });
export const ReminderLog = z.strictObject({ participant_ids: z.array(z.string().max(32)).min(1).max(50) });
export const SummaryRequest = z.strictObject({ bills: z.array(z.record(z.string(), z.string())).min(1).max(50) });

/** FastAPI-shaped validation error, so the existing app code keeps reading `detail[0].msg`. */
export function validationDetail(err: z.ZodError): Array<{ msg: string }> {
  const first = err.issues[0];
  const where = first && first.path.length ? `${first.path.join('.')}: ` : '';
  return [{ msg: `${where}${first?.message ?? 'Invalid request.'}` }];
}
