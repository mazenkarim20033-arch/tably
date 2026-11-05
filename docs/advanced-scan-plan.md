# Advanced Scan: assessment, strategy and roadmap

Status: **plan only. Nothing in the app was changed to write this.** Facts below are marked *verified* (checked in this
repository or by running something), *sourced* (read from a page, not independently confirmed) or *estimate* (my judgment).

## 0. The question and the honest starting point

Can a small specialist model make Tably's amounts more accurate than OCR plus arithmetic alone, without slowing normal
scanning or adding running costs?

What we already know from the work so far:

- *Verified*: the engine reads all 11 hand-transcribed real Egyptian receipt layouts exactly when given clean text,
  and 4 earlier real receipts. Synthetic held-out exact-match is 80-93% by layout family.
- *Verified*: on 40 real Egyptian photos run through a much noisier open-source reader (EasyOCR), only 8 add up. We have
  **no measurement yet with Apple Vision on Egyptian receipts**, which is what the app really uses. Every accuracy claim for
  the real app is therefore unmeasured. This is the single biggest gap, and it decides whether a model is needed at all.
- *Verified*: a general small vision model (SmolVLM-256M), asked "which of these amounts is on this row?", **copied whichever
  candidate it was shown** instead of reading (3-row smoke test and 35 of 120 planned calls; partial, not a benchmark).
  A specialist must be trained to refuse, not to guess. This shapes the whole design below.
- *Verified*: the first working version of the verifier (crop uncertain rows, send candidates, accept only answers that make
  the arithmetic work) exists and runs against Cloudflare Workers AI. **It is currently switched ON with test limits
  (10 reads/day shared, 20/month per install). I have not changed it and will not without your approval.**

## 1. Technical assessment of the current architecture

Monorepo (npm workspaces). Normal scanning is the path to protect.

| Layer | What it is | Relevant to Advanced Scan |
| --- | --- | --- |
| `apps/mobile/modules/tably-vision` | Swift module, Apple Vision OCR. Returns lines with quads, word boxes, runner-up readings and per-alternative confidences | The OCR candidates the verifier needs already exist (`alternates`, `alternateConfidences`). |
| `packages/core/src/engine/*` | layout (`buildLayout`) then reading (`readLayout`): header-driven columns, quantity x price arithmetic, label roles, alternative readings scored by arithmetic | Produces `uncertain`, `reasons`, `choices`, `fieldChoices`: exactly the "which fields are doubtful, and what could they be" signal. |
| `packages/core/src/arithmetic.ts` | `settleArithmetic`: chain checks, one-misread-digit suggestions, stray-row rules, rounding tolerance | The deterministic validator the brief asks for. Already shared by both readers. |
| `packages/core/src/verify.ts` | `verifyTargets` (which rows, which candidates, crop box), `applyAnswers` (accept only candidates, only if they make the receipt add up, else suggestion) | The seed of Advanced Scan. Reusable as is. |
| `apps/mobile/src/lib/aiRead.ts` | install id, monthly allowance, cropping rows with `expo-image-manipulator`, calls `/api/scan` | Becomes the *backend interface*: cloud today, on-device later. |
| `apps/worker/src/scan.ts` | Optional Workers AI endpoint, off-by-default switch, per-install/network/month/day limits | Stays as an optional fallback. No change needed. |
| `apps/mobile/src/app/scan.tsx`, `review.tsx` | Photo capture and the review screen, with the "Check with AI" card and Undo | Where the mode choice and the confirmation UI live. |
| `packages/core/eval/*` | Synthetic generator (9 layout families), hand-transcribed real fixtures, `eval:real`, `eval:fx` | Evaluation harness to extend; must keep real and synthetic apart. |

Reusable as is: OCR output format, uncertainty marking, arithmetic gates, row cropping, backend limits, Undo flow.
Missing: a calibrated confidence from any model, a "reject" answer, an on-device inference path, a labeled Egyptian set.

Conflicts and limits:

- **Normal scan must stay untouched.** Advanced Scan runs *after* the same OCR + engine pass, so the normal path is
  literally a prefix of the advanced one. No change to `recognizeText`, `readReceipt` or `settleArithmetic` is needed.
