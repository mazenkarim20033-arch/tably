import { useEffect, useRef, useState } from 'react';
import { Animated, Share, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { brand, formatAmount } from '@tably/core';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState } from '../components/Bits';
import { Icon } from '../components/Icon';
import { Screen } from '../components/Screen';
import { useTheme } from '../theme/ThemeProvider';
import { listBills, shareUrl, type MyBill } from '../lib/myBills';

export default function ShareScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, space, font, shadow } = useTheme();
  const [bill, setBill] = useState<MyBill | null | undefined>(undefined);
  const pop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    void listBills().then((all) => setBill(all.find((b) => b.id === id) ?? null));
  }, [id]);
  useEffect(() => {
    if (bill) Animated.spring(pop, { toValue: 1, useNativeDriver: true, speed: 8, bounciness: 10 }).start();
  }, [bill, pop]);

  if (bill === undefined) return null;
  if (bill === null) {
    return (
      <Screen back={false} scroll={false}>
        <EmptyState icon="alert" title="Bill not found" body="This bill is not saved on this phone." action="Back to home" onAction={() => router.replace('/')} />
      </Screen>
    );
  }
  const url = shareUrl(bill.shareToken);
  const send = () => Share.share({ message: `Pick what you had on our bill at ${bill.store}: ${url}`, url });

  return (
    <Screen
      back={false}
      footer={
        <>
          <Button label="Share link" icon="share" size="lg" onPress={send} />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <View style={{ flex: 1 }}><Button label="View payments" variant="secondary" onPress={() => router.replace({ pathname: '/bill/[id]', params: { id: bill.id } })} /></View>
            <View style={{ flex: 1 }}><Button label="Done" variant="ghost" onPress={() => router.replace('/')} /></View>
          </View>
        </>
      }
    >
      <View style={{ alignItems: 'center', gap: space.md, marginTop: space.xl }}>
        <Animated.View style={{ transform: [{ scale: pop }], opacity: pop, ...shadow.glow }}>
          <LinearGradient colors={[...brand.gradient]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="check" size={48} color="#fff" strokeWidth={3} />
          </LinearGradient>
        </Animated.View>
        <View style={{ alignItems: 'center', gap: 4 }}>
          <Text style={{ ...font.callout, color: colors.success, fontWeight: '600' }}>Bill created</Text>
          <Text style={{ ...font.largeTitle, color: colors.text, textAlign: 'center' }}>{bill.store}</Text>
          <Text style={{ ...font.title, fontSize: 22, color: colors.textMuted }}>{formatAmount(bill.total, bill.currency)}</Text>
        </View>
      </View>

      <Card style={{ marginTop: space.md, gap: space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="link" size={16} color={colors.textMuted} />
          <Text style={{ ...font.footnote, color: colors.textMuted, fontWeight: '600' }}>Link for your friends</Text>
        </View>
        <Text selectable style={{ ...font.callout, color: colors.text }}>{url}</Text>
        <Text style={{ ...font.footnote, color: colors.textFaint }}>Touch and hold the link to copy it.</Text>
      </Card>
      <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 4 }}>
        <Icon name="lock" size={16} color={colors.textFaint} />
        <Text style={{ ...font.footnote, color: colors.textFaint, flex: 1 }}>
          Anyone with this link can pick items on this bill, so share it only with the people eating with you. It expires in 30 days.
        </Text>
      </View>
    </Screen>
  );
}
