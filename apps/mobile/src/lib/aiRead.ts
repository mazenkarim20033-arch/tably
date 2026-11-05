import { useEffect, useState } from 'react';
import * as ImageManipulator from 'expo-image-manipulator';
import { chooseReading, parseVisionReply, receiptFromVision, type OcrLine, type Receipt } from '@tably/core';
import { apiUrl, requireServer } from './config';

/** Whether the server can read photos with an AI model. Asked once; false when unreachable or switched off. */
let known: boolean | null = null;
export function useAiAvailable(): boolean {
  const [on, setOn] = useState(known ?? false);
  useEffect(() => {
    if (known !== null || !apiUrl()) return;
    let live = true;
    fetch(`${apiUrl()}/api/features`)
      .then((r) => (r.ok ? r.json() : { vision: false }))
      .then((f: { vision?: boolean }) => {
        known = !!f.vision;
        if (live) setOn(known);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  return on;
}

/** Shrink the photo so it uploads quickly: receipts stay legible at about 1280 px on the long side. */
async function smallJpeg(uri: string): Promise<string> {
  const context = ImageManipulator.ImageManipulator.manipulate(uri);
  context.resize({ height: 1600 });
  const rendered = await context.renderAsync();
  const out = await rendered.saveAsync({ format: ImageManipulator.SaveFormat.JPEG, compress: 0.7, base64: true });
  if (!out.base64) throw new Error('Could not prepare the photo.');
  return out.base64;
}

export interface AiResult {
  /** the reading to show: the AI's if it holds together clearly better, otherwise the scanner's */
  receipt: Receipt;
  usedAi: boolean;
}

/** Send the photo to be read, then keep whichever reading adds up better. Throws a readable message on failure. */
export async function readWithAi(imageUri: string, ocr: OcrLine[], current: Receipt): Promise<AiResult> {
  const image = await smallJpeg(imageUri);
  const res = await fetch(`${requireServer()}/api/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image }),
  });
  const body = (await res.json().catch(() => ({}))) as { reading?: unknown; detail?: unknown };
  if (!res.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'The AI reading did not work. Your normal scan is still here.');
  const reading = parseVisionReply(body.reading);
  if (!reading) throw new Error('The AI could not make sense of this photo.');
  const chosen = chooseReading(current, receiptFromVision(reading, ocr));
  return { receipt: chosen.receipt, usedAi: chosen.source === 'ai' };
}
