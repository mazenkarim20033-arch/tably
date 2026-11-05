# Reading receipts with a vision model

The normal scan (Apple Vision OCR, then the layout and arithmetic engine) runs on the phone and is always the first
reading. A vision model is an optional second opinion for messy receipts and bad photos.

## How it works
The scanner stays the primary reader. The AI is a verifier for the few amounts the scanner is unsure about.

1. The engine marks doubtful amounts and knows the values they could be (runner-up readings, one-digit fixes).
2. `verifyTargets` finds the photo row each doubtful amount came from. Nothing is sent if nothing is in doubt.
3. The review screen shows **Check with AI** only then, and only if the server reports `vision: true`
   (`GET /api/features`). The person confirms each time.
4. The phone cuts out just those rows (a thin strip each, at most 6, about 900 px wide) and sends them with the
   candidate values to `POST /api/scan`. The full photo never leaves the phone; nothing is stored.
5. The Worker asks a Workers AI vision model (`SCAN_MODEL`, default `@cf/meta/llama-3.2-11b-vision-instruct`) which
   amount each row shows, as JSON.
6. `applyAnswers` ignores any answer that is not one of the candidates. If the items do not add up now, it applies the
   smallest set of answers that makes them add up, but only when exactly one such set exists; the previous reading is kept
   so **Undo** restores it. Otherwise the answers are only offered as one-tap choices. The model never overrules
   arithmetic, and nothing is applied without being shown.

The backend is replaceable: an on-device model only has to answer "which of these amounts does this row show".

## Cost and limits
Off by default: `SCAN_ENABLED` is `"off"` in `apps/worker/wrangler.jsonc`. Set it to `"on"` and deploy to switch it on;
set it back to `"off"` and deploy to stop all AI reading at once, with no app update.

Every scan is counted before the model is called, against these limits (all in `wrangler.jsonc`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `SCAN_USER_MONTHLY` | 5 | AI reads per app install per calendar month (the app shows how many are left) |
| (4 x the above) | 20 | per network address per month, so reinstalling or inventing ids gains little |
| `SCAN_MONTHLY_CAP` | 3000 | AI reads for everyone together per month: **this is your budget** |
| `SCAN_DAILY_CAP` | 200 | everyone together per day, against bursts |
| (fixed) | 10/hour | per network address |

Set the budget from money: `SCAN_MONTHLY_CAP` = monthly budget / cost of one read. Measure the cost of one read from the
Cloudflare dashboard after a few real scans. When the cap is reached, the app says AI reading is paused and the
normal scan keeps working. The install id is a random number the app makes for itself; it is not a login, so it is
one limit among several, not the only protection.

Meta's vision model asks for a one-time licence acceptance per Cloudflare account (see the model's page in the
Cloudflare dashboard). The model call has not been run against the live service yet; check the first real scan.

## On the phone instead
Researched, not built: SmolVLM (256M/500M) and Qwen2-VL 2B through MLX Swift are the candidates. No iPhone 15 speed
or receipt-accuracy numbers were found, and the memory limit for a free-Apple-ID install is unconfirmed, so a
time-boxed spike is needed: it fits in memory, answers a row in under about 10 s, and beats the scanner alone on
real receipts with known answers.

## Not yet measured
Small models misread digits more than large ones. Whether the verifier helps on real photos has to be measured on
receipts with known answers before relying on it.
