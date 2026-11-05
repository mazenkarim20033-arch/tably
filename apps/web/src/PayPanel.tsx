import { useEffect, useMemo, useRef, useState } from 'react';
import { formatAmount } from '@tably/core';
import {
  ApiError, cancelPayment, markPaid, startPayment, type BillView, type ExtraMethod, type Me, type PaymentStatus, type PersonTotal,
} from './api';
import { Tick } from './ui';
import { t, useLang } from './i18n';

/** Plain-language status. "Paid" is shown only for verified payments. */
export const statusLabel = (s: PaymentStatus | 'unpaid'): string =>
  ({
    unpaid: t('Not paid'),
    initiated: t('Payment started'),
    awaiting_confirmation: t('Waiting for confirmation'),
    verified: t('Paid · confirmed'),
    failed: t('Not confirmed'),
    expired: t('Expired'),
    cancelled: t('Cancelled'),
  })[s];

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
    out.push({ key: 'instapay', kind: 'instapay', name: 'InstaPay', hint: p.instapay_link ? t('Opens InstaPay for you') : t('Send from any bank app') });
  }
  (p.methods ?? []).forEach((m, i) => {
    if (m.kind === 'telda') out.push({ key: `telda${i}`, kind: 'telda', name: 'Telda', hint: m.value ?? '', extra: m });
    else if (m.kind === 'wallet') out.push({ key: `wallet${i}`, kind: 'wallet', name: m.label || t('Mobile wallet'), hint: m.value ?? '', extra: m });
    else if (m.kind === 'cash') out.push({ key: `cash${i}`, kind: 'cash', name: t('Cash'), hint: t('Pay in person'), extra: m });
    else out.push({ key: `other${i}`, kind: 'other', name: m.label || t('Other'), hint: m.value ?? '', extra: m });
  });
  return out;
}

function CopyButton({ value, label = t('Copy'), onCopied }: { value: string; label?: string; onCopied?: () => void }) {
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
      {done ? t('Copied') : label}
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
 * Paying a friend back. Tapping Pay lists the ways this person accepts (InstaPay, Telda, a wallet, cash...); picking one
 * shows exactly what to do for it: the amount (one tap to copy), the creator's InstaPay link (one tap to open their
 * app with the recipient filled in) or their details. Looking at this locks nothing: the payment, and with it the
 * person's items, is only locked when they tap "I've paid", and they can undo that until the creator confirms.
 */
