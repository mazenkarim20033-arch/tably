import { parseAmount, type Minor } from './money';
import type { OcrLine, Receipt, TotalField } from './receipt';
import { reconcile } from './reconcile';
import { setField, setItemLineTotal } from './receiptEdit';

/**
 * A small vision model is a verifier, not a second reader. The scanner stays the primary reader and knows which
 * amounts are in doubt. For each of those it hands the model a picture of just that receipt row plus the values the
 * evidence supports, and asks which one is printed. An answer is only used when it is one of those candidates, and it
 * is only applied when it makes the receipt add up; otherwise it is shown as a suggestion.
 */

/** One doubtful amount: where to crop the photo and what it might be. */
export interface VerifyTarget {
  /** the receipt path in doubt, e.g. "items.i3.lineTotal" or "total" */
  path: string;
  /** values to choose from, current reading first */
  candidates: Minor[];
  /** the row to crop, normalized 0..1 with the origin at the top-left */
  box: { x: number; y: number; w: number; h: number };
}

export const VERIFY_SCHEMA = {
  type: 'object',
  properties: { amount: { type: ['string', 'null'] } },
  required: ['amount'],
} as const;

const plain = (v: Minor) => (v / 100).toFixed(2);

export function verifyPrompt(candidates: Minor[]): string {
  return (
    'This image is one row cut from a printed receipt. Read the amount printed on that row: for an item it is the line ' +
    `total, usually the right-most number. It is probably one of: ${candidates.map(plain).join(', ')}. ` +
    'Return JSON {"amount": "<digits exactly as printed>"}. Copy the digits as you see them. Never calculate, correct ' +
    'or guess. If you cannot read it, return {"amount": null}.'
  );
}

/** The amount in a model's reply, or null when it did not give one. */
export function parseVerifyReply(reply: unknown): Minor | null {
  let obj: unknown = reply;
  if (typeof reply === 'string') {
    const a = reply.indexOf('{');
    const b = reply.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
      obj = JSON.parse(reply.slice(a, b + 1));
    } catch {
      return null;
    }
  }
  const amount = (obj as { amount?: unknown } | null)?.amount;
  return typeof amount === 'string' || typeof amount === 'number' ? parseAmount(String(amount)) : null;
}

const AMOUNT_FIELDS: TotalField[] = ['subtotal', 'tax', 'service', 'tip', 'total'];
const LABELS: Record<TotalField, RegExp> = {
  subtotal: /sub\s*-?\s*total/i, tax: /tax|vat/i, service: /service|srv/i, tip: /tip|gratuity/i, total: /total|amount due|balance/i,
};

/** Every amount a recognized line shows, counting the recognizer's runner-up readings. */
function amountsIn(line: OcrLine): Set<Minor> {
  const out = new Set<Minor>();
  for (const text of [line.text, ...(line.alternates ?? [])]) {
    for (const m of text.match(/\d[\d.,]*\d|\d/g) ?? []) {
      const v = parseAmount(m);
      if (v !== null) out.add(v);
    }
  }
  return out;
}

const words = (s: string) => s.toLowerCase().match(/[a-z؀-ۿ]{3,}/g) ?? [];

const ITEM_TOTAL = /^items\.([^.]+)\.lineTotal$/;

/**
 * The doubtful amounts to verify (at most `max`, those with the most rival values first), each with the row of the
 * photo it was read from. A doubtful amount whose row cannot be found is left out.
 */
