/**
 * Where the TABLY backend lives. It is fixed when the app is built (EXPO_PUBLIC_API_URL, set from the GitHub
 * repository variable API_URL), so nobody ever types an address. The address is permanent: a phone cannot use
 * "localhost", and the shared bill page is served from this same address.
 */
const BASE = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/$/, '');

export const apiUrl = (): string => BASE;
export const webUrl = (): string => (process.env.EXPO_PUBLIC_WEB_URL ?? BASE).replace(/\/$/, '');

export class NoServerError extends Error {
  constructor() {
    super('This build of the app has no server address. Rebuild it with the API_URL variable set.');
  }
}

export function requireServer(): string {
  if (!BASE) throw new NoServerError();
  return BASE;
}