export function PayPanel({ token, me, bill, mine, onClose, onChanged }: {
  token: string; me: Me; bill: BillView; mine: PersonTotal; onClose: () => void; onChanged: () => void;
}) {
  useLang();
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
  const cur = bill.currency;
  const live = mine.payment && ['initiated', 'awaiting_confirmation', 'verified'].includes(mine.payment.status) ? mine.payment : null;
  const status = statusOf(mine);
  const payee = bill.payee;
  const payeeName = payee?.name ?? t('The bill creator');
  const amount = live?.amount ?? mine.total;
  const away = () => { wentAway.current = true; };

  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setWorking(true);
    setError(null);
    try {
      await fn();
      onChanged();
      after?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Something went wrong. Please try again.'));
    }
    setWorking(false);
  }

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

  // Only now does anything lock. The way they paid goes in the note, so the creator knows which app to look in.
  const paidNow = () => {
    const via = chosen ? `via ${chosen.name}` : '';
    const text = [via, note.trim()].filter(Boolean).join(' · ').slice(0, 80);
    return run(async () => {
      const id = live?.id ?? (await startPayment(token, me, attemptKey.current)).payment.id;
      await markPaid(token, me, id, text);
    });
  };

  const amountRow = (
    <div className="amountrow">
      <div><small>{t('Amount to send')}</small><strong>{plain(amount)} <em>{cur}</em></strong></div>
      <CopyButton value={plain(amount)} label={t('Copy amount')} onCopied={away} />
    </div>
  );

  function detailsFor(o: Option) {
    switch (o.kind) {
      case 'instapay':
        return (
          <>
            {amountRow}
            {payee?.instapay_link ? (
              <a className="primary-btn linkstyle" href={payee.instapay_link} target="_blank" rel="noopener noreferrer" onClick={away}>
                {t('Open InstaPay to pay {name}', { name: payeeName })}
              </a>
            ) : null}
            {(payee?.instapay_address || payee?.instapay_phone) && (
              <>
                {payee?.instapay_link && <p className="or">{t('or send to')}</p>}
                {payee?.instapay_address && <CopyRow label={t('InstaPay address')} value={payee.instapay_address} onCopied={away} />}
                {payee?.instapay_phone && <CopyRow label={t('Phone number')} value={payee.instapay_phone} onCopied={away} />}
              </>
            )}
          </>
        );
      case 'telda':
        return (
          <>
            {amountRow}
            <CopyRow label={t('Telda tag or number')} value={o.extra?.value ?? ''} onCopied={away} />
            <p className="hint">{t('Open Telda, search for {name}, and send exactly this amount.', { name: payeeName })}</p>
          </>
        );
      case 'wallet':
        return (
          <>
            {amountRow}
            <CopyRow label={t('{name} number', { name: o.name })} value={o.extra?.value ?? ''} onCopied={away} />
            <p className="hint">{t('Open your wallet app and send exactly this amount to this number.')}</p>
          </>
        );
      case 'cash':
        return (
          <div className="cashcard">
            <strong>{t('Hand {amount} to {name}', { amount: formatAmount(amount, cur), name: payeeName })}</strong>
            <span>{t('They mark it paid once they have it.')}</span>
          </div>
        );
      default:
        return (
          <>
            {amountRow}
            <CopyRow label={o.name} value={o.extra?.value ?? ''} onCopied={away} />
          </>
        );
    }
  }

  const needsMenu = options.length > 1 && !chosen;
  const close = () => (live ? run(() => cancelPayment(token, me, live.id), onClose) : onClose());

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Pay" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Close">×</button>

        {status === 'verified' && (
          <>
            <Tick tone="success" />
            <h2>{t('Paid · confirmed')}</h2>
            <p className="sub">{t('{name} confirmed they received {amount}. You are all set.', { name: payeeName, amount: formatAmount(mine.payment!.amount, cur) })}</p>
          </>
        )}

        {status === 'awaiting_confirmation' && (
          <>
            <Tick tone="warning" />
            <h2>{t('Waiting for confirmation')}</h2>
            <p className="sub">
              {t('You said you sent {amount}. It counts as paid once {name} sees it in their account and confirms.', { amount: formatAmount(mine.payment!.amount, cur), name: payeeName })}
            </p>
            <p className="hint">{t("Tapped by mistake, or forgot an item? Undo, change your items, then pay again. Only undo if you haven't sent the money.")}</p>
            <button className="quiet" disabled={working} onClick={() => run(() => cancelPayment(token, me, mine.payment!.id), onClose)}>
              {t("Undo, I haven't paid")}
            </button>
          </>
        )}

        {(status === 'initiated' || status === 'unpaid' || status === 'failed' || status === 'expired' || status === 'cancelled') && (
          <>
            <h2>{needsMenu ? t('Pay {amount}', { amount: formatAmount(amount, cur) }) : t('Send {amount}', { amount: formatAmount(amount, cur) })}</h2>
            {status === 'failed' && <p className="error">{t('{name} could not find your last payment. Send it again or ask them.', { name: payeeName })}</p>}
            {status === 'expired' && <p className="error">{t('The last attempt timed out. You can start again.')}</p>}

            {needsMenu ? (
              <>
                <p className="sub" style={{ marginTop: -6 }}>{t('How do you want to pay {name}?', { name: payeeName })}</p>
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
                <button className="quiet" disabled={working} onClick={close}>{live ? t('Cancel payment') : t('Close')}</button>
              </>
            ) : (
              <>
                {options.length > 1 && (
                  <button type="button" className="linklike backlink" onClick={() => { setChosenKey(null); setReturned(false); }}>{t('‹ Other ways to pay')}</button>
                )}

                {returned && (
                  <div className="ret" role="status">
                    <div><strong>{t('Welcome back.')}</strong><span>{t('Did you send {amount}?', { amount: formatAmount(amount, cur) })}</span></div>
                    <button className="primary-btn" disabled={working} onClick={() => paidNow()}>{t("Yes, I've paid")}</button>
                    <button className="linklike" onClick={() => setReturned(false)}>{t('Not yet')}</button>
                  </div>
                )}

                {chosen && (
                  <>
                    {detailsFor(chosen)}

                    {chosen.kind !== 'cash' && (
                      <details className="disclosure">
                        <summary>{t('How to pay')}</summary>
                        <ol className="steps">
                          <li>{t('Open your banking app or wallet and send exactly the amount to {name}.', { name: payeeName })}</li>
                          <li>{t('Come back here and tap "I\'ve paid". It is only marked paid once {name} confirms they received it.', { name: payeeName })}</li>
                        </ol>
                        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={60} placeholder={t("Your bank's reference number (optional)")} aria-label="Bank reference" />
                      </details>
                    )}

                    {!returned && (
                      <button className="primary" disabled={working} onClick={() => paidNow()}>
                        {chosen.kind === 'cash' ? t("I've paid in cash") : t("I've paid")}
                      </button>
                    )}
                    <button className="quiet" disabled={working} onClick={close}>{live ? t('Cancel payment') : t('Close')}</button>
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
