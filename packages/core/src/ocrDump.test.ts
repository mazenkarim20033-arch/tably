import { describe, expect, it } from 'vitest';
import { decodeOcrDump, encodeOcrDump } from './ocrDump';
import type { OcrResult } from './receipt';

describe('scanner dump', () => {
  const result: OcrResult = {
    width: 3024,
    height: 4032,
    lines: [
      {
        text: 'Tea 60.00', x: 0.1, y: 0.2, w: 0.5, h: 0.02, confidence: 0.83,
        alternates: ['Tea 80.00'], alternateConfidences: [0.41],
        quad: [0.1, 0.2, 0.6, 0.19, 0.6, 0.21, 0.1, 0.22],
        words: [{ text: 'Tea', x: 0.1, y: 0.2, w: 0.1, h: 0.02 }, { text: '60.00', x: 0.45, y: 0.19, w: 0.15, h: 0.02 }],
      },
      { text: 'Total', x: 0.1, y: 0.3, w: 0.2, h: 0.02, confidence: 1 },
    ],
  };

  it('keeps everything the scanner returned', () => {
    expect(decodeOcrDump(encodeOcrDump(result))).toEqual(result);
  });

  it('still reads the first version, estimating the missing widths', () => {
    const old = decodeOcrDump('[{"t":"Total","x":0.2,"y":0.3,"h":0.02,"c":1}]');
    expect(old.lines[0]).toMatchObject({ text: 'Total', x: 0.2, y: 0.3, h: 0.02, confidence: 1 });
    expect(old.lines[0]!.w).toBeGreaterThan(0);
  });
});
