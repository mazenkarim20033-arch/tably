import { useEffect, useState } from 'react';
import { Alert, Image, Pressable, Share, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
  addItem, encodeOcrDump, formatAmount, reconcile, removeItem, setField, setItemDescription, setItemLineTotal,
  setItemQuantity, setTaxIncluded, type HeaderField, type Receipt,
} from '@tably/core';
import { Button } from '../components/Button';
import { Callout } from '../components/Bits';
import { Card, Section } from '../components/Card';
import { Screen } from '../components/Screen';
import { AmountField, TextField } from '../components/Fields';
import { useTheme } from '../theme/ThemeProvider';
import { getDraft, updateDraft, useDraft } from '../lib/draftStore';
import { ApiProblem, createBill, editReceipt, MismatchError } from '../lib/billsApi';
import { getAdminToken, savePayee, saveBill } from '../lib/myBills';
import { usePayeeForm } from '../lib/usePayeeForm';
import { PayeeFields } from '../components/PayeeFields';
import { readWithAi, useAiAvailable } from '../lib/aiRead';

const TOTAL_PATHS = ['subtotal', 'discounts', 'service', 'tax', 'tip', 'total'];
const CHECKED_HEADER = ['date', 'currency'];

/** The receipt being edited, read once when the screen opens (for initial open/closed state). */
function readDraftReceipt(): Receipt | null {
  return getDraft()?.receipt ?? null;
}

/** An item the person should look at before sharing. */
function needsLook(r: Receipt, i: Receipt['items'][number]): boolean {
  return (
    r.uncertain.includes(`items.${i.id}.lineTotal`) || r.uncertain.includes(`items.${i.id}.quantity`) ||
    i.flags.includes('does-not-add-up') || (i.suggestedLineTotal !== undefined && i.suggestedLineTotal !== i.lineTotal) ||
    i.lineTotal === null
  );
}

