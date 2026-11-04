import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Share, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { formatAmount } from '@tably/core';
import { Button } from '../../components/Button';
import { Avatar, Badge, Callout, ProgressBar, Stat, type Tone } from '../../components/Bits';
import { Card, ListRow, SectionTitle } from '../../components/Card';
import { Screen } from '../../components/Screen';
import { useTheme } from '../../theme/ThemeProvider';
import {
  addPerson, closeBill, confirmPayment, getAdminBill, logReminders, rejectPayment, reopenBill, updateLink,
  type AdminBill, type AdminPayment, ApiProblem,
} from '../../lib/billsApi';
import { getAdminToken, shareUrl, updateShareToken } from '../../lib/myBills';
import { startEditDraft } from '../../lib/draftStore';
import { agoLabel, groupReminder, owing, reminderFor } from '../../lib/reminders';

const LABEL: Record<string, { text: string; tone: Tone }> = {
  initiated: { text: 'Payment started', tone: 'neutral' },
  awaiting_confirmation: { text: 'Says they paid', tone: 'warning' },
  verified: { text: 'Paid · confirmed', tone: 'success' },
  failed: { text: 'Rejected', tone: 'danger' },
  expired: { text: 'Expired', tone: 'neutral' },
  cancelled: { text: 'Cancelled', tone: 'neutral' },
};

