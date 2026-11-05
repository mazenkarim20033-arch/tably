/**
 * Run the engine over real receipt photos that were recognized elsewhere (see eval/README.md): npm run eval:real -- <dir> [name]
 * There are no answer keys, so the receipt's own arithmetic is the check: a reading whose items and charges add up to the
 * printed total is very likely right; the others are listed with why, to be looked at by eye.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readReceipt, reconcile, type OcrResult } from '../src';

const dir = process.argv[2]!;
const truthFile = process.argv[3] && process.argv[3].endsWith('.json') ? process.argv[3] : undefined;
const only = truthFile ? undefined : process.argv[3];
interface Truth { total: number; items: number[]; tax?: number; service?: number; discounts?: number }
const truth: Record<string, Truth> = truthFile ? JSON.parse(readFileSync(truthFile, 'utf8')) : {};
const key = (f: string) => Object.keys(truth).find((k) => !k.startsWith('_') && f.startsWith(k));
const graded = { n: 0, total: 0, itemsExact: 0, recall: 0, falseItems: 0, trueItems: 0 };
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && (!only || f.includes(only))).sort();
const tally = { total: 0, ok: 0, mismatch: 0, incomplete: 0, noItems: 0, noTotal: 0 };
const bad: string[] = [];
for (const f of files) {
  const ocr = JSON.parse(readFileSync(join(dir, f), 'utf8')) as OcrResult;
  const r = readReceipt(ocr.lines);
  const rec = reconcile(r);
  tally.total++;
  tally[rec.status]++;
  if (r.items.length === 0) tally.noItems++;
  if (r.total === null) tally.noTotal++;
  const line = `${f.slice(0, 8)} ${rec.status.padEnd(10)} items=${String(r.items.length).padStart(2)} sum=${(rec.itemsSum / 100).toFixed(2).padStart(9)} total=${r.total === null ? '    -    ' : (r.total / 100).toFixed(2).padStart(9)} tax=${r.tax ?? '-'} svc=${r.service ?? '-'} flags=${r.uncertain.length} ${r.merchant ?? ''}`;
  console.log(line);
  if (rec.status !== 'ok') bad.push(f);
  const k = key(f);
  if (k) {
    const t = truth[k]!;
    const got = r.items.map((i) => i.lineTotal ?? -1).sort((a, b) => a - b);
    const want = [...t.items].sort((a, b) => a - b);
    const pool = [...got];
    let hit = 0;
    for (const w of want) { const at = pool.indexOf(w); if (at >= 0) { hit++; pool.splice(at, 1); } }
    graded.n++;
    graded.trueItems += want.length;
    graded.recall += hit;
    graded.falseItems += got.length - hit;
    if (r.total === t.total) graded.total++;
    if (got.length === want.length && hit === want.length) graded.itemsExact++;
    console.log(`   truth: total ${t.total / 100} got ${r.total === null ? '-' : r.total / 100} ${r.total === t.total ? 'OK ' : 'BAD'} | items ${hit}/${want.length} +${got.length - hit} false`);
  }
}
console.log('\n', JSON.stringify(tally));
if (graded.n) console.log(' graded', JSON.stringify(graded), `total ${(100 * graded.total / graded.n).toFixed(0)}%  items-exact ${(100 * graded.itemsExact / graded.n).toFixed(0)}%  item-recall ${(100 * graded.recall / graded.trueItems).toFixed(0)}%`);
console.log('not ok:', bad.map((b) => b.slice(0, 8)).join(' '));
