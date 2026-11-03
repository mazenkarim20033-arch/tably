import { describe, expect, it } from 'vitest';
import { allocate } from '../src/money';
import { admin, createBill, makeApi, sampleBill, view } from './helpers';

describe('money', () => {
  it('splits exactly and stays exact for huge amounts', () => {
    expect(allocate(10000, [1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(allocate(-101, [3, 5, 7]).reduce((a, b) => a + b, 0)).toBe(-101);
    const big = allocate(9_999_999_999_999, [3, 7, 11]);
    expect(big.reduce((a, b) => a + b, 0)).toBe(9_999_999_999_999);
  });
  it('rejects bad weights', () => {
    expect(() => allocate(100, [0, 0])).toThrow();
    expect(() => allocate(100, [-1, 2])).toThrow();
  });
});

describe('create and view bills', () => {
  it('returns unguessable tokens', async () => {
    const api = makeApi();
    const b = await createBill(api);
    expect(b.share_token.length).toBeGreaterThanOrEqual(32);
    expect(b.admin_token.length).toBeGreaterThanOrEqual(43);
    expect(b.share_token).not.toBe(b.admin_token);
    expect(b.id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('rejects a mismatch unless accepted', async () => {
    const api = makeApi();
    const r = await api.req('POST', '/api/bills', sampleBill({ printed_total: 40000 }));
    expect(r.status).toBe(422);
    expect(r.body.detail.computed_total).toBe(35280);
    expect((await api.req('POST', '/api/bills', sampleBill({ printed_total: 40000, accept_mismatch: true }))).status).toBe(201);
  });

  it('rejects bad input', async () => {
    const api = makeApi();
    for (const bad of [
      sampleBill({ currency: 'egp' }),
      sampleBill({ items: [] }),
      sampleBill({ tax: -5 }),
      { ...sampleBill(), evil: 1 },
      sampleBill({ items: [{ description: 'x', quantity: 0, line_total: 100 }] }),
    ]) {
      expect((await api.req('POST', '/api/bills', bad)).status).toBe(422);
    }
  });

  it('refuses oversized bodies', async () => {
    const api = makeApi();
    const r = await api.req('POST', '/api/bills', sampleBill({ store: 'x'.repeat(400_000) }), { 'content-length': '400000' });
    expect(r.status).toBe(413);
  });

  it('shows the admin view only with the admin key', async () => {
    const api = makeApi();
    const b = await createBill(api);
    expect((await api.req('GET', `/api/bills/${b.id}`)).status).toBe(404);
    expect((await api.req('GET', `/api/bills/${b.id}`, undefined, { 'x-admin-token': b.share_token })).status).toBe(404);
    const ok = await api.req('GET', `/api/bills/${b.id}`, undefined, admin(b));
    expect(ok.status).toBe(200);
    expect(ok.body.share_token).toBe(b.share_token);
  });

  it('leaks no admin data on the public view', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const d = await view(api, b.share_token);
    expect(d.store).toBe('Zooba');
    expect(d.totals.total).toBe(35280);
    const text = JSON.stringify(d);
    expect(text).not.toContain(b.admin_token);
    expect(text).not.toContain(b.id);
    expect(d.share_token).toBeUndefined();
  });

  it('answers 404 for an unknown link and throttles guessing', async () => {
    const api = makeApi();
    expect((await api.req('GET', '/api/s/not-a-real-token')).status).toBe(404);
    const codes: number[] = [];
    for (let i = 0; i < 34; i++) codes.push((await api.req('GET', `/api/s/guess${i}`)).status);
    expect(codes[0]).toBe(404);
    expect(codes.at(-1)).toBe(429);
  });

  it('turns a link off, replaces it, and lets it expire', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const url = `/api/bills/${b.id}/link`;
    expect((await api.req('POST', url, { disabled: true }, admin(b))).status).toBe(200);
    expect((await api.req('GET', `/api/s/${b.share_token}`)).status).toBe(403);
    await api.req('POST', url, { disabled: false }, admin(b));
    expect((await api.req('GET', `/api/s/${b.share_token}`)).status).toBe(200);

    const rotated = (await api.req('POST', url, { rotate: true }, admin(b))).body.share_token;
    expect((await api.req('GET', `/api/s/${b.share_token}`)).status).toBe(404);
    expect((await api.req('GET', `/api/s/${rotated}`)).status).toBe(200);

    api.env.sqlite.prepare('UPDATE bills SET share_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 60_000).toISOString(), b.id);
    expect((await api.req('GET', `/api/s/${rotated}`)).status).toBe(410);
    expect((await api.req('POST', url, { extend_days: 7 }, admin(b))).status).toBe(200);
    expect((await api.req('GET', `/api/s/${rotated}`)).status).toBe(200);
    expect((await api.req('POST', url, { disabled: true })).status).toBe(404); // needs the admin key
  });

  it('sets strict security headers and never caches API answers', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const r = await api.req('GET', `/api/s/${b.share_token}`);
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('strict-transport-security')).toContain('max-age');
  });

  it('exposes a cheap version check that changes with every visible change', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const v0 = (await api.req('GET', `/api/s/${b.share_token}/version`)).body.version;
    await api.req('POST', `/api/s/${b.share_token}/participants`, { name: 'Sara' });
    const v1 = (await api.req('GET', `/api/s/${b.share_token}/version`)).body.version;
    expect(v1).toBeGreaterThan(v0);
    expect((await api.req('GET', '/api/s/nope/version')).status).toBe(404);
  });

  it('accepts a payee, checks the payment link host, and normalizes the address', async () => {
    const api = makeApi();
    const bad = [
      { payee_name: 'M' },
      { payee_name: 'M', instapay_address: 'not an address' },
      { payee_name: 'M', instapay_phone: '123' },
      { payee_name: 'M', instapay_link: 'https://evil.example/pay' },
      { payee_name: 'M', instapay_link: 'http://ipn.eg/x' },
      { payee_name: 'M', instapay_link: 'https://user:pw@ipn.eg/x' },
    ];
    for (const payee of bad) expect((await api.req('POST', '/api/bills', sampleBill({ payee }))).status).toBe(422);
    const ok = await api.req('POST', '/api/bills', sampleBill({ payee: { payee_name: 'Mo', instapay_address: 'MO@instapay', instapay_phone: '01012345678', instapay_link: 'https://ipn.eg/S/mo/instapay/x' } }));
    expect(ok.status).toBe(201);
    expect((await view(api, ok.body.share_token)).payee.instapay_address).toBe('mo@instapay');
  });
});