const money2 = (m: number | null) => (m === null ? '—' : (m / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export default function Review() {
  const { colors, space, radius, font, soft } = useTheme();
  const draft = useDraft();
  const [showImage, setShowImage] = useState(false);
  const [creating, setCreating] = useState(false);
  const form = usePayeeForm();
  const [aiBusy, setAiBusy] = useState(false);
  const [aiUsed, setAiUsed] = useState(0);
  const { on: aiOn, left: aiLeft } = useAiAvailable(aiUsed);
  // Which cards are unfolded. Items that need a look start open and stay open while they are fixed.
  const [openItems, setOpenItems] = useState<Set<string>>(() => {
    const r0 = readDraftReceipt();
    return new Set((r0?.items ?? []).filter((i) => needsLook(r0!, i)).map((i) => i.id));
  });
  const [totalsOpen, setTotalsOpen] = useState(() => {
    const r0 = readDraftReceipt();
    return !!r0 && (r0.total === null || TOTAL_PATHS.some((k) => r0.uncertain.includes(k)));
  });
  const [payeeOpen, setPayeeOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // A payee saved before folds away: the person only needs to change it now and then.
  useEffect(() => {
    if (form.hadSaved) setPayeeOpen(false);
  }, [form.hadSaved]);
  const { payee, hasPayee } = form;

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

  // Optional second opinion from an AI model: only after the person agrees to send this one photo, and never silently.
  const askAi = () => Alert.alert(
    'Send this photo to an AI service?',
    'The photo is sent once to be read, and not kept. Without it, TABLY reads everything on your phone. The AI can misread numbers too, so TABLY only uses its answer when it adds up better than the normal scan, and you can undo it.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Send and read',
        onPress: async () => {
          if (!draft.imageUri) return;
          setAiBusy(true);
          try {
            const out = await readWithAi(draft.imageUri, draft.ocr, draft.receipt);
            if (out.usedAi) updateDraft({ receipt: out.receipt, beforeAi: draft.receipt });
            else Alert.alert('Kept your scan', 'The AI reading did not add up any better than the normal scan, so nothing was changed.');
          } catch (e) {
            Alert.alert('AI reading did not work', e instanceof Error ? e.message : 'Try again later. Your normal scan is still here.');
          }
          setAiBusy(false);
          setAiUsed((n) => n + 1);
        },
      },
    ],
  );
  const aiOffer = draft.beforeAi ? (
    <Card tone="accent" style={{ gap: space.sm }}>
      <Text style={{ ...font.headline, color: colors.text }}>Read with AI</Text>
      <Text style={{ ...font.footnote, color: colors.textMuted }}>This reading came from the AI because it adds up better. Check the amounts against the receipt.</Text>
      <Button label="Undo, use my normal scan" variant="secondary" onPress={() => updateDraft({ receipt: draft.beforeAi!, beforeAi: undefined })} />
    </Card>
  ) : aiOn && draft.imageUri && !draft.editBillId && (rec.status !== 'ok' || r.uncertain.length > 0) ? (
    aiLeft === 0 ? null : <Card style={{ gap: space.sm }}>
      <Text style={{ ...font.headline, color: colors.text }}>Not sure about this scan?</Text>
      <Text style={{ ...font.footnote, color: colors.textMuted }}>Ask an AI to read the photo too. You choose each time.{aiLeft === null ? "" : ` ${aiLeft} left this month.`}</Text>
      <Button label={aiBusy ? 'Reading…' : 'Read with AI'} variant="secondary" loading={aiBusy} onPress={askAi} />
    </Card>
  ) : null;
  const flagged = (path: string) => r.uncertain.includes(path);
  // A disputed field: why, in a few words, and the values the evidence supports as one-tap choices.
  const dispute = (path: string, current: number | null, choices: number[] | undefined, use: (v: number) => void) => {
    const reason = r.reasons?.[path];
    const options = [...new Set(choices ?? [])].filter((v) => v !== current);
    if (!flagged(path) || (!reason && options.length === 0)) return null;
    return (
      <View style={{ gap: 6 }}>
        {reason && (
          <View style={{ padding: 10, borderRadius: 12, backgroundColor: soft.warning }}>
            <Text style={{ ...font.footnote, color: colors.text }}>{reason}</Text>
          </View>
        )}
        {options.length > 0 && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {options.map((v) => (
              <Pressable
                key={v}
                accessibilityRole="button"
                onPress={() => use(v)}
                style={{ paddingVertical: 8, paddingHorizontal: 16, borderRadius: radius.pill, backgroundColor: colors.accent }}
              >
                <Text style={{ color: colors.accentText, fontWeight: '600' }}>Use {formatAmount(v, r.currency)}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    );
  };
  const money = (k: Exclude<HeaderField, 'merchant' | 'date' | 'currency'>, label: string) => (
    <View style={{ gap: 6 }}>
      <AmountField label={label} value={r[k]} uncertain={flagged(k)} onChange={(v) => edit(setField(r, k, k === 'discounts' ? (v === null ? 0 : -Math.abs(v)) : v))} />
      {k !== 'discounts' && dispute(k, r[k], r.fieldChoices?.[k], (v) => edit(setField(r, k, v)))}
    </View>
  );
  const retake = () => {
    Alert.alert('Retake the photo?', 'Your changes to this receipt will be lost.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Retake', style: 'destructive', onPress: () => router.replace('/scan') },
    ]);
  };
  const lookCount =
    r.items.filter((i) => needsLook(r, i)).length +
    TOTAL_PATHS.filter((k) => r.uncertain.includes(k)).length +
    CHECKED_HEADER.filter((k) => r.uncertain.includes(k)).length;
  const status =
    rec.status === 'ok' ? { c: colors.success, t: 'Matches the receipt total' }
    : rec.status === 'mismatch' ? { c: colors.danger, t: `The receipt says ${money2(rec.printedTotal)}, which is ${money2(Math.abs(rec.difference ?? 0))} ${(rec.difference ?? 0) > 0 ? 'more' : 'less'}. Check the amounts below.` }
    : { c: colors.warning, t: rec.message };
  const toggle = <T,>(set: Set<T>, v: T) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  };
  const dateText = r.date ? new Date(`${r.date}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'No date';
  const totalsSummary = [
    r.subtotal !== null && `Subtotal ${money2(r.subtotal)}`,
    r.discounts !== 0 && `Discount ${money2(r.discounts)}`,
    r.service !== null && `Service ${money2(r.service)}`,
    r.tax !== null && `Tax ${money2(r.tax)}`,
    r.tip !== null && `Tip ${money2(r.tip)}`,
    r.total !== null && `Total ${money2(r.total)}`,
    r.taxIncluded && 'Tax and service included in prices',
  ].filter(Boolean).join('  ·  ') || 'Nothing printed below the items.';
  const payeeSummary = form.summary;
  const addUnparsed = (text: string) => {
    const added = addItem(r);
    const id = added.items[added.items.length - 1]!.id;
    edit({ ...setItemDescription(added, id, text.replace(/\s{2,}/g, ' ').trim()), unparsed: r.unparsed.filter((x) => x !== text) });
    setOpenItems((o) => new Set(o).add(id));
  };

  return (
    <Screen
      title={draft.editBillId ? 'Edit receipt' : 'Review receipt'}
      footer={
        <>
        <Button size="lg" loading={creating} label={creating ? 'Saving…' : draft.editBillId ? 'Save changes' : 'Looks right · create bill'} onPress={() => {
            if (r.total === null) {
              // Nothing printed to check against: say what friends will split and let the person decide.
              Alert.alert(
                'No receipt total to check',
                `There is no total on this receipt, so TABLY cannot double-check the items. Friends will split ${formatAmount(rec.computedTotal, r.currency)} (the items plus any charges). Continue?`,
                [{ text: 'Go back', style: 'cancel' }, { text: 'Continue', onPress: () => void create() }],
              );
            } else void create();
          }}
          disabled={creating || !form.valid || r.items.length === 0 || r.items.some((i) => i.lineTotal === null || i.description.trim() === '')} />
        <Text style={{ ...font.footnote, color: colors.textFaint, textAlign: 'center' }}>{draft.editBillId ? 'People on the link see the changes straight away.' : 'You will get a private link to share. Your edits are saved on this phone.'}</Text>
              </>
      }
    >
        {draft.ocrError && (
          <Callout tone="warning">Text recognition did not run ({draft.ocrError}) Enter the receipt below.</Callout>
        )}

        {aiOffer}

        {/* Summary: what this receipt is, what it adds up to, and how much needs a look. */}
        <Card tone={rec.status === 'mismatch' ? 'danger' : lookCount > 0 ? 'warning' : undefined} style={{ gap: space.md }}>
          <TextField value={r.merchant ?? ''} onChange={(v) => edit(setField(r, 'merchant', v))} placeholder="Restaurant name" />
          <Pressable onPress={() => setDetailsOpen((o) => !o)} accessibilityRole="button" style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: CHECKED_HEADER.some((k) => flagged(k)) ? colors.warning : colors.textMuted, fontSize: 14 }}>
              {dateText} · {r.currency}{CHECKED_HEADER.some((k) => flagged(k)) ? ' · check' : ''}
            </Text>
            <Text style={{ color: colors.accent, fontWeight: '600' }}>{detailsOpen ? 'Done' : 'Edit'}</Text>
          </Pressable>
          {detailsOpen && (
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <TextField label="Date (YYYY-MM-DD)" width="62%" value={r.date ?? ''} uncertain={flagged('date')} onChange={(v) => edit(setField(r, 'date', v === '' ? null : v))} placeholder="2026-11-03" autoCapitalize="none" />
              <TextField label="Currency" width="34%" value={r.currency} uncertain={flagged('currency')} onChange={(v) => edit(setField(r, 'currency', v.toUpperCase().slice(0, 3)))} autoCapitalize="characters" />
            </View>
          )}
          <View style={{ gap: 2 }}>
            <Text style={{ color: colors.textFaint, fontSize: 13 }}>Items and charges add up to</Text>
            <Text style={{ color: colors.text, fontSize: 32, fontWeight: '700', letterSpacing: -0.8 }}>{money2(rec.computedTotal)} <Text style={{ fontSize: 16, fontWeight: '500', color: colors.textMuted }}>{r.currency}</Text></Text>
          </View>
          <Text style={{ color: status.c, fontWeight: '600' }}>{status.t}</Text>
          {lookCount > 0 && (
            <Text style={{ color: colors.warning, fontSize: 14 }}>
              {lookCount === 1 ? '1 thing' : `${lookCount} things`} to check, outlined in amber below.
            </Text>
          )}
          {(r.notes ?? []).map((n) => (
            <Text key={n} style={{ color: colors.textMuted, fontSize: 13 }}>• {n}</Text>
          ))}
          <View style={{ flexDirection: 'row', gap: space.lg, alignItems: 'center', flexWrap: 'wrap' }}>
            {draft.imageUri && (
              <Pressable onPress={() => setShowImage((v) => !v)} accessibilityRole="button">
                <Text style={{ color: colors.accent, fontWeight: '600' }}>{showImage ? 'Hide original' : 'Show original'}</Text>
              </Pressable>
            )}
            {!draft.editBillId && (
              <Pressable onPress={retake} accessibilityRole="button">
                <Text style={{ color: colors.accent, fontWeight: '600' }}>{draft.imageUri ? 'Retake photo' : 'Scan a receipt instead'}</Text>
              </Pressable>
            )}
          </View>
          {showImage && draft.imageUri && <Image source={{ uri: draft.imageUri }} resizeMode="contain" style={{ width: '100%', height: 420, borderRadius: radius.sm }} />}
        </Card>

        {/* Items: one line each; tap to edit. Items that need a look start open. */}
        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600', marginTop: space.sm }}>Items</Text>
        {r.items.map((i) => {
          const open = openItems.has(i.id);
          const look = needsLook(r, i);
          const reason = r.reasons?.[`items.${i.id}.lineTotal`] ?? r.reasons?.[`items.${i.id}.quantity`];
          return (
            <Card key={i.id} tone={look ? 'warning' : undefined}>
              <Pressable onPress={() => setOpenItems((o) => toggle(o, i.id))} accessibilityRole="button" accessibilityState={{ expanded: open }} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
                <View style={{ minWidth: 36, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 999, backgroundColor: colors.surfaceMuted, alignItems: 'center' }}>
                  <Text style={{ ...font.caption, color: colors.textMuted, fontWeight: '700' }}>{i.quantity}×</Text>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text numberOfLines={open ? undefined : 2} style={{ color: i.description.trim() ? colors.text : colors.textFaint, fontSize: 16 }}>{i.description.trim() || 'Unnamed item'}</Text>
                  {!open && look && reason ? <Text numberOfLines={2} style={{ color: colors.warning, fontSize: 13 }}>{reason}</Text> : null}
                  {i.quantity > 1 && i.unitPrice !== null && !open ? <Text style={{ color: colors.textFaint, fontSize: 13 }}>{money2(i.unitPrice)} each</Text> : null}
                </View>
                <Text style={{ color: look ? colors.warning : colors.text, fontSize: 16, fontWeight: '600' }}>{money2(i.lineTotal)}</Text>
              </Pressable>
              {open && (
                <View style={{ gap: space.sm }}>
                  <TextField label="Name" value={i.description} onChange={(v) => edit(setItemDescription(r, i.id, v))} placeholder="Item" />
                  {i.suggestedLineTotal !== undefined && i.suggestedLineTotal !== i.lineTotal && !r.reasons?.[`items.${i.id}.lineTotal`] && (
                    <Text style={{ color: colors.warning, fontSize: 13 }}>
                      The items only add up to the receipt if this price is {formatAmount(i.suggestedLineTotal, r.currency)}. The scanner may have misread a digit. Check the photo.
                    </Text>
                  )}
                  {dispute(
                    `items.${i.id}.lineTotal`,
                    i.lineTotal,
                    [...(i.suggestedLineTotal !== undefined ? [i.suggestedLineTotal] : []), ...(i.choices ?? [])],
                    (v) => edit(setItemLineTotal(r, i.id, v)),
                  )}
                  {flagged(`items.${i.id}.quantity`) && r.reasons?.[`items.${i.id}.quantity`] && r.reasons[`items.${i.id}.quantity`] !== r.reasons[`items.${i.id}.lineTotal`] && (
                    <Text style={{ color: colors.warning, fontSize: 13 }}>{r.reasons[`items.${i.id}.quantity`]}</Text>
                  )}
                  {i.flags.includes('does-not-add-up') && (
                    <Text style={{ color: colors.warning, fontSize: 13 }}>
                      This may not be an item: without it, the items match the receipt subtotal. Remove it if it is something else (an address, a code).
                    </Text>
                  )}
                  <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-end' }}>
                    <TextField label="Qty" width={70} keyboardType="number-pad" value={String(i.quantity)} uncertain={flagged(`items.${i.id}.quantity`)} onChange={(v) => edit(setItemQuantity(r, i.id, Number(v)))} />
                    <View style={{ flex: 1 }}>
                      <AmountField label={i.quantity > 1 ? 'Line total' : 'Price'} value={i.lineTotal} uncertain={flagged(`items.${i.id}.lineTotal`)} onChange={(v) => edit(setItemLineTotal(r, i.id, v))} />
                    </View>
                  </View>
                  {i.quantity > 1 && (
                    <Text style={{ color: colors.textFaint, fontSize: 13 }}>
                      {i.unitPrice === null ? 'Per-unit price not exact; kept as a line total.' : `${formatAmount(i.unitPrice, r.currency)} each`}
                    </Text>
                  )}
                  <Pressable onPress={() => edit(removeItem(r, i.id))} accessibilityRole="button" accessibilityLabel={`Remove ${i.description || 'item'}`} hitSlop={8} style={{ alignSelf: 'flex-start' }}>
                    <Text style={{ color: colors.danger, fontWeight: '600' }}>Remove item</Text>
                  </Pressable>
                </View>
              )}
            </Card>
          );
        })}
        <Button
          label="Add item"
          icon="plus"
          variant="secondary"
          onPress={() => {
            const added = addItem(r);
            edit(added);
            setOpenItems((o) => new Set(o).add(added.items[added.items.length - 1]!.id));
          }}
        />

        {r.unparsed.length > 0 && (
          <Card>
            <Text style={{ color: colors.textMuted, fontSize: 14 }}>Rows we could not read. Tap one to add it as an item:</Text>
            {r.unparsed.map((u, n) => (
              <Pressable key={n} onPress={() => addUnparsed(u)} accessibilityRole="button" style={{ paddingVertical: 4 }}>
                <Text style={{ color: colors.accent, fontSize: 15 }}>+ {u.replace(/\s{2,}/g, ' ')}</Text>
              </Pressable>
            ))}
          </Card>
        )}

        <Section
          title="Totals and charges"
          summary={totalsSummary}
          open={totalsOpen}
          onToggle={() => setTotalsOpen((o) => !o)}
          tone={rec.status === 'mismatch' ? 'danger' : TOTAL_PATHS.some((k) => flagged(k)) ? 'warning' : undefined}
        >
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
        </Section>

        {!draft.editBillId && (
          <Section title="Where should friends pay you?" summary={payeeSummary} open={payeeOpen} onToggle={() => setPayeeOpen((o) => !o)} tone={hasPayee ? undefined : 'warning'}>
            <PayeeFields form={form} />
          </Section>
        )}

        {draft.ocr.length > 0 && (
          <Text
            accessibilityRole="button"
            onPress={() =>
              // Only when the person taps it: the raw text the scanner read, to report a bad reading.
              void Share.share({
                message: encodeOcrDump({ lines: draft.ocr, width: draft.ocrSize?.width ?? 0, height: draft.ocrSize?.height ?? 0 }),
              })
            }
            style={{ color: colors.textFaint, fontSize: 13, textDecorationLine: 'underline', textAlign: 'center', marginTop: space.sm }}
          >
            Something wrong with the scan? Share what the scanner read
          </Text>
        )}
    </Screen>
  );
}
