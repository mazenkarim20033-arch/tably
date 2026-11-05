# Payments: what is real

| Method | Status | How it works |
|---|---|---|
| Manual InstaPay | **Works** | Creator adds their InstaPay address / phone / link. A friend sends money from their own banking app, puts a `TBL-XXXXXX` reference in the note and taps "I've paid". The creator checks their own account and taps Confirm. |
| Kashier (automatic InstaPay) | **Not implemented** | Needs a Kashier merchant account and credentials (business KYC). Kashier documents InstaPay QR / request-to-pay and signed webhooks (`x-kashier-signature`, HMAC-SHA256). The exact signed payload must be taken from their docs before building. Adapter slot: `KashierProvider`. |
| Telda | **Not available** | No public merchant API was found. Stub only. |

TABLY never uses private or undocumented InstaPay interfaces, never automates a banking app, and never asks for a PIN or OTP.

## States

`unpaid` (no row) → `initiated` → `awaiting_confirmation` → `verified`; also `failed`, `expired`, `cancelled`.

- The payer can only move their own payment to `awaiting_confirmation` or `cancelled`.
- `verified` comes only from the creator's confirmation or an authenticated provider event.
- An unfinished attempt expires after 24 hours; the creator can still confirm late money.
- Every change is stored in `payment_events` (who, when, from, to).

## Safety rules enforced by the server

- One live or settled payment per person (partial unique index), idempotency keys, and a row lock against double taps.
- Once someone starts paying, their amount is pinned and their selections, any shared item they hold, adjustments involving them, and the payee details are locked.
- Webhooks: signature checked on the raw body, unique event ids (idempotent), amount and currency must match exactly or nothing is verified, replies are the same for duplicates so providers stop retrying.

## Known limits

- The payment-link host allowlist defaults to `ipn.eg` and is **unverified**; set `TABLY_PAYMENT_LINK_HOSTS` once you know the real hosts.
- A payer's "I've paid" depends on the creator checking honestly; there is no automatic proof without a provider.

## Making paying faster

### Done: a shorter manual flow (no accounts, no fees)

Opening the pay sheet already starts the payment, so the details are on screen at once: the amount with a one-tap
copy, an "Open InstaPay" button when the creator saved their InstaPay link (it fills in the recipient), the address
and phone, and one "I've paid" button. The note with the `TBL-` reference is optional. Coming back from the banking
app puts "Did you send it? Yes, I've paid" at the top. About 8 taps became about 3.

InstaPay's own personal links and QR codes carry the recipient but never the amount, so the sender still types it.
Nothing about the amount can be pre-filled without a payment company.

### Possible: automatic payment with a payment company

Only a company that receives the money first can prove it arrived. Findings (checked November 2026; the sources
disagree in places, so confirm with each company before relying on a number):

| Company | InstaPay | Card fee | Individuals without a commercial register | Notes |
|---|---|---|---|---|
| Kashier | Yes: request-to-pay and QR in the API | about 2.75% + EGP 3, no monthly fee | Not stated; business verification | Request-to-pay pushes the request into the payer's banking app with the amount filled in; the result arrives by webhook. The `KashierProvider` slot is ready. |
| Paymob | Listed "coming soon" | 2.75% + EGP 3 | Sources conflict | Cards and wallets work; needs its own sign-up. |
| EasyKash | Yes | 3.5% | Yes | 7-day settlement. |
| XPay | Not published | 2.5% + EGP 2.5 | Yes | No-code payment links. |

Needs from the owner before any code is written: a merchant account with real credentials (KYC, which only the
account holder can complete), a decision on who pays the fee and how long settlement may take, and sandbox keys to
test against.
