import { useCallback, useEffect, useRef, useState } from 'react';
import { formatAmount } from '@tably/core';
import { PayPanel, statusLabel, statusOf } from "./PayPanel";
import { Av, Brand, niceDate } from './ui';
import { t, useLang } from './i18n';
import { ApiError, cancelPayment, getBill, getVersion, join, setClaim, type BillItem, type BillView, type ClaimChange, type Me } from './api';

const POLL_MS = 4000;
const POLL_SLOW_MS = 15000;

/** What the item rows should look like right after my tap, before the server confirms. Totals wait for the server. */
function withClaim(b: BillView, meId: string, itemId: string, c: ClaimChange): BillView {
  return {
    ...b,
    items: b.items.map((it) => {
      if (it.id !== itemId) return it;
      const others = it.claims.filter((x) => x.participant_id !== meId);
      const mine =
        'share' in c
          ? c.share ? [{ participant_id: meId, units: 0, shared: true }] : []
          : c.units > 0 ? [{ participant_id: meId, units: c.units, shared: false }] : [];
      const claims = [...others, ...mine];
      const exclusive = claims.reduce((s, x) => s + (x.shared ? 0 : x.units), 0);
      return { ...it, claims, exclusive, remaining: claims.some((x) => x.shared) ? 0 : it.quantity - exclusive };
    }),
  };
}

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
  useLang();
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

  // Live updates by polling a one-query version check; the full bill is fetched only when the version moves. The
  // check slows down while nothing changes and pauses while the tab is hidden, to stay inside the free request allowance.
  useEffect(() => {
    void refresh();
    let seen = -1;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let quietSince = Date.now();
    const tick = async () => {
      if (stopped) return;
      if (!document.hidden && busy.current === 0) {
        try {
          const v = await getVersion(token);
          if (seen !== -1 && v.version !== seen) { quietSince = Date.now(); await refresh(); }
          seen = v.version;
        } catch (e) {
          if (e instanceof ApiError && [403, 404, 410].includes(e.status)) setFatal({ status: e.status, message: e.message });
        }
      }
      const quiet = Date.now() - quietSince;
      timer = setTimeout(() => void tick(), quiet > 120_000 ? POLL_SLOW_MS : POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    const onVisible = () => {
      if (document.hidden) return;
      quietSince = Date.now();
      void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
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
    // Show the tap at once; the server's answer (or a reload after an error) replaces this guess.
    setBill((prev) => (prev ? withClaim(prev, me.id, item.id, change) : prev));
    let failed = false;
    try {
      setBill(await setClaim(token, me, item.id, change));
    } catch (e) {
      failed = true;
      if (e instanceof ApiError) {
        setToast(e.code === 'taken' ? t('Someone just took that. Pick something else.') : e.message);
        if (e.status === 401) setMe(null);
      } else {
        setToast(t('Could not reach the server. Check your connection.'));
      }
    } finally {
      busy.current -= 1;
      if (failed) void refresh(); // undo the guess; on success the response above is already the truth
    }
  }

  /** Everything on the bill, split among whoever shares it: the quick way to get an equal split. */
  async function splitAll() {
    if (!me || !bill) return;
    for (const it of bill.items) {
      const mine = it.claims.find((c) => c.participant_id === me.id);
      if (mine?.shared) continue;
      const mineUnits = mine ? mine.units : 0;
      if (it.quantity - (it.exclusive - mineUnits) < 1) continue; // already taken by others
      await change(it, { share: true });
    }
  }

  /** Take back "I've paid" so the items can be changed again. */
  async function undoPaid(paymentId: string) {
    if (!me) return;
    busy.current += 1;
    try {
      await cancelPayment(token, me, paymentId);
      setBill(await getBill(token));
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : t('Could not reach the server. Check your connection.'));
    } finally {
      busy.current -= 1;
    }
  }

  if (fatal) {
    return (
      <main className="page center">
        <Brand />
        <div className="empty">
          <h1>{fatal.status === 410 ? t('This link has expired') : fatal.status === 403 ? t('This link is turned off') : t('Bill not found')}</h1>
          <p className="sub">{fatal.status === 404 ? t('Check the link, or ask for a new one.') : fatal.message}</p>
        </div>
      </main>
    );
  }
  if (!bill) {
    return (
      <main className="page center" aria-busy="true">
        <Brand />
        <div className="skeleton" aria-hidden><span /><span /><span /></div>
        <p className="sub" style={{ textAlign: 'center' }}>{t('Loading the bill…')}</p>
      </main>
    );
  }

  const cur = bill.currency;
  const mine = me ? bill.participants.find((p) => p.id === me.id) : undefined;
  const names = new Map(bill.participants.map((p) => [p.id, p.name]));
  const closed = bill.status !== 'open';

  return (
    <>
      <main className="page">
        <Brand right={bill.date ? <span className="chip">{niceDate(bill.date)}</span> : undefined} />

        <section className="hero">
          <p className="eyebrow">{t('Split the bill')}</p>
          <h1>{bill.store}</h1>
          <div className="hero-row">
            <span className="hero-total">{formatAmount(bill.totals.total, cur)}</span>
            <span className="hero-meta">{bill.items.length === 1 ? t('{n} item', { n: 1 }) : t('{n} items', { n: bill.items.length })}</span>
          </div>
          {bill.participants.length > 0 && (
            <div className="faces">
              <span className="stack">{bill.participants.slice(0, 5).map((p) => <Av key={p.id} name={p.name} size={26} />)}</span>
              <span className="hero-meta">
                {bill.participants.length <= 3
                  ? t('{names} joined', { names: bill.participants.map((p) => p.name).join(', ') })
                  : t('{names} and {n} more joined', { names: bill.participants.slice(0, 2).map((p) => p.name).join(', '), n: bill.participants.length - 2 })}
              </span>
            </div>
          )}
        </section>

        {!me && closed ? (
          <p className="note">{t('This bill is closed.')}</p>
        ) : !me ? (
          <NameForm onJoin={async (name) => {
            const r = await join(token, name);
            const m = { id: r.participant_id, token: r.participant_token, name: r.name };
            saveMe(token, m);
            // Load the bill that already includes this person before showing them as joined.
            setBill(await getBill(token));
            setMe(m);
          }} />
        ) : (
          <>
            <p className="greet">{t('Hi {name}', { name: me.name })} <span aria-hidden>👋</span> {t('Tap what you had.')}</p>
            {!closed && !mine?.pinned && bill.items.length > 0 && (
              <button type="button" className="linklike quicksplit" onClick={() => void splitAll()}>{t('Had a bit of everything? Split it all evenly')}</button>
            )}
          </>
        )}

        {mine?.pinned && mine.payment && (
          <div className="lockcard" role="status">
            {mine.payment.status === 'verified' ? (
              <>
                <strong>{t('Paid · confirmed')}</strong>
                <span>{t('{name} confirmed it. Ask them if something needs to change.', { name: bill.payee?.name ?? t('The bill creator') })}</span>
              </>
            ) : (
              <>
                <strong>{mine.payment.status === 'awaiting_confirmation' ? t("You've said you paid") : t('Your payment has started')}</strong>
                <span>{t('Your items are locked while it stands. Forgot something? Undo it, change your items, then pay again.')}</span>
                <button type="button" className="lockbtn" onClick={() => void undoPaid(mine.payment!.id)}>{t('Undo and edit my items')}</button>
              </>
            )}
          </div>
        )}

        <h2 className="section">{t('Items')}</h2>
        <section className={'items' + (!me ? ' locked' : '')} aria-label={t('Receipt items')}>
          {bill.items.map((i) => (
            <ItemRow key={i.id} item={i} cur={cur} names={names} meId={me?.id} disabled={!me || bill.status !== 'open' || !!mine?.pinned} onChange={(c) => change(i, c)} />
          ))}
        </section>

        <h2 className="section">{t('Totals')}</h2>
        <div className="totals">
          {bill.totals.discounts !== 0 && <div><span>{t('Discounts')}</span><span>{formatAmount(bill.totals.discounts, cur)}</span></div>}
          {bill.totals.service > 0 && <div><span>{t('Service')}</span><span>{formatAmount(bill.totals.service, cur)}</span></div>}
          {bill.totals.tax > 0 && <div><span>{t('Tax')}</span><span>{formatAmount(bill.totals.tax, cur)}</span></div>}
          {bill.totals.tip > 0 && <div><span>{t('Tip')}</span><span>{formatAmount(bill.totals.tip, cur)}</span></div>}
          <div className="strong"><span>{t('Bill total')}</span><span>{formatAmount(bill.totals.total, cur)}</span></div>
        </div>

        <Progress bill={bill} />
        {bill.status === 'closed' && <p className="note">{t('This bill is closed.')}</p>}
      </main>

      {mine && (
        <div className="bar">
          <div className="bar-inner">
            <div className="owe">
              <small>{t('You owe')}</small>
              <strong>{formatAmount(mine.total, cur)}</strong>
              {mine.total > 0 && (
                <span className="breakdown">
                  {t('{amount} items', { amount: formatAmount(mine.items_total, cur) })}
                  {mine.service + mine.tax + mine.tip + mine.discounts !== 0 &&
                    t(' + {amount} share of extras', { amount: formatAmount(mine.service + mine.tax + mine.tip + mine.discounts, cur) })}
                  {mine.adjustment !== 0 &&
                    (mine.adjustment > 0
                      ? t(' + {amount} you are covering', { amount: formatAmount(mine.adjustment, cur) })
                      : t(' − {amount} covered for you', { amount: formatAmount(-mine.adjustment, cur) }))}
                </span>
              )}
            </div>
            {mine.total > 0 && bill.status === "open" && (bill.payee ? (
              <button className={statusOf(mine) === "verified" ? "pay done" : "pay"} onClick={() => setPaying(true)}>
                {statusOf(mine) === "unpaid" || statusOf(mine) === "failed" || statusOf(mine) === "expired" || statusOf(mine) === "cancelled" ? t('Pay') : statusLabel(statusOf(mine))}
              </button>
            ) : (
              <span className="soon">{t('The bill creator has not added payment details yet')}</span>
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
  useLang();
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  return (
    <form
      className="joincard"
      onSubmit={async (e) => {
        e.preventDefault();
        setWorking(true);
        setErr(null);
        try { await onJoin(name.trim()); } catch (x) { setErr(x instanceof Error ? x.message : t('Could not join.')); }
        setWorking(false);
      }}
    >
      <h2>{t('Who are you?')}</h2>
      <p className="sub">{t('Add your name, then tap the items you had. Everyone sees who picked what.')}</p>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Your name')} maxLength={40} autoComplete="given-name" aria-label={t('Your name')} />
      <button type="submit" className="primary-btn" disabled={working || name.trim() === ''}>{working ? t('Joining…') : t('Join and pick items')}</button>
      {err && <p className="error">{err}</p>}
    </form>
  );
}

function ItemRow({ item, cur, names, meId, disabled, onChange }: {
  item: BillItem; cur: string; names: Map<string, string>; meId?: string; disabled: boolean; onChange: (c: ClaimChange) => void;
}) {
  useLang();
  const mine = item.claims.find((c) => c.participant_id === meId);
  const mineUnits = mine && !mine.shared ? mine.units : 0;
  const mineShared = !!mine?.shared;
  const others = item.claims.filter((c) => c.participant_id !== meId);
  const otherSharers = others.filter((c) => c.shared);
  const maxUnits = item.quantity - (item.exclusive - mineUnits) - (otherSharers.length > 0 ? 1 : 0);
  const canShare = item.quantity - (item.exclusive - mineUnits) >= 1;
  const nameOf = (id: string) => names.get(id) ?? "?";

  const holders = [
    ...others.filter((c) => !c.shared).map((c) => ({ name: nameOf(c.participant_id), text: nameOf(c.participant_id) + (item.quantity > 1 ? " ×" + c.units : "") })),
    ...otherSharers.map((c) => ({ name: nameOf(c.participant_id), text: nameOf(c.participant_id) + ' ' + t('(split)') })),
  ];

  const price = <span className="price">{formatAmount(item.line_total, cur)}</span>;
  const label = (
    <span className="name">
      <span className="title">{item.quantity > 1 ? item.quantity + " × " : ""}{item.description}</span>
      {holders.length > 0 && (
        <small className="holders">
          {holders.map((h) => <span key={h.text} className="holder"><Av name={h.name} size={18} />{h.text}</span>)}
        </small>
      )}
    </span>
  );
  const pill = (
    <button className="pill" aria-pressed={mineShared} disabled={disabled || (!mineShared && !canShare)} onClick={() => onChange({ share: !mineShared })}>
      {t('Split')}
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
      <div className={'item' + (selected ? ' on' : '')}>
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
    <div className={'item multi' + (mineUnits > 0 || mineShared ? ' on' : '')}>
      <span className="check" aria-hidden data-on={mineUnits > 0 || mineShared} />
      {label}
      {price}
      <div className="controls">
        <span className="stepper">
          <button aria-label={t('Fewer')} disabled={disabled || mineUnits === 0} onClick={() => onChange({ units: mineUnits - 1 })}>−</button>
          <span aria-live="polite">{mineUnits}</span>
          <button aria-label={t('More')} disabled={disabled || mineUnits >= max} onClick={() => onChange({ units: mineUnits + 1 })}>+</button>
        </span>
        {pill}
      </div>
    </div>
  );
}

function Progress({ bill }: { bill: BillView }) {
  useLang();
  const pct = bill.totals.total ? Math.round((bill.totals.assigned / bill.totals.total) * 100) : 0;
  return (
    <section className="progress">
      <h2 className="section">{t('Who has what')}</h2>
      <div className="track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className="fill" style={{ width: `${pct}%` }} /></div>
      <p className="claimed">
        {bill.totals.unassigned === 0
          ? t('Everything is claimed.')
          : t('{amount} still unclaimed', { amount: formatAmount(bill.totals.unassigned, bill.currency) })}
      </p>
      {bill.totals.collected > 0 && <p className="claimed">{t('{amount} confirmed paid of {total}', { amount: formatAmount(bill.totals.collected, bill.currency), total: formatAmount(bill.totals.total, bill.currency) })}</p>}
      {bill.participants.length > 0 && (
        <ul className="people">
          {bill.participants.map((p) => (
            <li key={p.id}>
              <Av name={p.name} size={34} />
              <span className="who">
                <b>{p.name}</b>
                <span className="subline">
                  {p.payment ? <span className={"badge st-" + p.payment.status}>{statusLabel(statusOf(p))}</span> : <span className="badge st-none">{t('Not paid')}</span>}
                  {p.adjustment !== 0 && <small className="adj">{p.adjustment > 0 ? t('covers {amount} for others', { amount: formatAmount(p.adjustment, bill.currency) }) : t('{amount} covered', { amount: formatAmount(-p.adjustment, bill.currency) })}</small>}
                </span>
              </span>
              <span className="amt">{formatAmount(p.total, bill.currency)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
