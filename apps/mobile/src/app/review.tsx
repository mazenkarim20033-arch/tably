import { useState } from 'react';
import { Image, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  addItem, formatAmount, reconcile, removeItem, setField, setItemDescription, setItemLineTotal,
  setItemQuantity, setTaxIncluded, type HeaderField, type Receipt,
} from '@tably/core';
import { Button } from '../components/Button';
import { AmountField, TextField } from '../components/Fields';
import { useTheme } from '../theme/ThemeProvider';
import { updateDraft, useDraft } from '../lib/draftStore';

export default function Review() {
  const { colors, space, radius } = useTheme();
  const draft = useDraft();
  const [showImage, setShowImage] = useState(false);
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
        <Text style={{ color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.6 }}>Review receipt</Text>

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
        {r.uncertain.length > 0 && (
          <Text style={{ color: colors.textMuted, fontSize: 14 }}>Fields outlined in amber were hard to read. Edit or tap into one to confirm it.</Text>
        )}

        <TextField label="Store" value={r.merchant ?? ''} uncertain={flagged('merchant')} onChange={(v) => edit(setField(r, 'merchant', v))} placeholder="Restaurant name" />
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <TextField label="Date (YYYY-MM-DD)" width="62%" value={r.date ?? ''} uncertain={flagged('date')} onChange={(v) => edit(setField(r, 'date', v === '' ? null : v))} placeholder="2026-11-03" autoCapitalize="none" />
          <TextField label="Currency" width="34%" value={r.currency} uncertain={flagged('currency')} onChange={(v) => edit(setField(r, 'currency', v.toUpperCase().slice(0, 3)))} autoCapitalize="characters" />
        </View>

        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600', marginTop: space.md }}>Items</Text>
        {r.items.map((i) => (
          <View key={i.id} style={{ backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: space.sm }}>
            <TextField value={i.description} uncertain={flagged(`items.${i.id}.description`)} onChange={(v) => edit(setItemDescription(r, i.id, v))} placeholder="Item" />
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
        <Button label="Looks right · create bill" onPress={() => router.push('/bills')} disabled={r.items.length === 0 || rec.status === 'incomplete'} />
        <Text style={{ color: colors.textFaint, fontSize: 12, textAlign: 'center' }}>Bill creation and sharing arrive in Phase 3. Your edits are saved on this phone.</Text>
      </View>
    </SafeAreaView>
  );
}
