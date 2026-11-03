import { describe, expect, it } from 'vitest';
import { PROVIDERS, WebhookRejected } from '../src/payments';
import { PAYEE, admin, claim, createBill, itemId, join, makeApi, sampleBill, view } from './helpers';

const say = (api: any, t: string, h: any, id: string, note?: string) =>
  api.req('POST', `/api/s/${t}/payments/${id}/paid`, note ? { payer_note: note } : {}, h);
const start = (api: any, t: string, h: any) => api.req('POST', `/api/s/${t}/payments`, { provider: 'manual_instapay' }, h);

describe('hardening', () => {
  it('rejects oversized bodies, declared or chunked, and still accepts normal ones', async () => {
    const api = makeApi();
    expect((await api.req('POST', '/api/bills', sampleBill({ store: 'x'.repeat(400_000) }))).status).toBe(413);
    // No Content-Length: the stream is measured as it arrives.
    const { app } = await import('../src/app');
    const chunk = new TextEncoder().encode('a'.repeat(8192));
    const stream = new ReadableStream({
      start(ctl) {
        for (let i = 0; i < 100; i++) ctl.enqueue(chunk);
        ctl.close();
      },
    });
    const r = await app.request('/api/bills', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.9.9.9' }, body: stream, duplex: 'half' } as RequestInit, api.env);
    expect(r.status).toBe(413);
    expect((await api.req('POST', '/api/bills', sampleBill())).status).toBe(201);
  });

  it('sends security headers, never caches the API, and exposes no docs', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const r = await api.req('GET', `/api/s/${b.share_token}`);
    expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('permissions-policy')).toContain('camera=()');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('strict-transport-security')).toContain('max-age');
    for (const p of ['/docs', '/redoc', '/openapi.json', '/api/docs']) expect((await api.req('GET', p)).status).not.toBe(200);
  });

  it('throttles anyone guessing share links, but never a real link', async () => {
    const api = makeApi();
    const b = await createBill(api);
    for (let i = 0; i < 35; i++) expect((await api.req('GET', `/api/s/real${i}`)).status).toBeLessThanOrEqual(429);
    const blocked = await api.req('GET', '/api/s/another');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();

    const calm = makeApi();
    const ok = await createBill(calm);
    for (let i = 0; i < 40; i++) expect((await calm.req('GET', `/api/s/${ok.share_token}`)).status).toBe(200);
    void b;
  });

  it('throttles bill creation per client', async () => {
    const api = makeApi();
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await api.req('POST', '/api/bills', sampleBill())).status);
    expect(codes.slice(0, 20).every((c) => c === 201)).toBe(true);
    expect(codes[21]).toBe(429);
  });

  it('wrong admin key and wrong id look identical, so ids cannot be probed', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const a = await api.req('GET', `/api/bills/${b.id}`, undefined, { 'x-admin-token': 'wrong' });
    const c = await api.req('GET', '/api/bills/doesnotexist', undefined, { 'x-admin-token': 'wrong' });
    expect(a.status).toBe(404);
    expect(a.body).toEqual(c.body);
  });
});

describe('versions', () => {
  it('moves on every visible change and not on a no-op', async () => {
    const api = makeApi();
    const b = await createBill(api, { payee: PAYEE });
    const t = b.share_token;
    const ver = async () => (await api.req('GET', `/api/s/${t}/version`)).body.version as number;
    const v0 = await ver();
    const a = await join(api, t, 'A');
    const v1 = await ver();
    expect(v1).toBeGreaterThan(v0);
    const fid = itemId(await view(api, t), 'Falafel');
    await claim(api, t, a, fid, 1);
    const v2 = await ver();
    expect(v2).toBeGreaterThan(v1);
    await claim(api, t, a, 'x', 1); // 404, nothing changes
    await api.req('PUT', `/api/s/${t}/claims`, { item_id: itemId(await view(api, t), 'Koshari'), units: 0 }, a); // release nothing
    expect(await ver()).toBe(v2);
    await api.req('POST', `/api/bills/${b.id}/link`, { disabled: true }, admin(b));
    expect((await api.req('GET', `/api/s/${t}/version`)).status).toBe(403);
    expect((await api.req('GET', '/api/s/nope/version')).status).toBe(404);
  });

  it('replaces the link: the old one dies at once, the new one works', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const r = await api.req('POST', `/api/bills/${b.id}/link`, { rotate: true }, admin(b));
    expect((await api.req('GET', `/api/s/${b.share_token}`)).status).toBe(404);
    expect((await api.req('GET', `/api/s/${r.body.share_token}`)).status).toBe(200);
  });
});

