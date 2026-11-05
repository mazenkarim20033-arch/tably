import { describe, expect, it } from 'vitest';
import { PAYEE, admin, claim, createBill, itemId, join, makeApi, view } from './helpers';

const TELDA = { kind: 'telda', value: '@mazen' };
const WALLET = { kind: 'wallet', value: '01012345678', label: 'Vodafone Cash' };

describe('other ways to be paid (Telda, wallet, cash)', () => {
  it('lets a creator accept only Telda, with no InstaPay at all', async () => {
    const api = makeApi();
    const b = await createBill(api, { payee: { payee_name: 'Mazen', methods: [TELDA] } });
    const d = await view(api, b.share_token);
    expect(d.payee).toMatchObject({ name: 'Mazen', instapay_address: null, methods: [{ kind: 'telda', value: '@mazen' }] });
  });

  it('shows every method to friends, next to InstaPay', async () => {
    const api = makeApi();
    const b = await createBill(api, { payee: { ...PAYEE, methods: [TELDA, WALLET, { kind: 'cash' }, { kind: 'other', label: 'Fawry', value: '123' }] } });
    const d = await view(api, b.share_token);
    expect(d.payee.instapay_address).toBe('mazen@instapay');
    expect(d.payee.methods.map((m: any) => m.kind)).toEqual(['telda', 'wallet', 'cash', 'other']);
    expect(d.payee.methods[1]).toMatchObject({ label: 'Vodafone Cash', value: '01012345678' });
  });

  it('a bill with only InstaPay shows no extra methods (older bills are unchanged)', async () => {
    const api = makeApi();
    const b = await createBill(api, { payee: PAYEE });
    expect((await view(api, b.share_token)).payee.methods).toEqual([]);
    const none = await createBill(api);
    expect((await view(api, none.share_token)).payee).toBeNull();
  });

  it('a friend can start paying a bill that accepts only cash, and the instructions list the methods', async () => {
    const api = makeApi();
    const b = await createBill(api, { payee: { payee_name: 'Mazen', methods: [{ kind: 'cash' }] } });
    const h = await join(api, b.share_token, 'Alice');
    await claim(api, b.share_token, h, itemId(await view(api, b.share_token), 'Falafel'), 1);
    const r = await api.req('POST', `/api/s/${b.share_token}/payments`, { provider: 'manual_instapay' }, h);
    expect(r.status).toBe(201);
    expect(r.body.instructions.methods).toEqual([{ kind: 'cash' }]);
  });

  it('keeps which way a friend paid, so the creator knows where to look', async () => {
    const api = makeApi();
    const b = await createBill(api, { payee: { ...PAYEE, methods: [TELDA] } });
    const h = await join(api, b.share_token, 'Alice');
    await claim(api, b.share_token, h, itemId(await view(api, b.share_token), 'Falafel'), 1);
    const started = await api.req('POST', `/api/s/${b.share_token}/payments`, { provider: 'manual_instapay' }, h);
    const id = started.body.payment.id;
    await api.req('POST', `/api/s/${b.share_token}/payments/${id}/paid`, { payer_note: 'via Telda' }, h);
    const mine = (await api.req('GET', `/api/bills/${b.id}`, undefined, admin(b))).body.payments;
    expect(mine[0]).toMatchObject({ status: 'awaiting_confirmation', payer_note: 'via Telda' });
  });

  it('rejects a payee with nothing to pay to, a bad wallet number, or a repeated method', async () => {
    const api = makeApi();
    const post = (payee: unknown) => api.req('POST', '/api/bills', { store: 'X', currency: 'EGP', items: [{ description: 'A', quantity: 1, line_total: 1000 }], payee });
    expect((await post({ payee_name: 'Mazen' })).status).toBe(422);
    expect((await post({ payee_name: 'Mazen', methods: [] })).status).toBe(422);
    expect((await post({ payee_name: 'Mazen', methods: [{ kind: 'wallet', value: '12345' }] })).status).toBe(422);
    expect((await post({ payee_name: 'Mazen', methods: [TELDA, { kind: 'telda', value: '@other' }] })).status).toBe(422);
    expect((await post({ payee_name: 'Mazen', methods: [{ kind: 'cash' }, { kind: 'cash' }] })).status).toBe(422);
    expect((await post({ payee_name: 'Mazen', methods: [{ kind: 'bitcoin', value: 'x' }] })).status).toBe(422);
    expect((await post({ payee_name: 'Mazen', methods: Array.from({ length: 7 }, (_, i) => ({ kind: 'other', label: 'L', value: String(i) })) })).status).toBe(422);
  });

  it('accepts Telda by @tag or by phone number', async () => {
    const api = makeApi();
    for (const value of ['@mazen.k', 'mazen_k', '01112345678']) {
      const r = await api.req('POST', '/api/bills', { store: 'X', currency: 'EGP', items: [{ description: 'A', quantity: 1, line_total: 1000 }], payee: { payee_name: 'M', methods: [{ kind: 'telda', value }] } });
      expect(r.status).toBe(201);
    }
  });

  it('the creator can change the ways to pay until someone starts paying', async () => {
    const api = makeApi();
    const b = await createBill(api, { payee: PAYEE });
    const ok = await api.req('PUT', `/api/bills/${b.id}/payee`, { ...PAYEE, methods: [WALLET] }, admin(b));
    expect(ok.status).toBe(200);
    expect((await view(api, b.share_token)).payee.methods).toHaveLength(1);
    const cleared = await api.req('PUT', `/api/bills/${b.id}/payee`, { ...PAYEE, methods: null }, admin(b));
    expect(cleared.status).toBe(200);
    expect((await view(api, b.share_token)).payee.methods).toEqual([]);

    const h = await join(api, b.share_token, 'Alice');
    await claim(api, b.share_token, h, itemId(await view(api, b.share_token), 'Falafel'), 1);
    await api.req('POST', `/api/s/${b.share_token}/payments`, { provider: 'manual_instapay' }, h);
    const locked = await api.req('PUT', `/api/bills/${b.id}/payee`, { ...PAYEE, methods: [TELDA] }, admin(b));
    expect(locked.status).toBe(409);
  });
});