- **Free Apple ID sideloading** (7-day expiry, limited capabilities). Whether the *increased-memory-limit entitlement* works
  with it is unconfirmed (*sourced*: AltStore supports it; Sideloadly unknown). Test before relying on it.
- **Builds run only in GitHub Actions** (no Mac here). Any native module is a 15-20 minute compile cycle I cannot debug locally.
- **IPA size**: a bundled model adds directly to the install. Model download on first use avoids that but needs internet once.
- **The brief requires fully local inference.** Today's verifier needs the network. That is acceptable only as a temporary route.

## 2. Datasets: availability, licences, annotations, suitability

| Dataset | Size | Licence | Annotations | Suitability for *verification* |
| --- | --- | --- | --- | --- |
| **CORD v2** (clovaai/cord, HF `naver-clova-ix/cord-v2`) | 1,000 (800/100/100) | CC BY 4.0 (*verified*, repo and HF card) | Word `text` + `quad`, `row_id`, `category` (menu name/price/qty, subtotal, tax, total), `group_id`; some store/payment fields removed for Indonesian legal reasons | **Best fit for fields**: item prices, qty, subtotal, tax, total with positions. Indonesian shops, small images, no Arabic, no EGP. |
| **SROIE** (ICDAR 2019; community mirror `zzzDavid/ICDAR-2019-SROIE`) | 1,000 (600 train/val + 400 test) | Repo is MIT, but that covers the *team's code*. Official data terms **not verified**: check the competition download page before use | Line boxes + text (tasks 1-2); task 3 JSON has only company, address, date, **total** | Good for totals and dates and for OCR-error mining. **No item prices, subtotal or tax**. The source notes known label mistakes. |
| **Humans in the Loop receipt set** | 192 images | CC0 (*sourced*) | Bounding boxes with a class each (business name, address, phone, ...) | **Not suitable**: segmentation classes, no verified amounts. Skip. |
| **CORU / ReceiptSense** (HF `abdoelsayed/CORU`) | 20k key-info images, 30k OCR images, 10k item rows, 1,265 QA receipts | MIT (*verified*, HF card) | Boxes with 5 classes (merchant, date, total, no, item); OCR split with character/word text (*sourced*, not inspected); item CSV; QA pairs (3.9 GB zip, not downloaded) | **The key Egyptian candidate**: Arabic/English, Egyptian shops, EGP (*verified* by viewing 40 photos). Needs inspection of the OCR and QA splits to confirm ground-truth amounts. |

Gaps no public set fills: Arabic-Indic digits with comma decimals together with ground-truth totals, EGP service-charge/VAT
formats, and Apple-Vision-style OCR errors. **A labeled Egyptian set must be built.** I hand-read 11 photos in two sessions;
that is too few. The estimate is **300-500 labeled real receipts** for evaluation alone (see section 6).

Privacy rule for real data: only public datasets and your own receipts that **you** choose to share are used; nothing real
goes to an external service without your explicit permission.

## 3. What the model should actually do

Not "read the receipt". A **verifier with a reject option**:

1. Input: a crop of one row (or a small window), the OCR text of that row, the OCR runner-ups, and the candidate values.
2. Output: a choice among {candidate 1..k, **none of these / cannot tell**} plus a probability, never a free number.
3. The arithmetic validator and the user decide. A correction is applied silently only when it is *proven* by the receipt's
   own sums; anything else is a one-tap suggestion.

Why classification instead of generation: our own test showed free generation copies hints. Scoring candidates by likelihood
(or a classification head) cannot invent a digit, and "none" can be trained directly. Training must include **wrong-hint
examples whose right answer is "reject"** and rows where the OCR was already right (to keep false corrections near zero).

## 4. The four approaches compared

