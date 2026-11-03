import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { brand, type as t } from '@tably/core';
import { Logo } from '../components/Logo';
import { Button } from '../components/Button';
import { useTheme } from '../theme/ThemeProvider';

export default function Home() {
  const { colors, space } = useTheme();
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bg, padding: space.lg }]}>
      <View style={styles.hero}>
        <Logo size={84} />
        <Text style={[styles.title, { color: colors.text }]}>{brand.name}</Text>
        <Text style={[styles.tagline, { color: colors.textMuted }]}>{brand.tagline}</Text>
      </View>
      <View style={{ gap: space.sm }}>
        <Button label="Scan a receipt" onPress={() => router.push('/scan')} />
        <Button label="Previous bills" variant="quiet" onPress={() => router.push('/bills')} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'space-between' },
  hero: { flex: 1, justifyContent: 'center', alignItems: 'flex-start', gap: 12 },
  title: { fontSize: t.display.size, fontWeight: '700', letterSpacing: t.display.tracking, marginTop: 16 },
  tagline: { fontSize: 18, lineHeight: 26, maxWidth: 280 },
});
