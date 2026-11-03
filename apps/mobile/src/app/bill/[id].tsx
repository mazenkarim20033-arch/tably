import { useCallback, useEffect, useState } from 'react';
import { Alert, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { formatAmount } from '@tably/core';
import { Button } from '../../components/Button';
import { useTheme } from '../../theme/ThemeProvider';
import { confirmPayment, getAdminBill, rejectPayment, type AdminBill, type AdminPayment } from '../../lib/billsApi';
import { getAdminToken } from '../../lib/myBills';

const LABEL: Record<string, string> = {
  initiated: 'Payment started',
  awaiting_confirmation: 'Says they paid',
  verified: 'Paid · confirmed',
  failed: 'Rejected',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/** Creator's view of one bill. Money is "confirmed" only by the creator tapping Confirm after checking their own account. */
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

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  async function review(p: AdminPayment, action: 'confirm' | 'reject') {
    const token = await getAdminToken(id);
    if (!token || !bill) return;
    setBusy(true);
    try {
      setBill(await (action === 'confirm' ? confirmPayment : rejectPayment)(id, token, p.id));
    } catch (e) {
      Alert.alert('Could not update', e instanceof Error ? e.message : 'Please try again.');
    }
    setBusy(false);
  }

  function ask(p: AdminPayment, cur: string) {
    Alert.alert(
      `Did ${formatAmount(p.amount, cur)} arrive?`,
      `Check your own bank or InstaPay for a transfer from ${p.participant_name} of exactly ${formatAmount(p.amount, cur)}${p.payer_note ? ` (their reference: ${p.payer_note})` : ''}. Their note should read ${p.reference}. Only confirm if you can see it.`,
      [
        { text: 'Not yet', style: 'cancel' },
        { text: 'Not received', style: 'destructive', onPress: () => void review(p, 'reject') },
        { text: 'Yes, confirm', onPress: () => void review(p, 'confirm') },
      ],
    );
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
  const waiting = bill.payments.filter((p) => p.status === 'awaiting_confirmation');
  const stat = (label: string, v: number) => (
    <View style={{ flex: 1 }}>
      <Text style={{ color: colors.textFaint, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600' }}>{formatAmount(v, cur)}</Text>
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }} refreshControl={<RefreshControl refreshing={false} onRefresh={load} />}>
        <Text style={{ color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.6 }}>{bill.store}</Text>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {stat('Bill total', t.total)}
          {stat('Claimed', t.assigned)}
          {stat('Unclaimed', t.unassigned)}
        </View>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {stat('Confirmed paid', t.collected)}
          {stat('Waiting on you', t.awaiting)}
          {stat('Outstanding', t.outstanding)}
        </View>
        {!bill.payee && <Text style={{ color: colors.warning }}>No payment details on this bill, so friends cannot pay yet.</Text>}

        {waiting.length > 0 && (
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600', marginTop: space.sm }}>Needs your check</Text>
        )}
        {waiting.map((p) => (
          <View key={p.id} style={{ padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface, borderColor: colors.warning, borderWidth: 1.5, gap: space.sm }}>
            <Text style={{ color: colors.text, fontWeight: '600' }}>{p.participant_name} says they sent {formatAmount(p.amount, cur)}</Text>
            <Text style={{ color: colors.textMuted, fontSize: 13 }}>Reference {p.reference}{p.payer_note ? ` · theirs: ${p.payer_note}` : ''}</Text>
            <Text style={{ color: colors.textFaint, fontSize: 12 }}>Not confirmed until you check your account and tap below.</Text>
            <Button label="Check and confirm" onPress={() => ask(p, cur)} disabled={busy} />
          </View>
        ))}

        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600', marginTop: space.sm }}>People</Text>
        {bill.participants.length === 0 && <Text style={{ color: colors.textMuted }}>Nobody has joined yet. Share the link.</Text>}
        {bill.participants.map((p) => (
          <View key={p.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <View>
              <Text style={{ color: colors.text, fontSize: 16 }}>{p.name}</Text>
              <Text style={{ color: p.payment?.status === 'verified' ? colors.success : colors.textFaint, fontSize: 13 }}>
                {p.payment ? LABEL[p.payment.status] ?? p.payment.status : 'Not paid'}
              </Text>
            </View>
            <Text style={{ color: colors.textMuted, fontSize: 16 }}>{formatAmount(p.total, cur)}</Text>
          </View>
        ))}
        <Text style={{ color: colors.textFaint, fontSize: 12, marginTop: space.sm }}>
          Reminders, closing the bill and editing arrive in Phase 6. TABLY does not verify bank transfers by itself.
        </Text>
        <Button label="Share link" variant="quiet" onPress={() => router.push({ pathname: '/share', params: { id } })} />
        <Button label="Back" variant="quiet" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}
