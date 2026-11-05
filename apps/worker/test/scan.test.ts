import { describe, expect, it } from 'vitest';
import { makeApi } from './helpers';

const photo = 'A'.repeat(400);
const reading = { items: [{ name: 'Tea', quantity: 1, amount: '10.00' }], total: '10.00' };
const fakeAi = (response: unknown) => ({ run: async () => ({ response }) }) as never;

describe('AI reading', () => {
  it('is off by default', async () => {
    const api = makeApi();
    expect((await api.req('GET', '/api/features')).body).toEqual({ vision: false });
    expect((await api.req('POST', '/api/scan', { image: photo })).status).toBe(503);
  });
  it('is off when enabled without the AI binding', async () => {
    expect((await makeApi({ SCAN_ENABLED: 'on' }).req('GET', '/api/features')).body).toEqual({ vision: false });
  });
  it('returns the model reading when on', async () => {
    const api = makeApi({ SCAN_ENABLED: 'on', AI: fakeAi(JSON.stringify(reading)) });
    expect((await api.req('GET', '/api/features')).body).toEqual({ vision: true });
    const r = await api.req('POST', '/api/scan', { image: photo });
    expect(r.status).toBe(200);
    expect(r.body.reading.items[0].name).toBe('Tea');
  });
  it('accepts a reply the AI already returned as an object', async () => {
    const api = makeApi({ SCAN_ENABLED: 'on', AI: fakeAi(reading) });
    expect((await api.req('POST', '/api/scan', { image: photo })).status).toBe(200);
  });
  it('says so when the AI answers nonsense or fails', async () => {
    expect((await makeApi({ SCAN_ENABLED: 'on', AI: fakeAi('I cannot help') }).req('POST', '/api/scan', { image: photo })).status).toBe(502);
    const boom = { run: async () => { throw new Error('down'); } } as never;
    expect((await makeApi({ SCAN_ENABLED: 'on', AI: boom }).req('POST', '/api/scan', { image: photo })).status).toBe(502);
  });
  it('rejects things that are not a base64 photo', async () => {
    const api = makeApi({ SCAN_ENABLED: 'on', AI: fakeAi(reading) });
    expect((await api.req('POST', '/api/scan', { image: 'not base64!!' })).status).toBe(422);
    expect((await api.req('POST', '/api/scan', {})).status).toBe(422);
  });
  it('stops at the shared daily budget', async () => {
    const api = makeApi({ SCAN_ENABLED: 'on', AI: fakeAi(reading), SCAN_DAILY_CAP: '3' });
    for (let i = 0; i < 3; i++) expect((await api.req('POST', '/api/scan', { image: photo })).status).toBe(200);
    expect((await api.req('POST', '/api/scan', { image: photo })).status).toBe(429);
  });
  it('accepts bodies above the normal limit but not above the scan limit', async () => {
    const api = makeApi({ SCAN_ENABLED: 'on', AI: fakeAi(reading) });
    expect((await api.req('POST', '/api/scan', { image: 'A'.repeat(1_000_000) })).status).toBe(200);
    expect((await api.req('POST', '/api/scan', { image: 'A'.repeat(2_200_000) })).status).toBe(413);
  });
});
