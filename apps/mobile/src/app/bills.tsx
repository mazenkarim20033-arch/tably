import { useCallback, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { formatAmount } from '@tably/core';
import { Button } from '../components/Button';
import { useTheme } from '../theme/ThemeProvider';
import { fetchSummaries, type BillSummary } from '../lib/billsApi';
import { forgetBill, getAdminToken, listBills, type MyBill } from '../lib/myBills';

interface Row extends MyBill {
  live?: BillSummary;
}

/** Everything this phone created. Live status comes from the server; if offline, the saved basics still show. */
export default function Bills() {
  const { colors, space, radius } = useTheme();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [offline, setOffline] = useState(false);

  useFocusEffect(useCallback(() => {
    let alive = true;
    (async () => {
      const mine = await listBills();
      if (alive) setRows(mine);
      try {
        const refs = (await Promise.all(mine.map(async (b) => ({ id: b.id, admin_token: (await getAdminToken(b.id)) ?? '' })))).filter((r) => r.admin_token);
        const live = await fetchSummaries(refs);
        if (!alive) return;
        const byId = new Map(live.map((s) => [s.id, s]));
        setRows(mine.map((b) => ({ ...b, live: byId.get(b.id) })));
        setOffline(false);
      } catch {
        if (alive) setOffline(true);
      }
    })();
    return () => { alive = false; };
  }, []));

  const badge = (r: Row) => {
    const s = r.live;
    if (!s || s.missing) return s?.missing ? 'Not found on server' : '';
    if (s.status === 'closed') return 'Closed';
    if (s.waiting) return `${s.waiting} to confirm`;
    if ((s.outstanding ?? 0) === 0 && (s.total ?? 0) > 0) return 'All paid';
    return `${formatAmount(s.outstanding ?? 0, s.currency ?? r.currency)} outstanding`;
  };

  return (
    <SafeAreaView style={{ flex: 1, padding: space.lg, backgroundColor: colors.bg, gap: space.md }}>
      <Text style={{ color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.6, marginTop: space.md }}>Previous bills</Text>
      {offline && <Text style={{ color: colors.warning, fontSize: 13 }}>Could not reach the server. Showing what is saved on this phone.</Text>}
      {rows && rows.length === 0 && <Text style={{ color: colors.textMuted }}>No bills yet. Scan a receipt to create one.</Text>}
      <FlatList
        data={rows ?? []}
        keyExtractor={(b) => b.id}
        contentContainerStyle={{ gap: space.sm }}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push({ pathname: '/bill/[id]', params: { id: item.id } })}
            onLongPress={() => item.live?.missing && void forgetBill(item.id).then(() => setRows((r) => r?.filter((x) => x.id !== item.id) ?? r))}
            style={{ padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface, borderColor: item.live?.waiting ? colors.warning : colors.border, borderWidth: 1, flexDirection: 'row', justifyContent: 'space-between' }}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>{item.store}</Text>
              <Text style={{ color: colors.textFaint, fontSize: 13 }}>
                {item.createdAt.slice(0, 10)}{item.live?.people ? ` · ${item.live.people} ${item.live.people === 1 ? 'person' : 'people'}` : ''}
              </Text>
              <Text style={{ color: item.live?.waiting ? colors.warning : colors.textMuted, fontSize: 13 }}>{badge(item)}</Text>
            </View>
            <Text style={{ color: colors.textMuted }}>{formatAmount(item.live?.total ?? item.total, item.currency)}</Text>
          </Pressable>
        )}
      />
      <Button label="Back" variant="quiet" onPress={() => router.back()} />
    </SafeAreaView>
  );
}
