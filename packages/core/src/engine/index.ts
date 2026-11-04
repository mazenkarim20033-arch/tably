import { parseReceipt } from '../parseReceipt';
import type { OcrLine, Receipt } from '../receipt';
import { reconcile } from '../reconcile';
import { buildLayout, straightened } from './layout';
import { readLayout } from './read';

export { buildLayout, straightened } from './layout';
export type { Layout, Line, Column, Token } from './layout';
export { readLayout, roleOf, normalizeLabel } from './read';

/**
 * The receipt engine: layout (stage C), then meaning and pairing (D, E) with alternative readings, then arithmetic
 * (F). The earlier reader is kept as a fallback: it is used only when its reading adds up and the new one does not.
 */
export function readReceipt(lines: OcrLine[]): Receipt {
  const clean = lines.filter((l) => l.text.trim().length > 0);
  const layout = buildLayout(clean);
  const fresh = readLayout(clean, layout).receipt;
  if (reconcile(fresh).status === 'ok' && fresh.items.length > 0) return fresh;
  const old = parseReceipt(layout.oriented ? straightened(clean, layout) : clean);
  if (reconcile(old).status === 'ok' && old.items.length > 0) return old;
  return fresh.items.length > 0 ? fresh : old;
}
