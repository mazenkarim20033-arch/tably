# Security notes

## What is protected, and how

| Risk | Defence |
|---|---|
| Guessing a bill link | 192-bit random share tokens; unknown links return 404; 30 misses per 5 minutes per IP then 429 |
| Reading or changing a bill as the creator | Separate 256-bit admin token, stored only as a SHA-256 hash on the server and in the phone keychain; wrong key and wrong bill look identical (404) |
| Pretending to be another participant | Each participant gets a secret on joining (stored hashed); people added by the creator get none |
| Two people taking the same item | Item row locked in a transaction (`SELECT ... FOR UPDATE`; `BEGIN IMMEDIATE` on SQLite); 12-way race test has exactly one winner |
| Wrong totals | All money is integer piastres; only the server computes totals; splits use largest-remainder so parts always sum exactly |
| Fake "paid" | A payment becomes verified only through the creator's confirmation or an authenticated provider event; payers cannot reach either |
| Duplicate or replayed payments | One live/settled payment per person (partial unique index), idempotency keys, row lock, unique provider event ids |
| Forged provider webhooks | Signature checked on the raw body before parsing; amount and currency must match exactly or nothing is verified |
| Editing around a payment | Receipt, selections, shared items, adjustments, payee and removal are locked once someone starts paying |
| Misdirected money | Payee details cannot change after payment starts; payment links must be https on an allowed host |
| Abuse and floods | Per-IP rate limits on every write; request bodies capped (256 KB JSON, 8 MB photo) including chunked uploads |
| Token leaks | `Referrer-Policy: no-referrer`; access logs redact `/s/<token>`; API responses `no-store`; tokens never in query strings |
| Script injection / framing | Strict Content-Security-Policy, `X-Frame-Options: DENY`, no `dangerouslySetInnerHTML`, HSTS over https |
| Bad uploads | Only JPEG/PNG by magic bytes, content type decided by the server, client filenames ignored, served only to the creator |
| Data kept forever | Only display names, amounts and the receipt photo are stored; `purge` deletes bills after 180 days |
| Secrets in the repo | None. The only secret is the database URL, kept in host settings. Provider keys will be server-side only |
| Dependencies | `pip-audit`: none known. `npm audit` (production): 11 moderate, all in Expo's build tooling (glob/minimatch), none in the web page or the server |

TABLY never stores bank passwords, PINs or OTPs, never talks to a private InstaPay interface, and never automates a banking app.

## Known gaps (be honest with yourself about these)

- **Link = access.** Anyone with a share link can pick items and see the payee's InstaPay details. That is the product, so share links only with the people at the table. Turn the link off or make a new one from the dashboard.
- **Creator honesty.** Without a payment provider, "paid" means the creator said they saw the money.
- **No user accounts.** Admin keys live in one phone's keychain. Losing the phone or deleting the app loses control of existing bills (they expire and are purged).
- **Rate limits are in memory.** Correct for one server process; use Redis or a gateway before running several.
- **Live updates poll the database** once a second per open page; fine for friends at a table, not for thousands of viewers.
- **No audit of the Swift OCR module, no penetration test, no formal threat review.** This is a careful MVP, not a certified financial product. Do not process other people's money at scale before getting an independent security review and checking Egyptian payment-service regulation.
- **Postgres untested.** See `docs/deploy.md`.
