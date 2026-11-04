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

function CopyRow({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copyrow">
      <div><small>{label}</small><strong>{value}</strong></div>
      <button
        onClick={async () => {
          try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ }
        }}
      >
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function PayPanel({ token, me, bill, mine, onClose, onChanged }: {
  token: string; me: Me; bill: BillView; mine: PersonTotal; onClose: () => void; onChanged: () => void;
}) {
  const [details, setDetails] = useState<PaymentDetails | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const attemptKey = useRef(crypto.randomUUID());
  const cur = bill.currency;
  const live = mine.payment && ['initiated', 'awaiting_confirmation', 'verified'].includes(mine.payment.status) ? mine.payment : null;
  const status = statusOf(mine);

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

  const payee = bill.payee;
  const ins = details?.instructions;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Pay" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Close">×</button>

        {status === 'verified' && (
          <>
            <Tick tone="success" />
            <h2>Paid · confirmed</h2>
            <p className="sub">{payee?.name ?? 'The bill creator'} confirmed they received {formatAmount(mine.payment!.amount, cur)}. You are all set.</p>
          </>
        )}

        {status === 'awaiting_confirmation' && (
          <>
            <Tick tone="warning" />
            <h2>Waiting for confirmation</h2>
            <p className="sub">
              You said you sent {formatAmount(mine.payment!.amount, cur)}. This is <b>not confirmed yet</b>: it counts as paid only
              after {payee?.name ?? 'the bill creator'} checks their account and confirms.
            </p>
            {mine.payment && <CopyRow label="Reference you used" value={mine.payment.reference} />}
          </>
        )}

        {(status === 'initiated' || status === 'unpaid' || status === 'failed' || status === 'expired' || status === 'cancelled') && (
          <>
            <h2>Pay {formatAmount(live?.amount ?? mine.total, cur)}</h2>
            {status === 'failed' && <p className="error">{payee?.name ?? 'The bill creator'} could not find this payment. You can try again or ask them.</p>}
            {status === 'expired' && <p className="error">That attempt timed out. Start again when you are ready to pay.</p>}

            {!live && (
              <>
                <p className="sub">You send this to {payee?.name ?? 'the bill creator'} from your own banking app. TABLY never touches your money or your bank login.</p>
                <button className="primary" disabled={working} onClick={() => run(() => startPayment(token, me, attemptKey.current))}>
                  Show payment details
                </button>
              </>
            )}

            {live && ins && (
              <>
                <p className="sub">Send exactly {formatAmount(live.amount, cur)} to {ins.payee_name ?? 'the bill creator'}:</p>
                {ins.instapay_address && <CopyRow label="InstaPay address" value={ins.instapay_address} />}
                {ins.instapay_phone && <CopyRow label="Phone number" value={ins.instapay_phone} />}
                <CopyRow label="Put this in the transfer note" value={live.reference} />
                {ins.instapay_link && (
                  <a className="linkbtn" href={ins.instapay_link} target="_blank" rel="noopener noreferrer">
                    Open payment link ({new URL(ins.instapay_link).hostname})
                  </a>
                )}
                <ol className="steps">{ins.steps?.map((s) => <li key={s}>{s}</li>)}</ol>
                <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={80} placeholder="Your bank's reference number (optional)" aria-label="Bank reference" />
                <button className="primary" disabled={working} onClick={() => run(() => markPaid(token, me, live.id, note.trim()))}>
                  I've paid
                </button>
                <button className="quiet" disabled={working} onClick={() => run(() => cancelPayment(token, me, live.id))}>
                  Cancel
                </button>
              </>
            )}
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
