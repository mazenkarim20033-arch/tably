import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { formatAmount, parseAmount } from '@tably/core';
import { Button } from '../components/Button';
import { AmountField } from '../components/Fields';
import { useTheme } from '../theme/ThemeProvider';
import {
  addTransfer, assignFor, getAdminBill, removePerson, removeTransfer, type AdminBill, type AdminItem, type ClaimChange,
} from '../lib/billsApi';
import { getAdminToken } from '../lib/myBills';

/** One person on a bill: fix what they have, cover or be covered by someone, or remove them. */
export default function Person() {
  const { id, pid } = useLocalSearchParams<{ id: string; pid: string }>();
  const { colors, space, radius } = useTheme();
  const [bill, setBill] = useState<AdminBill | null>(null);
  const [busy, setBusy] = useState(false);
  const [coverFor, setCoverFor] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | null>(null);

  const load = useCallback(async () => {
    const token = await getAdminToken(id);
    if (token) setBill(await getAdminBill(id, token));
  }, [id]);
  useFocusEffect(useCallback(() => void load().catch(() => undefined), [load]));

  async function act(fn: (token: string) => Promise<AdminBill>) {
    const token = await getAdminToken(id);
    if (!token) return;
    setBusy(true);
    try {
      setBill(await fn(token));
    } catch (e) {
      Alert.alert('Could not do that', e instanceof Error ? e.message : 'Please try again.');
    }
    setBusy(false);
  }

  const me = bill?.participants.find((p) => p.id === pid);
  if (!bill || !me) {
    return (
      <SafeAreaView style={{ flex: 1, padding: space.lg, backgroundColor: colors.bg }}>
        <Text style={{ color: colors.textMuted, marginTop: space.xl }}>Loading…</Text>
        <Button label="Back" variant="quiet" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }
  const cur = bill.currency;
  const closed = bill.status === 'closed';
  const locked = me.pinned || closed;
  const others = bill.participants.filter((p) => p.id !== pid);
  const name = (x: string) => bill.participants.find((p) => p.id === x)?.name ?? '?';
  const mine = bill.transfers.filter((t) => t.payer_id === pid || t.beneficiary_id === pid);

  function itemRow(it: AdminItem) {
    const claim = it.claims.find((c) => c.participant_id === pid);
    const units = claim && !claim.shared ? claim.units : 0;
    const shared = !!claim?.shared;
    const otherShare = it.claims.some((c) => c.shared && c.participant_id !== pid);
    const max = it.quantity - (it.exclusive - units) - (otherShare ? 1 : 0);
    const chip = (label: string, on: boolean, onPress: () => void, disabled = false) => (
      <Pressable
        onPress={onPress}
        disabled={disabled || busy || locked}
        style={{ paddingVertical: 6, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: on ? colors.accent : colors.surfaceMuted, opacity: disabled || locked ? 0.4 : 1 }}
      >
        <Text style={{ color: on ? colors.accentText : colors.text, fontWeight: '600' }}>{label}</Text>
      </Pressable>
    );
    const set = (c: ClaimChange) => void act((t) => assignFor(id, t, pid, it.id, c));
    return (
      <View key={it.id} style={{ padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, gap: space.sm }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ color: colors.text, flex: 1 }}>{it.quantity > 1 ? `${it.quantity} × ` : ''}{it.description}</Text>
          <Text style={{ color: colors.textMuted }}>{formatAmount(it.line_total, cur)}</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
          {it.quantity === 1
            ? chip('Has it', units === 1, () => set({ units: units ? 0 : 1 }), !units && max < 1)
            : <>
                {chip('−', false, () => set({ units: units - 1 }), units === 0)}
                <Text style={{ color: colors.text, alignSelf: 'center', minWidth: 16, textAlign: 'center' }}>{units}</Text>
                {chip('+', false, () => set({ units: units + 1 }), units >= max)}
              </>}
          {chip('Split', shared, () => set({ share: !shared }), !shared && it.quantity - (it.exclusive - units) < 1)}
        </View>
      </View>
    );
  }

  function cover() {
    if (!coverFor || !amount) return;
    // "pid covers part of coverFor's share"
    void act((t) => addTransfer(id, t, pid, coverFor, amount));
    setCoverFor(null);
    setAmount(null);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.6 }}>{me.name}</Text>
        <Text style={{ color: colors.textMuted }}>Owes {formatAmount(me.total, cur)}{me.adjustment !== 0 ? ` (includes ${formatAmount(me.adjustment, cur)} adjustment)` : ''}</Text>
        {locked && (
          <Text style={{ color: colors.warning, fontSize: 14 }}>
            {closed ? 'This bill is closed.' : 'They have started or finished paying, so their items and amount are locked. Reject or cancel their payment to change them.'}
          </Text>
        )}

        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600' }}>What they have</Text>
        {bill.items.map(itemRow)}

        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600', marginTop: space.sm }}>Adjustments</Text>
        <Text style={{ color: colors.textFaint, fontSize: 13 }}>Move part of what someone owes onto {me.name}. The bill total never changes.</Text>
        {mine.map((tr) => (
          <View key={tr.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: colors.text, flex: 1 }}>{name(tr.payer_id)} covers {formatAmount(tr.amount, cur)} for {name(tr.beneficiary_id)}</Text>
            <Text onPress={() => void act((t) => removeTransfer(id, t, tr.id))} style={{ color: colors.danger }}>Remove</Text>
          </View>
        ))}
        {!locked && others.length > 0 && (
          <>
            <Text style={{ color: colors.textMuted, fontSize: 14 }}>{me.name} covers part of:</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {others.map((o) => (
                <Pressable key={o.id} onPress={() => setCoverFor(o.id === coverFor ? null : o.id)} style={{ paddingVertical: 6, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: coverFor === o.id ? colors.accent : colors.surfaceMuted }}>
                  <Text style={{ color: coverFor === o.id ? colors.accentText : colors.text }}>{o.name}</Text>
                </Pressable>
              ))}
            </View>
            {coverFor && (
              <>
                <AmountField label={`Amount (${cur})`} value={amount} onChange={setAmount} />
                <Button label="Add adjustment" onPress={cover} disabled={busy || !amount || parseAmount(String((amount ?? 0) / 100)) === null} />
              </>
            )}
          </>
        )}

        {!closed && (
          <Button
            label={`Remove ${me.name}`}
            variant="quiet"
            disabled={busy}
            onPress={() => Alert.alert(`Remove ${me.name}?`, 'Their items go back to unclaimed.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Remove', style: 'destructive', onPress: async () => {
                const token = await getAdminToken(id);
                if (!token) return;
                try {
                  await removePerson(id, token, pid);
                  router.back();
                } catch (e) {
                  Alert.alert('Could not remove', e instanceof Error ? e.message : 'Please try again.');
                }
              } },
            ])}
          />
        )}
        <Button label="Back" variant="quiet" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}
