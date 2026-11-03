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
