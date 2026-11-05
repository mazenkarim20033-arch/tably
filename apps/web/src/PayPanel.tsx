import { useEffect, useMemo, useRef, useState } from 'react';
import { formatAmount } from '@tably/core';
import {
  ApiError, cancelPayment, getPayment, markPaid, startPayment, type BillView, type ExtraMethod, type Me, type PaymentDetails,
  type PaymentStatus, type PersonTotal,
} from './api';
import { Tick } from './ui';

/** Plain-language status. "Paid" is shown only for verified payments. */
export const STATUS_LABEL: Record<PaymentStatus | 'unpaid', string> = {
  unpaid: 'Not paid',
  initiated: 'Payment started',
  awaiting_confirmation: 'Waiting for confirmation',
  verified: 'Paid · confirmed',
  failed: 'Not confirmed',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

export const statusOf = (p: PersonTotal): PaymentStatus | 'unpaid' => p.payment?.status ?? 'unpaid';

const plain = (minor: number) => (minor / 100).toFixed(2);

/** One way this creator can be paid, as the friend sees it in the menu. */
interface Option {
  key: string;
  kind: 'instapay' | ExtraMethod['kind'];
  name: string;
  hint: string;
  extra?: ExtraMethod;
}

function optionsFor(bill: BillView): Option[] {
  const p = bill.payee;
  if (!p) return [];
  const out: Option[] = [];
  if (p.instapay_address || p.instapay_phone || p.instapay_link) {
    out.push({ key: 'instapay', kind: 'instapay', name: 'InstaPay', hint: p.instapay_link ? 'Opens InstaPay for you' : 'Send from any bank app' });
  }
  (p.methods ?? []).forEach((m, i) => {
    if (m.kind === 'telda') out.push({ key: `telda${i}`, kind: 'telda', name: 'Telda', hint: m.value ?? '', extra: m });
    else if (m.kind === 'wallet') out.push({ key: `wallet${i}`, kind: 'wallet', name: m.label || 'Mobile wallet', hint: m.value ?? '', extra: m });
    else if (m.kind === 'cash') out.push({ key: `cash${i}`, kind: 'cash', name: 'Cash', hint: 'Pay in person', extra: m });
    else out.push({ key: `other${i}`, kind: 'other', name: m.label || 'Other', hint: m.value ?? '', extra: m });
  });
  return out;
}

function CopyButton({ value, label = 'Copy', onCopied }: { value: string; label?: string; onCopied?: () => void }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copybtn"
      onClick={async () => {
        onCopied?.(); // tapping copy means they are heading to their banking app, whether or not the clipboard allowed it
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch { /* clipboard blocked */ }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

function CopyRow({ label, value, onCopied }: { label: string; value: string; onCopied?: () => void }) {
  return (
    <div className="copyrow">
      <div><small>{label}</small><strong>{value}</strong></div>
      <CopyButton value={value} onCopied={onCopied} />
    </div>
  );
}

/**
 * Paying a friend back. Tapping Pay shows the ways this person accepts (InstaPay, Telda, a wallet, cash...); picking one
 * shows exactly what to do for it. Opening the sheet already starts the payment, so everything is on screen at once:
 * the amount (one tap to copy), the creator's InstaPay link (one tap to open their app with the recipient filled in) or
 * their details, and a single "I've paid" button. Coming back from the banking app brings that button to the top.
 * Nothing is ever marked paid until the creator confirms.
 */
export function PayPanel({ token, me, bill, mine, onClose, onChanged }: {
  token: string; me: Me; bill: BillView; mine: PersonTotal; onClose: () => void; onChanged: () => void;
}) {
  const [details, setDetails] = useState<PaymentDetails | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [returned, setReturned] = useState(false);
  const options = useMemo(() => optionsFor(bill), [bill]);
  // With only one way to pay there is nothing to choose.
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const chosen = options.length === 1 ? options[0]! : options.find((o) => o.key === chosenKey) ?? null;
  const attemptKey = useRef(crypto.randomUUID());
  const wentAway = useRef(false);
  const started = useRef(false);
  const cur = bill.currency;
  const live = mine.payment && ['initiated', 'awaiting_confirmation', 'verified'].includes(mine.payment.status) ? mine.payment : null;
  const status = statusOf(mine);
  const payeeName = bill.payee?.name ?? 'the bill creator';

  // Load the instructions for an open attempt (also after a page reload).
  useEffect(() => {
    if (!live) return;
    getPayment(token, me, live.id).then(setDetails).catch(() => { /* shown via status */ });
  }, [live?.id, live?.status, token, me]);

  async function run(fn: () => Promise<PaymentDetails>) {
    setWorking(true);
    setError(null);
    try {
      setDetails(await fn());
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    }
    setWorking(false);
  }

  // Start the payment as soon as the sheet opens; the key makes a repeat harmless.
  useEffect(() => {
    if (started.current || live || status === 'verified' || status === 'awaiting_confirmation') return;
    started.current = true;
    void run(() => startPayment(token, me, attemptKey.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When they come back from their banking app, put the answer front and centre.
  useEffect(() => {
    const back = () => {
      if (!document.hidden && wentAway.current) {
        wentAway.current = false;
        setReturned(true);
      }
    };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, []);

  const ins = details?.instructions;
  const amount = live?.amount ?? mine.total;
  const away = () => { wentAway.current = true; };
  // The way they paid goes in the note, so the creator knows which app to look in.
  const paidNow = () => {
    if (!live) return;
    const via = chosen ? `via ${chosen.name}` : '';
    const text = [via, note.trim()].filter(Boolean).join(' · ').slice(0, 80);
    return run(() => markPaid(token, me, live.id, text));
  };

  const amountRow = (
    <div className="amountrow">
      <div><small>Amount to send</small><strong>{plain(amount)} <em>{cur}</em></strong></div>
      <CopyButton value={plain(amount)} label="Copy amount" onCopied={away} />
    </div>
  );

  function detailsFor(o: Option) {
    const ref = live && <CopyRow label="Optional note, helps them match it" value={live.reference} onCopied={away} />;
    switch (o.kind) {
      case 'instapay':
        return (
          <>
            {amountRow}
            {ins?.instapay_link ? (
              <a className="primary-btn linkstyle" href={ins.instapay_link} target="_blank" rel="noopener noreferrer" onClick={away}>
                Open InstaPay to pay {payeeName}
              </a>
            ) : null}
            {(ins?.instapay_address || ins?.instapay_phone) && (
              <>
                {ins?.instapay_link && <p className="or">or send to</p>}
                {ins?.instapay_address && <CopyRow label="InstaPay address" value={ins.instapay_address} onCopied={away} />}
                {ins?.instapay_phone && <CopyRow label="Phone number" value={ins.instapay_phone} onCopied={away} />}
              </>
            )}
            {ref}
          </>
        );
      case 'telda':
        return (
          <>
            {amountRow}
            <CopyRow label="Telda tag or number" value={o.extra?.value ?? ''} onCopied={away} />
            <p className="hint">Open Telda, search for {payeeName}, and send exactly this amount.</p>
            {ref}
          </>
        );
      case 'wallet':
        return (
          <>
            {amountRow}
            <CopyRow label={`${o.name} number`} value={o.extra?.value ?? ''} onCopied={away} />
            <p className="hint">Open your wallet app and send exactly this amount to this number.</p>
            {ref}
          </>
        );
      case 'cash':
        return (
          <div className="cashcard">
            <strong>Hand {formatAmount(amount, cur)} to {payeeName}</strong>
            <span>They mark it paid once they have it.</span>
          </div>
        );
      default:
        return (
          <>
            {amountRow}
            <CopyRow label={o.name} value={o.extra?.value ?? ''} onCopied={away} />
            {ref}
          </>
        );
    }
  }

  const needsMenu = options.length > 1 && !chosen;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Pay" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Close">×</button>

        {status === 'verified' && (
          <>
            <Tick tone="success" />
            <h2>Paid · confirmed</h2>
            <p className="sub">{payeeName} confirmed they received {formatAmount(mine.payment!.amount, cur)}. You are all set.</p>
          </>
        )}

        {status === 'awaiting_confirmation' && (
          <>
            <Tick tone="warning" />
            <h2>Waiting for confirmation</h2>
            <p className="sub">
              You said you sent {formatAmount(mine.payment!.amount, cur)}. It counts as paid once {payeeName} sees it in
              their account and confirms.
            </p>
          </>
        )}

        {(status === 'initiated' || status === 'unpaid' || status === 'failed' || status === 'expired' || status === 'cancelled') && (
          <>
            <h2>{needsMenu ? `Pay ${formatAmount(amount, cur)}` : `Send ${formatAmount(amount, cur)}`}</h2>
            {status === 'failed' && <p className="error">{payeeName} could not find your last payment. Send it again or ask them.</p>}
            {status === 'expired' && <p className="error">The last attempt timed out. Here is a fresh one.</p>}

            {needsMenu ? (
              <>
                <p className="sub" style={{ marginTop: -6 }}>How do you want to pay {payeeName}?</p>
                <ul className="methodlist">
                  {options.map((o) => (
                    <li key={o.key}>
                      <button type="button" className="method" onClick={() => setChosenKey(o.key)}>
                        <span className={`mico mico-${o.kind}`} aria-hidden>{o.name.trim()[0]?.toUpperCase()}</span>
                        <span className="mtext"><b>{o.name}</b><small>{o.hint}</small></span>
                        <span className="mgo" aria-hidden>›</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {live && <button className="quiet" disabled={working} onClick={() => run(() => cancelPayment(token, me, live.id))}>Cancel</button>}
              </>
            ) : (
              <>
                {options.length > 1 && (
                  <button type="button" className="linklike backlink" onClick={() => { setChosenKey(null); setReturned(false); }}>‹ Other ways to pay</button>
                )}

                {returned && live && (
                  <div className="ret" role="status">
                    <div><strong>Welcome back.</strong><span>Did you send {formatAmount(live.amount, cur)}?</span></div>
                    <button className="primary-btn" disabled={working} onClick={() => paidNow()}>Yes, I've paid</button>
                    <button className="linklike" onClick={() => setReturned(false)}>Not yet</button>
                  </div>
                )}

                {!ins || !chosen ? (
                  <div className="skeleton sheetskel" aria-hidden><span /><span /></div>
                ) : (
                  <>
                    {detailsFor(chosen)}

                    {chosen.kind !== 'cash' && (
                      <details className="disclosure">
                        <summary>How to pay</summary>
                        <ol className="steps">{ins.steps?.map((s) => <li key={s}>{s}</li>)}</ol>
                        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={60} placeholder="Your bank's reference number (optional)" aria-label="Bank reference" />
                      </details>
                    )}

                    {!returned && live && (
                      <button className="primary" disabled={working} onClick={() => paidNow()}>
                        {chosen.kind === 'cash' ? "I've paid in cash" : "I've paid"}
                      </button>
                    )}
                    {live && (
                      <button className="quiet" disabled={working} onClick={() => run(() => cancelPayment(token, me, live.id))}>
                        Cancel
                      </button>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
