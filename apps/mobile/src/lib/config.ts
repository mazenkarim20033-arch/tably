import { Directory, File, Paths } from 'expo-file-system';

/**
 * Where the TABLY backend lives. The address can be set inside the app (Settings), because a server running
 * on a PC behind a free tunnel gets a new address every time it restarts. A build-time address
 * (EXPO_PUBLIC_API_URL) is only the fallback. A phone cannot use "localhost".
 */
const BUILD_URL = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/$/, '');
const BUILD_WEB_URL = (process.env.EXPO_PUBLIC_WEB_URL ?? '').replace(/\/$/, '');

let saved: string | null = null;

function settingsFile(): File {
  const dir = new Directory(Paths.document, 'settings');
  dir.create({ intermediates: true, idempotent: true });
  return new File(dir, 'server.json');
}

/** Current server address, or '' when none is set yet. */
export const apiUrl = (): string => saved ?? BUILD_URL;
/** Base of the public share page. Same host as the API, because the backend serves the web page too. */
export const webUrl = (): string => (saved ? saved : BUILD_WEB_URL || BUILD_URL);
export const hasServer = (): boolean => apiUrl() !== '';

/** Accepts "abc.trycloudflare.com" or a full https:// address; returns the clean origin or null if unusable. */
export function normalizeServerUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    // iOS blocks plain http for ordinary apps, and an unencrypted server would expose admin keys. Require https.
    if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export async function loadServerUrl(): Promise<void> {
  try {
    const f = settingsFile();
    if (!f.exists) return;
    const url = normalizeServerUrl(String(JSON.parse(await f.text()).url ?? ''));
    saved = url;
  } catch {
    saved = null;
  }
}

export async function saveServerUrl(url: string): Promise<void> {
  saved = url;
  const f = settingsFile();
  f.create({ overwrite: true });
  await f.write(JSON.stringify({ url }));
}

/** True when a TABLY server answers at `url`. */
export async function checkServer(url: string): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(`${url}/api/health`, { signal: ctl.signal });
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class NoServerError extends Error {
  constructor() {
    super('Set your server address first: Home > Server settings.');
  }
}

export function requireServer(): string {
  const url = apiUrl();
  if (!url) throw new NoServerError();
  return url;
}
