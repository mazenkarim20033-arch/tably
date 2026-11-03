import { describe, expect, it } from 'vitest';
import { PAYEE, admin, claim, createBill, itemId, join, makeApi, share, view } from './helpers';

const edit = (api: any, b: any, body: unknown) => api.req('PATCH', `/api/bills/${b.id}/receipt`, body, admin(b));
const full = async (api: any, b: any) => (await api.req('GET', `/api/bills/${b.id}`, undefined, admin(b))).body;

describe('receipt editing', () => {
  it('edits items, keeps claims on kept items and drops them with removed ones', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const t = b.share_token;
    const a = await join(api, t, 'A');
    const d = await view(api, t);
    await claim(api, t, a, itemId(d, 'Falafel'), 1);
    await claim(api, t, a, itemId(d, 'Koshari'), 1);
    const r = await edit(api, b, {
      store: 'Zooba 2', tax: 0, service: 0, printed_total: null,
      items: [
        { id: itemId(d, 'Falafel'), description: 'Falafel XL', quantity: 1, line_total: 9000 },
        { description: 'Tea', quantity: 1, line_total: 3000 },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.store).toBe('Zooba 2');
    expect(r.body.items.map((i: any) => i.description)).toEqual(['Falafel XL', 'Tea']);
    expect(r.body.participants[0].items_total).toBe(9000); // Koshari was removed with its claim
    expect(api.env.sqlite.prepare('SELECT COUNT(*) AS n FROM claims').get()).toEqual({ n: 1 });
  });

  it('checks the arithmetic, repeated ids, and claims that no longer fit', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const d = await view(api, b.share_token);
    const a = await join(api, b.share_token, 'A');
    await claim(api, b.share_token, a, itemId(d, 'Mango juice'), 2);
    const mj = itemId(d, 'Mango juice');
    const mismatch = await edit(api, b, { store: 'x', tax: 0, service: 0, printed_total: 999, items: [{ id: mj, description: 'Mango juice', quantity: 2, line_total: 12000 }] });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.detail.code).toBe('mismatch');
    expect((await edit(api, b, { store: 'x', tax: 0, service: 0, items: [{ id: mj, description: 'a', quantity: 2, line_total: 1 }, { id: mj, description: 'b', quantity: 1, line_total: 1 }] })).status).toBe(422);
    const conflict = await edit(api, b, { store: 'x', tax: 0, service: 0, items: [{ id: mj, description: 'Mango juice', quantity: 1, line_total: 6000 }] });
    expect(conflict.status).toBe(409);
    expect(conflict.body.detail.code).toBe('claims_conflict');
    expect((await full(api, b)).items.find((i: any) => i.id === mj).quantity).toBe(2); // nothing was changed
  });

  it('needs the admin key and an open bill', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const body = { store: 'x', tax: 0, service: 0, items: [{ description: 'a', quantity: 1, line_total: 100 }] };
    expect((await api.req('PATCH', `/api/bills/${b.id}/receipt`, body, { 'x-admin-token': 'nope' })).status).toBe(404);
    await api.req('POST', `/api/bills/${b.id}/close`, { force: true }, admin(b));
    const r = await edit(api, b, body);
    expect(r.status).toBe(409);
    expect(r.body.detail.code).toBe('closed');
  });
});

describe('people', () => {
  it('adds a person, assigns for them, and removes them with everything they held', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const d = await view(api, b.share_token);
    const added = await api.req('POST', `/api/bills/${b.id}/participants`, { name: 'Dad' }, admin(b));
    expect(added.status).toBe(201);
    const pid = added.body.participants[0].id;
    expect((await api.req('POST', `/api/bills/${b.id}/participants`, { name: ' dad ' }, admin(b))).status).toBe(409);
    const asg = await api.req('PUT', `/api/bills/${b.id}/participants/${pid}/claims`, { item_id: itemId(d, 'Falafel'), units: 1 }, admin(b));
    expect(asg.status).toBe(200);
    expect(asg.body.participants[0].items_total).toBe(8500);
    expect((await api.req('PUT', `/api/bills/${b.id}/participants/${pid}/claims`, { item_id: 'nope', units: 1 }, admin(b))).status).toBe(404);
    const gone = await api.req('DELETE', `/api/bills/${b.id}/participants/${pid}`, undefined, admin(b));
    expect(gone.status).toBe(200);
    expect(gone.body.participants).toHaveLength(0);
    expect(gone.body.totals.unassigned).toBe(gone.body.totals.total);
    expect(api.env.sqlite.prepare('SELECT COUNT(*) AS n FROM claims').get()).toEqual({ n: 0 });
    expect((await api.req('DELETE', `/api/bills/${b.id}/participants/${pid}`, undefined, admin(b))).status).toBe(404);
  });

  it("cannot remove someone who has started paying, and cannot change their items", async () => {
    const api = makeApi();
    const b = await createBill(api, { payee: PAYEE });
    const t = b.share_token;
    const a = await join(api, t, 'A');
    await claim(api, t, a, itemId(await view(api, t), 'Falafel'), 1);
    await api.req('POST', `/api/s/${t}/payments`, { provider: 'manual_instapay' }, a);
    const pid = (await view(api, t)).participants[0].id;
    expect((await api.req('DELETE', `/api/bills/${b.id}/participants/${pid}`, undefined, admin(b))).status).toBe(409);
    const locked = await api.req('PUT', `/api/bills/${b.id}/participants/${pid}/claims`, { item_id: itemId(await view(api, t), 'Falafel'), units: 0 }, admin(b));
    expect(locked.status).toBe(409);
    expect(locked.body.detail.code).toBe('locked');
  });
});

