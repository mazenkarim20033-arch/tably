/** Tokens and hashing. Everything uses Web Crypto, which every Worker has. */

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** URL-safe random token. 24 bytes = 192 bits, infeasible to guess. */
export function newToken(bytes = 24): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** 32 hex characters, the same shape the app already expects for ids. */
export const newId = (): string => crypto.randomUUID().replace(/-/g, '');

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compare two hex digests without stopping at the first difference. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function tokenMatches(token: string | null | undefined, storedHash: string): Promise<boolean> {
  if (!token) return false;
  return safeEqual(await sha256Hex(token), storedHash);
}
