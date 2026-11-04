# TABLY receipt engine: assessment and redesign

Status: milestone 4 done plus first real-receipt fixes; the app now reads receipts with the new engine (`readReceipt`), which falls back to the old
reader only when that one adds up and the new one does not. Not yet tested on real held-out receipts.

## First real-receipt feedback (Burak, 14 lines)

The first scan of a receipt we had never seen showed three general gaps. Each was fixed as a rule, not for that receipt,
and the synthetic generator gained a randomized layout with the same properties, so the evaluation can see them:

- **A lone total label whose amount drifted onto the next line** (bigger type, amount to the right) took no amount, so
  the total came out blank. A lone money label now takes the amount just beyond it in the reading direction.
- **A name that wraps, with the quantity on its first line and the price on the second**, became an unreadable row
  plus a fake item. When the table's lines start with a quantity, a line without one continues the line above, and
  the table start extends upward over such a line.
- **Amounts glued to a currency code** ("11,185.00EGP") are read as amounts.

New synthetic layout "qty-wrap-big-total": 36% fully right before the fixes, 82% after. What remains in it is the
deliberate scanner damage.

Not resolved: the printed subtotal on that receipt (11,185.00) is 1,200.00 more than the 14 prices the scanner read,
so some price or line is missing or misread. Without that scan's raw data the cause is unknown. The app still shows the
mismatch rather than hiding it.

## Milestone 4: validation, confidence, review screen (stages F and G)

- **What a disputed field carries:** the path in `uncertain`, a few plain words in `reasons`, and one-tap values in
  `choices` (items) or `fieldChoices` (totals). Nothing is applied automatically, and editing a field clears all three.
- **Rules,** shared by both readers unless noted:
  - Several prices that a single misread digit could explain each get that value as a choice, up to three. The old
    behaviour was a note only.
  - When the printed subtotal plus charges does not equal the printed total, each one-digit fix of one of those
    numbers is offered on its field.
  - A charge printed with its rate ("Service 12%") must be that share of its base, within one pound. If it is not,
    it is flagged. *(new engine)*
  - Quantity × unit price that is one misread digit away from the line total is offered on the price. *(new engine)*
  - A runner-up scanner reading about as confident as the chosen one becomes a choice. *(new engine)*
  - Equally good readings that disagree offer each other's value on the disputed line. *(new engine)*
- **Review screen:**
  - the reason under a disputed field, and "Use …" buttons for each choice, on items and on totals
  - the old single "Use 60.00" suggestion is one of those choices
  - "Retake photo", with a confirmation before edits are lost

On the synthetic holdout, milestone 3 against milestone 4 on the same 400 receipts:

| | milestone 3 | milestone 4 |
|---|---|---|
| wrong fields that are flagged | 42.9% | 53.6% |
| flags that point at a real error | 56.3% | 44.1% |
| silent wrong fields | 48 | 39 |

- **Trade-off:** more errors are caught at the cost of more false alarms. The largest source of false alarms is a
  quantity read from a number before the name ("2 Chocolate Fudge…"), which is genuinely ambiguous ("7 Up"), so it
  stays flagged.
- **Generator fix:** labels printed a rate that differed from the one charged ("Service 12%" on a 10% charge). That
  changed the synthetic set, so the baseline was re-measured (old reader: 38% exact, 1,318 silent wrong fields).
  Milestone 3's 88.8% was on the earlier set; on this set it is 85.8%, the same as milestone 4.

## Milestone 3: meaning and pairing (stages D and E)

- **Shared rules:** the arithmetic rules moved to `arithmetic.ts`, shared by both readers. That move changed no
  score and no test.
- **Line roles** come from words, checked from the most specific meaning to the least:
  - header, then table or invoice numbers, then counts ("Total Qty", "Min Charge", covers)
  - then subtotal, then the charge printed first (tax, service, tip, discount)
  - then payment, then total, then other non-item lines
  - punctuation inside words is ignored ("V.A.T" is "vat")
- **Summary boxes:** labels printed above their values take the value under them, by horizontal overlap.
- **Line-total column:** the column equal to quantity × another column, else the column at the end of the reading
  direction (right for English, left for Arabic).
- **Items are segmented at the edge where names start.** That edge is fitted as a slanting line:
  - an indented line continues the item above
  - a line in the other script is a caption
  - "2 @ 15.00" gives the item above its quantity and unit price
  - a number between two words of a name stays in the name
- **Several readings** are built (how loose text lines attach, which column is the line total). The one whose numbers
  add up wins. Equally good readings that disagree mark the disputed items for review.
- **Fallback:** the old reader is used only when its reading adds up and the new one's does not.

