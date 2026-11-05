import { VISION_PROMPT, VISION_SCHEMA, parseVisionReply } from '@tably/core';
import type { Hono } from 'hono';
import { HttpError, rateLimit, windowOf, type C } from './http';
import type { Env } from './types';

/** A resized receipt photo as base64 JPEG is a few hundred KB; this is the most one scan may carry. */
export const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const DEFAULT_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const DAY = 86_400;

/** Reading with an AI model is off until the owner turns it on (SCAN_ENABLED=on) and the AI binding exists. */
export const scanEnabled = (env: Env) => env.SCAN_ENABLED === 'on' && !!env.AI;

/** One shared daily budget for every user, so a burst of traffic can never run past the free allowance. */
async function dailyBudget(c: C): Promise<void> {
  const cap = Number(c.env.SCAN_DAILY_CAP ?? 200);
  const row = await c.env.DB
    .prepare(
      'INSERT INTO rate_hits(bucket, key, window, hits) VALUES (?1, ?2, ?3, 1) ' +
        'ON CONFLICT(bucket, key, window) DO UPDATE SET hits = hits + 1 RETURNING hits',
    )
    .bind('scan-all', 'all', windowOf(DAY))
    .first<{ hits: number }>();
  if ((row?.hits ?? 0) > cap) throw new HttpError(429, 'AI reading is busy for today. The normal scan still works.');
}

export function scanRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get('/api/features', (c) => c.json({ vision: scanEnabled(c.env) }));

  app.post('/api/scan', async (c: C) => {
    if (!scanEnabled(c.env)) throw new HttpError(503, 'AI reading is not switched on.');
    await rateLimit(c, 'scan', 10, 3600);
    await dailyBudget(c);
    let image: unknown;
    try {
      const text = await c.req.text();
      if (text.length > MAX_SCAN_BYTES) throw new HttpError(413, 'That photo is too large.');
      image = (JSON.parse(text) as { image?: unknown }).image;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(422, 'Invalid request.');
    }
    if (typeof image !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(image) || image.length < 100) throw new HttpError(422, 'Send the photo as base64 JPEG.');

    let reply: unknown;
    try {
      const out = (await c.env.AI!.run(c.env.SCAN_MODEL ?? DEFAULT_MODEL, {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
          ],
        }],
        response_format: { type: 'json_schema', json_schema: VISION_SCHEMA },
        max_tokens: 2000,
        temperature: 0,
      } as never)) as { response?: unknown };
      reply = out?.response;
    } catch (e) {
      console.error('scan failed', e instanceof Error ? e.message : String(e));
      throw new HttpError(502, 'The AI service could not read this photo. The normal scan still works.');
    }
    const reading = parseVisionReply(reply);
    if (!reading) throw new HttpError(502, 'The AI could not make sense of this photo.');
    return c.json({ reading });
  });
}
