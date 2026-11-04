import { normalizeDigits, parseAmount } from '../money';
import type { OcrLine } from '../receipt';

/**
 * Stage C: layout reconstruction. Turns scanner observations into printed lines and columns using the geometry the
 * scanner reports (corners and word boxes), not the order it returns text in and not one tilt for the whole page.
 *
 *  1. Tokens: every word gets its own box, so a price inside a merged observation still has a position.
 *  2. Baseline field: each observation that spans some width tells us the local direction of the printed lines
 *     (from its word centres, else its corners). Directions are collected per horizontal band of the page and per
 *     slice of x, so a curled page (lines bending) and a rotated one are both followed. Integrating the direction from
 *     the middle of the page gives, for any point, how far its line has drifted up or down: subtracting that drift
 *     "unbends" the page.
 *  3. Lines: observations are grouped by their unbent height. Two observations that overlap horizontally are never on
 *     one printed line, which keeps a caption under a name from merging with it.
 *  4. Columns: numbers that line up by their right edge down the page form a column. Columns may slant (keystone);
 *     each is a fitted line x = a + b * height, and holds at most one number per printed line.
 *
 * When the scanner gave no usable geometry (older app builds, hand-typed fixtures), `oriented` is false and callers
 * should not trust the unbending; the lines are still grouped, assuming a straight page.
 */

export interface Token {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** index of the observation it came from */
  obs: number;
  confidence: number;
  /** Unbent vertical position (the height its printed line has in the middle of the page). */
  v: number;
  kind: 'amount' | 'integer' | 'word';
  /** set for amount and integer tokens */
  value: number | null;
  /** index into Layout.columns, or -1 */
  column: number;
}

export interface Line {
  /** observations on this line, left to right */
  obs: number[];
  /** tokens on this line, left to right */
  tokens: Token[];
  v: number;
  /** text of the line, left to right */
  text: string;
}

export interface Column {
  /** right edge x = a + b * v */
  a: number;
  b: number;
  tokens: Token[];
  /** most tokens are amounts with decimals (prices), or small whole numbers (quantities) */
  role: 'amount' | 'integer';
}

export interface Layout {
  oriented: boolean;
  /** normal text height (normalized) */
  textHeight: number;
  /** unbent height of each observation, same order as the input */
  obsV: number[];
  lines: Line[];
  columns: Column[];
  tokens: Token[];
}

const cx = (l: { x: number; w: number }) => l.x + l.w / 2;
const cy = (l: { y: number; h: number }) => l.y + l.h / 2;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function weightedMedian(pairs: Array<[value: number, weight: number]>): number {
  if (pairs.length === 0) return 0;
  const s = [...pairs].sort((a, b) => a[0] - b[0]);
  const total = s.reduce((t, p) => t + p[1], 0);
  let acc = 0;
  for (const [v, w] of s) {
    acc += w;
    if (acc >= total / 2) return v;
  }
  return s[s.length - 1]![0];
}

const AMOUNT = /^[-(]?\d{1,3}([,.]?\d{3})*[.,٫]\d{2}\)?-?$/;
const INTEGER = /^\d{1,3}$/;

function classifyToken(text: string): { kind: Token['kind']; value: number | null } {
  const t = normalizeDigits(text).replace(/^(egp|le|usd|\$|€|£)/i, '').replace(/(egp|le|ج\.?م\.?)$/i, '');
  if (AMOUNT.test(t)) return { kind: 'amount', value: parseAmount(t.replace(/[()]/g, '').replace(/-$/, '')) };
  if (INTEGER.test(t)) return { kind: 'integer', value: Number(t) };
  // A quantity printed with a decimal ("1.0", "2.000"): a whole number, not money.
  if (/^\d{1,3}[.,]0{1,3}$/.test(t) && !AMOUNT.test(t)) return { kind: 'integer', value: Math.round(Number(t.replace(',', '.'))) };
  return { kind: 'word', value: null };
}

