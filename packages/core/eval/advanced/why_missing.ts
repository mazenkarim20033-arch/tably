/**
 * For receipts where the engine found no total: was the true total readable in the recognized text at all?
 * Separates "the reader never saw it" (not fixable by the engine) from "the engine had it and did not pick it".
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAmount, readReceipt, type OcrResult } from '../../src';

interface Label { id: string; total: number | null }
const dir = process.argv[2]!;
const labels = new Map((JSON.parse(readFileSync(process.argv[3]!, 'utf8')) as Label[]).map((l) => [l.id, l]));
let missing = 0;
let seen = 0;
const engineMiss: string[] = [];
for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
  const id = f.replace(/\.json$/, '');
  const lab = labels.get(id);
  if (!lab || lab.total === null) continue;
  const ocr = JSON.parse(readFileSync(join(dir, f), 'utf8')) as OcrResult;
  if (readReceipt(ocr.lines).total !== null) continue;
  missing++;
  const present = ocr.lines.some((l) => l.text.split(/\s+/).some((w) => parseAmount(w) === lab.total));
  if (present) {
    seen++;
    engineMiss.push(`${id.slice(0, 8)} total ${lab.total / 100}: ${ocr.lines.filter((l) => l.text.split(/\s+/).some((w) => parseAmount(w) === lab.total)).map((l) => JSON.stringify(l.text)).join(' | ')}`);
  }
}
console.log(`${missing} receipts with no total found; the true total was present in the text for ${seen} of them (the engine had it and missed it)`);
console.log(engineMiss.slice(0, 14).join('\n'));
