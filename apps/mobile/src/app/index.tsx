import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import { brand } from '@tably/core';
import { Logo } from '../components/Logo';
import { Button } from '../components/Button';
import { BillCard } from '../components/BillCard';
import { Icon, type IconName } from '../components/Icon';
import { Card, SectionTitle } from '../components/Card';
import { useTheme } from '../theme/ThemeProvider';
import { useBills } from '../lib/useBills';
import { loadPayee } from '../lib/myBills';

const STEPS: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: 'camera', title: 'Scan the receipt', body: 'Take a photo. TABLY reads the items and checks the total.' },
  { icon: 'share', title: 'Share one link', body: 'Friends open it in their browser, no app needed, and pick what they had.' },
  { icon: 'wallet', title: 'Everyone pays their share', body: 'You confirm each payment, so nothing is marked paid by mistake.' },
];

export default function Home() {
  const { colors, space, font, soft, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const { rows } = useBills();
  // Whether payment details are saved on this phone: they decide what friends are offered when they pay.
  const [paySaved, setPaySaved] = useState<boolean | null>(null);
  useFocusEffect(useCallback(() => {
    void loadPayee().then((p) => setPaySaved(!!p?.payee_name && !!(p.instapay_address || p.instapay_phone || p.instapay_link || (p.methods?.length ?? 0) > 0)));
  }, []));
  const recent = (rows ?? []).slice(0, 3);
  const first = rows !== null && rows.length === 0;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* A soft glow of the brand colours behind the top of the screen. */}
      <LinearGradient
        pointerEvents="none"
        colors={[dark ? 'rgba(109,91,247,0.28)' : 'rgba(109,91,247,0.16)', dark ? 'rgba(34,200,232,0.10)' : 'rgba(34,200,232,0.08)', 'transparent']}
        locations={[0, 0.5, 1]}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 380 }}
      />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: space.lg, paddingBottom: 170 + insets.bottom, gap: space.lg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Logo size={36} />
            <Text style={{ ...font.title, fontSize: 21, letterSpacing: 1.5, color: colors.text }}>{brand.name}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            {!first && rows !== null && (
              <Pressable onPress={() => router.push('/bills')} accessibilityRole="button" hitSlop={10}>
                <Text style={{ ...font.callout, color: colors.accent, fontWeight: '600' }}>All bills</Text>
              </Pressable>
            )}
            <Pressable onPress={() => router.push('/about')} accessibilityRole="button" accessibilityLabel="About and privacy" hitSlop={12}>
              <Icon name="info" size={22} color={colors.textMuted} />
            </Pressable>
          </View>
        </View>

        {recent.length === 0 ? (
          <>
            <View style={{ gap: space.sm, marginTop: space.lg }}>
              <Text style={{ ...font.largeTitle, fontSize: 38, lineHeight: 44, color: colors.text }}>Split the bill,{'\n'}not the friendship.</Text>
              <Text style={{ ...font.body, color: colors.textMuted, maxWidth: 320 }}>
                Scan a receipt, send one link, and everyone picks and pays their own share.
              </Text>
            </View>
            <SectionTitle>How it works</SectionTitle>
            <View style={{ gap: space.sm }}>
              {STEPS.map((s, n) => (
                <View key={s.title} style={{ flexDirection: 'row', gap: space.md, alignItems: 'center', padding: space.md, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
                  <View style={{ width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: soft.accent }}>
                    <Icon name={s.icon} size={22} color={colors.accent} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ ...font.headline, color: colors.text }}>{n + 1}. {s.title}</Text>
                    <Text style={{ ...font.footnote, color: colors.textMuted }}>{s.body}</Text>
                  </View>
                </View>
              ))}
            </View>
          </>
        ) : (
          <>
            <View style={{ gap: 4, marginTop: space.sm }}>
              <Text style={{ ...font.largeTitle, color: colors.text }}>Your bills</Text>
              <Text style={{ ...font.callout, color: colors.textMuted }}>Pick up where you left off.</Text>
            </View>
            <View style={{ gap: space.sm }}>
              {recent.map((b) => <BillCard key={b.id} bill={b} />)}
            </View>
          </>
        )}
        {paySaved !== null && (
          <Card tone={paySaved ? undefined : 'accent'} onPress={() => router.push('/payment')}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <View style={{ width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: soft.accent }}>
                <Icon name="wallet" size={22} color={colors.accent} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ ...font.headline, color: colors.text }}>{paySaved ? 'Payment details' : 'Add your payment details'}</Text>
                <Text style={{ ...font.footnote, color: colors.textMuted }}>
                  {paySaved ? 'Saved. Every new bill uses them.' : 'Save your InstaPay link once, so friends can pay you in one tap.'}
                </Text>
              </View>
              <Icon name="chevron-right" size={18} color={colors.textFaint} />
            </View>
          </Card>
        )}
      </ScrollView>

      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: Math.max(insets.bottom, space.md), backgroundColor: colors.bg, gap: space.sm }}>
        <Button label="Scan a receipt" icon="camera" size="lg" onPress={() => router.push('/scan')} />
      </View>
    </SafeAreaView>
  );
}
