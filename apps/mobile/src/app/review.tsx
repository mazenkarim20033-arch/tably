import { useEffect, useState } from 'react';
import { Alert, Image, Pressable, ScrollView, Share, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  addItem, encodeOcrDump, formatAmount, reconcile, removeItem, setField, setItemDescription, setItemLineTotal,
  setItemQuantity, setTaxIncluded, type HeaderField, type Receipt,
} from '@tably/core';
import { Button } from '../components/Button';
import { AmountField, TextField } from '../components/Fields';
import { useTheme } from '../theme/ThemeProvider';
import { updateDraft, useDraft } from '../lib/draftStore';
import { ApiProblem, createBill, editReceipt, MismatchError } from '../lib/billsApi';
import { getAdminToken, loadPayee, savePayee, saveBill } from '../lib/myBills';

export default function Review() {
  const { colors, space, radius } = useTheme();
  const draft = useDraft();
  const [showImage, setShowImage] = useState(false);
  const [creating, setCreating] = useState(false);
  const [payeeName, setPayeeName] = useState('');
  const [ipa, setIpa] = useState('');
  const [phone, setPhone] = useState('');
  const [link, setLink] = useState('');

  useEffect(() => {
    void loadPayee().then((p) => {
      if (!p) return;
      setPayeeName(p.payee_name);
      setIpa(p.instapay_address ?? '');
      setPhone(p.instapay_phone ?? '');
      setLink(p.instapay_link ?? '');
    });
  }, []);

  const payee = {
    payee_name: payeeName.trim(),
    ...(ipa.trim() ? { instapay_address: ipa.trim() } : {}),
    ...(phone.trim() ? { instapay_phone: phone.trim() } : {}),
    ...(link.trim() ? { instapay_link: link.trim() } : {}),
  };
  const hasPayee = payee.payee_name !== '' && Object.keys(payee).length > 1;

  async function create(acceptMismatch = false) {
    if (!draft) return;
    setCreating(true);
    try {
      if (draft.editBillId) {
        const token = await getAdminToken(draft.editBillId);
        if (!token) throw new Error('This phone does not hold the admin key for this bill.');
        await editReceipt(draft.editBillId, token, draft.receipt, acceptMismatch);
        router.back();
        return;
      }
      const made = await createBill(draft.receipt, acceptMismatch, hasPayee ? payee : undefined);
      if (hasPayee) void savePayee(payee);
      const rec = reconcile(draft.receipt);
      await saveBill(
        { id: made.id, store: draft.receipt.merchant?.trim() || 'Receipt', currency: draft.receipt.currency,
          total: rec.computedTotal, shareToken: made.share_token, createdAt: new Date().toISOString() },
        made.admin_token,
      );
      router.replace({ pathname: '/share', params: { id: made.id } });
    } catch (e) {
      setCreating(false);
      if (e instanceof ApiProblem && e.code === 'mismatch') {
        Alert.alert('Totals do not match', 'Your items do not add up to the receipt total. Save anyway using the item total?', [{ text: 'Go back and fix', style: 'cancel' }, { text: 'Use item total', onPress: () => void create(true) }]);
      } else if (e instanceof MismatchError) {
        Alert.alert(
          'Totals do not match',
          `Your items add up to ${formatAmount(e.computed, draft.receipt.currency)} but the receipt total is ${formatAmount(e.printed, draft.receipt.currency)}. Friends will be asked to split ${formatAmount(e.computed, draft.receipt.currency)}.`,
          [{ text: 'Go back and fix', style: 'cancel' }, { text: 'Use item total', onPress: () => void create(true) }],
        );
      } else {
        Alert.alert('Could not create the bill', e instanceof Error ? e.message : 'Please try again.');
      }
    }
  }
  if (!draft) {
    router.replace('/');
    return null;
  }
  const r = draft.receipt;
  const rec = reconcile(r);
  const edit = (next: Receipt) => updateDraft({ receipt: next });
  const flagged = (path: string) => r.uncertain.includes(path);
  const money = (k: Exclude<HeaderField, 'merchant' | 'date' | 'currency'>, label: string) => (
    <AmountField label={label} value={r[k]} uncertain={flagged(k)} onChange={(v) => edit(setField(r, k, k === 'discounts' ? (v === null ? 0 : -Math.abs(v)) : v))} />
  );
  const banner =
    rec.status === 'ok' ? { c: colors.success, t: rec.message }
    : rec.status === 'mismatch' ? { c: colors.danger, t: `${rec.message} Difference ${formatAmount(rec.difference ?? 0, r.currency)}.` }
    : { c: colors.warning, t: rec.message };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: 140 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.6 }}>{draft.editBillId ? 'Edit receipt' : 'Review receipt'}</Text>

        {draft.ocrError && (
          <Text style={{ color: colors.warning }}>Text recognition did not run ({draft.ocrError}) Enter the receipt below.</Text>
        )}
        {draft.imageUri && (
          <Pressable onPress={() => setShowImage((s) => !s)} accessibilityRole="button">
            <Text style={{ color: colors.accent, fontWeight: '600' }}>{showImage ? 'Hide original receipt' : 'Show original receipt'}</Text>
            {showImage && <Image source={{ uri: draft.imageUri }} resizeMode="contain" style={{ width: '100%', height: 420, marginTop: 8, borderRadius: radius.md }} />}
          </Pressable>
        )}

        <View style={{ borderLeftWidth: 3, borderLeftColor: banner.c, paddingLeft: 12 }}>
          <Text style={{ color: banner.c, fontWeight: '600' }}>{banner.t}</Text>
        </View>
        {draft.ocr.length > 0 && (
          <Text
            accessibilityRole="button"
            onPress={() =>
              // Only when the person taps it: the raw text the scanner read, to report a bad reading.
              void Share.share({
                message: encodeOcrDump({ lines: draft.ocr, width: draft.ocrSize?.width ?? 0, height: draft.ocrSize?.height ?? 0 }),
              })
            }
            style={{ color: colors.textFaint, fontSize: 13, textDecorationLine: 'underline' }}
          >
            Share what the scanner read (helps fix wrong readings)
          </Text>
        )}
        {(r.notes ?? []).map((n) => (
          <Text key={n} style={{ color: colors.textMuted, fontSize: 14 }}>• {n}</Text>
        ))}
        {r.uncertain.some((u) => u !== 'merchant' && !u.endsWith('.description')) && (
          <Text style={{ color: colors.textMuted, fontSize: 14 }}>Fields outlined in amber were hard to read or were calculated. Edit or tap into one to confirm it.</Text>
        )}

        <TextField label="Store" value={r.merchant ?? ''} onChange={(v) => edit(setField(r, 'merchant', v))} placeholder="Restaurant name" />
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <TextField label="Date (YYYY-MM-DD)" width="62%" value={r.date ?? ''} uncertain={flagged('date')} onChange={(v) => edit(setField(r, 'date', v === '' ? null : v))} placeholder="2026-11-03" autoCapitalize="none" />
          <TextField label="Currency" width="34%" value={r.currency} uncertain={flagged('currency')} onChange={(v) => edit(setField(r, 'currency', v.toUpperCase().slice(0, 3)))} autoCapitalize="characters" />
        </View>

        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600', marginTop: space.md }}>Items</Text>
        {r.items.map((i) => (
          <View key={i.id} style={{ backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: space.sm }}>
            <TextField value={i.description} onChange={(v) => edit(setItemDescription(r, i.id, v))} placeholder="Item" />
            {i.suggestedLineTotal !== undefined && i.suggestedLineTotal !== i.lineTotal && (
              <View style={{ gap: 6 }}>
                <Text style={{ color: colors.warning, fontSize: 13 }}>
                  The items only add up to the receipt if this price is {formatAmount(i.suggestedLineTotal, r.currency)}. The scanner may have misread a digit. Check the photo.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => edit(setItemLineTotal(r, i.id, i.suggestedLineTotal!))}
                  style={{ alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 16, borderRadius: radius.pill, backgroundColor: colors.accent }}
                >
                  <Text style={{ color: colors.accentText, fontWeight: '600' }}>Use {formatAmount(i.suggestedLineTotal, r.currency)}</Text>
                </Pressable>
              </View>
            )}
            {i.flags.includes('does-not-add-up') && (
              <Text style={{ color: colors.warning, fontSize: 13 }}>
                This may not be an item: without it, the items match the receipt subtotal. Tap × to remove it if it is something else (an address, a code).
              </Text>
            )}
            <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-end' }}>
              <TextField label="Qty" width={70} keyboardType="number-pad" value={String(i.quantity)} uncertain={flagged(`items.${i.id}.quantity`)} onChange={(v) => edit(setItemQuantity(r, i.id, Number(v)))} />
              <View style={{ flex: 1 }}>
                <AmountField label={i.quantity > 1 ? 'Line total' : 'Price'} value={i.lineTotal} uncertain={flagged(`items.${i.id}.lineTotal`)} onChange={(v) => edit(setItemLineTotal(r, i.id, v))} />
              </View>
              <Pressable onPress={() => edit(removeItem(r, i.id))} accessibilityLabel={`Remove ${i.description || 'item'}`} hitSlop={8} style={{ paddingBottom: 12 }}>
                <Text style={{ color: colors.danger, fontSize: 22 }}>×</Text>
              </Pressable>
            </View>
            {i.quantity > 1 && (
              <Text style={{ color: colors.textFaint, fontSize: 13 }}>
                {i.unitPrice === null ? 'Per-unit price not exact; kept as a line total.' : `${formatAmount(i.unitPrice, r.currency)} each`}
              </Text>
            )}
          </View>
        ))}
        <Button label="Add item" variant="quiet" onPress={() => edit(addItem(r))} />

        {r.unparsed.length > 0 && (
          <View style={{ gap: 4 }}>
            <Text style={{ color: colors.textMuted, fontSize: 14 }}>Rows we could not read. Add them as items if they matter:</Text>
            {r.unparsed.map((u, n) => <Text key={n} style={{ color: colors.textFaint, fontSize: 14 }}>· {u}</Text>)}
          </View>
        )}

        {!draft.editBillId && <>
        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600', marginTop: space.md }}>Where should friends pay you?</Text>
        <Text style={{ color: colors.textMuted, fontSize: 14 }}>Shown to people with your link. They send money from their own bank app; you confirm each payment yourself. Add at least one of address, phone or link.</Text>
        <TextField label="Your name" value={payeeName} onChange={setPayeeName} placeholder="Shown to friends" />
        <TextField label="InstaPay address" value={ipa} onChange={setIpa} placeholder="name@instapay" autoCapitalize="none" autoCorrect={false} />
        <TextField label="Phone number linked to InstaPay" value={phone} onChange={setPhone} placeholder="01012345678" keyboardType="number-pad" />
        <TextField label="InstaPay payment link (optional)" value={link} onChange={setLink} placeholder="https://ipn.eg/..." autoCapitalize="none" autoCorrect={false} />
        </>}

        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600', marginTop: space.md }}>Totals</Text>
        {money('subtotal', 'Subtotal (as printed)')}
        {money('discounts', 'Discounts')}
        {money('service', 'Service charge')}
        {money('tax', 'Tax')}
        {money('tip', 'Tip')}
        {money('total', 'Total (as printed)')}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
          <Text style={{ color: colors.textMuted, flex: 1 }}>Tax and service are already included in the item prices</Text>
          <Switch value={r.taxIncluded} onValueChange={(v) => edit(setTaxIncluded(r, v))} />
        </View>
        <Text style={{ color: colors.textFaint, fontSize: 13 }}>Items add up to {formatAmount(rec.itemsSum, r.currency)}.</Text>
      </ScrollView>

      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: space.lg, backgroundColor: colors.bg, borderTopColor: colors.border, borderTopWidth: 1, gap: space.sm }}>
        <Button label={creating ? 'Saving…' : draft.editBillId ? 'Save changes' : 'Looks right · create bill'} onPress={() => {
            if (r.total === null) {
              // Nothing printed to check against: say what friends will split and let the person decide.
              Alert.alert(
                'No receipt total to check',
                `There is no total on this receipt, so TABLY cannot double-check the items. Friends will split ${formatAmount(rec.computedTotal, r.currency)} (the items plus any charges). Continue?`,
                [{ text: 'Go back', style: 'cancel' }, { text: 'Continue', onPress: () => void create() }],
              );
            } else void create();
          }}
          disabled={creating || r.items.length === 0 || r.items.some((i) => i.lineTotal === null || i.description.trim() === '')} />
        <Text style={{ color: colors.textFaint, fontSize: 12, textAlign: 'center' }}>{draft.editBillId ? 'People on the link see the changes straight away.' : 'You will get a private link to share. Your edits are saved on this phone.'}</Text>
      </View>
    </SafeAreaView>
  );
}
