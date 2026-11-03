import { useEffect, useState } from 'react';
import { Share, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { formatAmount } from '@tably/core';
import { Button } from '../components/Button';
import { useTheme } from '../theme/ThemeProvider';
import { listBills, shareUrl, type MyBill } from '../lib/myBills';

export default function ShareScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, space, radius } = useTheme();
  const [bill, setBill] = useState<MyBill | null | undefined>(undefined);

  useEffect(() => {
    void listBills().then((all) => setBill(all.find((b) => b.id === id) ?? null));
  }, [id]);

  if (bill === undefined) return null;
  if (bill === null) {
    return (
      <SafeAreaView style={{ flex: 1, padding: space.lg, backgroundColor: colors.bg }}>
        <Text style={{ color: colors.text, fontSize: 20 }}>Bill not found on this phone.</Text>
        <Button label="Home" variant="quiet" onPress={() => router.replace('/')} />
      </SafeAreaView>
    );
  }
  const url = shareUrl(bill.shareToken);

  return (
    <SafeAreaView style={{ flex: 1, padding: space.lg, justifyContent: 'space-between', backgroundColor: colors.bg }}>
      <View style={{ gap: space.sm, marginTop: space.xl }}>
        <Text style={{ color: colors.textFaint, fontSize: 13 }}>Bill created</Text>
        <Text style={{ color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.6 }}>{bill.store}</Text>
        <Text style={{ color: colors.textMuted, fontSize: 16 }}>{formatAmount(bill.total, bill.currency)}</Text>
        <View style={{ marginTop: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }}>
          <Text selectable style={{ color: colors.text, fontSize: 15 }}>{url}</Text>
        </View>
        <Text style={{ color: colors.textFaint, fontSize: 13, lineHeight: 19 }}>
          Anyone with this link can pick items on this bill, so share it only with the people eating with you. The link expires in 30 days.
        </Text>
      </View>
      <View style={{ gap: space.sm }}>
        <Button label="Share link" onPress={() => Share.share({ message: `Pick what you had on our bill at ${bill.store}: ${url}`, url })} />
        <Button label="View payments" variant="quiet" onPress={() => router.replace({ pathname: '/bill/[id]', params: { id: bill.id } })} />
        <Button label="Done" variant="quiet" onPress={() => router.replace('/')} />
      </View>
    </SafeAreaView>
  );
}
