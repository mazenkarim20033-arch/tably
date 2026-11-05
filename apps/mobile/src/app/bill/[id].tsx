import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Share, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { formatAmount } from '@tably/core';
import { Button } from '../../components/Button';
import { Avatar, Badge, Callout, ProgressBar, Stat, type Tone } from '../../components/Bits';
import { Icon } from '../../components/Icon';
import { Card, ListRow, SectionTitle } from '../../components/Card';
import { Screen } from '../../components/Screen';
import { useTheme } from '../../theme/ThemeProvider';
import {
  addPerson, closeBill, confirmPayment, getAdminBill, logReminders, rejectPayment, reopenBill, updateLink, updatePayee,
  type AdminBill, type AdminPayment, ApiProblem,
} from '../../lib/billsApi';
import { getAdminToken, loadPayee, shareUrl, updateShareToken } from '../../lib/myBills';
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
  // Payments the person has ticked after finding them in their own bank. Nothing is ticked for them.
  const [picked, setPicked] = useState<Set<string>>(new Set());

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

  /** Confirm every ticked payment, one request each, so a failure on one never hides the others. */
  function confirmPicked(list: AdminPayment[], cur: string) {
    const sum = list.reduce((t, p) => t + p.amount, 0);
    Alert.alert(
      `Confirm ${list.length} ${list.length === 1 ? 'payment' : 'payments'}?`,
      `That is ${formatAmount(sum, cur)} in total. Only confirm payments you can see in your own bank or InstaPay account.`,
      [
        { text: 'Not yet', style: 'cancel' },
        { text: `Yes, confirm ${formatAmount(sum, cur)}`, onPress: () => void doConfirm(list) },
      ],
    );
  }

  async function doConfirm(list: AdminPayment[]) {
    const token = await getAdminToken(id);
    if (!token) return;
    setBusy(true);
    const failed: string[] = [];
    for (const p of list) {
      try {
        setBill(await confirmPayment(id, token, p.id));
      } catch {
        failed.push(p.participant_name);
      }
    }
    setPicked(new Set());
    setBusy(false);
    if (failed.length > 0) Alert.alert('Some could not be confirmed', `${failed.join(', ')}. Pull down to refresh and try again.`);
  }

  function notReceived(p: AdminPayment) {
    Alert.alert(`Mark ${p.participant_name}'s payment as not received?`, 'They will be told it was not found and can pay again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Not received', style: 'destructive', onPress: () => void act((t) => rejectPayment(id, t, p.id)) },
    ]);
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

  /** Where friends pay: use the details saved on this phone, or go and edit them. */
  function paymentMenu() {
    Alert.alert('Payment details', 'These are what your friends see when they pay.', [
      {
        text: 'Use my saved details',
        onPress: async () => {
          const saved = await loadPayee();
          if (!saved) return void router.push('/payment');
          const token = await getAdminToken(id);
          if (!token) return;
          setBusy(true);
          try {
            setBill(await updatePayee(id, token, saved));
            Alert.alert('Updated', 'Friends now see your saved payment details on this bill.');
          } catch (e) {
            Alert.alert('Could not update', e instanceof Error ? e.message : 'Please try again.');
          }
          setBusy(false);
        },
      },
      { text: 'Edit my saved details', onPress: () => router.push('/payment') },
      { text: 'Cancel', style: 'cancel' },
    ]);
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

      {waiting.length > 0 && (() => {
        const list = [...waiting].sort((x, y) => x.amount - y.amount);
        const chosen = list.filter((p) => picked.has(p.id));
        const chosenSum = chosen.reduce((t, p) => t + p.amount, 0);
        const all = chosen.length === list.length;
        return (
          <>
            <SectionTitle>Check your bank once</SectionTitle>
            <Card tone="warning" style={{ gap: space.md }}>
              <Text style={{ ...font.callout, color: colors.textMuted }}>
                Open your bank or InstaPay and look for these {list.length === 1 ? 'deposit' : `${list.length} deposits`}. Tick the ones you can see, then confirm them together.
              </Text>
              {list.map((p) => {
                const on = picked.has(p.id);
                return (
                  <View key={p.id} style={{ gap: 6 }}>
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: on }}
                      onPress={() => setPicked((cur0) => { const n = new Set(cur0); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}
                    >
                      <View style={{ width: 26, height: 26, borderRadius: 8, borderWidth: 2, borderColor: on ? colors.accent : colors.border, backgroundColor: on ? colors.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                        {on ? <Icon name="check" size={16} color={colors.accentText} strokeWidth={3} /> : null}
                      </View>
                      <Avatar name={p.participant_name} size={36} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ ...font.headline, color: colors.text }}>{p.participant_name}</Text>
                        <Text style={{ ...font.footnote, color: colors.textMuted }}>Note {p.reference}{p.payer_note ? ` · theirs: ${p.payer_note}` : ''}</Text>
                      </View>
                      <Text style={{ ...font.number, color: colors.text }}>{formatAmount(p.amount, cur)}</Text>
                    </Pressable>
                    <Text onPress={() => notReceived(p)} style={{ ...font.footnote, color: colors.danger, fontWeight: '600', marginLeft: 26 + 12 + 36 + 12 }}>Not received</Text>
                  </View>
                );
              })}
              <View style={{ gap: space.sm }}>
                <Button
                  label={chosen.length === 0 ? 'Tick what you can see' : `Confirm ${chosen.length} · ${formatAmount(chosenSum, cur)}`}
                  icon="check"
                  onPress={() => confirmPicked(chosen, cur)}
                  disabled={busy || chosen.length === 0}
                />
                {list.length > 1 && (
                  <Button label={all ? 'Untick all' : 'Tick all'} variant="ghost" size="sm" onPress={() => setPicked(all ? new Set() : new Set(list.map((p) => p.id)))} />
                )}
              </View>
              <Text style={{ ...font.footnote, color: colors.textFaint }}>Nothing counts as paid until you confirm it here.</Text>
            </Card>
          </>
        );
      })()}

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
        {!closed && <ListRow icon="wallet" title="Payment details" detail="Where friends are told to pay" onPress={paymentMenu} disabled={busy} />}
        <ListRow icon="share" title="Share link" onPress={() => void Share.share({ message: `Pick what you had on our bill at ${bill.store}: ${shareUrl(bill.share_token)}` })} />
        <ListRow icon="link" title="Link settings" detail={bill.share_disabled ? 'The link is off' : 'Turn off, extend or replace the link'} onPress={() => linkMenu(bill)} disabled={busy} />
        {closed
          ? <ListRow last icon="refresh" title="Reopen bill" onPress={() => void act((tk) => reopenBill(id, tk))} disabled={busy} />
          : <ListRow last icon="lock" title="Close bill" detail="Nobody can pick or pay after this. You can reopen it." tone="danger" onPress={() => closeFlow(bill)} disabled={busy} />}
      </Card>
    </Screen>
  );
}
