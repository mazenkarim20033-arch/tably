/**
 * Receipt reading evaluation. `npm run eval` (in packages/core) scores the current engine on every fixture and on
 * the synthetic holdout set, prints a report and writes eval/report.json. `npm run eval -- --save-baseline` also
 * stores the result as eval/baseline.json, which later runs are compared with.
 *
 * Sets are reported separately and never averaged together: real dev receipts (used while building), real holdout
 * receipts (never used to tune a rule), and synthetic holdout receipts (useful, but not proof of real accuracy).
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReceipt } from '../src/parseReceipt';
import { toLines, type Fixture } from './fixture';
import { score, summarize, type Score } from './metrics';
import { syntheticSet } from './synthetic';

const here = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC = 400;

function loadFixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const split of ['dev', 'holdout'] as const) {
    const dir = join(here, 'receipts', split);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      const fx = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture;
      if (fx.split !== split) throw new Error(`${f} says split "${fx.split}" but lives in ${split}/`);
      out.push(fx);
    }
  }
  return out;
}

interface Result { fx: Fixture; s: Score; ms: number }

function run(fixtures: Fixture[]): Result[] {
  return fixtures.map((fx) => {
    const lines = toLines(fx.input);
    const t0 = performance.now();
    const rc = parseReceipt(lines);
    const ms = performance.now() - t0;
    return { fx, s: score(rc, fx.truth), ms };
  });
}

const fixtures = loadFixtures();
const unreviewed = fixtures.filter((f) => !f.reviewed);
const real = run(fixtures.filter((f) => f.reviewed));
const synthetic = run(syntheticSet(SYNTHETIC));

const sets = {
  'real-dev': real.filter((x) => x.fx.split === 'dev'),
  'real-holdout': real.filter((x) => x.fx.split === 'holdout'),
  'synthetic-holdout': synthetic,
};
const report = {
  engine: 'parseReceipt (pre-redesign)',
  sets: Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, summarize(v)])),
  syntheticByTemplate: Object.fromEntries(
    [...new Set(synthetic.map((x) => x.fx.tags[0]!))].map((t) => [t, summarize(synthetic.filter((x) => x.fx.tags[0] === t))]),
  ),
  syntheticByCondition: Object.fromEntries(
    ['mild', 'distorted', 'misread', 'misread-with-runner-up', 'lost-fragment'].map((t) => [t, summarize(synthetic.filter((x) => x.fx.tags.includes(t)))]),
  ),
  realReceipts: real.map((x) => ({ id: x.fx.id, split: x.fx.split, source: x.fx.source, exact: x.s.exact, ...pick(x.s) })),
};

function pick(s: Score) {
  return { items: `${s.matched}/${s.truthItems}`, falseItems: s.falseItems, qty: s.qtyRight, price: s.priceRight, silentWrong: s.silentWrong };
}

// ---- print ----
const cols = ['receipts', 'exactReceipts', 'itemRecall', 'itemPrecision', 'falseItems', 'qtyAccuracy', 'priceAccuracy', 'misassigned', 'errorsFlagged', 'flagPrecision', 'silentWrong', 'msMedian'] as const;
const fmt = (v: unknown) => (v === null || v === undefined ? '-' : String(v));
function table(title: string, rows: Record<string, ReturnType<typeof summarize>>) {
  console.log(`\n${title}`);
  console.log(['set'.padEnd(24), ...cols.map((c) => c.padStart(13))].join(''));
  for (const [k, v] of Object.entries(rows)) console.log([k.padEnd(24), ...cols.map((c) => fmt(v[c]).padStart(13))].join(''));
}
table('Overall (percentages unless a count)', report.sets);
console.log('\nTotals accuracy %');
for (const [k, v] of Object.entries(report.sets)) console.log(`  ${k.padEnd(22)} ${JSON.stringify(v.totals)}`);
table('Synthetic holdout by layout', report.syntheticByTemplate);
table('Synthetic holdout by condition', report.syntheticByCondition);
console.log('\nReal receipts');
for (const r of report.realReceipts) console.log(`  ${(r.exact ? 'OK  ' : 'FAIL')} ${r.id.padEnd(28)} ${r.split.padEnd(8)} ${r.source.padEnd(12)} items ${r.items} false ${r.falseItems} silent ${r.silentWrong}`);
if (unreviewed.length) console.log(`\nNot scored (answer key not reviewed yet): ${unreviewed.map((f) => f.id).join(', ')}`);

writeFileSync(join(here, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const baselinePath = join(here, 'baseline.json');
if (process.argv.includes('--save-baseline')) {
  writeFileSync(baselinePath, JSON.stringify(report, null, 2) + '\n');
  console.log('\nSaved as the baseline.');
} else if (existsSync(baselinePath)) {
  const base = JSON.parse(readFileSync(baselinePath, 'utf8')) as typeof report;
  console.log('\nChange against the baseline');
  for (const [k, v] of Object.entries(report.sets)) {
    const b = base.sets[k as keyof typeof base.sets];
    if (!b) continue;
    const d = (c: (typeof cols)[number]) => (typeof v[c] === 'number' && typeof b[c] === 'number' ? `${c} ${(v[c] as number) - (b[c] as number) >= 0 ? '+' : ''}${Math.round(((v[c] as number) - (b[c] as number)) * 10) / 10}` : null);
    console.log(`  ${k.padEnd(22)} ${['exactReceipts', 'itemRecall', 'priceAccuracy', 'qtyAccuracy', 'falseItems', 'silentWrong'].map((c) => d(c as (typeof cols)[number])).filter(Boolean).join('  ')}`);
  }
}
