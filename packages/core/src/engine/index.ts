import { parseReceipt } from '../parseReceipt';
import type { OcrLine, Receipt } from '../receipt';
import { buildLayout, straightened } from './layout';

export { buildLayout, straightened } from './layout';
export type { Layout, Line, Column, Token } from './layout';

/**
 * The receipt engine. While the redesign is in progress it reconstructs the layout (stage C) and hands the
 * straightened page to the existing reader for meaning and pairing; later milestones replace those stages.
 * Without usable geometry from the scanner it is exactly the existing reader.
 */
export function readReceipt(lines: OcrLine[]): Receipt {
  const clean = lines.filter((l) => l.text.trim().length > 0);
  const layout = buildLayout(clean);
  if (!layout.oriented) return parseReceipt(clean);
  return parseReceipt(straightened(clean, layout));
}
