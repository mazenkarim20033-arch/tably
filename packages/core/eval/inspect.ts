/** Show one failing synthetic receipt next to its answer key: npm run eval:inspect -- <layout> [n] */
import { parseReceipt } from '../src/parseReceipt';
import { toLines } from './fixture';
import { score } from './metrics';
import { syntheticSet } from './synthetic';
const want = process.argv[2]!;
const fails = syntheticSet(400).filter((f) => f.tags[0] === want && !score(parseReceipt(toLines(f.input)), f.truth).exact);
const fx = fails[Number(process.argv[3] ?? 0)]!;
console.log(fails.length, 'failures;', fx.description, fx.tags.join(','));
for (const l of toLines(fx.input).sort((a, b) => a.y - b.y)) console.log(`${l.y.toFixed(3)} ${l.x.toFixed(3)}  ${l.text}`);
const rc = parseReceipt(toLines(fx.input));
console.log('TRUTH', JSON.stringify({ items: fx.truth.items.map((i) => [i.name, i.qty, i.lineTotal]), sub: fx.truth.subtotal, svc: fx.truth.service, tax: fx.truth.tax, total: fx.truth.total }));
console.log('GOT  ', JSON.stringify({ items: rc.items.map((i) => [i.description, i.quantity, i.lineTotal]), sub: rc.subtotal, svc: rc.service, tax: rc.tax, total: rc.total }));
