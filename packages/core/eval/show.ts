/** Print what the engine read from one recognized photo: npm run eval:show -- <dir> <name-prefix> */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readReceipt, buildLayout, type OcrResult } from '../src';

const dir = process.argv[2]!;
const f = readdirSync(dir).find((n) => n.startsWith(process.argv[3]!))!;
const ocr = JSON.parse(readFileSync(join(dir, f), 'utf8')) as OcrResult;
if (process.argv.includes('--lines')) for (const l of buildLayout(ocr.lines).lines) console.log(l.v.toFixed(3), ' ', l.text);
const r = readReceipt(ocr.lines);
console.log(JSON.stringify({ merchant: r.merchant, items: r.items.map((i) => [i.description, i.quantity, i.lineTotal]), sub: r.subtotal, tax: r.tax, svc: r.service, total: r.total, uncertain: r.uncertain, notes: r.notes, unparsed: r.unparsed }, null, 1));