/** Words of an observation with their boxes: from the scanner when it gave them, else spread along the box. */
function wordsOf(l: OcrLine): Array<{ text: string; x: number; y: number; w: number; h: number }> {
  const parts = l.text.split(/\s+/).filter(Boolean);
  if (l.words && l.words.length === parts.length) return l.words;
  const chars = parts.reduce((n, p) => n + p.length, 0) + Math.max(0, parts.length - 1);
  const per = chars > 0 ? l.w / chars : 0;
  // Arabic text is printed right to left: its first word is the rightmost.
  const arabic = (l.text.match(/[؀-ۿ]/g) ?? []).length > (l.text.match(/[A-Za-z]/g) ?? []).length;
  let at = arabic ? l.x + l.w : l.x;
  return parts.map((text) => {
    const w = text.length * per;
    const x = arabic ? at - w : at;
    at = arabic ? at - w - per : at + w + per;
    return { text, x, y: l.y, w, h: l.h };
  });
}

interface Sample { x0: number; x1: number; y: number; slope: number; weight: number }

/** The local direction of printed lines, measured from each observation that spans enough width. */
function slopeSamples(lines: OcrLine[]): Sample[] {
  const out: Sample[] = [];
  for (const l of lines) {
    const words = l.words ?? [];
    let slope: number | null = null;
    let span = 0;
    if (words.length >= 2) {
      // Least-squares slope of the word centres: they sit on the observation's baseline.
      const pts = words.map((w) => [cx(w), cy(w)] as const);
      const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      const sxx = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
      span = Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));
      if (span > 0.06 && sxx > 0) slope = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / sxx;
    }
    if (slope === null && l.quad?.length === 8) {
      const [tlx, tly, trx, try_, brx, bry, blx, bly] = l.quad as [number, number, number, number, number, number, number, number];
      span = (trx - tlx + brx - blx) / 2;
      if (span > 0.06) slope = ((try_ - tly) / (trx - tlx) + (bry - bly) / (brx - blx)) / 2;
    }
    if (slope !== null && Number.isFinite(slope) && Math.abs(slope) < 0.5) {
      out.push({ x0: l.x, x1: l.x + l.w, y: cy(l), slope, weight: span });
    }
  }
  return out;
}