| | Direct weight editing | LoRA fine-tuning | Distillation | Custom digit recognizer |
| --- | --- | --- | --- | --- |
| Idea | A stronger model edits a small model's weights, no gradients | Train low-rank adapters on a pretrained model | Student learns from a stronger teacher's labels | Train a tiny model on cropped numbers |
| Evidence | **Weak**: one early blog post, reported by secondary sources only (VentureBeat etc.); the reported gain is on a math model that looped, not on vision; I could not read the primary text | **Good**: several public Qwen2-VL/SmolVLM receipt adapters exist (scores not read); standard method | Standard; here the teacher is mostly *our labels*, not a large model | Standard OCR recognition; very well understood |
| Receipt/digit accuracy | Unknown, likely poor for perception | Plausible gain over base; unproven vs OCR | Same as the student's ceiling | Likely the best accuracy per megabyte on digits; weak on context |
| Training cost | Needs a frontier API (paid) | Free Colab T4 (~15 GB, *sourced*); 256M-500M fits (*estimate*) | Free if teacher = labels; paid if a frontier model labels data | Free Colab or the laptop |
| Model size | = base (0.25-2 B params) | base + adapter (tens of MB, *estimate*) | = student | **~1-15 MB** (PP-OCR mobile recognizers are 10-16 MB, *sourced*; a digits-only model can be far smaller, *estimate*) |
| iPhone 15 (6 GB) | same as base | base 4-bit ~0.2-1.8 GB (*estimate*); MLX-Swift adapter loading for VLMs not confirmed | same as student | **Core ML, milliseconds, trivial RAM** (*estimate*, test it) |
| Offline | yes after download | yes | yes | **yes, can ship inside the app** |
| Uses OCR text as context | n/a | yes, in the prompt | yes | not by itself (pixels only); combine with the engine |
| Risk | Unverified method; cost; may be a dead end | Native integration unproven in our build setup; Core ML/ANE graph limits (*sourced*) | Little added value over LoRA here | Cannot judge context ("is this the total?"), only read digits |

Recommendations (all **free**, in this order):

1. **Custom digit recognizer first.** It is the one approach with a realistic path to beating a general model on a narrow
   task, it is tiny, offline, deployable without the native-VLM risk, and measurable within days.
2. **LoRA on a small model second**, only if the recognizer plus the existing engine leaves a measurable gap that needs
   *context* (which row is the total, discount sign, VAT inclusive?). Candidates: SmolVLM-256M/500M, Florence-2-base (230M,
   community Core ML conversion reports ~1.2 GB peak RAM and iOS 17+, *sourced*), Qwen2-VL-2B. Check each licence first.
3. **Distillation** is folded into LoRA training data (labels from CORD/CORU/our transcriptions); a frontier teacher is
   optional and costs money, so **not without your approval**.
4. **Weight editing**: keep as a clearly-labeled optional experiment *after* a baseline exists, and only if the method is
   confirmed by its primary source and a free path is found. It must not block the roadmap.

## 5. Candidate models and what must be measured on the phone

Nothing below counts as suitable until measured on an iPhone 15: peak memory, load time, latency per crop, thermal behavior.

| Model | Params / size | Notes |
| --- | --- | --- |
| Digit recognizer (new, CRNN/SVTR-tiny) | ~1-15 MB | Core ML; train on CORU OCR crops + synthetic digit renderings (Western and Arabic-Indic, both decimal marks). |
| SmolVLM-256M / 500M | small (<1 GB, *estimate*) | Weak zero-shot on receipts, tends to copy hints; needs fine-tuning. |
| Florence-2-base | 230M | Existing Core ML conversions; vision encoder runs on GPU, not the Neural Engine (*sourced*). |
| Qwen2-VL-2B (4-bit) | ~1.2-1.8 GB | Strongest small candidate; heaviest; free-Apple-ID memory limit unconfirmed. |
| PP-OCR mobile recognizer | 10-16 MB | Reference point and possible fine-tuning base for the digit task. |

## 6. Evaluation methodology

Splits (never mixed):

- **Train**: public data (CORD, CORU subsets), synthetic receipts, mined real OCR errors.
- **Validation**: held-out stores/layouts from the same sources, used for tuning thresholds.
- **Test (frozen, never trained on)**: **Egyptian real receipts only**, split **by shop** so a layout seen in training never
  appears in test. Synthetic data is **excluded from test by rule**.

