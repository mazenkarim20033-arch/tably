import { useEffect, useRef, useState } from 'react';
import { formatAmount } from '@tably/core';
import {
  ApiError, cancelPayment, getPayment, markPaid, startPayment, type BillView, type Me, type PaymentDetails,
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
 * Paying a friend back, in as few steps as a manual transfer allows. Opening this sheet already starts the payment,
 * so the details are on screen at once: the amount (one tap to copy), the creator's InstaPay link (one tap to open
 * their app with the recipient filled in) or address, and a single "I've paid" button. Coming back from the banking
 * app brings that button to the top. Nothing is ever marked paid until the creator confirms.
 */
export function PayPanel({ token, me, bill, mine, onClose, onChanged }: {
  token: string; me: Me; bill: BillView; mine: PersonTotal; onClose: () => void; onChanged: () => void;
}) {
  const [details, setDetails] = useState<PaymentDetails | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [returned, setReturned] = useState(false);
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
  const paidNow = () => live && run(() => markPaid(token, me, live.id, note.trim()));

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
            <h2>Send {formatAmount(amount, cur)}</h2>
            {status === 'failed' && <p className="error">{payeeName} could not find your last payment. Send it again or ask them.</p>}
            {status === 'expired' && <p className="error">The last attempt timed out. Here is a fresh one.</p>}

            {returned && live && (
              <div className="ret" role="status">
                <div><strong>Welcome back.</strong><span>Did you send {formatAmount(live.amount, cur)}?</span></div>
                <button className="primary-btn" disabled={working} onClick={() => paidNow()}>Yes, I've paid</button>
                <button className="linklike" onClick={() => setReturned(false)}>Not yet</button>
              </div>
            )}

            {!ins ? (
              <div className="skeleton sheetskel" aria-hidden><span /><span /></div>
            ) : (
              <>
                <div className="amountrow">
                  <div><small>Amount to send</small><strong>{plain(live?.amount ?? mine.total)} <em>{cur}</em></strong></div>
                  <CopyButton value={plain(live?.amount ?? mine.total)} label="Copy amount" onCopied={() => { wentAway.current = true; }} />
                </div>

                {ins.instapay_link ? (
                  <a className="primary-btn linkstyle" href={ins.instapay_link} target="_blank" rel="noopener noreferrer" onClick={() => { wentAway.current = true; }}>
                    Open InstaPay to pay {payeeName}
                  </a>
                ) : null}

                {(ins.instapay_address || ins.instapay_phone) && (
                  <>
                    {ins.instapay_link && <p className="or">or send to</p>}
                    {ins.instapay_address && <CopyRow label="InstaPay address" value={ins.instapay_address} onCopied={() => { wentAway.current = true; }} />}
                    {ins.instapay_phone && <CopyRow label="Phone number" value={ins.instapay_phone} onCopied={() => { wentAway.current = true; }} />}
                  </>
                )}

                {live && <CopyRow label="Optional note, helps them match it" value={live.reference} onCopied={() => { wentAway.current = true; }} />}

                <details className="disclosure">
                  <summary>How to pay</summary>
                  <ol className="steps">{ins.steps?.map((s) => <li key={s}>{s}</li>)}</ol>
                  <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={80} placeholder="Your bank's reference number (optional)" aria-label="Bank reference" />
                </details>

                {!returned && live && (
                  <button className="primary" disabled={working} onClick={() => paidNow()}>
                    I've paid
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
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
