import { useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import * as ImageManipulator from 'expo-image-manipulator';
import { applyAnswers, verifyTargets, type OcrLine, type Receipt, type VerifyTarget } from '@tably/core';
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

/** One row of the photo, cut out and shrunk so it uploads in a moment. */
async function cropRow(uri: string, photo: { width: number; height: number }, box: VerifyTarget['box']): Promise<string> {
  const originX = Math.round(box.x * photo.width);
  const originY = Math.round(box.y * photo.height);
  const width = Math.max(1, Math.min(photo.width - originX, Math.round(box.w * photo.width)));
  const height = Math.max(1, Math.min(photo.height - originY, Math.round(box.h * photo.height)));
  const context = ImageManipulator.ImageManipulator.manipulate(uri);
  context.crop({ originX, originY, width, height });
  if (width > 900) context.resize({ width: 900 });
  const rendered = await context.renderAsync();
  const out = await rendered.saveAsync({ format: ImageManipulator.SaveFormat.JPEG, compress: 0.8, base64: true });
  if (!out.base64) throw new Error('Could not prepare the photo.');
  return out.base64;
}

export interface AiResult {
  receipt: Receipt;
  /** the AI's answers were used because they make the items add up */
  applied: boolean;
  /** the receipt differs from the one sent (corrections applied, or the AI's readings offered as choices) */
  changed: boolean;
}

/**
 * Ask the AI about only the amounts the scan is unsure of: a small picture of each row, plus the values it could be.
 * Throws a readable message on failure. Nothing is sent when there is nothing in doubt.
 */
export async function readWithAi(imageUri: string, ocr: OcrLine[], current: Receipt): Promise<AiResult> {
  const targets = verifyTargets(current, ocr);
  if (targets.length === 0) return { receipt: current, applied: false, changed: false };
  const photo = await ImageManipulator.ImageManipulator.manipulate(imageUri).renderAsync();
  const crops = [];
  for (const t of targets) crops.push({ path: t.path, candidates: t.candidates, image: await cropRow(imageUri, photo, t.box) });
  const res = await fetch(`${requireServer()}/api/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-install-id': await getInstallId() },
    body: JSON.stringify({ crops }),
  });
  const body = (await res.json().catch(() => ({}))) as { answers?: Record<string, number | null>; detail?: unknown };
  if (!res.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'The AI reading did not work. Your normal scan is still here.');
  if (!body.answers || typeof body.answers !== 'object') throw new Error('The AI could not make sense of this photo.');
  return applyAnswers(current, targets, body.answers);
}
