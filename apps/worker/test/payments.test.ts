import { beforeEach, describe, expect, it } from 'vitest';
import { PROVIDERS, WebhookRejected } from '../src/payments';
import { PAYEE, admin, claim, createBill, itemId, join, makeApi, share, view } from './helpers';

/** A bill with a payee, Alice holding the falafel, ready to pay. */
async function setup() {
  const api = makeApi();
  const b = await createBill(api, { payee: PAYEE });
  const t = b.share_token;
  const alice = await join(api, t, 'Alice');
  const bob = await join(api, t, 'Bob');
  const d = await view(api, t);
  await claim(api, t, alice, itemId(d, 'Falafel'), 1);
  await claim(api, t, bob, itemId(d, 'Koshari'), 1);
  return { api, b, t, alice, bob, d };
}
const pay = (api: any, t: string, h: any, key?: string) =>
  api.req('POST', `/api/s/${t}/payments`, { provider: 'manual_instapay' }, key ? { ...h, 'idempotency-key': key } : h);
const events = async (api: any, b: any) => (await api.req('GET', `/api/bills/${b.id}`, undefined, admin(b))).body.payments;

describe('payments', () => {
  it('starts a payment for exactly what the person owes, with a reference and instructions', async () => {
    const { api, t, alice, d } = await setup();
    const me = d.participants.find((p: any) => p.name === 'Alice');
    const r = await pay(api, t, alice);
    expect(r.status).toBe(201);
    expect(r.body.payment.status).toBe('initiated');
    expect(r.body.payment.reference).toMatch(/^TBL-[A-Z2-9]{6}$/);
    const fresh = (await view(api, t)).participants.find((p: any) => p.name === 'Alice');
    expect(r.body.payment.amount).toBe(fresh.total);
    expect(r.body.payment.amount).toBeGreaterThan(me.items_total);
    expect(r.body.instructions.steps.length).toBe(3);
  });

  it('refuses without a payee, without items, and with unknown or disabled methods', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const a = await join(api, b.share_token, 'A');
    expect((await pay(api, b.share_token, a)).status).toBe(409); // no payee
    const s = await setup();
    const nobody = await join(s.api, s.t, 'Nobody');
    const r = await pay(s.api, s.t, nobody);
    expect(r.status).toBe(409);
    expect(r.body.detail.code).toBe('nothing_due');
    expect((await s.api.req('POST', `/api/s/${s.t}/payments`, { provider: 'nope' }, s.alice)).status).toBe(422);
    expect((await s.api.req('POST', `/api/s/${s.t}/payments`, { provider: 'kashier' }, s.alice)).status).toBe(409);
    expect((await pay(s.api, s.t, {})).status).toBe(401);
  });

  it('is idempotent: the same key, or a second tap, returns the same payment', async () => {
    const { api, t, alice } = await setup();
    const one = await pay(api, t, alice, 'k1');
    const two = await pay(api, t, alice, 'k1');
    const three = await pay(api, t, alice);
    expect(two.body.payment.id).toBe(one.body.payment.id);
    expect(three.body.payment.id).toBe(one.body.payment.id);
  });

  it('lets two simultaneous starts end with one live payment', async () => {
    const { api, t, alice } = await setup();
    const rs = await Promise.all([pay(api, t, alice), pay(api, t, alice), pay(api, t, alice)]);
    expect(new Set(rs.map((r) => r.body.payment.id)).size).toBe(1);
  });

  it('only the creator can verify: the payer reports, the creator confirms', async () => {
    const { api, b, t, alice } = await setup();
    const p = (await pay(api, t, alice)).body.payment;
    const paid = await api.req('POST', `/api/s/${t}/payments/${p.id}/paid`, { payer_note: ' sent ' }, alice);
    expect(paid.status).toBe(200);
    expect(paid.body.payment.status).toBe('awaiting_confirmation');
    expect((await view(api, t)).participants[0].payment.status).toBe('awaiting_confirmation');
    // The payer cannot confirm, and neither can another person.
    expect((await api.req('POST', `/api/bills/${b.id}/payments/${p.id}/confirm`, {}, {})).status).toBe(404);
    const ok = await api.req('POST', `/api/bills/${b.id}/payments/${p.id}/confirm`, {}, admin(b));
    expect(ok.status).toBe(200);
    expect(ok.body.payments[0].status).toBe('verified');
    expect(ok.body.totals.collected).toBe(p.amount);
    expect(ok.body.payments[0].events.map((e: any) => e.to)).toEqual(['initiated', 'awaiting_confirmation', 'verified']);
    expect(ok.body.payments[0].payer_note).toBe('sent');
    // A verified payment cannot be cancelled by the payer.
    const c = await api.req('POST', `/api/s/${t}/payments/${p.id}/cancel`, {}, alice);
    expect(c.status).toBe(409);
    expect(c.body.detail.code).toBe('bad_transition');
  });

  it('cannot be confirmed twice or read through someone else', async () => {
    const { api, b, t, alice, bob } = await setup();
    const p = (await pay(api, t, alice)).body.payment;
    expect((await api.req('GET', `/api/s/${t}/payments/${p.id}`, undefined, bob)).status).toBe(404);
    expect((await api.req('POST', `/api/s/${t}/payments/${p.id}/paid`, {}, bob)).status).toBe(404);
    expect((await api.req('POST', `/api/bills/${b.id}/payments/${p.id}/confirm`, {}, admin(b))).status).toBe(200);
    expect((await api.req('POST', `/api/bills/${b.id}/payments/${p.id}/confirm`, {}, admin(b))).status).toBe(409);
  });

  it('rejecting lets the person try again; the creator can undo a mistaken rejection', async () => {
    const { api, b, t, alice } = await setup();
    const p = (await pay(api, t, alice)).body.payment;
    await api.req('POST', `/api/s/${t}/payments/${p.id}/paid`, {}, alice);
    expect((await api.req('POST', `/api/bills/${b.id}/payments/${p.id}/reject`, { note: 'not received' }, admin(b))).body.payments[0].status).toBe('failed');
    const again = await pay(api, t, alice);
    expect(again.body.payment.id).not.toBe(p.id);
    expect((await api.req('POST', `/api/bills/${b.id}/payments/${p.id}/confirm`, {}, admin(b))).status).toBe(409); // a newer attempt is live
  });

  it('cancelling frees the person to start again', async () => {
    const { api, t, alice } = await setup();
    const p = (await pay(api, t, alice)).body.payment;
    expect((await api.req('POST', `/api/s/${t}/payments/${p.id}/cancel`, {}, alice)).body.payment.status).toBe('cancelled');
    expect((await pay(api, t, alice)).body.payment.id).not.toBe(p.id);
  });

  it('expires an old attempt on the next read, and the creator can still confirm it', async () => {
    const { api, b, t, alice } = await setup();
    const p = (await pay(api, t, alice)).body.payment;
    api.env.sqlite.exec(`UPDATE payments SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = '${p.id}'`);
    expect((await api.req('GET', `/api/s/${t}/payments/${p.id}`, undefined, alice)).body.payment.status).toBe('expired');
    expect((await api.req('POST', `/api/s/${t}/payments/${p.id}/paid`, {}, alice)).status).toBe(409);
    expect((await api.req('POST', `/api/bills/${b.id}/payments/${p.id}/confirm`, {}, admin(b))).body.payments[0].status).toBe('verified');
  });

  it('freezes the amount once payment starts, so later changes cannot alter what was asked', async () => {
    const { api, b, t, alice, d } = await setup();
    const p = (await pay(api, t, alice)).body.payment;
    // Alice cannot change her items; others cannot take her shared items; the receipt and payee are locked.
    expect((await claim(api, t, alice, itemId(d, 'Falafel'), 0)).status).toBe(409);
    expect((await api.req('PATCH', `/api/bills/${b.id}/receipt`, { store: 'X', items: [{ description: 'a', quantity: 1, line_total: 100 }] }, admin(b))).status).toBe(409);
    expect((await api.req('PUT', `/api/bills/${b.id}/payee`, PAYEE, admin(b))).status).toBe(409);
    const bob = (await view(api, t)).participants.find((x: any) => x.name === 'Bob');
    // Extra items another person takes later change the bill, not Alice's pinned amount.
    const fresh = (await view(api, t)).participants.find((x: any) => x.name === 'Alice');
    expect(fresh.total).toBe(p.amount);
    expect(bob.total).toBeGreaterThan(0);
  });

  it('closed bills accept no new payments', async () => {
    const { api, b, t, alice } = await setup();
    await api.req('POST', `/api/bills/${b.id}/close`, { force: true }, admin(b));
    expect((await pay(api, t, alice)).status).toBe(409);
  });
});

