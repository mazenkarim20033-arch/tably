import { useCallback, useEffect, useRef, useState } from 'react';
import { formatAmount } from '@tably/core';
import { ApiError, getBill, join, setClaim, type BillItem, type BillView, type Me } from './api';

const POLL_MS = 3000;

function loadMe(token: string): Me | null {
  try {
    const raw = localStorage.getItem(`tably.me.${token}`);
    return raw ? (JSON.parse(raw) as Me) : null;
  } catch {
    return null;
  }
}
function saveMe(token: string, me: Me) {
  try { localStorage.setItem(`tably.me.${token}`, JSON.stringify(me)); } catch { /* private mode */ }
}

export function BillPage({ token }: { token: string }) {
  const [bill, setBill] = useState<BillView | null>(null);
  const [fatal, setFatal] = useState<{ status: number; message: string } | null>(null);
  const [me, setMe] = useState<Me | null>(() => loadMe(token));
  const [toast, setToast] = useState<string | null>(null);
  const busy = useRef(0);

  const refresh = useCallback(async () => {
    if (busy.current > 0) return; // do not overwrite an in-flight change with an older snapshot
    try {
      setBill(await getBill(token));
      setFatal(null);
    } catch (e) {
      if (e instanceof ApiError && [403, 404, 410].includes(e.status)) setFatal({ status: e.status, message: e.message });
    }
  }, [token]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => { if (!document.hidden) void refresh(); }, POLL_MS);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // If the server no longer knows this person (e.g. removed by the creator), ask for a name again.
  useEffect(() => {
    if (bill && me && !bill.participants.some((p) => p.id === me.id)) setMe(null);
  }, [bill, me]);

  async function change(item: BillItem, units: number) {
    if (!me) return;
    busy.current += 1;
    try {
      setBill(await setClaim(token, me, item.id, units));
    } catch (e) {
      if (e instanceof ApiError) {
        setToast(e.code === 'taken' ? 'Someone just took that. Pick something else.' : e.message);
        if (e.status === 401) setMe(null);
      }
    } finally {
      busy.current -= 1;
      void refresh();
    }
  }

  if (fatal) {
    return (
      <main className="page center">
        <h1>{fatal.status === 410 ? 'This link has expired' : fatal.status === 403 ? 'This link is turned off' : 'Bill not found'}</h1>
        <p className="sub">{fatal.status === 404 ? 'Check the link, or ask for a new one.' : fatal.message}</p>
      </main>
    );
  }
  if (!bill) return <main className="page center"><p className="sub">Loading…</p></main>;

  const cur = bill.currency;
  const mine = me ? bill.participants.find((p) => p.id === me.id) : undefined;
  const names = new Map(bill.participants.map((p) => [p.id, p.name]));

  return (
    <>
      <main className="page">
        {bill.date && <p className="eyebrow">{bill.date}</p>}
        <h1>{bill.store}</h1>
        <p className="sub">{me ? `Hi ${me.name}. Tap what you had.` : 'Enter your name to pick your items.'}</p>

        {!me && <NameForm onJoin={async (name) => {
          const r = await join(token, name);
          const m = { id: r.participant_id, token: r.participant_token, name: r.name };
          saveMe(token, m);
          // Load the bill that already includes this person before showing them as joined.
          setBill(await getBill(token));
          setMe(m);
        }} />}

        <section className="items" aria-label="Receipt items">
          {bill.items.map((i) => (
            <ItemRow key={i.id} item={i} cur={cur} names={names} meId={me?.id} disabled={!me || bill.status !== 'open'} onChange={(u) => change(i, u)} />
          ))}
        </section>

        <div className="totals">
          {bill.totals.discounts !== 0 && <div><span>Discounts</span><span>{formatAmount(bill.totals.discounts, cur)}</span></div>}
          {bill.totals.service > 0 && <div><span>Service</span><span>{formatAmount(bill.totals.service, cur)}</span></div>}
          {bill.totals.tax > 0 && <div><span>Tax</span><span>{formatAmount(bill.totals.tax, cur)}</span></div>}
          {bill.totals.tip > 0 && <div><span>Tip</span><span>{formatAmount(bill.totals.tip, cur)}</span></div>}
          <div className="strong"><span>Bill total</span><span>{formatAmount(bill.totals.total, cur)}</span></div>
        </div>

        <Progress bill={bill} />
        {bill.status === 'closed' && <p className="note">This bill is closed.</p>}
      </main>

      {mine && (
        <div className="bar">
          <div className="bar-inner">
            <div className="owe">
              <small>You owe</small>
              <strong>{formatAmount(mine.total, cur)}</strong>
              {mine.total > 0 && (
                <span className="breakdown">
                  {formatAmount(mine.items_total, cur)} items
                  {mine.service + mine.tax + mine.tip + mine.discounts !== 0 &&
                    ` + ${formatAmount(mine.service + mine.tax + mine.tip + mine.discounts, cur)} share of extras`}
                </span>
              )}
            </div>
            <span className="soon">Payment coming soon</span>
          </div>
        </div>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}

function NameForm({ onJoin }: { onJoin: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  return (
    <form
      className="join"
      onSubmit={async (e) => {
        e.preventDefault();
        setWorking(true);
        setErr(null);
        try { await onJoin(name.trim()); } catch (x) { setErr(x instanceof Error ? x.message : 'Could not join.'); }
        setWorking(false);
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" maxLength={40} autoComplete="given-name" aria-label="Your name" />
      <button type="submit" disabled={working || name.trim() === ''}>Join</button>
      {err && <p className="error">{err}</p>}
    </form>
  );
}

function ItemRow({ item, cur, names, meId, disabled, onChange }: {
  item: BillItem; cur: string; names: Map<string, string>; meId?: string; disabled: boolean; onChange: (units: number) => void;
}) {
  const mineUnits = item.claims.find((c) => c.participant_id === meId)?.units ?? 0;
  const others = item.claims.filter((c) => c.participant_id !== meId);
  const full = item.remaining === 0 && mineUnits === 0;
  const holders = others.map((c) => `${names.get(c.participant_id) ?? '?'}${item.quantity > 1 ? ` ×${c.units}` : ''}`).join(', ');

  const label = (
    <span className="name">
      {item.quantity > 1 ? `${item.quantity} × ` : ''}{item.description}
      {holders && <small className="holders">{holders}</small>}
    </span>
  );
  const price = <span className="price">{formatAmount(item.line_total, cur)}</span>;

  if (item.quantity === 1) {
    return (
      <button className="item" aria-pressed={mineUnits === 1} disabled={disabled || full} onClick={() => onChange(mineUnits ? 0 : 1)}>
        <span className="check" />
        {label}
        {price}
      </button>
    );
  }
  const max = mineUnits + item.remaining;
  return (
    <div className="item static">
      <span className="check" aria-hidden data-on={mineUnits > 0} />
      {label}
      <span className="stepper">
        <button aria-label="Fewer" disabled={disabled || mineUnits === 0} onClick={() => onChange(mineUnits - 1)}>−</button>
        <span aria-live="polite">{mineUnits}</span>
        <button aria-label="More" disabled={disabled || mineUnits >= max} onClick={() => onChange(mineUnits + 1)}>+</button>
      </span>
      {price}
    </div>
  );
}

function Progress({ bill }: { bill: BillView }) {
  const pct = bill.totals.total ? Math.round((bill.totals.assigned / bill.totals.total) * 100) : 0;
  return (
    <div className="progress">
      <div className="track"><div className="fill" style={{ width: `${pct}%` }} /></div>
      <p>
        {bill.totals.unassigned === 0
          ? 'Everything is claimed.'
          : `${formatAmount(bill.totals.unassigned, bill.currency)} still unclaimed`}
      </p>
      {bill.participants.length > 0 && (
        <ul className="people">
          {bill.participants.map((p) => (
            <li key={p.id}><span>{p.name}</span><span>{formatAmount(p.total, bill.currency)}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}
