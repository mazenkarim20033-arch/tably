import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { formatAmount, parseAmount } from '@tably/core';
import { Button } from '../components/Button';
import { Avatar, Callout } from '../components/Bits';
import { Card, SectionTitle } from '../components/Card';
import { Icon } from '../components/Icon';
import { AmountField } from '../components/Fields';
import { Screen } from '../components/Screen';
import { useTheme } from '../theme/ThemeProvider';
import {
  addTransfer, assignFor, getAdminBill, removePerson, removeTransfer, type AdminBill, type AdminItem, type ClaimChange,
} from '../lib/billsApi';
import { t, useLang } from '../lib/i18n';
import { getAdminToken } from '../lib/myBills';

/** One person on a bill: fix what they have, cover or be covered by someone, or remove them. */
export default function Person() {
  useLang();
  const { id, pid } = useLocalSearchParams<{ id: string; pid: string }>();
  const { colors, space, radius, font } = useTheme();
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
      Alert.alert(t('Could not do that'), e instanceof Error ? e.message : t('Please try again.'));
    }
    setBusy(false);
  }

  const me = bill?.participants.find((p) => p.id === pid);
  if (!bill || !me) {
    return (
      <Screen scroll={false}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md }}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={{ ...font.callout, color: colors.textMuted }}>{t('Loading…')}</Text>
        </View>
      </Screen>
    );
  }
  const cur = bill.currency;
  const closed = bill.status === 'closed';
  const locked = me.pinned || closed;
  const others = bill.participants.filter((p) => p.id !== pid);
  const name = (x: string) => bill.participants.find((p) => p.id === x)?.name ?? '?';
  const mine = bill.transfers.filter((t) => t.payer_id === pid || t.beneficiary_id === pid);

  /** A small round or pill control: an amber-free, high-contrast tap target. */
  const chip = (label: string, on: boolean, onPress: () => void, disabled = false, round = false) => (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy || locked}
      accessibilityRole="button"
      accessibilityState={{ selected: on, disabled: disabled || locked }}
      style={{
        minWidth: round ? 40 : undefined, height: 40, paddingHorizontal: round ? 0 : 18, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center',
        flexDirection: 'row', gap: 6, backgroundColor: on ? colors.accent : colors.surfaceMuted, opacity: disabled || locked ? 0.4 : 1,
      }}
    >
      {on && !round ? <Icon name="check" size={16} color={colors.accentText} strokeWidth={2.6} /> : null}
      <Text style={{ ...font.headline, fontSize: 15, color: on ? colors.accentText : colors.text }}>{label}</Text>
    </Pressable>
  );

  function itemRow(it: AdminItem) {
    const claim = it.claims.find((c) => c.participant_id === pid);
    const units = claim && !claim.shared ? claim.units : 0;
    const shared = !!claim?.shared;
    const otherShare = it.claims.some((c) => c.shared && c.participant_id !== pid);
    const max = it.quantity - (it.exclusive - units) - (otherShare ? 1 : 0);
    const has = units > 0 || shared;
    const set = (c: ClaimChange) => void act((t) => assignFor(id, t, pid, it.id, c));
    return (
      <Card key={it.id} tone={has ? 'accent' : undefined} style={{ gap: space.sm }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md }}>
          <Text style={{ ...font.body, color: colors.text, flex: 1, fontWeight: '500' }}>{it.quantity > 1 ? `${it.quantity} × ` : ''}{it.description}</Text>
          <Text style={{ ...font.number, color: colors.textMuted }}>{formatAmount(it.line_total, cur)}</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' }}>
          {it.quantity === 1
            ? chip(t('Has it'), units === 1, () => set({ units: units ? 0 : 1 }), !units && max < 1)
            : (
              <>
                {chip('−', false, () => set({ units: units - 1 }), units === 0, true)}
                <Text style={{ ...font.headline, color: colors.text, minWidth: 28, textAlign: 'center' }}>{units}</Text>
                {chip('+', false, () => set({ units: units + 1 }), units >= max, true)}
              </>
            )}
          {chip(t('Split'), shared, () => set({ share: !shared }), !shared && it.quantity - (it.exclusive - units) < 1)}
        </View>
      </Card>
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
    <Screen back>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <Avatar name={me.name} size={64} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={1} style={{ ...font.largeTitle, color: colors.text }}>{me.name}</Text>
          <Text style={{ ...font.callout, color: colors.textMuted }}>
            {t('Owes')} <Text style={{ color: colors.text, fontWeight: '700' }}>{formatAmount(me.total, cur)}</Text>
            {me.adjustment !== 0 ? ' ' + t('(includes {amount} adjustment)', { amount: formatAmount(me.adjustment, cur) }) : ''}
          </Text>
        </View>
      </View>
      {locked && (
        <Callout tone="warning" icon="lock">
          {closed ? t('This bill is closed.') : t('They have started or finished paying, so their items and amount are locked. Reject or cancel their payment to change them.')}
        </Callout>
      )}

      <SectionTitle>What they have</SectionTitle>
      {bill.items.map(itemRow)}

      <SectionTitle>Adjustments</SectionTitle>
      <Text style={{ ...font.footnote, color: colors.textMuted }}>{t('Move part of what someone owes onto {name}. The bill total never changes.', { name: me.name })}</Text>
      {mine.map((tr) => (
        <Card key={tr.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Text style={{ ...font.callout, color: colors.text, flex: 1 }}>{t('{payer} covers {amount} for {other}', { payer: name(tr.payer_id), amount: formatAmount(tr.amount, cur), other: name(tr.beneficiary_id) })}</Text>
          <Text onPress={() => void act((t) => removeTransfer(id, t, tr.id))} style={{ ...font.callout, color: colors.danger, fontWeight: '600' }}>{t('Remove')}</Text>
        </Card>
      ))}
      {!locked && others.length > 0 && (
        <Card style={{ gap: space.md }}>
          <Text style={{ ...font.callout, color: colors.textMuted }}>{t('{name} covers part of:', { name: me.name })}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {others.map((o) => (
              <Pressable
                key={o.id}
                onPress={() => setCoverFor(o.id === coverFor ? null : o.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: coverFor === o.id }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingLeft: 6, paddingRight: 14, borderRadius: radius.pill, backgroundColor: coverFor === o.id ? colors.accent : colors.surfaceMuted }}
              >
                <Avatar name={o.name} size={28} />
                <Text style={{ ...font.callout, color: coverFor === o.id ? colors.accentText : colors.text, fontWeight: '600' }}>{o.name}</Text>
              </Pressable>
            ))}
          </View>
          {coverFor && (
            <>
              <AmountField label={t('Amount ({cur})', { cur })} value={amount} onChange={setAmount} />
              <Button label="Add adjustment" onPress={cover} disabled={busy || !amount || parseAmount(String((amount ?? 0) / 100)) === null} />
            </>
          )}
        </Card>
      )}

      {!closed && (
        <View style={{ marginTop: space.md }}>
          <Button
            label={t('Remove {name}', { name: me.name })}
            icon="trash"
            variant="danger"
            disabled={busy}
            onPress={() => Alert.alert(t('Remove {store}?', { store: me.name }), t('Their items go back to unclaimed.'), [
              { text: t('Cancel'), style: 'cancel' },
              { text: t('Remove'), style: 'destructive', onPress: async () => {
                const token = await getAdminToken(id);
                if (!token) return;
                try {
                  await removePerson(id, token, pid);
                  router.back();
                } catch (e) {
                  Alert.alert(t('Could not remove'), e instanceof Error ? e.message : t('Please try again.'));
                }
              } },
            ])}
          />
        </View>
      )}
    </Screen>
  );
}