describe('money rules', () => {
  it('caps an adjustment at what the beneficiary owes and keeps the total', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const t = b.share_token;
    const [a, c] = [await join(api, t, 'A'), await join(api, t, 'C')];
    const d = await view(api, t);
    await claim(api, t, a, itemId(d, 'Falafel'), 1);
    await claim(api, t, c, itemId(d, 'Koshari'), 1);
    const [pa, pc] = (await view(api, t)).participants;
    const r = await api.req('POST', `/api/bills/${b.id}/transfers`, { payer_id: pa.id, beneficiary_id: pc.id, amount: 99_999_999 }, admin(b));
    expect(r.body.participants.find((p: any) => p.id === pc.id).total).toBe(0);
    const sum = r.body.participants.reduce((s: number, p: any) => s + p.total, 0);
    expect(sum).toBe(pa.total + pc.total);
  });

  it('extras follow each person’s share and the shares sum to the whole bill', async () => {
    const api = makeApi();
    const t = (await createBill(api)).share_token;
    const [a, b2, c] = [await join(api, t, 'A'), await join(api, t, 'B'), await join(api, t, 'C')];
    const d = await view(api, t);
    await claim(api, t, a, itemId(d, 'Falafel'), 1);
    await claim(api, t, b2, itemId(d, 'Koshari'), 1);
    await api.req('PUT', `/api/s/${t}/claims`, { item_id: itemId(d, 'Mango juice'), share: true }, b2);
    await api.req('PUT', `/api/s/${t}/claims`, { item_id: itemId(d, 'Mango juice'), share: true }, c);
    const out = await view(api, t);
    expect(out.totals.unassigned).toBe(0);
    expect(out.participants.reduce((s: number, p: any) => s + p.total, 0)).toBe(out.totals.total);
  });
});

describe('payment edge cases', () => {
  async function paying() {
    const api = makeApi();
    const b = await createBill(api, { payee: PAYEE, tax: 0, service: 0, printed_total: null });
    const t = b.share_token;
    const [a, c] = [await join(api, t, 'A'), await join(api, t, 'C')];
    const pizza = itemId(await view(api, t), 'Mango juice');
    await api.req('PUT', `/api/s/${t}/claims`, { item_id: pizza, share: true }, a);
    await api.req('PUT', `/api/s/${t}/claims`, { item_id: pizza, share: true }, c);
    return { api, b, t, a, c, pizza };
  }

  it('freezes a shared item once one sharer has paid', async () => {
    const { api, t, a, c, pizza } = await paying();
    await start(api, t, a);
    const r = await api.req('PUT', `/api/s/${t}/claims`, { item_id: pizza, share: false }, c);
    expect(r.status).toBe(409);
    expect(r.body.detail.code).toBe('locked');
    const third = await join(api, t, 'D');
    expect((await api.req('PUT', `/api/s/${t}/claims`, { item_id: pizza, share: true }, third)).status).toBe(409);
  });

  it('keeps a payer’s amount fixed even when the others change', async () => {
    const { api, t, a, c } = await paying();
    const p = (await start(api, t, a)).body.payment;
    await api.req('PUT', `/api/s/${t}/claims`, { item_id: itemId(await view(api, t), 'Koshari'), units: 1 }, c);
    const mine = (await view(api, t)).participants.find((x: any) => x.name === 'A');
    expect(mine.total).toBe(p.amount);
    expect(mine.pinned).toBe(true);
  });

  it('an added person has no usable secret, so nobody can act as them', async () => {
    const { api, b, t } = await paying();
    const added = await api.req('POST', `/api/bills/${b.id}/participants`, { name: 'Dad' }, admin(b));
    const pid = added.body.participants.find((p: any) => p.name === 'Dad').id;
    const fid = itemId(await view(api, t), 'Falafel');
    for (const token of ['', 'x', b.share_token, b.admin_token]) {
      const r = await api.req('PUT', `/api/s/${t}/claims`, { item_id: fid, units: 1 }, { 'x-participant-id': pid, 'x-participant-token': token });
      expect(r.status).toBe(401);
    }
  });

  it('provider failure events move a payment to failed; wrong-state events are ignored', async () => {
    PROVIDERS.testpay = {
      key: 'testpay', label: 'T', automated: true, availability: () => ({ enabled: true, reason: '' }),
      verifyWebhook: async (h, raw) => {
        if (h.get('x-sig') !== 's') throw new WebhookRejected('bad');
        return JSON.parse(raw);
      },
    };
    const { api, b, t, a } = await paying();
    const p = (await start(api, t, a)).body.payment;
    api.env.sqlite.exec(`UPDATE payments SET provider = 'testpay' WHERE id = '${p.id}'`);
    const hook = (body: unknown) => api.req('POST', '/api/webhooks/testpay', body, { 'x-sig': 's' });
    expect((await hook({ event_id: 'f1', reference: p.reference, status: 'failed', amount: p.amount, currency: 'EGP' })).body.result).toBe('applied');
    expect((await api.req('GET', `/api/bills/${b.id}`, undefined, admin(b))).body.payments[0].status).toBe('failed');
    // failed -> expired is not a legal move
    expect((await hook({ event_id: 'f2', reference: p.reference, status: 'expired', amount: p.amount, currency: 'EGP' })).body.result).toBe('ignored');
  });
});

