import { useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { formatAmount } from '@tably/core';
import { Button } from '../components/Button';
import { useTheme } from '../theme/ThemeProvider';
import { listBills, type MyBill } from '../lib/myBills';

export default function Bills() {
  const { colors, space, radius } = useTheme();
  const [bills, setBills] = useState<MyBill[] | null>(null);
  useEffect(() => {
    void listBills().then(setBills);
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, padding: space.lg, backgroundColor: colors.bg, gap: space.md }}>
      <Text style={{ color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.6, marginTop: space.md }}>Previous bills</Text>
      {bills && bills.length === 0 && <Text style={{ color: colors.textMuted }}>No bills yet. Scan a receipt to create one.</Text>}
      <FlatList
        data={bills ?? []}
        keyExtractor={(b) => b.id}
        contentContainerStyle={{ gap: space.sm }}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push({ pathname: '/share', params: { id: item.id } })}
            style={{ padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, flexDirection: 'row', justifyContent: 'space-between' }}
          >
            <View>
              <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>{item.store}</Text>
              <Text style={{ color: colors.textFaint, fontSize: 13 }}>{item.createdAt.slice(0, 10)}</Text>
            </View>
            <Text style={{ color: colors.textMuted }}>{formatAmount(item.total, item.currency)}</Text>
          </Pressable>
        )}
      />
      <Text style={{ color: colors.textFaint, fontSize: 12 }}>Payment tracking and the creator dashboard arrive in Phase 6.</Text>
      <Button label="Back" variant="quiet" onPress={() => router.back()} />
    </SafeAreaView>
  );
}
