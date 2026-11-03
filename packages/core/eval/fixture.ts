import { decodeOcrDump } from '../src/ocrDump';
import type { OcrLine } from '../src/receipt';

/** The answer key for one receipt, written by a person from the photo. Amounts are in minor units (piastres). */
export interface Truth {
  /** Lines people can be charged for. Lines printed at 0.00 are left out: they are not split. */
  items: Array<{ name: string; qty: number; lineTotal: number }>;
  /** null: not printed on the receipt. */
  subtotal: number | null;
  tax: number | null;
  service: number | null;
  tip: number | null;
  /** Total savings as a negative number, or null when none is printed. */
  discount: number | null;
  total: number | null;
}

export type Input =
  /** "Share what the scanner read", pasted as is (either version). */
  | { kind: 'dump'; dump: unknown }
  /** Hand-typed rows: "|" separates fragments. `two-column` puts the last fragment on the right; `grid` spaces them evenly. */
  | { kind: 'rows'; layout: 'two-column' | 'grid'; rows: string[] }
  /** Positions measured from a photo, in pixels: [text, x0, x1, y-centre]. */
  | { kind: 'pixels'; width: number; height: number; frags: Array<[string, number, number, number]> };

export interface Fixture {
  id: string;
  /** How the input was obtained, from most to least trustworthy. */
  source: 'vision-dump' | 'measured' | 'typed' | 'synthetic';
  split: 'dev' | 'holdout';
  description: string;
  /** false until a person has checked the answer key against the photo. Unreviewed fixtures are not scored. */
  reviewed: boolean;
  /** Free-form tags used to break results down, e.g. "bilingual", "summary-box", "tilted". */
  tags: string[];
  input: Input;
  truth: Truth;
}

export function toLines(input: Input): OcrLine[] {
  switch (input.kind) {
    case 'dump':
      return decodeOcrDump(typeof input.dump === 'string' ? input.dump : JSON.stringify(input.dump)).lines;
    case 'rows':
      return input.rows.flatMap((row, i) => {
        const parts = row.split('|');
        if (input.layout === 'two-column') {
          const y = 0.05 + i * 0.04;
          return parts.map((text, j) => ({ text, x: j === 0 ? 0.05 : 0.7, y, w: 0.3, h: 0.025, confidence: 0.95 }));
        }
        const y = 0.04 + i * 0.04;
        return parts.map((text, j) => ({ text, x: 0.05 + j * 0.24, y, w: 0.2, h: 0.022, confidence: 0.95 }));
      });
    case 'pixels':
      // A tilted line's axis-aligned box is taller the longer the line is (as Vision reports it).
      return input.frags.map(([text, x0, x1, yc]) => {
        const hPx = 15 + (x1 - x0) * 0.06;
        return { text, x: x0 / input.width, y: (yc - hPx / 2) / input.height, w: (x1 - x0) / input.width, h: hPx / input.height, confidence: 0.9 };
      });
  }
}