describe('the whole journey', () => {
  it('goes from a new bill to a closed one', async () => {
    const api = makeApi();
    const b = await createBill(api, { payee: { payee_name: 'Mazen', instapay_address: 'mazen@instapay' } });
    const t = b.share_token;
    const [sara, omar] = [await join(api, t, 'Sara'), await join(api, t, 'Omar')];
    const d = await view(api, t);
    await claim(api, t, sara, itemId(d, 'Falafel'), 1);
    await claim(api, t, omar, itemId(d, 'Koshari'), 1);
    await claim(api, t, sara, itemId(d, 'Mango juice'), 1);
    await api.req('PUT', `/api/s/${t}/claims`, { item_id: itemId(d, 'Mango juice'), share: true }, omar);
    let v = await view(api, t);
    expect(v.totals.unassigned).toBe(0);

    const pays: any[] = [];
    for (const [name, h] of [['Sara', sara], ['Omar', omar]] as const) {
      const p = (await start(api, t, h)).body.payment;
      pays.push(p);
      expect((await say(api, t, h, p.id, `bank-${name}`)).body.payment.status).toBe('awaiting_confirmation');
    }
    v = await view(api, t);
    expect(v.totals.collected).toBe(0);
    expect(v.totals.awaiting).toBe(pays[0].amount + pays[1].amount);
    expect((await api.req('POST', `/api/bills/${b.id}/close`, {}, admin(b))).status).toBe(409);

    for (const p of pays) expect((await api.req('POST', `/api/bills/${b.id}/payments/${p.id}/confirm`, {}, admin(b))).status).toBe(200);
    v = await view(api, t);
    expect(v.totals.collected).toBe(pays[0].amount + pays[1].amount);
    expect(v.totals.outstanding).toBe(v.totals.total - v.totals.collected);

    const closed = await api.req('POST', `/api/bills/${b.id}/close`, {}, admin(b));
    expect(closed.body.status).toBe('closed');
    expect((await api.req('POST', `/api/s/${t}/participants`, { name: 'TooLate' })).status).toBe(409);
    expect((await claim(api, t, sara, itemId(d, 'Falafel'), 0)).status).toBe(409);

    await api.req('POST', `/api/bills/${b.id}/link`, { disabled: true }, admin(b));
    expect((await api.req('GET', `/api/s/${t}`)).status).toBe(403);
  });
});
