import { describe, expect, it } from 'vitest';
import { makeApi } from './helpers';

const ID = { 'x-install-id': 'install-aaaaaaaaaaaaaaaa' };
const crop = (path = 'items.i1.lineTotal', over: Record<string, unknown> = {}) => ({ path, image: 'A'.repeat(400), candidates: [8500, 5500], ...over });
const body = (...crops: unknown[]) => ({ crops: crops.length ? crops : [crop()] });
/** A model that answers with the given amount text for every row. */
const fakeAi = (amount: unknown) => ({ run: async () => ({ response: JSON.stringify({ amount }) }) }) as never;
type Api = ReturnType<typeof makeApi>;
const scan = (api: Api, b: unknown = body(), id: Record<string, string> = ID) => api.req('POST', '/api/scan', b, id);
const on = (over: Record<string, unknown> = {}) => makeApi({ SCAN_ENABLED: 'on', AI: fakeAi('55.00'), ...over });

describe('AI verifier', () => {
  it('is off by default', async () => {
    const api = makeApi();
    expect((await api.req('GET', '/api/features')).body).toEqual({ vision: false });
    expect((await scan(api)).status).toBe(503);
  });
  it('is off when enabled without the AI binding', async () => {
    expect((await makeApi({ SCAN_ENABLED: 'on' }).req('GET', '/api/features')).body).toEqual({ vision: false });
  });
  it('answers each row with the amount the model read', async () => {
    const api = on();
    expect((await api.req('GET', '/api/features')).body).toEqual({ vision: true });
    const r = await scan(api, body(crop('items.i1.lineTotal'), crop('total')));
    expect(r.status).toBe(200);
    expect(r.body.answers).toEqual({ 'items.i1.lineTotal': 5500, total: 5500 });
  });
  it('gives null for a row the model could not read', async () => {
    const r = await scan(on({ AI: fakeAi(null) }));
    expect(r.body.answers).toEqual({ 'items.i1.lineTotal': null });
  });
  it('says so when the model fails', async () => {
    const boom = { run: async () => { throw new Error('down'); } } as never;
    expect((await scan(on({ AI: boom }))).status).toBe(502);
  });
  it('rejects malformed row pictures', async () => {
    const api = on();
    expect((await scan(api, { crops: [] })).status).toBe(422);
    expect((await scan(api, body(crop('x', { image: 'not base64!!' })))).status).toBe(422);
    expect((await scan(api, body(crop('x', { candidates: [] })))).status).toBe(422);
    expect((await scan(api, body(crop('x', { candidates: ['5'] })))).status).toBe(422);
    expect((await scan(api, { crops: Array.from({ length: 7 }, () => crop()) })).status).toBe(422);
    expect((await scan(api, {})).status).toBe(422);
  });
  it('accepts bodies above the normal limit but not above the scan limit', async () => {
    const api = on();
    expect((await scan(api, body(crop('a', { image: 'A'.repeat(300_000) }), crop('b', { image: 'A'.repeat(300_000) }), crop('c', { image: 'A'.repeat(300_000) })))).status).toBe(200);
    expect((await scan(api, body(crop('a', { image: 'A'.repeat(2_200_000) })))).status).toBe(413);
  });
  it('stops at the shared daily budget', async () => {
    const api = on({ SCAN_DAILY_CAP: '3', SCAN_USER_MONTHLY: '99' });
    for (let i = 0; i < 3; i++) expect((await scan(api)).status).toBe(200);
    expect((await scan(api)).status).toBe(429);
  });
  it('gives each install a monthly allowance and reports what is left', async () => {
    const api = on({ SCAN_USER_MONTHLY: '2' });
    expect((await api.req('GET', '/api/features', undefined, ID)).body).toEqual({ vision: true, left: 2 });
    expect((await scan(api)).status).toBe(200);
    expect((await api.req('GET', '/api/features', undefined, ID)).body.left).toBe(1);
    expect((await scan(api)).status).toBe(200);
    expect((await scan(api)).status).toBe(429);
    expect((await api.req('GET', '/api/features', undefined, ID)).body.left).toBe(0);
  });
  it('wants an install id', async () => {
    expect((await on().req('POST', '/api/scan', body())).status).toBe(422);
  });
  it('stops a network that keeps making new ids', async () => {
    const api = on({ SCAN_USER_MONTHLY: '1', SCAN_DAILY_CAP: '99' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await scan(api, body(), { 'x-install-id': `install-${String(i).padStart(16, '0')}` })).status);
    expect(codes).toEqual([200, 200, 200, 200, 429]);
  });
  it('stops at the monthly budget for everyone', async () => {
    const api = on({ SCAN_MONTHLY_CAP: '1' });
    expect((await scan(api)).status).toBe(200);
    expect((await scan(api)).status).toBe(429);
  });
});