/** Creator dashboard. Money is "confirmed" only by the creator tapping Confirm after checking their own account. */
export default function BillScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, space, font } = useTheme();
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
      <Screen scroll={false}>
        {error ? <Callout tone="danger">{error}</Callout> : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md }}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={{ ...font.callout, color: colors.textMuted }}>Loading your bill…</Text>
          </View>
        )}
      </Screen>
    );
  }
  const cur = bill.currency;
  const t = bill.totals;
  const closed = bill.status === 'closed';
  const waiting = bill.payments.filter((p) => p.status === 'awaiting_confirmation');
  const owes = owing(bill);
  const paidShare = t.total > 0 ? t.collected / t.total : 0;
  const state: { label: string; tone: Tone } = closed
    ? { label: 'Closed', tone: 'neutral' }
    : bill.share_disabled ? { label: 'Open · link is off', tone: 'warning' } : { label: 'Open', tone: 'success' };

  return (
    <Screen title={bill.store} subtitle={<Badge label={state.label} tone={state.tone} />} onRefresh={load}>
      {/* The money at a glance. */}
      <Card style={{ gap: space.md }}>
        <View style={{ gap: 2 }}>
          <Text style={{ ...font.caption, color: colors.textFaint }}>Collected so far</Text>
          <Text style={{ ...font.largeTitle, color: colors.text }}>
            {formatAmount(t.collected, cur)} <Text style={{ ...font.callout, color: colors.textMuted, fontWeight: '500' }}>of {formatAmount(t.total, cur)}</Text>
          </Text>
        </View>
        <ProgressBar value={paidShare} tone={paidShare >= 1 ? 'success' : 'accent'} />
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Stat label="Waiting on you" value={formatAmount(t.awaiting, cur)} tone={t.awaiting > 0 ? 'warning' : undefined} />
          <Stat label="Still to collect" value={formatAmount(t.outstanding, cur)} />
          <Stat label="Not picked yet" value={formatAmount(t.unassigned, cur)} tone={t.unassigned > 0 ? 'warning' : undefined} />
        </View>
      </Card>
      {!bill.payee && <Callout tone="warning">No payment details on this bill, so friends cannot pay yet.</Callout>}

      {waiting.length > 0 && <SectionTitle>Needs your check</SectionTitle>}
      {waiting.map((p) => (
        <Card key={p.id} tone="warning" style={{ gap: space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <Avatar name={p.participant_name} />
            <View style={{ flex: 1 }}>
              <Text style={{ ...font.headline, color: colors.text }}>{p.participant_name} says they sent {formatAmount(p.amount, cur)}</Text>
              <Text style={{ ...font.footnote, color: colors.textMuted }}>Reference {p.reference}{p.payer_note ? ` · theirs: ${p.payer_note}` : ''}</Text>
            </View>
          </View>
          <Text style={{ ...font.footnote, color: colors.textFaint }}>It is not confirmed until you check your account and tap below.</Text>
          <Button label="Check and confirm" icon="check" onPress={() => ask(p, cur)} disabled={busy} />
        </Card>
      ))}

      <SectionTitle right={!closed ? <Text onPress={() => Alert.prompt('Add someone', 'For a friend who is not using the link. You will pick their items.', (name) => { if (name?.trim()) void act((tk) => addPerson(id, tk, name.trim())); })} style={{ ...font.callout, color: colors.accent, fontWeight: '600' }}>Add someone</Text> : undefined}>
        People
      </SectionTitle>
      {bill.participants.length === 0 ? (
        <Card>
          <Text style={{ ...font.callout, color: colors.textMuted }}>Nobody has joined yet. Share the link and people will show up here as they pick their items.</Text>
          <Button label="Share link" icon="share" variant="secondary" onPress={() => void Share.share({ message: `Pick what you had on our bill at ${bill.store}: ${shareUrl(bill.share_token)}` })} />
        </Card>
      ) : (
        <Card style={{ paddingVertical: space.xs, gap: 0 }}>
          {bill.participants.map((p, n) => {
            const pay = p.payment ? LABEL[p.payment.status] ?? { text: p.payment.status, tone: 'neutral' as Tone } : { text: 'Not paid', tone: 'neutral' as Tone };
            const canRemind = !closed && owes.some((o) => o.id === p.id);
            return (
              <View key={p.id} style={{ paddingVertical: 12, borderBottomWidth: n === bill.participants.length - 1 ? 0 : 1, borderBottomColor: colors.border, gap: 8 }}>
                <Pressable onPress={() => router.push({ pathname: '/person', params: { id, pid: p.id } })} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <Avatar name={p.name} />
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={{ ...font.headline, color: colors.text }}>{p.name}</Text>
                    <Badge label={pay.text} tone={pay.tone} />
                  </View>
                  <Text style={{ ...font.number, color: colors.text }}>{formatAmount(p.total, cur)}</Text>
                  <Text style={{ color: colors.textFaint }}>›</Text>
                </Pressable>
                {canRemind && (
                  <Text onPress={() => void remind(bill, [p], reminderFor(bill, p))} style={{ ...font.footnote, color: colors.accent, fontWeight: '600', marginLeft: 52 }}>
                    Remind {p.name}{p.reminder_count > 0 ? ` · reminded ${agoLabel(p.last_reminded_at)}` : ''}
                  </Text>
                )}
              </View>
            );
          })}
        </Card>
      )}
      {!closed && owes.length > 1 && (
        <Button label={`Remind ${owes.length} people`} icon="bell" variant="secondary" onPress={() => void remind(bill, owes, groupReminder(bill, owes))} disabled={busy} />
      )}
      <Text style={{ ...font.footnote, color: colors.textFaint }}>
        TABLY cannot send texts or notifications. Remind opens your share sheet (WhatsApp, iMessage) so you send the message yourself.
      </Text>

      <SectionTitle>Manage</SectionTitle>
      <Card style={{ paddingVertical: space.xs, gap: 0 }}>
        {!closed && (
          <ListRow
            icon="edit"
            title="Edit receipt"
            detail="Fix an item or price. People on the link see the change."
            onPress={() => {
              startEditDraft(bill);
              router.push('/review');
            }}
          />
        )}
        <ListRow icon="share" title="Share link" onPress={() => void Share.share({ message: `Pick what you had on our bill at ${bill.store}: ${shareUrl(bill.share_token)}` })} />
        <ListRow icon="link" title="Link settings" detail={bill.share_disabled ? 'The link is off' : 'Turn off, extend or replace the link'} onPress={() => linkMenu(bill)} disabled={busy} />
        {closed
          ? <ListRow last icon="refresh" title="Reopen bill" onPress={() => void act((tk) => reopenBill(id, tk))} disabled={busy} />
          : <ListRow last icon="lock" title="Close bill" detail="Nobody can pick or pay after this. You can reopen it." tone="danger" onPress={() => closeFlow(bill)} disabled={busy} />}
      </Card>
    </Screen>
  );
}