describe('adjustments', () => {
  it('moves money between two people, and removes it again', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const t = b.share_token;
    const [a, c] = [await join(api, t, 'A'), await join(api, t, 'C')];
    const d = await view(api, t);
    await claim(api, t, a, itemId(d, 'Falafel'), 1);
    await claim(api, t, c, itemId(d, 'Koshari'), 1);
    const [pa, pc] = (await view(api, t)).participants;
    const before = [pa.total, pc.total];
    const r = await api.req('POST', `/api/bills/${b.id}/transfers`, { payer_id: pa.id, beneficiary_id: pc.id, amount: 1000, note: 'lunch' }, admin(b));
    expect(r.status).toBe(201);
    expect(r.body.participants.map((p: any) => p.total)).toEqual([before[0] + 1000, before[1] - 1000]);
    expect(r.body.transfers).toHaveLength(1);
    const gone = await api.req('DELETE', `/api/bills/${b.id}/transfers/${r.body.transfers[0].id}`, undefined, admin(b));
    expect(gone.body.participants.map((p: any) => p.total)).toEqual(before);
    expect((await api.req('DELETE', `/api/bills/${b.id}/transfers/${r.body.transfers[0].id}`, undefined, admin(b))).status).toBe(404);
  });

  it('rejects the same person twice, strangers, and locked people', async () => {
    const api = makeApi();
    const b = await createBill(api, { payee: PAYEE });
    const other = await createBill(api);
    const t = b.share_token;
    const [a, c] = [await join(api, t, 'A'), await join(api, t, 'C')];
    await claim(api, t, a, itemId(await view(api, t), 'Falafel'), 1);
    const [pa, pc] = (await view(api, t)).participants;
    const strangerId = (await api.req('POST', `/api/bills/${other.id}/participants`, { name: 'S' }, admin(other))).body.participants[0].id;
    const t2 = (body: unknown) => api.req('POST', `/api/bills/${b.id}/transfers`, body, admin(b));
    expect((await t2({ payer_id: pa.id, beneficiary_id: pa.id, amount: 1 })).status).toBe(422);
    expect((await t2({ payer_id: pa.id, beneficiary_id: strangerId, amount: 1 })).status).toBe(422);
    expect((await t2({ payer_id: pa.id, beneficiary_id: pc.id, amount: 0 })).status).toBe(422);
    await api.req('POST', `/api/s/${t}/payments`, { provider: 'manual_instapay' }, a);
    expect((await t2({ payer_id: pa.id, beneficiary_id: pc.id, amount: 100 })).status).toBe(409);
    void c;
  });
});

describe('closing, reminders, summaries', () => {
  it('closes only when settled unless forced, and reopens', async () => {
    const api = makeApi();
    const b = await createBill(api, { payee: PAYEE });
    const t = b.share_token;
    const close = (body: unknown = {}) => api.req('POST', `/api/bills/${b.id}/close`, body, admin(b));
    expect((await close()).body.detail.code).toBe('unsettled'); // nobody joined
    const a = await join(api, t, 'A');
    const d = await view(api, t);
    for (const i of d.items) await claim(api, t, a, i.id, i.quantity);
    expect((await close()).body.detail.message).toMatch(/Not confirmed paid yet: A/);
    const p = (await api.req('POST', `/api/s/${t}/payments`, { provider: 'manual_instapay' }, a)).body.payment;
    await api.req('POST', `/api/bills/${b.id}/payments/${p.id}/confirm`, {}, admin(b));
    const done = await close();
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('closed');
    expect((await join(api, t, 'Late').catch((e) => e.message)).toString()).toMatch(/409/); // closed bills take nobody new
    const re = await api.req('POST', `/api/bills/${b.id}/reopen`, undefined, admin(b));
    expect(re.body.status).toBe('open');
    expect((await close({ force: true })).body.status).toBe('closed');
  });

  it('logs reminders for people on this bill only', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const a = await join(api, b.share_token, 'A');
    void a;
    const pid = (await view(api, b.share_token)).participants[0].id;
    const r = await api.req('POST', `/api/bills/${b.id}/reminders`, { participant_ids: [pid, pid, 'nobody'] }, admin(b));
    expect(r.status).toBe(200);
    expect(r.body.participants[0].reminder_count).toBe(1);
    expect(r.body.participants[0].last_reminded_at).toBeTruthy();
    expect((await api.req('POST', `/api/bills/${b.id}/reminders`, { participant_ids: [] }, admin(b))).status).toBe(422);
  });

  it('summarizes the bills whose admin tokens the phone holds, and hides the rest', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const other = await createBill(api);
    await join(api, b.share_token, 'A');
    const r = await api.req('POST', '/api/bills/summaries', {
      bills: [{ id: b.id, admin_token: b.admin_token }, { id: other.id, admin_token: 'wrong' }, { id: 'nope', admin_token: 'x' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.bills[0]).toMatchObject({ id: b.id, store: 'Zooba', status: 'open', people: 1, waiting: 0, link_disabled: false });
    expect(r.body.bills[1]).toEqual({ id: other.id, missing: true });
    expect(r.body.bills[2]).toEqual({ id: 'nope', missing: true });
  });
});

describe('payee', () => {
  it('sets payment details and only allows InstaPay links on allowed hosts', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const put = (body: unknown) => api.req('PUT', `/api/bills/${b.id}/payee`, body, admin(b));
    expect((await put(PAYEE)).body.payee).toMatchObject({ name: 'Mazen', instapay_address: 'mazen@instapay' });
    expect((await put({ payee_name: 'M', instapay_link: 'https://evil.example/pay' })).status).toBe(422);
    expect((await put({ payee_name: 'M', instapay_link: 'https://ipn.eg/S/abc/instapay/1' })).status).toBe(200);
    expect((await put({ payee_name: 'M' })).status).toBe(422);
    expect((await full(api, b)).share_token).toBe(b.share_token);
  });
});
