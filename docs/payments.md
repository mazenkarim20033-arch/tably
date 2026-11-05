# Payments: what is real

| Method | Status | How it works |
|---|---|---|
| Manual InstaPay | **Works** | Creator adds their InstaPay address / phone / link. A friend sends money from their own banking app, puts a `TBL-XXXXXX` reference in the note and taps "I've paid". The creator checks their own account and taps Confirm. |
| Kashier (automatic InstaPay) | **Not implemented** | Needs a Kashier merchant account and credentials (business KYC). Kashier documents InstaPay QR / request-to-pay and signed webhooks (`x-kashier-signature`, HMAC-SHA256). The exact signed payload must be taken from their docs before building. Adapter slot: `KashierProvider`. |
| Telda, mobile wallets, cash | **Works (manual)** | The creator lists their Telda tag or number, a wallet number and/or cash. The friend picks one in the pay menu, sees what to send to, and taps "I've paid"; the way they paid is added to their note (`via Telda`) so the creator knows where to look. Same confirmation rule as InstaPay. No Telda API is used: none is public. |

TABLY never uses private or undocumented InstaPay interfaces, never automates a banking app, and never asks for a PIN or OTP.

## States

`unpaid` (no row) → `initiated` → `awaiting_confirmation` → `verified`; also `failed`, `expired`, `cancelled`.

- The payer can only move their own payment to `awaiting_confirmation` or `cancelled`. They can take back "I've paid" (`awaiting_confirmation` to `cancelled`) until the creator confirms, which unlocks their items so they can add something they forgot and pay the new total. If the money did arrive after they took it back, the creator can still confirm it.
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

### Done: ways to pay (menu)

Tapping Pay lists the ways the creator accepts (InstaPay, Telda, a wallet, cash, other). With only one way, the menu is
skipped. The list is stored as JSON in `bills.payee_extra` (migration `0002_payment_methods.sql`); it is validated by
the API (Telda tag or phone, a wallet phone number, cash, or a labelled "other"), at most six, Telda and cash once
each. Older bills have none and look exactly as before.

### Done: check your bank once (app)

The bill page lists everyone who says they paid, sorted by amount, with the note to look for and what they paid
with. The creator ticks what they can see in their own bank and confirms them together. Nothing is ticked for
them, and each payment is still confirmed individually on the server.

### Not built (and why)

Automatic notification to the creator through Telegram was considered and removed: the creator checks the app instead.

### Done: nothing locks until "I've paid"

Opening the pay sheet only shows how to pay; it creates no payment and locks nothing. The payment (and with it the
person's items and amount) is created when they tap "I've paid", and the bill page then says so and offers "Undo and
edit my items". A confirmed payment stays locked: ask the creator.

### Done: payment details saved once (app)

A "Payment details" screen (opened from the home screen or a bill) saves the creator's InstaPay link, address, phone,
Telda, wallet and cash on the phone. Every new bill uses them; one tap updates bills already made (refused by the
server for a bill where someone has started paying). There are no accounts: "saved to their account" means saved on
that person's own phone.
