import { useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import * as ImageManipulator from 'expo-image-manipulator';
import { chooseReading, parseVisionReply, receiptFromVision, type OcrLine, type Receipt } from '@tably/core';
import { apiUrl, requireServer } from './config';

/** A random id this install made for itself, so the server can count its monthly AI reads. It is not a login. */
let installId: string | null = null;
async function getInstallId(): Promise<string> {
  if (installId) return installId;
  try {
    installId = await SecureStore.getItemAsync('tably.install');
    if (!installId) {
      installId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.padEnd(24, '0');
      await SecureStore.setItemAsync('tably.install', installId);
    }
  } catch {
    installId = installId ?? `tmp${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.padEnd(24, '0');
  }
  return installId;
}

/** Whether the server can read photos with an AI model, and how many reads this install has left this month. */
export function useAiAvailable(refresh?: unknown): { on: boolean; left: number | null } {
  const [state, setState] = useState<{ on: boolean; left: number | null }>({ on: false, left: null });
  useEffect(() => {
    if (!apiUrl()) return;
    let live = true;
    void getInstallId().then((id) =>
      fetch(`${apiUrl()}/api/features`, { headers: { 'x-install-id': id } })
        .then((r) => (r.ok ? r.json() : { vision: false }))
        .then((f: { vision?: boolean; left?: number }) => { if (live) setState({ on: !!f.vision, left: typeof f.left === 'number' ? f.left : null }); })
        .catch(() => undefined),
    );
    return () => { live = false; };
  }, [refresh]);
  return state;
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
    headers: { 'content-type': 'application/json', 'x-install-id': await getInstallId() },
    body: JSON.stringify({ image }),
  });
  const body = (await res.json().catch(() => ({}))) as { reading?: unknown; detail?: unknown };
  if (!res.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'The AI reading did not work. Your normal scan is still here.');
  const reading = parseVisionReply(body.reading);
  if (!reading) throw new Error('The AI could not make sense of this photo.');
  const chosen = chooseReading(current, receiptFromVision(reading, ocr));
  return { receipt: chosen.receipt, usedAi: chosen.source === 'ai' };
}
