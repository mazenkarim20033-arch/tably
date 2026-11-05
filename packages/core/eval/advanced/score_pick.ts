/**
 * Score the engine on receipts read elsewhere (OcrResult json per receipt) against labels built from the CORU QA files.
 * Usage: npm run eval:pick -- <folder of ocr json named <id>.json> <labels.json> [json output]
 *
 * Only fields with a trusted label are scored: the total (every answer agreed) and the subtotal when labeled.
 * "Silent wrong" = the engine gave a value that is wrong and did not mark the field for a check.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readReceipt, reconcile, type OcrResult } from '../../src';
import { declineRate, exactAccuracy, wilson, type Outcome } from './metrics';

interface Label { id: string; shop: string; total: number | null; subtotal: number | null; vat: number | null }

const dir = process.argv[2]!;
const labels = JSON.parse(readFileSync(process.argv[3]!, 'utf8')) as Label[];
const byId = new Map(labels.map((l) => [l.id, l]));
const outcomes: Outcome[] = [];
const silent: string[] = [];
let scored = 0;
let adds = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
  const id = f.replace(/\.json$/, '');
  const lab = byId.get(id);
  if (!lab) continue;
  const r = readReceipt((JSON.parse(readFileSync(join(dir, f), 'utf8')) as OcrResult).lines);
  scored++;
  if (reconcile(r).status === 'ok') adds++;
  const add = (field: 'total' | 'subtotal', truth: number | null, got: number | null) => {
    if (truth === null) return;
    outcomes.push({ receiptId: id, shop: lab.shop || id, field, truth, arms: { engine: { value: got } } });
    const flagged = r.uncertain.includes(field) || reconcile(r).status !== 'ok';
    if (got !== null && got !== truth && !flagged) silent.push(`${id.slice(0, 8)} ${field} read ${got / 100} truth ${truth / 100}`);
  };
  add('total', lab.total, r.total);
  add('subtotal', lab.subtotal, r.subtotal);
}
const fmt = (x: number) => (Number.isNaN(x) ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const summary: Record<string, unknown> = { receipts: scored, addUp: `${adds}/${scored}` };
for (const field of ['total', 'subtotal'] as const) {
  const rows = outcomes.filter((o) => o.field === field);
  const right = rows.filter((o) => o.arms.engine!.value === o.truth).length;
  const [lo, hi] = wilson(right, rows.length);
  summary[field] = { n: rows.length, exact: fmt(exactAccuracy(rows, 'engine')), ci95: `${fmt(lo)} to ${fmt(hi)}`, notFound: fmt(declineRate(rows, 'engine')) };
}
summary.silentWrong = silent.length;
console.log(JSON.stringify(summary, null, 1));
if (silent.length) console.log(silent.slice(0, 12).join('\n'));
if (process.argv[4]) writeFileSync(process.argv[4], JSON.stringify({ summary, silent }, null, 1));
