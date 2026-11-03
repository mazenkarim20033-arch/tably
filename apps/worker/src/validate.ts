import { z } from 'zod';

const MAX_MINOR = 100_000_000_00; // 100M major units: every sum stays far inside what a JS number holds exactly
const money = z.number().int().min(0).max(MAX_MINOR);

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);

export const PayeeIn = z
  .strictObject({
    payee_name: trimmed(1, 60),
    instapay_address: z.string().regex(/^[A-Za-z0-9._-]{2,40}@[A-Za-z]{2,20}$/).nullish(),
    instapay_phone: z.string().regex(/^01[0125]\d{8}$/).nullish(),
    instapay_link: z.string().max(300).nullish(),
  })
  .refine((p) => p.instapay_address || p.instapay_phone || p.instapay_link, {
    message: 'add an InstaPay address, phone number or payment link',
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

/** FastAPI-shaped validation error, so the existing app code keeps reading `detail[0].msg`. */
export function validationDetail(err: z.ZodError): Array<{ msg: string }> {
  const first = err.issues[0];
  const where = first && first.path.length ? `${first.path.join('.')}: ` : '';
  return [{ msg: `${where}${first?.message ?? 'Invalid request.'}` }];
}
