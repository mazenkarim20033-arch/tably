import { useMemo, useState } from 'react';
import { allocate, formatAmount } from '@tably/core';

/** Phase 1 design sample only: hard-coded items, no server, no real bill. */
const SAMPLE = {
  store: 'Zooba, Zamalek',
  date: '3 Nov 2026',
  items: [
    { id: 1, name: 'Crispy falafel sandwich', price: 8500 },
    { id: 2, name: 'Koshari bowl', price: 7500 },
    { id: 3, name: 'Fresh mango juice', price: 6000 },
    { id: 4, name: 'Sweet potato fries', price: 5500 },
  ],
  service: 3250,
  tax: 4550,
};

export function App() {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const total = useMemo(() => {
    const sub = SAMPLE.items.reduce((s, i) => s + i.price, 0);
    const mine = SAMPLE.items.filter((i) => picked.has(i.id)).reduce((s, i) => s + i.price, 0);
    if (mine === 0) return 0;
    // Service and tax are shared in proportion to what you picked (largest-remainder keeps cents exact).
    const [svc = 0, tax = 0] = [
      allocate(SAMPLE.service, [mine, sub - mine])[0],
      allocate(SAMPLE.tax, [mine, sub - mine])[0],
    ];
    return mine + svc + tax;
  }, [picked]);

  const toggle = (id: number) =>
    setPicked((p) => {
      const n = new Set(p);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  return (
    <>
      <main className="page">
        <p className="eyebrow">{SAMPLE.date}</p>
        <h1>{SAMPLE.store}</h1>
        <p className="sub">Tap what you had.</p>
        <section className="items" aria-label="Receipt items">
          {SAMPLE.items.map((i) => (
            <button key={i.id} className="item" aria-pressed={picked.has(i.id)} onClick={() => toggle(i.id)}>
              <span className="check" />
              <span className="name">{i.name}</span>
              <span className="price">{formatAmount(i.price)}</span>
            </button>
          ))}
        </section>
        <div className="totals">
          <div><span>Service</span><span>{formatAmount(SAMPLE.service)}</span></div>
          <div><span>Tax</span><span>{formatAmount(SAMPLE.tax)}</span></div>
        </div>
        <p className="note">Design sample (Phase 1). Not a real bill; nothing is saved or paid.</p>
      </main>
      <div className="bar">
        <div className="bar-inner">
          <div className="owe"><small>You owe</small><strong>{formatAmount(total)}</strong></div>
          <button className="pay" disabled={total === 0}>Continue</button>
        </div>
      </div>
    </>
  );
}
