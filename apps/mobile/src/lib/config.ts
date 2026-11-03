/**
 * Where the TABLY backend lives. A sideloaded iPhone cannot reach "localhost" on your PC, so set
 * EXPO_PUBLIC_API_URL at build time to a hosted URL (or your PC's LAN address while testing).
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000').replace(/\/$/, '');

/** Base of the public share page. Same host as the API when the backend serves the web app. */
export const WEB_URL = (process.env.EXPO_PUBLIC_WEB_URL ?? API_URL).replace(/\/$/, '');
