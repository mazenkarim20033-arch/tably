import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { formatAmount } from '@tably/core';
import { useTheme } from '../theme/ThemeProvider';
import { Badge, ProgressBar } from './Bits';
import { Card } from './Card';
import { Icon } from './Icon';
import { billStatus, type BillRow } from '../lib/useBills';
import { dateLocale, t, useLang } from '../lib/i18n';

/** One bill in a list: who it is for, how much, and how far along the paying is. */
export function BillCard({ bill, onRemove }: { bill: BillRow; onRemove?: () => void }) {
  useLang();
  const { colors, soft, font, space } = useTheme();
  const status = billStatus(bill);
  const s = bill.live;
  const total = s?.total ?? bill.total;
  const cur = s?.currency ?? bill.currency;
  const paid = s && !s.missing && total > 0 ? (s.collected ?? 0) / total : null;
  return (
    <Card
      tone={s?.waiting ? 'warning' : undefined}
      onPress={() => router.push({ pathname: '/bill/[id]', params: { id: bill.id } })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: soft.accent }}>
          <Icon name="receipt" size={22} color={colors.accent} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={1} style={{ ...font.headline, color: colors.text }}>{bill.store}</Text>
          <Text style={{ ...font.footnote, color: colors.textFaint }}>
            {new Date(bill.createdAt).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })}
            {s?.people ? ` · ${s.people === 1 ? t('{n} person', { n: 1 }) : t('{n} people', { n: s.people })}` : ''}
          </Text>
        </View>
        <Text style={{ ...font.number, color: colors.text }}>{formatAmount(total, cur)}</Text>
      </View>
      {paid !== null && <ProgressBar value={paid} tone={paid >= 1 ? 'success' : 'accent'} />}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Badge label={status.label} tone={status.tone} />
        {onRemove ? <Text onPress={onRemove} style={{ ...font.footnote, color: colors.danger, fontWeight: '600' }}>{t('Remove from this phone')}</Text> : <Icon name="chevron-right" size={18} color={colors.textFaint} />}
      </View>
    </Card>
  );
}
