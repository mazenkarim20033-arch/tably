# Reading receipts with a vision model

The normal scan (Apple Vision OCR, then the layout and arithmetic engine) runs on the phone and is always the first
reading. A vision model is an optional second opinion for messy receipts and bad photos.

## How it works
- The review screen shows **Read with AI** when the scan does not add up or has fields to check, and only if the
  server reports `vision: true` (`GET /api/features`).
- The person confirms each time. The photo is resized (about 1600 px, JPEG) and sent to `POST /api/scan`; it is not stored.
- The Worker asks a Workers AI vision model (`SCAN_MODEL`, default `@cf/meta/llama-3.2-11b-vision-instruct`) for JSON
  with amounts as printed text. It returns that reading only.
- On the phone, `receiptFromVision` builds a receipt. Every amount the scanner never saw (counting its runner-up
  readings) is flagged, and the receipt's arithmetic is checked. `chooseReading` keeps the scanner's reading unless the
  AI's is clearly better. The previous reading is kept so **Undo** restores it. Nothing is applied without showing.

## Cost and limits
- Off by default: `SCAN_ENABLED` is `"off"` in `wrangler.jsonc`. Set it to `"on"` and deploy to switch it on.
- Workers AI has a free daily allowance. `SCAN_DAILY_CAP` (default 200 scans a day, shared by everyone) and 10 scans per
  person per hour keep it inside that.
- Meta's vision model asks for a one-time licence acceptance per Cloudflare account (see the model's page in the
  Cloudflare dashboard). The model call has not been run against the live service yet; check the first real scan.

## Later: on the phone
The same `VisionReading` format can be produced by an on-device model, which would need no server and no upload.
Only the call that produces the reading would change.

## Not yet measured
Small models misread digits more than the large hosted ones. Whether this beats the normal scan on real photos has
to be measured on receipts with known answers before relying on it.
