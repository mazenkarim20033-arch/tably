# Receipt reading evaluation

```bash
npm run eval                      # score the engine; compares with baseline.json
npm run eval -- --save-baseline   # store the current scores as the baseline
npm run eval:inspect -- wrapped-names 0   # show one failing synthetic receipt next to its answer key
npm run eval:import -- dump.txt cafe-x    # add a receipt from "Share what the scanner read" (goes to holdout)
```

## Sets

- **real-dev** (`receipts/dev/`): real receipts used while building. Fixing these is allowed.
- **real-holdout** (`receipts/holdout/`): real receipts that are only scored. Never change the engine to make one of
  these pass; if one fails, describe the general problem, fix it with dev examples, and see whether holdout improves.
- **synthetic-holdout** (`synthetic.ts`): 400 generated receipts in 8 layout families under camera distortion and OCR
  damage. Useful for spotting whole classes of failure; not proof of real accuracy.

The three sets are reported separately and never averaged together.

## Adding a real receipt

1. In the app, open the receipt's review screen, tap "Share what the scanner read", and save the text to a file.
2. `npm run eval:import -- <file> <short-id>`; the receipt goes to holdout unless you add `dev`.
3. Open the new JSON and correct the answer key against the photo: every item name, quantity and line total, and the
   printed subtotal, tax, service, tip, discount and total (`null` when not printed). Leave out lines printed at 0.00.
4. Set `"reviewed": true`. Unreviewed receipts are listed but not scored.

## What the numbers mean

| metric | meaning |
|---|---|
| exactReceipts | every item, quantity, line total and printed total right |
| itemRecall / itemPrecision | items found by name / predicted items that are real |
| qtyAccuracy, priceAccuracy | among items found, quantity / line total right; a price on the wrong item is wrong |
| misassigned | prices that were read but put on another item (hidden when totals still add up) |
| errorsFlagged | share of wrong fields the review screen outlines in amber; the rest are silent errors |
| flagPrecision | share of amber fields that were really wrong (low means false alarms) |
| silentWrong | wrong fields with no warning: the number that matters most |
