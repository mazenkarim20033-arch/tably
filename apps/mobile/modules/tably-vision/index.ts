import { Platform } from 'react-native';
import { requireNativeModule } from 'expo';
import type { OcrLine } from '@tably/core';

type Native = { recognizeText(uri: string): Promise<OcrLine[]> };

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
export async function recognizeText(uri: string): Promise<OcrLine[]> {
  if (!native) throw new Error('On-device OCR is only available in the iPhone build.');
  return native.recognizeText(uri);
}
