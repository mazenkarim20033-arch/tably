import { useEffect, useState } from 'react';
import { loadPayee, type PayeeMethod, type SavedPayee } from './myBills';
import { t } from './i18n';

/** Telda accepts a @tag or the phone number tied to it; wallets are Egyptian mobile numbers. */
export const TELDA_OK = /^(@?[A-Za-z0-9._]{2,30}|01[0125]\d{8})$/;
export const WALLET_OK = /^01[0125]\d{8}$/;

/**
 * The person's payment details as a form: how friends can pay them (InstaPay, Telda, a wallet, cash). The saved copy
 * on this phone fills it in, so they type it once and every new bill uses it. `payee` is what gets sent and saved.
 */
export function usePayeeForm() {
  const [name, setName] = useState('');
  const [ipa, setIpa] = useState('');
  const [phone, setPhone] = useState('');
  const [link, setLink] = useState('');
  const [telda, setTelda] = useState('');
  const [wallet, setWallet] = useState('');
  const [walletName, setWalletName] = useState('');
  const [cash, setCash] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [hadSaved, setHadSaved] = useState(false);

  useEffect(() => {
    void loadPayee().then((p) => {
      if (p) {
        setName(p.payee_name);
        setIpa(p.instapay_address ?? '');
        setPhone(p.instapay_phone ?? '');
        setLink(p.instapay_link ?? '');
        for (const m of p.methods ?? []) {
          if (m.kind === 'telda') setTelda(m.value);
          else if (m.kind === 'wallet') { setWallet(m.value); setWalletName(m.label ?? ''); }
          else if (m.kind === 'cash') setCash(true);
        }
        setHadSaved(!!p.payee_name && !!(p.instapay_address || p.instapay_phone || p.instapay_link || (p.methods?.length ?? 0) > 0));
      }
      setLoaded(true);
    });
  }, []);

  const teldaOk = telda.trim() === '' || TELDA_OK.test(telda.trim());
  const walletOk = wallet.trim() === '' || WALLET_OK.test(wallet.trim());
  const methods: PayeeMethod[] = [
    ...(telda.trim() && teldaOk ? [{ kind: 'telda' as const, value: telda.trim() }] : []),
    ...(wallet.trim() && walletOk ? [{ kind: 'wallet' as const, value: wallet.trim(), ...(walletName.trim() ? { label: walletName.trim() } : {}) }] : []),
    ...(cash ? [{ kind: 'cash' as const }] : []),
  ];
  const payee: SavedPayee = {
    payee_name: name.trim(),
    ...(ipa.trim() ? { instapay_address: ipa.trim() } : {}),
    ...(phone.trim() ? { instapay_phone: phone.trim() } : {}),
    ...(link.trim() ? { instapay_link: link.trim() } : {}),
    ...(methods.length > 0 ? { methods } : {}),
  };
  const hasPayee = payee.payee_name !== '' && Object.keys(payee).length > 1;
  const ways = [
    (ipa.trim() || phone.trim() || link.trim()) && t('InstaPay'),
    ...methods.map((m) => (m.kind === 'telda' ? 'Telda' : m.kind === 'wallet' ? m.label ?? t('Wallet') : m.kind === 'cash' ? t('Cash') : m.label)),
  ].filter(Boolean).join(', ');

  return {
    name, setName, ipa, setIpa, phone, setPhone, link, setLink, telda, setTelda, wallet, setWallet, walletName, setWalletName, cash, setCash,
    teldaOk, walletOk, valid: teldaOk && walletOk, payee, hasPayee,
    summary: hasPayee ? `${payee.payee_name} · ${ways}` : t('Add where friends should send money.'),
    loaded, hadSaved,
  };
}

export type PayeeForm = ReturnType<typeof usePayeeForm>;
