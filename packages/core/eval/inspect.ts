/** Show one failing synthetic receipt next to its answer key: npm run eval:inspect -- <layout> [n] [--lines] */
import { readReceipt, buildLayout } from '../src/engine';
import { toLines } from './fixture';
import { score } from './metrics';
import { syntheticSet } from './synthetic';
const want = process.argv[2]!;
const fails = syntheticSet(400).filter((f) => f.tags[0] === want && !score(readReceipt(toLines(f.input)), f.truth).exact);
const fx = fails[Number(process.argv[3] ?? 0)]!;
console.log(fails.length, 'failures;', fx.description, fx.tags.join(','));
const lines = toLines(fx.input);
if (process.argv.includes('--lines')) {
  const lay = buildLayout(lines);
  console.log('oriented', lay.oriented, 'textHeight', lay.textHeight.toFixed(4));
  for (const ln of lay.lines) console.log(ln.v.toFixed(3), ' ', ln.text);
} else for (const l of [...lines].sort((a, b) => a.y - b.y)) console.log(`${l.y.toFixed(3)} ${l.x.toFixed(3)}  ${l.text}`);
const rc = readReceipt(lines);
console.log('TRUTH', JSON.stringify({ items: fx.truth.items.map((i) => [i.name, i.qty, i.lineTotal]), sub: fx.truth.subtotal, svc: fx.truth.service, tax: fx.truth.tax, total: fx.truth.total }));
console.log('GOT  ', JSON.stringify({ items: rc.items.map((i) => [i.description, i.quantity, i.lineTotal]), sub: rc.subtotal, svc: rc.service, tax: rc.tax, total: rc.total }));