| | baseline | milestone 2 | milestone 3 |
|---|---|---|---|
| real dev, exact receipts | 3 of 4 | 3 of 4 | 4 of 4 |
| synthetic, exact receipts | 37% | 37% | 88.8% |
| synthetic, item recall | 80.9% | 88.4% | 99.8% |
| synthetic, price accuracy | 90.6% | 93.3% | 98.8% |
| synthetic, prices on the wrong item | 99 | 65 | 2 |
| synthetic, false items | 44 | 35 | 1 |
| synthetic, silent wrong fields | 1,325 | 927 | 24 |
| time per receipt (median) | 5.8 ms | 4.3 ms | 1.3 ms |

- **The ceiling:** about 15% of synthetic receipts carry a deliberately misread digit and cannot be exact. 88.8% is
  close to that ceiling.
- **What remains:** most of the remaining silent errors are those misreads when more than one price could explain the
  gap. They are only noted, not marked on a field. That is milestone 4.

**Caution about these numbers.** The same person wrote the synthetic generator and the new rules, so the synthetic
set flatters the engine. The generator also had a bug, fixed here: a misread digit was not applied to the word
boxes. Only real held-out receipts can show how well the engine generalises.

## Milestone 2: layout (stage C)

`buildLayout` rebuilds printed lines from the scanner's geometry, not one global tilt:

- **Model:** the slope of the printed lines is a + b·x + c·y + d·x·y (rotation, curl, keystone). It is fitted
  robustly to each observation's measured slope (from its word centres, else its corners), then integrated to get
  each point's vertical drift.
- **Lines:** observations are grouped by their unbent height. Two observations that overlap horizontally are never on
  one line, so a caption under a name stays a separate line.
- **Columns:** numbers whose right edges line up, as slanted fitted lines with one number per line, labelled as
  price columns or quantity columns.
- **No geometry:** with no usable geometry (old dumps, typed fixtures) it reports `oriented: false` and the engine
  uses the old reader unchanged.

Results:
- **Synthetic layout test:** 100% of 3,638 printed rows rebuilt exactly; 99.4% with noisy corners and word boxes.
- **End to end on the synthetic holdout:** the new layout feeding the old meaning and pairing stages.

| | baseline | milestone 2 |
|---|---|---|
| item recall | 80.9% | 88.4% |
| price accuracy | 90.6% | 93.3% |
| prices on the wrong item | 99 | 65 |
| false items | 44 | 35 |
| silent wrong fields | 1,325 | 927 |
| exact receipts | 37% | 37% |

Exact receipts did not change: what still fails is meaning and pairing (price before the name, "2 @" lines, wrapped
names, unfamiliar labels such as "V.A.T"), which is milestone 3. The remaining prices on the wrong item are all in
wrapped names.

Not yet known: how clean real Vision corners and word boxes are. The first dumps from the new build will show it.

## Baseline (current parser, before the redesign)

From `packages/core/eval/baseline.json` (`npm run eval`):

| set | receipts | exact | item recall | qty | price | misassigned | errors flagged | silent wrong fields |
|---|---|---|---|---|---|---|---|---|
| real dev | 4 | 75% | 100% | 100% | 100% | 0 | 0% | 1 |
| real holdout | 0 | - | - | - | - | - | - | - |
| synthetic holdout | 400 | 37% | 80.9% | 88.7% | 90.6% | 99 | 9.5% | 1,325 |

Weakest synthetic layouts:
- price printed before the name: 0% exact
- summary box above the table: 0% exact
- "2 @ 15.00" lines: 4% exact
- wrapped names: 36% exact, 38 false items

Only 9.5% of wrong fields are outlined for review. The real-dev numbers are high because those receipts were fixed one by one, which is the overfitting this redesign is meant to end.

## 1. What exists today

```
camera / photo picker (expo-image-picker, quality 1)
  └─ TablyVisionModule.swift
       VNRecognizeTextRequest, .accurate, en-US + ar-SA, language correction off
       upright pass; the 3 other orientations only if almost no text is found
       per observation: top string, 2 runner-ups, axis-aligned box, confidence
  └─ OcrLine[] {text, x, y, w, h, confidence, alternates}      (draft keeps these)
  └─ packages/core parseReceipt.ts  (1,131 lines, one file)
       straightenByOrder (Nth price ↔ Nth name)     ┐ several candidate readings,
       candidateSlopes → parseWithSlope × 2-3        ┘ arithmetic picks one
         groupFragments → Row{text: string}  ← spatial detail ends here
         keyword regexes on the row string → kind (item / tax / total / …)
         regexes on the row string → qty, unit price, line total
         table region = after a header row, before the first money label
         misread-digit and stray-row suggestions from the subtotal
  └─ Receipt {items, totals, uncertain: string[], notes, unparsed}
  └─ review.tsx: amber outlines, one-tap "Use 60.00", mismatch banner, × to remove
```