/** Solve a small linear system (Gaussian elimination with partial pivoting). */
function solve(A: number[][], y: number[]): number[] | null {
  const n = y.length;
  const M = A.map((row, i) => [...row, y[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-12) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/**
 * A smooth model of the page: the slope of the printed lines at (x, y) is a + b*x + c*y + d*x*y. Rotation is a,
 * paper curl bends lines (b), a keystoned or bowed page changes the slope down the page (c, d). Each observation
 * measures the average slope over its own width, so the model is fitted to span averages, with weights by width and
 * outliers (a misread box, a stamp) dropped. Simpler models are used when there is too little to fit.
 */
function driftFn(samples: Sample[]): (x: number, y: number) => number {
  const feats = (s: Sample, terms: number) => {
    const xm = (s.x0 + s.x1) / 2;
    return [1, xm, s.y, xm * s.y].slice(0, terms);
  };
  let use = samples;
  let coef: number[] = [median(samples.map((s) => s.slope)), 0, 0, 0];
  const terms = samples.length >= 12 ? 4 : samples.length >= 6 ? 3 : 1;
  for (let round = 0; round < 3 && terms > 1; round++) {
    const A = Array.from({ length: terms }, () => new Array<number>(terms).fill(0));
    const y = new Array<number>(terms).fill(0);
    for (const s of use) {
      const f = feats(s, terms);
      for (let i = 0; i < terms; i++) {
        y[i]! += s.weight * f[i]! * s.slope;
        for (let j = 0; j < terms; j++) A[i]![j]! += s.weight * f[i]! * f[j]!;
      }
    }
    const sol = solve(A, y);
    if (!sol) break;
    coef = [...sol, 0, 0, 0].slice(0, 4);
    const resid = use.map((s) => Math.abs(s.slope - feats(s, terms).reduce((t, f, i) => t + f * coef[i]!, 0)));
    const cut = Math.max(0.004, median(resid) * 3);
    const kept = use.filter((_, i) => resid[i]! <= cut);
    if (kept.length === use.length || kept.length < terms * 2) break;
    use = kept;
  }
  const [a, b, c, d] = coef as [number, number, number, number];
  // drift(x, y) = integral from 0.5 to x of (a + b*t + c*y + d*t*y) dt
  return (x, yy) => (a + c * yy) * (x - 0.5) + ((b + d * yy) / 2) * (x * x - 0.25);
}

/** The height of the text itself, not of its (possibly tilted, inflated) box. */
function textHeights(lines: OcrLine[]): number[] {
  return lines.map((l) => {
    if (l.quad?.length === 8) {
      const [tlx, tly, , , , , blx, bly] = l.quad as number[] as [number, number, number, number, number, number, number, number];
      return Math.hypot(blx - tlx, bly - tly) || l.h;
    }
    return l.h;
  });
}

export function buildLayout(input: OcrLine[]): Layout {
  const lines = input;
  const samples = slopeSamples(lines);
  // Geometry only counts when it says something: corners that are all exactly level could be a scanner that does not
  // report real corners, so they are not trusted on their own.
  const informative = samples.some((s) => Math.abs(s.slope) > 1e-6) || lines.some((l) => (l.words?.length ?? 0) >= 2);
  const oriented = samples.length >= 3 && informative;
  const drift = oriented ? driftFn(samples) : () => 0;

  const heights = textHeights(lines).sort((a, b) => a - b);
  const textHeight = heights.length ? heights[Math.floor((heights.length - 1) * 0.3)]! : 0.02;

  // Unbent height of each observation: its centre minus the drift of its line at its centre.
  const obsV = lines.map((l) => cy(l) - drift(cx(l), cy(l)));

  // Lines: sort by unbent height and group; never put two horizontally overlapping observations on one line.
  const order = lines.map((_, i) => i).sort((a, b) => obsV[a]! - obsV[b]!);
  const groups: Array<{ obs: number[]; v: number }> = [];
  const tol = textHeight * 0.55;
  for (const i of order) {
    const l = lines[i]!;
    let placed = false;
    for (let g = groups.length - 1; g >= 0 && g >= groups.length - 3; g--) {
      const grp = groups[g]!;
      if (Math.abs(obsV[i]! - grp.v) > tol) continue;
      const overlaps = grp.obs.some((j) => {
        const o = lines[j]!;
        const overlap = Math.min(o.x + o.w, l.x + l.w) - Math.max(o.x, l.x);
        return overlap > 0.25 * Math.min(o.w, l.w);
      });
      if (overlaps) continue;
      grp.obs.push(i);
      grp.v = grp.obs.reduce((s, j) => s + obsV[j]!, 0) / grp.obs.length;
      placed = true;
      break;
    }
    if (!placed) groups.push({ obs: [i], v: obsV[i]! });
  }
  groups.sort((a, b) => a.v - b.v);

  const tokens: Token[] = [];
  const built: Line[] = groups.map((g) => {
    const obs = [...g.obs].sort((a, b) => lines[a]!.x - lines[b]!.x);
    const lineTokens: Token[] = obs.flatMap((i) =>
      wordsOf(lines[i]!).map((w) => {
        const { kind, value } = classifyToken(w.text);
        const t: Token = {
          text: w.text, x: w.x, y: w.y, w: w.w, h: w.h, obs: i, confidence: lines[i]!.confidence,
          v: g.v, kind, value, column: -1,
        };
        return t;
      }),
    ).sort((a, b) => a.x - b.x);
    tokens.push(...lineTokens);
    return { obs, tokens: lineTokens, v: g.v, text: obs.map((i) => lines[i]!.text.trim()).join('  ') };
  });

  return { oriented, textHeight, obsV, lines: built, columns: findColumns(built, textHeight), tokens };
}

/**
 * Numbers whose right edges line up down the page. Seeds are runs of right edges close in x; neighbouring runs are
 * merged while the merged run still fits one slanted line and holds at most one number per printed line.
 */
function findColumns(lines: Line[], textHeight: number): Column[] {
  const nums: Array<{ t: Token; line: number; right: number }> = [];
  lines.forEach((ln, li) => ln.tokens.forEach((t) => t.kind !== 'word' && nums.push({ t, line: li, right: t.x + t.w })));
  if (nums.length < 2) return [];
  nums.sort((a, b) => a.right - b.right);

  type Run = typeof nums;
  let runs: Run[] = [];
  for (const n of nums) {
    const r = runs[runs.length - 1];
    if (r && n.right - r[r.length - 1]!.right < 0.025) r.push(n);
    else runs.push([n]);
  }
  const fit = (run: Run) => {
    const vs = run.map((n) => n.t.v);
    const mv = vs.reduce((s, v) => s + v, 0) / vs.length;
    const mr = run.reduce((s, n) => s + n.right, 0) / run.length;
    const svv = vs.reduce((s, v) => s + (v - mv) ** 2, 0);
    const b = run.length >= 3 && svv > 1e-6 ? run.reduce((s, n) => s + (n.t.v - mv) * (n.right - mr), 0) / svv : 0;
    const a = mr - b * mv;
    const resid = Math.max(...run.map((n) => Math.abs(n.right - (a + b * n.t.v))));
    return { a, b, resid };
  };
  const oneLineEach = (run: Run) => new Set(run.map((n) => n.line)).size === run.length;
  // Greedy merge of neighbouring runs.
  let merged = true;
  while (merged) {
    merged = false;
    for (let k = 0; k + 1 < runs.length; k++) {
      const union = [...runs[k]!, ...runs[k + 1]!];
      const f = fit(union);
      if (oneLineEach(union) && f.resid < Math.max(0.012, textHeight * 0.6) && Math.abs(f.b) < 0.25) {
        runs = [...runs.slice(0, k), union, ...runs.slice(k + 2)];
        merged = true;
        break;
      }
    }
  }
  const columns: Column[] = [];
  for (const run of runs) {
    if (run.length < 2) continue;
    // A run that holds two numbers of one line is not a column; keep the one nearest the fitted edge.
    const f = fit(run);
    const byLine = new Map<number, (typeof run)[number]>();
    for (const n of run) {
      const prev = byLine.get(n.line);
      if (!prev || Math.abs(n.right - (f.a + f.b * n.t.v)) < Math.abs(prev.right - (f.a + f.b * prev.t.v))) byLine.set(n.line, n);
    }
    const members = [...byLine.values()];
    if (members.length < 2) continue;
    const amounts = members.filter((n) => n.t.kind === 'amount').length;
    const col: Column = { a: f.a, b: f.b, tokens: members.map((n) => n.t), role: amounts * 2 >= members.length ? 'amount' : 'integer' };
    const id = columns.length;
    for (const n of members) n.t.column = id;
    columns.push(col);
  }
  return columns;
}

/**
 * The scanner observations moved onto their reconstructed lines: same x, a common height per line, and a normal text
 * height. Code that groups by height (the current reader) then sees a straight page.
 */
export function straightened(input: OcrLine[], layout: Layout): OcrLine[] {
  const h = layout.textHeight;
  const vOf = new Map<number, number>();
  layout.lines.forEach((ln) => ln.obs.forEach((i) => vOf.set(i, ln.v)));
  return input.map((l, i) => {
    const v = vOf.get(i) ?? layout.obsV[i]!;
    const hh = Math.min(l.h, h * 1.15);
    return { ...l, y: v - hh / 2, h: hh };
  });
}

export const _internal = { median, classifyToken };
