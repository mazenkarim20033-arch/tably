import { describe, expect, it } from 'vitest';
import { admin, claim, createBill, itemId, join, makeApi, sampleBill, share, view } from './helpers';

const sum = (d: any) => d.participants.reduce((s: number, p: any) => s + p.total, 0);

describe('joining and claiming', () => {
  it('joins and claims an item with a proportional share of the extras', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const t = b.share_token;
    const alice = await join(api, t, 'Alice');
    const r = await claim(api, t, alice, itemId(await view(api, t), 'Falafel'), 1);
    expect(r.status).toBe(200);
    const me = r.body.participants[0];
    expect(me.items_total).toBe(8500);
    expect(me.tax).toBe(Math.floor((8500 * 3920) / 28000));
    expect(me.total).toBeGreaterThan(8500);
  });

  it('never lets two people take the same exclusive item, and releasing frees it', async () => {
    const api = makeApi();
    const t = (await createBill(api)).share_token;
    const a = await join(api, t, 'Alice');
    const b = await join(api, t, 'Bob');
    const fid = itemId(await view(api, t), 'Falafel');
    expect((await claim(api, t, a, fid, 1)).status).toBe(200);
    const taken = await claim(api, t, b, fid, 1);
    expect(taken.status).toBe(409);
    expect(taken.body.detail.code).toBe('taken');
    expect((await claim(api, t, a, fid, 0)).status).toBe(200);
    expect((await claim(api, t, b, fid, 1)).status).toBe(200);
  });

  it('splits quantity items by units', async () => {
    const api = makeApi();
    const t = (await createBill(api)).share_token;
    const [a, b, c] = [await join(api, t, 'A'), await join(api, t, 'B'), await join(api, t, 'C')];
    const jid = itemId(await view(api, t), 'Mango juice');
    expect((await claim(api, t, a, jid, 1)).status).toBe(200);
    expect((await claim(api, t, b, jid, 1)).status).toBe(200);
    const full = await claim(api, t, c, jid, 1);
    expect(full.status).toBe(409);
    expect(full.body.detail.available).toBe(0);
    expect((await claim(api, t, a, jid, 2)).status).toBe(409);
  });

  it('adds up to the bill total when everything is claimed', async () => {
    const api = makeApi();
    const t = (await createBill(api)).share_token;
    const [a, b, c] = [await join(api, t, 'A'), await join(api, t, 'B'), await join(api, t, 'C')];
    const d = await view(api, t);
    await claim(api, t, a, itemId(d, 'Falafel'), 1);
    await claim(api, t, b, itemId(d, 'Mango juice'), 1);
    await claim(api, t, c, itemId(d, 'Mango juice'), 1);
    const out = (await claim(api, t, c, itemId(d, 'Koshari'), 1)).body;
    expect(out.totals.unassigned).toBe(0);
    expect(sum(out)).toBe(out.totals.total);
    expect(out.totals.total).toBe(35280);
  });

  it('keeps the unclaimed part unassigned', async () => {
    const api = makeApi();
    const t = (await createBill(api)).share_token;
    const a = await join(api, t, 'A');
    const tot = (await claim(api, t, a, itemId(await view(api, t), 'Koshari'), 1)).body.totals;
    expect(tot.assigned + tot.unassigned).toBe(tot.total);
    expect(tot.assigned).toBeGreaterThan(0);
    expect(tot.assigned).toBeLessThan(tot.total);
  });

  it('does not add included tax twice', async () => {
    const api = makeApi();
    const t = (await createBill(api, { tax_included: true, tax: 1000, service: 0, printed_total: 28000 })).share_token;
    const a = await join(api, t, 'A');
    const d = await view(api, t);
    for (const i of d.items) await claim(api, t, a, i.id, i.quantity);
    const f = await view(api, t);
    expect(f.totals.total).toBe(28000);
    expect(f.participants[0].total).toBe(28000);
  });

  it('needs valid participant credentials', async () => {
    const api = makeApi();
    const t = (await createBill(api)).share_token;
    const fid = itemId(await view(api, t), 'Falafel');
    const a = await join(api, t, 'Alice');
    expect((await api.req('PUT', `/api/s/${t}/claims`, { item_id: fid, units: 1 })).status).toBe(401);
    expect((await claim(api, t, { ...a, 'x-participant-token': 'wrong' }, fid, 1)).status).toBe(401);
    const other = await createBill(api);
    expect((await claim(api, other.share_token, a, fid, 1)).status).toBe(401); // a token from another bill
  });

  it('rejects unknown items, bad units, and bodies with both or neither mode', async () => {
    const api = makeApi();
    const t = (await createBill(api)).share_token;
    const a = await join(api, t, 'A');
    const fid = itemId(await view(api, t), 'Falafel');
    expect((await claim(api, t, a, 'nope', 1)).status).toBe(404);
    expect((await claim(api, t, a, fid, -1)).status).toBe(422);
    expect((await claim(api, t, a, fid, 2)).status).toBe(409);
    expect((await api.req('PUT', `/api/s/${t}/claims`, { item_id: fid, units: 1, share: true }, a)).status).toBe(422);
    expect((await api.req('PUT', `/api/s/${t}/claims`, { item_id: fid }, a)).status).toBe(422);
  });

  it('rejects duplicate names regardless of case, and blocks claims on a disabled link', async () => {
    const api = makeApi();
    const b = await createBill(api);
    const t = b.share_token;
    const a = await join(api, t, 'Sara');
    expect((await api.req('POST', `/api/s/${t}/participants`, { name: ' sARA ' })).status).toBe(409);
    const fid = itemId(await view(api, t), 'Falafel');
    await api.req('POST', `/api/bills/${b.id}/link`, { disabled: true }, admin(b));
    expect((await claim(api, t, a, fid, 1)).status).toBe(403);
  });

  it('has exactly one winner when many people race for one item', async () => {
    const api = makeApi();
    const t = (await createBill(api)).share_token;
    const fid = itemId(await view(api, t), 'Falafel');
    const people = [];
    for (let n = 0; n < 12; n++) people.push(await join(api, t, `P${n}`));
    const codes = await Promise.all(people.map((h) => claim(api, t, h, fid, 1).then((r) => r.status)));
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(11);
    const holders = (await view(api, t)).items.find((i: any) => i.id === fid).claims;
    expect(holders).toHaveLength(1);
  });
});

