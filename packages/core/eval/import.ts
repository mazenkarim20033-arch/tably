/**
 * Turn a pasted "Share what the scanner read" text into an evaluation fixture:
 *   npm run eval:import -- <file with the pasted text> <id> [dev|holdout]
 * New receipts go to holdout unless told otherwise. The answer key is pre-filled from the current engine's reading
 * and marked unreviewed: a person must check every item, quantity and amount against the photo, fix what is wrong,
 * and set "reviewed": true. Until then the receipt is not scored.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeOcrDump } from '../src/ocrDump';
import { parseReceipt } from '../src/parseReceipt';
import type { Fixture } from './fixture';

const [file, id, split = 'holdout'] = process.argv.slice(2);
if (!file || !id || (split !== 'dev' && split !== 'holdout')) {
  console.error('usage: npm run eval:import -- <dump file> <id> [dev|holdout]');
  process.exit(1);
}
const text = readFileSync(file, 'utf8').trim();
const ocr = decodeOcrDump(text);
const rc = parseReceipt(ocr.lines);
const fx: Fixture = {
  id,
  source: 'vision-dump',
  split,
  description: 'Imported from the app. Check the answer key against the photo.',
  reviewed: false,
  tags: [],
  input: { kind: 'dump', dump: JSON.parse(text) },
  truth: {
    items: rc.items.map((i) => ({ name: i.description, qty: i.quantity, lineTotal: i.lineTotal ?? 0 })),
    subtotal: rc.subtotal, tax: rc.tax, service: rc.service, tip: rc.tip, discount: rc.discounts || null, total: rc.total,
  },
};
const dir = join(dirname(fileURLToPath(import.meta.url)), 'receipts', split);
mkdirSync(dir, { recursive: true });
const out = join(dir, `${id}.json`);
if (existsSync(out)) {
  console.error(`${out} exists already.`);
  process.exit(1);
}
writeFileSync(out, JSON.stringify(fx, null, 2) + '\n');
console.log(`Wrote ${out}. Review the answer key, then set "reviewed": true.`);