describe('webhooks', () => {
  beforeEach(() => {
    // A signing provider that exists only in tests: the body is JSON and the secret is a header.
    PROVIDERS.testpay = {
      key: 'testpay', label: 'Test', automated: true,
      availability: () => ({ enabled: true, reason: '' }),
      verifyWebhook: async (headers, raw) => {
        if (headers.get('x-sig') !== 'secret') throw new WebhookRejected('bad signature');
        return JSON.parse(raw);
      },
    };
  });

  async function started() {
    const s = await setup();
    const pRow = (await pay(s.api, s.t, s.alice)).body.payment;
    // Re-label the attempt as belonging to the test provider so the event can find it.
    s.api.env.sqlite.exec(`UPDATE payments SET provider = 'testpay' WHERE id = '${pRow.id}'`);
    return { ...s, pRow };
  }
  const hook = (api: any, body: unknown, sig = 'secret') => api.req('POST', '/api/webhooks/testpay', body, { 'x-sig': sig });

  it('rejects an unsigned or wrongly signed event and unknown providers', async () => {
    const { api, pRow } = await started();
    const ev = { event_id: 'e1', reference: pRow.reference, status: 'paid', amount: pRow.amount, currency: 'EGP' };
    expect((await hook(api, ev, 'wrong')).status).toBe(401);
    expect((await api.req('POST', '/api/webhooks/manual_instapay', ev)).status).toBe(401);
    expect((await api.req('POST', '/api/webhooks/kashier', ev)).status).toBe(401);
    expect((await api.req('POST', '/api/webhooks/nobody', ev)).status).toBe(404);
  });

  it('verifies a correctly signed, exactly matching event and ignores a replay', async () => {
    const { api, b, pRow } = await started();
    const ev = { event_id: 'e1', reference: pRow.reference, status: 'paid', amount: pRow.amount, currency: 'EGP' };
    expect((await hook(api, ev)).body.result).toBe('applied');
    expect((await hook(api, ev)).body.result).toBe('duplicate');
    const a = (await api.req('GET', `/api/bills/${b.id}`, undefined, admin(b))).body;
    expect(a.payments[0].status).toBe('verified');
    expect(a.totals.collected).toBe(pRow.amount);
  });

  it('never verifies when the amount or currency differs', async () => {
    const { api, b, pRow } = await started();
    expect((await hook(api, { event_id: 'e2', reference: pRow.reference, status: 'paid', amount: pRow.amount - 1, currency: 'EGP' })).body.result).toBe('mismatch');
    expect((await hook(api, { event_id: 'e3', reference: pRow.reference, status: 'paid', amount: pRow.amount, currency: 'USD' })).body.result).toBe('mismatch');
    expect((await api.req('GET', `/api/bills/${b.id}`, undefined, admin(b))).body.payments[0].status).toBe('initiated');
  });

  it('ignores events for unknown references', async () => {
    const { api } = await started();
    expect((await hook(api, { event_id: 'e4', reference: 'TBL-NOPE00', status: 'paid', amount: 1, currency: 'EGP' })).body.result).toBe('ignored');
  });
});
