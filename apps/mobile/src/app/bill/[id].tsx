import { useCallback, useState } from 'react';
import { Alert, RefreshControl, ScrollView, Share, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { formatAmount } from '@tably/core';
import { Button } from '../../components/Button';
import { useTheme } from '../../theme/ThemeProvider';
import {
  addPerson, closeBill, confirmPayment, getAdminBill, logReminders, rejectPayment, reopenBill, updateLink,
  type AdminBill, type AdminPayment, ApiProblem,
} from '../../lib/billsApi';
import { getAdminToken, shareUrl, updateShareToken } from '../../lib/myBills';
import { startEditDraft } from '../../lib/draftStore';
import { agoLabel, groupReminder, owing, reminderFor } from '../../lib/reminders';

const LABEL: Record<string, string> = {
  initiated: 'Payment started',
  awaiting_confirmation: 'Says they paid',
  verified: 'Paid · confirmed',
  failed: 'Rejected',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/** Creator dashboard. Money is "confirmed" only by the creator tapping Confirm after checking their own account. */
export default function BillScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, space, radius } = useTheme();
  const [bill, setBill] = useState<AdminBill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const token = await getAdminToken(id);
      if (!token) return setError('This phone does not hold the admin key for this bill.');
      setBill(await getAdminBill(id, token));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the bill.');
    }
  }, [id]);

  useFocusEffect(useCallback(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]));

  /** Run an admin action with the stored key and show any server message plainly. */
  async function act(fn: (token: string) => Promise<AdminBill | unknown>) {
    const token = await getAdminToken(id);
    if (!token) return;
    setBusy(true);
    try {
      const r = await fn(token);
      if (r && typeof r === 'object' && 'items' in r) setBill(r as AdminBill);
      else await load();
    } catch (e) {
      Alert.alert('Could not do that', e instanceof Error ? e.message : 'Please try again.');
    }
    setBusy(false);
  }

  function ask(p: AdminPayment, cur: string) {
    Alert.alert(
      `Did ${formatAmount(p.amount, cur)} arrive?`,
      `Check your own bank or InstaPay for a transfer from ${p.participant_name} of exactly ${formatAmount(p.amount, cur)}${p.payer_note ? ` (their reference: ${p.payer_note})` : ''}. Their note should read ${p.reference}. Only confirm if you can see it.`,
      [
        { text: 'Not yet', style: 'cancel' },
        { text: 'Not received', style: 'destructive', onPress: () => void act((t) => rejectPayment(id, t, p.id)) },
        { text: 'Yes, confirm', onPress: () => void act((t) => confirmPayment(id, t, p.id)) },
      ],
    );
  }

  async function remind(b: AdminBill, people: AdminBill['participants'], message: string) {
    try {
      const r = await Share.share({ message });
      if (r.action === Share.sharedAction) await act((t) => logReminders(id, t, people.map((p) => p.id)));
    } catch { /* share sheet closed */ }
    void b;
  }

  function closeFlow(b: AdminBill) {
    void act(async (t) => {
      try {
        return await closeBill(id, t);
      } catch (e) {
        if (e instanceof ApiProblem && e.code === 'unsettled') {
          Alert.alert('Not settled yet', `${e.message}\n\nClose anyway? Nobody can pick items or pay after it is closed. You can reopen it.`, [
            { text: 'Keep open', style: 'cancel' },
            { text: 'Close anyway', style: 'destructive', onPress: () => void act((tt) => closeBill(id, tt, true)) },
          ]);
          return b;
        }
        throw e;
      }
    });
  }

  function linkMenu(b: AdminBill) {
    Alert.alert('Share link', b.share_disabled ? 'The link is turned off.' : 'Anyone with the link can pick items.', [
      b.share_disabled
        ? { text: 'Turn link back on', onPress: () => void act((t) => updateLink(id, t, { disabled: false })) }
        : { text: 'Turn link off', style: 'destructive', onPress: () => void act((t) => updateLink(id, t, { disabled: true })) },
      { text: 'Extend 7 days', onPress: () => void act((t) => updateLink(id, t, { extend_days: 7 })) },
      {
        text: 'Make a new link',
        onPress: () => void act(async (t) => {
          const r = await updateLink(id, t, { rotate: true });
          await updateShareToken(id, r.share_token);
          return getAdminBill(id, t);
        }),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  if (!bill) {
    return (
      <SafeAreaView style={{ flex: 1, padding: space.lg, backgroundColor: colors.bg }}>
        <Text style={{ color: error ? colors.danger : colors.textMuted, marginTop: space.xl }}>{error ?? 'Loading…'}</Text>
        <Button label="Back" variant="quiet" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }
  const cur = bill.currency;
  const t = bill.totals;
  const closed = bill.status === 'closed';
  const waiting = bill.payments.filter((p) => p.status === 'awaiting_confirmation');
  const owes = owing(bill);
  const stat = (label: string, v: number) => (
    <View style={{ flex: 1 }}>
      <Text style={{ color: colors.textFaint, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600' }}>{formatAmount(v, cur)}</Text>
    </View>
  );
  const h2 = { color: colors.text, fontSize: 18, fontWeight: '600' as const, marginTop: space.sm };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }} refreshControl={<RefreshControl refreshing={false} onRefresh={load} />}>
        <View>
          <Text style={{ color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.6 }}>{bill.store}</Text>
          <Text style={{ color: closed ? colors.textFaint : bill.share_disabled ? colors.warning : colors.success, fontSize: 13 }}>
            {closed ? 'Closed' : bill.share_disabled ? 'Open · link is off' : 'Open'}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: space.sm }}>{stat('Bill total', t.total)}{stat('Claimed', t.assigned)}{stat('Unclaimed', t.unassigned)}</View>
        <View style={{ flexDirection: 'row', gap: space.sm }}>{stat('Confirmed paid', t.collected)}{stat('Waiting on you', t.awaiting)}{stat('Outstanding', t.outstanding)}</View>
        {!bill.payee && <Text style={{ color: colors.warning }}>No payment details on this bill, so friends cannot pay yet.</Text>}

        {waiting.length > 0 && <Text style={h2}>Needs your check</Text>}
        {waiting.map((p) => (
          <View key={p.id} style={{ padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface, borderColor: colors.warning, borderWidth: 1.5, gap: space.sm }}>
            <Text style={{ color: colors.text, fontWeight: '600' }}>{p.participant_name} says they sent {formatAmount(p.amount, cur)}</Text>
            <Text style={{ color: colors.textMuted, fontSize: 13 }}>Reference {p.reference}{p.payer_note ? ` · theirs: ${p.payer_note}` : ''}</Text>
            <Text style={{ color: colors.textFaint, fontSize: 12 }}>Not confirmed until you check your account and tap below.</Text>
            <Button label="Check and confirm" onPress={() => ask(p, cur)} disabled={busy} />
          </View>
        ))}

        <Text style={h2}>People</Text>
        {bill.participants.length === 0 && <Text style={{ color: colors.textMuted }}>Nobody has joined yet. Share the link.</Text>}
        {bill.participants.map((p) => (
          <View key={p.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm }}>
            <View style={{ flex: 1 }}>
              <Text onPress={() => router.push({ pathname: '/person', params: { id, pid: p.id } })} style={{ color: colors.text, fontSize: 16 }}>{p.name} ›</Text>
              <Text style={{ color: p.payment?.status === 'verified' ? colors.success : colors.textFaint, fontSize: 13 }}>
                {p.payment ? LABEL[p.payment.status] ?? p.payment.status : 'Not paid'}
                {p.reminder_count > 0 ? ` · reminded ${agoLabel(p.last_reminded_at)}` : ''}
              </Text>
            </View>
            {!closed && owes.some((o) => o.id === p.id) && (
              <Text onPress={() => void remind(bill, [p], reminderFor(bill, p))} style={{ color: colors.accent, fontWeight: '600' }}>Remind</Text>
            )}
            <Text style={{ color: colors.textMuted, fontSize: 16, minWidth: 80, textAlign: 'right' }}>{formatAmount(p.total, cur)}</Text>
          </View>
        ))}
        {!closed && owes.length > 1 && (
          <Button label={`Remind ${owes.length} people`} variant="quiet" onPress={() => void remind(bill, owes, groupReminder(bill, owes))} disabled={busy} />
        )}
        {!closed && (
          <Button
            label="Add someone"
            variant="quiet"
            onPress={() => Alert.prompt('Add someone', 'For a friend who is not using the link. You will pick their items.', (name) => {
              if (name?.trim()) void act((tk) => addPerson(id, tk, name.trim()));
            })}
            disabled={busy}
          />
        )}
        <Text style={{ color: colors.textFaint, fontSize: 12 }}>
          TABLY cannot send texts or notifications. Remind opens your share sheet (WhatsApp, iMessage) so you send the message yourself.
        </Text>

        <Text style={h2}>Manage</Text>
        {!closed && (
          <Button
            label="Edit receipt"
            variant="quiet"
            onPress={() => {
              startEditDraft(bill);
              router.push('/review');
            }}
          />
        )}
        <Button label="Share link" onPress={() => void Share.share({ message: `Pick what you had on our bill at ${bill.store}: ${shareUrl(bill.share_token)}` })} />
        <Button label="Link settings" variant="quiet" onPress={() => linkMenu(bill)} disabled={busy} />
        {closed
          ? <Button label="Reopen bill" variant="quiet" onPress={() => void act((tk) => reopenBill(id, tk))} disabled={busy} />
          : <Button label="Close bill" variant="quiet" onPress={() => closeFlow(bill)} disabled={busy} />}
        <Button label="Back" variant="quiet" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}
