import { useSyncExternalStore } from 'react';
import { Directory, File, Paths } from 'expo-file-system';
import { emptyReceipt, type OcrLine, type Receipt } from '@tably/core';

/** The receipt being scanned/edited. Persisted on disk so an interrupted scan is not lost. */
export interface Draft {
  id: string;
  /** file:// URI of the preserved original photo, or null for manual entry */
  imageUri: string | null;
  receipt: Receipt;
  /** Raw OCR lines, kept so the parser can be re-run after improvements. */
  ocr: OcrLine[];
  ocrError: string | null;
}

let current: Draft | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function dirFor(id: string): Directory {
  return new Directory(Paths.document, 'drafts', id);
}

export function getDraft(): Draft | null {
  return current;
}

export function useDraft(): Draft | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

/** Copy the original photo into app storage (the picker's cache copy can be purged). */
export async function startDraft(sourceUri: string | null): Promise<Draft> {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let imageUri: string | null = null;
  if (sourceUri) {
    const dir = dirFor(id);
    dir.create({ intermediates: true, idempotent: true });
    const dest = new File(dir, 'original.jpg');
    await new File(sourceUri).copy(dest);
    imageUri = dest.uri;
  }
  current = { id, imageUri, receipt: emptyReceipt(), ocr: [], ocrError: null };
  emit();
  return current;
}

export function updateDraft(patch: Partial<Omit<Draft, 'id'>>): void {
  if (!current) return;
  current = { ...current, ...patch };
  emit();
  void persist(current);
}

async function persist(d: Draft): Promise<void> {
  try {
    const dir = dirFor(d.id);
    dir.create({ intermediates: true, idempotent: true });
    const f = new File(dir, 'draft.json');
    f.create({ overwrite: true });
    await f.write(JSON.stringify(d));
  } catch {
    // Persistence is best-effort; the in-memory draft stays authoritative.
  }
}