describe('sharing one item', () => {
  const plain = (items: Array<{ description: string; quantity: number; line_total: number }>) =>
    sampleBill({ items, tax: 0, service: 0, printed_total: null });

  it('splits one item exactly between three sharers', async () => {
    const api = makeApi();
    const r = await api.req('POST', '/api/bills', plain([{ description: 'Pizza', quantity: 1, line_total: 10000 }]));
    const t = r.body.share_token;
    const people = [await join(api, t, 'A'), await join(api, t, 'B'), await join(api, t, 'C')];
    const pid = itemId(await view(api, t), 'Pizza');
    for (const h of people) expect((await share(api, t, h, pid)).status).toBe(200);
    const d = await view(api, t);
    expect(d.participants.map((p: any) => p.total)).toEqual([3334, 3333, 3333]);
    expect(d.totals.unassigned).toBe(0);
  });

  it('keeps sharing and exclusive claims from conflicting', async () => {
    const api = makeApi();
    const t = (await api.req('POST', '/api/bills', plain([{ description: 'Pizza', quantity: 1, line_total: 9000 }]))).body.share_token;
    const a = await join(api, t, 'A');
    const b = await join(api, t, 'B');
    const pid = itemId(await view(api, t), 'Pizza');
    expect((await claim(api, t, a, pid, 1)).status).toBe(200);
    expect((await share(api, t, b, pid)).status).toBe(409); // A holds the only unit
    await claim(api, t, a, pid, 0);
    expect((await share(api, t, b, pid)).status).toBe(200);
    expect((await claim(api, t, a, pid, 1)).status).toBe(409); // a sharer exists, so nobody takes the whole item
  });

  it('gives the pool to whoever the exclusive holders leave', async () => {
    const api = makeApi();
    const t = (await api.req('POST', '/api/bills', plain([{ description: 'Wings', quantity: 4, line_total: 40000 }]))).body.share_token;
    const [a, b, c] = [await join(api, t, 'A'), await join(api, t, 'B'), await join(api, t, 'C')];
    const wid = itemId(await view(api, t), 'Wings');
    expect((await claim(api, t, a, wid, 2)).status).toBe(200);
    expect((await share(api, t, b, wid)).status).toBe(200);
    expect((await share(api, t, c, wid)).status).toBe(200);
    const totals = (d: any) => Object.fromEntries(d.participants.map((p: any) => [p.name, p.total]));
    expect(totals(await view(api, t))).toEqual({ A: 20000, B: 10000, C: 10000 });
    expect((await claim(api, t, a, wid, 4)).status).toBe(409);
    expect((await claim(api, t, a, wid, 3)).status).toBe(200);
    expect(totals(await view(api, t))).toEqual({ A: 30000, B: 5000, C: 5000 });
  });

  it('releases the pool when sharers leave, and leaving never drops an exclusive claim', async () => {
    const api = makeApi();
    const t = (await api.req('POST', '/api/bills', plain([{ description: 'Pizza', quantity: 1, line_total: 9000 }]))).body.share_token;
    const a = await join(api, t, 'A');
    const b = await join(api, t, 'B');
    const pid = itemId(await view(api, t), 'Pizza');
    await share(api, t, a, pid);
    await share(api, t, b, pid);
    await share(api, t, a, pid, false);
    expect((await view(api, t)).participants.map((p: any) => p.total)).toEqual([0, 9000]);
    await share(api, t, b, pid, false);
    expect((await view(api, t)).totals.unassigned).toBe(9000);

    await claim(api, t, a, pid, 1);
    await share(api, t, a, pid, false); // leaving the pool must not touch an exclusive claim
    expect((await view(api, t)).participants[0].total).toBe(9000);
  });
});
