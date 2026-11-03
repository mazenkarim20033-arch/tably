import { useCallback, useEffect, useRef, useState } from 'react';
import { formatAmount } from '@tably/core';
import { PayPanel, STATUS_LABEL, statusOf } from "./PayPanel";
import { ApiError, getBill, join, setClaim, type BillItem, type BillView, type ClaimChange, type Me } from './api';

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
  const [paying, setPaying] = useState(false);
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

  // Live updates: the server announces changes over SSE and we refetch. Polling stays as a safety net
  // (fast while the stream is down, slow while it is up).
  useEffect(() => {
    void refresh();
    let live = false;
    let es: EventSource | null = null;
    if (typeof EventSource !== 'undefined') {
      es = new EventSource(`/api/s/${encodeURIComponent(token)}/events`);
      es.addEventListener('ready', () => { live = true; });
      es.addEventListener('changed', () => { void refresh(); });
      es.addEventListener('gone', () => { live = false; void refresh(); });
      es.onerror = () => { live = false; }; // the browser reconnects by itself
    }
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      if (document.hidden) return;
      if (!live || n % 7 === 0) void refresh();
    }, POLL_MS);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      es?.close();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, token]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // If the server no longer knows this person (e.g. removed by the creator), ask for a name again.
  useEffect(() => {
    if (bill && me && !bill.participants.some((p) => p.id === me.id)) setMe(null);
  }, [bill, me]);

  async function change(item: BillItem, change: ClaimChange) {
    if (!me) return;
    busy.current += 1;
    try {
      setBill(await setClaim(token, me, item.id, change));
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
            <ItemRow key={i.id} item={i} cur={cur} names={names} meId={me?.id} disabled={!me || bill.status !== 'open'} onChange={(c) => change(i, c)} />
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
                  {mine.adjustment !== 0 &&
                    (mine.adjustment > 0
                      ? ` + ${formatAmount(mine.adjustment, cur)} you are covering`
                      : ` − ${formatAmount(-mine.adjustment, cur)} covered for you`)}
                </span>
              )}
            </div>
            {mine.total > 0 && bill.status === "open" && (bill.payee ? (
              <button className={statusOf(mine) === "verified" ? "pay done" : "pay"} onClick={() => setPaying(true)}>
                {statusOf(mine) === "unpaid" || statusOf(mine) === "failed" || statusOf(mine) === "expired" || statusOf(mine) === "cancelled" ? "Pay" : STATUS_LABEL[statusOf(mine)]}
              </button>
            ) : (
              <span className="soon">The bill creator has not added payment details yet</span>
            ))}
          </div>
        </div>
      )}
      {paying && me && mine && <PayPanel token={token} me={me} bill={bill} mine={mine} onClose={() => setPaying(false)} onChanged={() => void refresh()} />}
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
  item: BillItem; cur: string; names: Map<string, string>; meId?: string; disabled: boolean; onChange: (c: ClaimChange) => void;
}) {
  const mine = item.claims.find((c) => c.participant_id === meId);
  const mineUnits = mine && !mine.shared ? mine.units : 0;
  const mineShared = !!mine?.shared;
  const others = item.claims.filter((c) => c.participant_id !== meId);
  const otherSharers = others.filter((c) => c.shared);
  const maxUnits = item.quantity - (item.exclusive - mineUnits) - (otherSharers.length > 0 ? 1 : 0);
  const canShare = item.quantity - (item.exclusive - mineUnits) >= 1;
  const nameOf = (id: string) => names.get(id) ?? "?";

  const holders = [
    ...others.filter((c) => !c.shared).map((c) => nameOf(c.participant_id) + (item.quantity > 1 ? " ×" + c.units : "")),
    ...(otherSharers.length ? ["split: " + otherSharers.map((c) => nameOf(c.participant_id)).join(", ")] : []),
  ].join(" · ");

  const price = <span className="price">{formatAmount(item.line_total, cur)}</span>;
  const label = (
    <span className="name">
      {item.quantity > 1 ? item.quantity + " × " : ""}{item.description}
      {holders && <small className="holders">{holders}</small>}
    </span>
  );
  const pill = (
    <button className="pill" aria-pressed={mineShared} disabled={disabled || (!mineShared && !canShare)} onClick={() => onChange({ share: !mineShared })}>
      Split
    </button>
  );

  if (item.quantity === 1) {
    const selected = mineUnits === 1 || mineShared;
    const canTake = maxUnits >= 1;
    const tap = () => {
      if (mineShared) onChange({ share: false });
      else if (mineUnits) onChange({ units: 0 });
      else if (canTake) onChange({ units: 1 });
      else onChange({ share: true }); // the item is already being split, so tapping joins the split
    };
    return (
      <div className="item">
        <button className="pick" aria-pressed={selected} disabled={disabled || (!selected && !canTake && !canShare)} onClick={tap}>
          <span className="check" />
          {label}
        </button>
        {pill}
        {price}
      </div>
    );
  }
  const max = Math.max(maxUnits, mineUnits);
  return (
    <div className="item multi">
      <span className="check" aria-hidden data-on={mineUnits > 0 || mineShared} />
      {label}
      {price}
      <div className="controls">
        <span className="stepper">
          <button aria-label="Fewer" disabled={disabled || mineUnits === 0} onClick={() => onChange({ units: mineUnits - 1 })}>−</button>
          <span aria-live="polite">{mineUnits}</span>
          <button aria-label="More" disabled={disabled || mineUnits >= max} onClick={() => onChange({ units: mineUnits + 1 })}>+</button>
        </span>
        {pill}
      </div>
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
      {bill.totals.collected > 0 && <p>{formatAmount(bill.totals.collected, bill.currency)} confirmed paid of {formatAmount(bill.totals.total, bill.currency)}</p>}
      {bill.participants.length > 0 && (
        <ul className="people">
          {bill.participants.map((p) => (
            <li key={p.id}><span>{p.name}{p.payment && <small className={"st st-" + p.payment.status}>{" · " + STATUS_LABEL[statusOf(p)]}</small>}{p.adjustment !== 0 && <small className="adj">{p.adjustment > 0 ? " covers " + formatAmount(p.adjustment, bill.currency) + " for others" : " · " + formatAmount(-p.adjustment, bill.currency) + " covered"}</small>}</span><span>{formatAmount(p.total, bill.currency)}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}