It takes about 9 ms for 60–75 fragments on the PC, so there is plenty of room for a heavier but smarter pipeline.

## 2. Assessment

### Reliable: keep as it is

- **Money handling**: integer piastres, plus parsing of Arabic-Indic digits, thousands separators and decimal commas (`money.ts`).
- **Honesty rules**: amounts are never changed silently. A correction is a suggestion the person accepts, and a mismatch is reported, not "fixed". These rules carry over to the new engine.
- **The OCR settings are sound**: `.accurate` with language correction off, so digits and dish names are not "corrected" into dictionary words. Runner-up readings are also kept.
- **The raw OCR is stored with each draft**, so a better engine can re-read old scans.
- **The review screen pattern works**: flag a field, offer a one-tap fix, keep everything else editable.

### Fragile: the causes of receipt-by-receipt fixing

1. **No image preprocessing at all.** The receipt is never located, cropped or flattened. A tilted or curved photo goes straight to OCR. Everything downstream then has to guess the tilt, which is what failed on Table 9.
2. **Geometry is thrown away at the source.** Vision gives each observation a four-corner quadrilateral (the true angle of that line) and can return the box of any word inside it. We keep only an axis-aligned box, which grows taller when a line is tilted. The tilt then has to be re-estimated globally, and one slope cannot describe a curved or keystoned page.
3. **A whole observation is the smallest unit.** When Vision returns `Fresh Mango Juice منجا 230.00` as one string, the parser cannot see where the price sits. When it splits the same row into four pieces, the parser has to re-join them. These two cases need different code paths today.
4. **Spatial structure is flattened into a string per row early on.** After `groupFragments` everything is regexes on `row.text`, including the quantity, the unit price versus the line total, and the label. Columns are never modelled. "Which column is this number in?" cannot be asked, so it is inferred from token order in a string.
5. **Semantics are first-match keyword regexes.** One regex list decides tax, service or total for the whole row, and the order of the list matters. "Total" in a column header, "Total Min", "Tax Invoice" and "Total Qty" each needed a special case.
6. **Pairing is three overlapping mechanisms**: tilt grouping, orphan attachment, and order pairing. The last two were added after specific receipts failed (Table 9, Rehab City). Each is a local patch, and the arbitrary +70 head start in `parseReceipt` shows they don't share a scoring model.
7. **Arithmetic is the only score**, and it cannot see association errors. Moving every price one row down still adds up. Nothing measures how good the geometry of a pairing is.
8. **Uncertainty is binary and unranked.** A field is either in `uncertain` or not. There is no "two readings disagree" state, no second-best interpretation and no confidence that could be calibrated.

### Test assets: weaker than they look

| Fixture | Source |
|---|---|
| Rehab City | **The only real Apple Vision dump**, and it has no widths or runner-ups |
| Popeyes, TakeAway | Real receipts, hand-typed as rows |
| Table 9 | Rebuilt from a screenshot (positions measured by eye) |
| Stress tests | Generated with the same layout primitives the parser assumes |

- The "misread digit" stress test has a bug: `/d/` should be `/\d/`. It corrupts prices into junk like `60.00860.00` instead of changing one digit, so it does not test what it says.
- There is no development versus held-out split and no per-field metric. Everything is pass/fail on receipts the code was tuned on, so a high pass rate today says little about unseen receipts.
- "Share what the scanner read" drops the width, the runner-ups and the corner points, so the dumps you send are incomplete.

## 3. Redesign

A small engine in `packages/core/src/engine/`, one module per stage, with a typed hand-off between stages. The old `parseReceipt` stays callable behind the same signature until the new engine beats it on the evaluation set.

### A. Preprocess (Swift, on device)

- `VNDetectDocumentSegmentationRequest` finds the receipt's four corners. `CIPerspectiveCorrection` then produces a flat, cropped copy. The original is always kept.
- Variant 2 is a grayscale, contrast and shadow-flattened version, using Core Image only. It runs only when stage F rejects pass 1.
- Orientation comes from the document corners and the text quadrilaterals, not from "too little text".
- Cost to measure on a real iPhone: segmentation is about 50–100 ms; a second OCR pass is about 1–2 s and runs only on fallback.

### B. OCR with full geometry (Swift)

- For every observation, return the four corner points, the top 3–5 candidates with confidences, and **a box for every word**. Vision can give the box of any character range, so `230.00` gets its own box even when Vision merged it into a line.
- On iOS 26 and later, also run `RecognizeDocumentsRequest`, which can return table rows and cells, and use it as one more signal, not as the source of truth. This needs to be verified on your phone; the app supports iOS 15.1 and up, so the feature is guarded by a version check.
- "Share what the scanner read" exports everything above, so your dumps become complete test fixtures.

### C. Layout: tokens, then lines, columns and regions