export function verifyTargets(receipt: Receipt, ocr: OcrLine[], max = 6): VerifyTarget[] {
  interface Want { path: string; current: Minor | null; candidates: Minor[]; hint: string; label?: RegExp }
  const wants: Want[] = [];
  for (const i of receipt.items) {
    const path = `items.${i.id}.lineTotal`;
    const rivals = [...(i.choices ?? []), ...(i.suggestedLineTotal !== undefined ? [i.suggestedLineTotal] : []), ...(i.altLineTotals ?? [])];
    if (!receipt.uncertain.includes(path) && rivals.length === 0) continue;
    wants.push({ path, current: i.lineTotal, candidates: [...new Set([...(i.lineTotal !== null ? [i.lineTotal] : []), ...rivals])], hint: i.description });
  }
  for (const f of AMOUNT_FIELDS) {
    const cur = receipt[f];
    const rivals = receipt.fieldChoices?.[f] ?? [];
    if (!receipt.uncertain.includes(f) && rivals.length === 0) continue;
    wants.push({ path: f, current: cur, candidates: [...new Set([...(cur !== null ? [cur] : []), ...rivals])], hint: '', label: LABELS[f] });
  }
  wants.sort((a, b) => b.candidates.length - a.candidates.length);

  const taken = new Set<number>();
  const out: VerifyTarget[] = [];
  for (const w of wants) {
    if (out.length >= max || w.candidates.length === 0) continue;
    const hint = new Set(words(w.hint));
    let best = -1;
    let bestScore = 0;
    ocr.forEach((line, n) => {
      if (taken.has(n)) return;
      const seen = amountsIn(line);
      if (!w.candidates.some((v) => seen.has(v))) return;
      const score = 1 + (w.current !== null && seen.has(w.current) ? 1 : 0) + words(line.text).filter((t) => hint.has(t)).length * 2 + (w.label?.test(line.text) ? 3 : 0);
      if (score > bestScore) { best = n; bestScore = score; }
    });
    if (best < 0) continue;
    taken.add(best);
    const l = ocr[best]!;
    const y = Math.max(0, l.y - l.h * 0.4);
    out.push({ path: w.path, candidates: w.candidates, box: { x: 0, y, w: 1, h: Math.min(1 - y, l.h * 1.8) } });
  }
  return out;
}

export interface Verified {
  receipt: Receipt;
  /** the model's answers were used because they make the receipt add up */
  applied: boolean;
  /** the receipt differs from the one passed in (corrections applied, or suggestions attached) */
  changed: boolean;
}

function withValue(r: Receipt, path: string, value: Minor): Receipt {
  const m = ITEM_TOTAL.exec(path);
  return m ? setItemLineTotal(r, m[1]!, value) : setField(r, path as TotalField, value);
}

function subsets<T>(xs: T[]): T[][] {
  const all: T[][] = [];
  for (let mask = 1; mask < 1 << xs.length; mask++) all.push(xs.filter((_, k) => mask & (1 << k)));
  return all.sort((a, b) => a.length - b.length);
}

/**
 * Use the model's answers (`path` to amount read, null when unreadable). Answers that are not among the candidates are
 * ignored. If the receipt does not add up now, the smallest set of answers that makes it add up is applied, provided
 * exactly one such set exists. Otherwise the answers are attached as suggestions and nothing is changed.
 */
export function applyAnswers(receipt: Receipt, targets: VerifyTarget[], answers: Record<string, Minor | null>): Verified {
  const current = (path: string): Minor | null => {
    const m = ITEM_TOTAL.exec(path);
    return m ? receipt.items.find((i) => i.id === m[1])?.lineTotal ?? null : receipt[path as TotalField];
  };
  const changes = targets.flatMap((t) => {
    const v = answers[t.path];
    return v !== null && v !== undefined && t.candidates.includes(v) && v !== current(t.path) ? [{ path: t.path, value: v }] : [];
  });
  if (changes.length === 0) return { receipt, applied: false, changed: false };

  if (reconcile(receipt).status !== 'ok') {
    const fits: typeof changes[] = [];
    for (const set of subsets(changes)) {
      if (fits.length > 0 && set.length > fits[0]!.length) break;
      const next = set.reduce((r, c) => withValue(r, c.path, c.value), receipt);
      if (reconcile(next).status === 'ok') fits.push(set);
    }
    if (fits.length === 1) {
      const set = fits[0]!;
      const next = set.reduce((r, c) => withValue(r, c.path, c.value), receipt);
      const notes = [...next.notes, `The AI read ${set.map((c) => plain(c.value)).join(', ')} from the photo, which makes the items add up.`];
      return { receipt: { ...next, notes }, applied: true, changed: true };
    }
  }

  // Not proven: show what the model read as a one-tap choice and leave the receipt as it is.
  const reasons = { ...(receipt.reasons ?? {}) };
  const uncertain = [...receipt.uncertain];
  const fieldChoices = { ...(receipt.fieldChoices ?? {}) };
  let items = receipt.items;
  for (const c of changes) {
    reasons[c.path] = `The AI read ${plain(c.value)} from the photo. Check it against the receipt.`;
    if (!uncertain.includes(c.path)) uncertain.push(c.path);
    const m = ITEM_TOTAL.exec(c.path);
    if (m) items = items.map((i) => (i.id === m[1] ? { ...i, choices: [...new Set([c.value, ...(i.choices ?? [])])] } : i));
    else fieldChoices[c.path as TotalField] = [...new Set([c.value, ...(fieldChoices[c.path as TotalField] ?? [])])];
  }
  return { receipt: { ...receipt, items, reasons, uncertain, fieldChoices }, applied: false, changed: true };
}
