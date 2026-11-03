import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Button } from './Button';
import { useTheme } from '../theme/ThemeProvider';

/** Honest stand-in for screens that arrive in later phases. */
export function Placeholder({ title, note }: { title: string; note: string }) {
  const { colors, space } = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, padding: space.lg, justifyContent: 'space-between', backgroundColor: colors.bg }}>
      <View style={{ gap: space.sm, marginTop: space.xl }}>
        <Text style={{ color: colors.text, fontSize: 24, fontWeight: '600' }}>{title}</Text>
        <Text style={{ color: colors.textMuted, fontSize: 16 }}>{note}</Text>
      </View>
      <Button label="Back" variant="quiet" onPress={() => router.back()} />
    </SafeAreaView>
  );
}