- **Tokens**: words with their own quadrilaterals. Merged versus split observations stop mattering.
- **Local baselines**: each token's angle comes from its quadrilateral. Lines are traced by following neighbouring tokens along their local direction. That handles curved and keystoned paper without a global slope.
- **Columns**: cluster the left, right and centre edges of numeric tokens that recur down the page. A price column is a run of right-aligned amounts. A quantity column is a run of small integers.
- **Regions**: header, item table, summary or totals, and footer, found from column membership and density instead of keywords alone. This covers tables with no header row and summary boxes above the table.
- **Reading direction**: per line, from script (Arabic versus Latin runs) and the line's position relative to the columns.

### D. Semantics: scored roles, not first-match regexes

- Each token gets typed candidates: money, quantity, percent, date, time, phone, code, word.
- Each line gets a role score (item, subtotal, tax, service, tip, discount, total, payment, meta) from several features. Keywords in English and Arabic are one feature. Column membership, position in the region, the count and kind of numbers on the line, and "has a percent next to it" are others.
- Unfamiliar labels can still be placed by structure. A line in the summary region whose amount equals 14% of the subtotal is very likely tax, whatever it is called.

### E. Association: one global, scored assignment

- Item lines and amount tokens are matched by an **order-preserving alignment** (dynamic programming), which allows skips for captions, free lines and stray numbers.
- Each pairing costs: distance from the line's baseline, column fit, script and direction consistency, and the quantity × unit = line pattern.
- The solver keeps the best few complete interpretations (an N-best list), not just one. That list is what stage F and the uncertainty logic work with.

### F. Validation: arithmetic as evidence, never as an edit

- Check qty × unit = line, Σ lines = subtotal, subtotal + charges ± discount = total, and that a percentage label matches its amount.
- Hypotheses are ranked by **geometry cost and arithmetic together**. A pairing that adds up but crosses rows loses to one that adds up and follows the baselines.
- When two interpretations both add up but assign prices differently, the result is marked **ambiguous** instead of one being picked silently.

### G. Confidence and suggestions

- Each field gets a confidence built from the OCR candidate confidence, the gap between the best and second-best interpretation for that field, and the arithmetic support.
- The UI shows only three states: fine, check this (amber), and two readings disagree (amber plus a one-tap choice). Numbers stay hidden.
- Suggestions are limited to runner-up OCR readings and alternative pairings that the arithmetic supports, as today, but taken from the N-best list.

### Fallback ladder (extra work only when needed)

1. Flattened image, OCR, layout and association. Accept if F says consistent with a clear margin.
2. Otherwise run OCR on the contrast variant, merge the tokens, and redo C to F.
3. Otherwise swap in runner-up OCR readings for low-confidence amounts, re-run F, and offer them as suggestions.
4. Otherwise show the best interpretation with the disagreeing fields marked.

No cloud AI or paid service. An on-device model is not planned; if one is ever proposed, it gets measured for size, memory and speed first.

## 4. Evaluation framework

- `packages/core/eval/receipts/*.json`: the full Vision dump (from the improved share button), optionally the photo, and hand-written ground truth (items, quantities, line totals, subtotal, charges, total).
- **Split, fixed up front**: `dev/` for building, `holdout/` that is only scored and never used to tune a rule. Each new real receipt goes to holdout by default, roughly 1 in 3.
- `npm run eval` reports, per set:
  - item precision and recall, and false items
  - quantity, price and association accuracy (a price on the wrong item counts as wrong even when totals match)
  - subtotal and total accuracy
  - confidence calibration: how often "fine" fields are right, and how often "check" fields are wrong
  - time per receipt
- **Synthetic set**, rewritten so it does not share the parser's assumptions: RTL tables, prices before names, right-aligned names, multi-column summaries, wrapped names, unit plus line columns, interleaved OCR order, perspective and curvature, and duplicate-sum traps (permutations that add up the same). It is reported separately from real receipts and is never used as proof.
- Fix the `/d/` bug in the existing misread test.

**What I cannot do from this PC:** run Apple Vision. Real-world accuracy can only be measured on dumps from your iPhone, and builds take about 16 minutes each plus queue time. The holdout set needs real receipts from you: 30 or more varied ones would make the numbers meaningful.

## 5. Milestones (each committed separately)

1. Swift: export quadrilaterals, word boxes and runner-ups. Full share dump. Fix the test bug. Eval harness, with the current parser as the baseline score. **One build so you can start collecting dumps.**
2. Layout engine (C), with the old pipeline still live.
3. Semantics (D) and association (E) with N-best.
4. Validation, confidence and UI states (F, G). Review screen gets "two readings disagree" and a retake button.
5. Preprocessing and the fallback ladder (A), measured on the phone.
6. Switch the app to the new engine once it beats the old one on holdout. Report results and remaining failure types. Final IPA.
