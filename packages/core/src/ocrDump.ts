import type { OcrLine, OcrResult } from './receipt';

/**
 * The text behind "Share what the scanner read": everything the scanner returned, compact enough to paste into a
 * message, and lossless enough to become a test receipt. Version 1 (an array of {t,x,y,h,c}) is still read.
 */
interface DumpLineV2 {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
  c: number;
  a?: string[]; // runner-up readings
  ac?: number[]; // their confidences
  q?: number[]; // corners
  wd?: Array<[string, number, number, number, number]>; // words: text, x, y, w, h
}

interface DumpV2 {
  v: 2;
  w: number;
  h: number;
  lines: DumpLineV2[];
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function encodeOcrDump(result: OcrResult): string {
  const dump: DumpV2 = {
    v: 2,
    w: result.width,
    h: result.height,
    lines: result.lines.map((l) => ({
      t: l.text, x: r4(l.x), y: r4(l.y), w: r4(l.w), h: r4(l.h), c: Math.round(l.confidence * 100) / 100,
      ...(l.alternates?.length ? { a: l.alternates } : {}),
      ...(l.alternateConfidences?.length ? { ac: l.alternateConfidences.map((c) => Math.round(c * 100) / 100) } : {}),
      ...(l.quad?.length === 8 ? { q: l.quad.map(r4) } : {}),
      ...(l.words?.length ? { wd: l.words.map((w) => [w.text, r4(w.x), r4(w.y), r4(w.w), r4(w.h)] as [string, number, number, number, number]) } : {}),
    })),
  };
  return JSON.stringify(dump);
}

/** Read a dump of either version. Version 1 recorded no widths; they are estimated from the text length. */
export function decodeOcrDump(json: string): OcrResult {
  const data = JSON.parse(json) as DumpV2 | Array<{ t: string; x: number; y: number; h: number; c: number; w?: number }>;
  if (Array.isArray(data)) {
    return {
      width: 0,
      height: 0,
      lines: data.map((r) => ({ text: r.t, x: r.x, y: r.y, w: r.w ?? Math.max(0.03, r.t.length * r.h * 0.66), h: r.h, confidence: r.c })),
    };
  }
  if (data.v !== 2) throw new Error(`Unknown scanner dump version ${String((data as { v?: unknown }).v)}.`);
  return {
    width: data.w,
    height: data.h,
    lines: data.lines.map((l): OcrLine => ({
      text: l.t, x: l.x, y: l.y, w: l.w, h: l.h, confidence: l.c,
      ...(l.a ? { alternates: l.a } : {}),
      ...(l.ac ? { alternateConfidences: l.ac } : {}),
      ...(l.q ? { quad: l.q } : {}),
      ...(l.wd ? { words: l.wd.map(([text, x, y, w, h]) => ({ text, x, y, w, h })) } : {}),
    })),
  };
}
