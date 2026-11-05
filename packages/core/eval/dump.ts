import { readFileSync } from 'node:fs';
import { decodeOcrDump, readReceipt, reconcile } from '../src';
const d = decodeOcrDump(readFileSync(process.argv[2]!, 'utf8'));
const r = readReceipt(d.lines);
console.log(JSON.stringify({ merchant: r.merchant, date: r.date, cur: r.currency, items: r.items.map((i) => [i.description, i.quantity, i.lineTotal, i.flags]), sub: r.subtotal, tax: r.tax, svc: r.service, tip: r.tip, total: r.total, uncertain: r.uncertain, reasons: r.reasons, notes: r.notes, unparsed: r.unparsed, rec: reconcile(r).status }, null, 1));
