/**
 * Run the engine over real receipt photos that were recognized elsewhere (see eval/README.md): npm run eval:real -- <dir> [name]
 * There are no answer keys, so the receipt's own arithmetic is the check: a reading whose items and charges add up to the
 * printed total is very likely right; the others are listed with why, to be looked at by eye.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readReceipt, reconcile, type OcrResult } from '../src';

const dir = process.argv[2]!;
const only = process.argv[3];
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
}
console.log('\n', JSON.stringify(tally));
console.log('not ok:', bad.map((b) => b.slice(0, 8)).join(' '));