Comparison arms, all on the same test set: (A) OCR alone, (B) OCR + deterministic validation (today's engine),
(C) B + the specialist, (D) B + cloud model, (E-H) each experimental model.

Metrics (per field type: total, subtotal, tax/VAT, discount, item price, quantity, date):

- **Exact field accuracy** and **numerical accuracy** (value within 0.01) after each arm.
- **Error correction rate** = wrong-OCR fields that become right / wrong-OCR fields.
- **False correction rate** = right-OCR fields changed to wrong / right-OCR fields. **This is the headline safety metric.**
- **Reject rate** and calibration (expected calibration error, reliability curve): when the model says 90%, is it right 90%?
- **Silent-wrong rate** of the whole pipeline (wrong with no warning), as in the current eval.
- **Latency, model size, peak memory** measured on the iPhone 15, not on a laptop.

Sample size (*estimate*): if ~10-15% of receipts contain an OCR error, 400 test receipts give only ~40-60 error cases. Differences
of a few points are not detectable with fewer. Plan for **at least 400-500 labeled Egyptian test receipts**, and report
confidence intervals, not single numbers.

Synthetic OCR errors (digit confusions, dropped decimal points, comma/dot swaps, merged or missing cells, Arabic-Indic mix)
are used to train and to stress-test, **never to claim real-world accuracy**. Real OCR errors are mined by running OCR
(EasyOCR locally; Apple Vision via your phone) over CORD/CORU images and diffing against labels.

## 7. Roadmap (each stage ends in a go / no-go gate)

| Stage | Work | Cost | Gate to continue |
| --- | --- | --- | --- |
| 0. Truth | Get Apple Vision dumps of 50+ of your own Egyptian receipts; hand-label 100+ more from CORU. Inspect CORU OCR and QA splits for usable amounts | $0 | A frozen, shop-split test set exists. |
| 1. Baseline | Score A and B on it with Apple Vision text. Mine real OCR errors. Categorize failures | $0 | **If OCR + validation is already ~95%+ exact with <2% silent-wrong, stop: no model needed.** |
| 2. Digit recognizer | Train a tiny recognizer on synthetic + CORU crops; Core ML export; test on phone | $0 (Colab free/laptop) | Beats the baseline on amount fields with false-correction <1%, on-phone latency <100 ms. |
| 3. Context model (LoRA) | Fine-tune a small VLM as a candidate-chooser with reject. Colab free T4 | $0 | Beats stage 2 where context matters; proven rejection of wrong hints; fits phone memory/latency. |
| 4. Optional experiments | Distillation with a stronger teacher; weight editing | **Ask first** | Only if stages 2-3 leave a clear gap and you approve the cost. |
| 5. Phone feasibility | Native module spike (Core ML first, MLX-Swift only if needed); memory/latency on iPhone 15 | $0 | Peak RAM and speed within budget, no crashes. |
| 6. Advanced Scan | Mode choice, suggestion banner, confirm UI, backend interface, Arabic strings | $0 | Normal scan latency unchanged; held-out numbers hold on-device. |

## 8. Advanced Scan product behavior (target)

- **Normal Scan**: unchanged. No model, no crops, no network.
- **Advanced Scan**: the same OCR + engine pass, then `verifyTargets` picks doubtful fields, crops only those rows, the model
  proposes among candidates with a confidence, `applyAnswers`-style validation proves or demotes each answer, and anything
  unproven is shown as a one-tap choice. Silent changes are limited to arithmetic-proven fixes, with a note and Undo.
- The review screen **suggests** Advanced Scan when the engine reports real uncertainty (mismatch, flagged amounts). It is
  never run on every receipt.

## 9. Files and components that would eventually change

- `packages/core/src/verify.ts` (confidence, reject, per-field types), `packages/core/src/engine/read.ts` (export a ranked
  uncertainty list), new `packages/core/src/advanced/` (policy: when to suggest, thresholds), tests and `docs/vision.md`.
- `apps/mobile/src/app/scan.tsx` (mode choice), `apps/mobile/src/app/review.tsx` (suggestion banner, confirm UI, Undo),
  `apps/mobile/src/lib/aiRead.ts` (backend interface: on-device first, cloud optional), `apps/mobile/src/lib/draftStore.ts`
  (mode and results), `apps/mobile/src/lib/i18n.ts` (Arabic strings).
- New native module `apps/mobile/modules/tably-verifier` (Core ML), the CI script `scripts/ci-ios-build.sh` and
  `.github/workflows/ios-unsigned.yml` (model assets), `apps/mobile/app.json` (entitlements/size).
- `apps/worker/src/scan.ts`: **no change required** (kept as an optional fallback).
- `packages/core/eval/*`: new test set loader, metrics (false-correction, calibration), arm comparison, kept separate from synthetic.
- Not touched: `tably-vision` OCR module, `recognizeText`, `readReceipt`, `settleArithmetic`, payments, share flow.

## 10. Deployment risks

- **Memory on a 6 GB iPhone with a free Apple ID** (per-app cap unconfirmed; entitlement support unconfirmed).
- **Neural Engine graph limits**: some conversions fall back to the GPU (*sourced*); latency must be measured.
- **Native build iteration is slow** (GitHub Actions only); an MLX-Swift route also hit an unresolved macro-plugin question.
- **Small labeled Egyptian set** is the main accuracy risk: results can look good on public data and fail on local receipts.
- **Overfitting to layouts**: mitigated by shop-level splits and a frozen test set.
- **Privacy and licensing**: confirm SROIE's official terms and each model's licence before use; never upload real receipts
  without your permission.
- **Over-correction**: a model that "fixes" right amounts is worse than none; the false-correction gate is non-negotiable.

## 11. Costs and approvals

Everything proposed runs on this laptop and the free Colab tier ($0). **Needs your approval before anything is spent or changed:**
GPU rental beyond free Colab, any frontier-model API (weight-editing or distillation labeling), a paid Apple developer account,
raising any Cloudflare limit (it is currently on with test limits; I can switch it off if you prefer), uploading any real receipt.

## 12. First actions proposed (no app changes)

1. You send Apple Vision dumps ("Share what the scanner read") of 50+ Egyptian receipts, photos optional.
2. I inspect the CORU OCR/QA splits, finish the labeled set, and build the held-out evaluation harness with the metrics above.
3. Baseline numbers for arms A and B on real Apple Vision output. **Decide at that gate whether a model is needed.**

## 13. Stage 0 findings (started)

Inspected without downloading images in bulk (range reads of the zip indexes and a few files):

- **CORU OCR split** (`OCR/*.zip`): text-line crops with transcriptions, grouped by kind: `_line_N` (about 3,996 in the test split),
  `_date` (146), `_total` (130), `_no` (107), `_merchant` (77). The `_total` crops are real Egyptian total rows with the text as
  a word list, for example `["Total", "49.00", ".ج.م"]` or `["516.24", "اﻹجمالى"]`. **This is real, labeled training data
  for the digit recognizer and the total verifier**, in both languages. The train split is much larger (not yet counted).
- **CORU QA split** (`QA/test.zip`, 1,265 receipts, 3.9 GB with images): per receipt about 40 question/answer pairs that include
  the total, subtotal, VAT, discount, date and many item prices. Checked one receipt against its photo (LC Waikiki): the item
  prices, total without VAT and total all matched exactly. **A usable source of labeled Egyptian receipts**, with caveats:
  - Questions vary per receipt, so labels need careful parsing (`eval/advanced/build_labels.py`).
  - On the first 295 label files: 142 are Egyptian (EGP/LE), **54 are US receipts** ($), 95 have several "total" answers that
    disagree (some are legitimate, such as "amount due" after a payment, some are label noise), and only about 58% of receipts
    with a total and subtotal add up (subtotal + VAT - discount = total, within 0.05; service charge, delivery fees and
    included VAT explain many of the rest).
  - So only a **filtered subset (estimate: a few hundred receipts)** is clean enough for a frozen test set, after a visual
    spot-check. All 1,265 label files are being fetched (about 20 minutes); the photos are not downloaded yet.
- **No Apple Vision text exists for any of these photos.** They can be run through EasyOCR here (a noisier reader), but Apple
  Vision output needs the iPhone. The decisive baseline therefore needs **your own receipts scanned in the app**.

Harness started (no app changes): `packages/core/eval/advanced/metrics.ts` (exact accuracy, correction and false-correction
rates, decline rate, calibration error, Wilson intervals, shop-split check) with tests, and `build_labels.py`.
