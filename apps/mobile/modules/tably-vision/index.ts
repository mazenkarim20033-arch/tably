import { Platform } from 'react-native';
import { requireNativeModule } from 'expo';
import type { OcrResult } from '@tably/core';

type Native = { recognizeText(uri: string): Promise<OcrResult | OcrResult['lines']> };

let native: Native | null = null;
if (Platform.OS === 'ios') {
  try {
    native = requireNativeModule<Native>('TablyVision');
  } catch {
    native = null; // module missing from this build
  }
}

export const isOcrAvailable = native !== null;

/** On-device OCR via Apple Vision. Throws when unavailable so the UI can fall back to manual entry. */
export async function recognizeText(uri: string): Promise<OcrResult> {
  if (!native) throw new Error('On-device OCR is only available in the iPhone build.');
  const res = await native.recognizeText(uri);
  // Older native builds returned only the lines.
  return Array.isArray(res) ? { lines: res, width: 0, height: 0 } : res;
}
