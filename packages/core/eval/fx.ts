/** Show what the engine read from one fixture next to its answer key: npm run eval:fx -- <id> [--lines] */
import { readFileSync } from 'node:fs';
import { readReceipt, buildLayout } from '../src/engine';
import { toLines, type Fixture } from './fixture';

const f = JSON.parse(readFileSync(`eval/receipts/dev/${process.argv[2]}.json`, 'utf8')) as Fixture;
const lines = toLines(f.input);
if (process.argv.includes('--lines')) for (const l of buildLayout(lines).lines) console.log(l.v.toFixed(3), ' ', l.text);
const r = readReceipt(lines);
const t = f.truth;
console.log('TRUTH', JSON.stringify({ items: t.items.map((i) => [i.name, i.qty, i.lineTotal]), sub: t.subtotal, svc: t.service, tax: t.tax, disc: t.discount, total: t.total }));
console.log('GOT  ', JSON.stringify({ items: r.items.map((i) => [i.description, i.quantity, i.lineTotal]), sub: r.subtotal, svc: r.service, tax: r.tax, disc: r.discounts, total: r.total, uncertain: r.uncertain, notes: r.notes }));
