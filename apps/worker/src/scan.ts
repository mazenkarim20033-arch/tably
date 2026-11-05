import { VERIFY_SCHEMA, parseVerifyReply, verifyPrompt } from '@tably/core';
import type { Hono } from 'hono';
import { HttpError, rateLimit, windowOf, type C } from './http';
import type { Env } from './types';

/**
 * The AI is a verifier: the phone sends small pictures of the few receipt rows it is unsure about, with the values it
 * thinks they could be, and the model says which amount it sees. The phone decides what to do with the answers.
 */

/** A few small row pictures; the most one request may carry. */
export const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_CROPS = 6;
const DEFAULT_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const DAY = 86_400;

/** Reading with an AI model is off until the owner turns it on (SCAN_ENABLED=on) and the AI binding exists. */
export const scanEnabled = (env: Env) => env.SCAN_ENABLED === 'on' && !!env.AI;

const num = (v: string | undefined, fallback: number) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Start of the current calendar month (UTC), in seconds: the window that monthly allowances count in. */
const monthStart = () => { const d = new Date(); return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000); };

/** The app sends a random id it made for itself. It is not a login, so it is only one of several limits. */
const installId = (c: C): string | null => {
  const id = c.req.header('x-install-id') ?? '';
  return /^[A-Za-z0-9-]{16,64}$/.test(id) ? id : null;
};

async function used(c: C, bucket: string, key: string, window: number): Promise<number> {
  const row = await c.env.DB.prepare('SELECT hits FROM rate_hits WHERE bucket = ?1 AND key = ?2 AND window = ?3').bind(bucket, key, window).first<{ hits: number }>();
  return row?.hits ?? 0;
}

async function count(c: C, bucket: string, key: string, window: number): Promise<number> {
  const row = await c.env.DB
    .prepare(
      'INSERT INTO rate_hits(bucket, key, window, hits) VALUES (?1, ?2, ?3, 1) ' +
        'ON CONFLICT(bucket, key, window) DO UPDATE SET hits = hits + 1 RETURNING hits',
    )
    .bind(bucket, key, window)
    .first<{ hits: number }>();
  return row?.hits ?? 0;
}

const userAllowance = (env: Env) => num(env.SCAN_USER_MONTHLY, 5);

/**
 * Spending limits, tightest first: a monthly allowance per app install, a larger one per network address (so a
 * reinstall or a made-up id gains little), a monthly budget for everyone together, and a daily cap against bursts.
 * Counted before the model is called, so a flood cannot get past them.
 */
async function spend(c: C): Promise<void> {
  const id = installId(c);
  if (!id) throw new HttpError(422, 'Update the app to use AI reading.');
  const month = monthStart();
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  if ((await count(c, 'scan-user', id, month)) > userAllowance(c.env)) throw new HttpError(429, 'You have used your AI reads for this month. The normal scan still works.');
  if ((await count(c, 'scan-ip', ip, month)) > userAllowance(c.env) * 4) throw new HttpError(429, 'Too many AI reads from this network this month. The normal scan still works.');
  if ((await count(c, 'scan-all-month', 'all', month)) > num(c.env.SCAN_MONTHLY_CAP, 3000)) throw new HttpError(429, 'AI reading is paused until next month. The normal scan still works.');
  if ((await count(c, 'scan-all', 'all', windowOf(DAY))) > num(c.env.SCAN_DAILY_CAP, 200)) throw new HttpError(429, 'AI reading is busy for today. The normal scan still works.');
}

interface Crop { path: string; image: string; candidates: number[] }

function cropsOf(body: unknown): Crop[] {
  const list = (body as { crops?: unknown } | null)?.crops;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CROPS) throw new HttpError(422, `Send between 1 and ${MAX_CROPS} row pictures.`);
  return list.map((c: Partial<Crop>) => {
    const ok = typeof c?.path === 'string' && c.path.length <= 64 && typeof c.image === 'string' && /^[A-Za-z0-9+/=]+$/.test(c.image) && c.image.length >= 100 &&
      Array.isArray(c.candidates) && c.candidates.length >= 1 && c.candidates.length <= 8 && c.candidates.every((v) => Number.isSafeInteger(v) && v >= 0);
    if (!ok) throw new HttpError(422, 'Invalid row picture.');
    return c as Crop;
  });
}

export function scanRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get('/api/features', async (c: C) => {
    const id = installId(c);
    const left = id ? Math.max(0, userAllowance(c.env) - (await used(c, 'scan-user', id, monthStart()))) : undefined;
    return c.json({ vision: scanEnabled(c.env), ...(left === undefined ? {} : { left }) });
  });

  app.post('/api/scan', async (c: C) => {
    if (!scanEnabled(c.env)) throw new HttpError(503, 'AI reading is not switched on.');
    await rateLimit(c, 'scan', 10, 3600);
    // Check the request before it is counted against anyone's allowance.
    let body: unknown;
    try {
      const text = await c.req.text();
      if (text.length > MAX_SCAN_BYTES) throw new HttpError(413, 'That is too much to send.');
      body = JSON.parse(text);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(422, 'Invalid request.');
    }
    const crops = cropsOf(body);
    await spend(c);

    const answers: Record<string, number | null> = {};
    try {
      await Promise.all(crops.map(async (crop) => {
        const out = (await c.env.AI!.run(c.env.SCAN_MODEL ?? DEFAULT_MODEL, {
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: verifyPrompt(crop.candidates) },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${crop.image}` } },
            ],
          }],
          response_format: { type: 'json_schema', json_schema: VERIFY_SCHEMA },
          max_tokens: 60,
          temperature: 0,
        } as never)) as { response?: unknown };
        answers[crop.path] = parseVerifyReply(out?.response);
      }));
    } catch (e) {
      console.error('scan failed', e instanceof Error ? e.message : String(e));
      throw new HttpError(502, 'The AI service could not read this photo. The normal scan still works.');
    }
    return c.json({ answers });
  });
}
