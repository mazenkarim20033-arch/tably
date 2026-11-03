import { Pressable, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { brand } from '@tably/core';
import { useTheme } from '../theme/ThemeProvider';

type Props = { label: string; onPress: () => void; variant?: 'primary' | 'quiet'; disabled?: boolean };

export function Button({ label, onPress, variant = 'primary', disabled }: Props) {
  const { colors, radius } = useTheme();
  const base = { borderRadius: radius.pill, opacity: disabled ? 0.5 : 1 };
  if (variant === 'quiet') {
    return (
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [styles.btn, base, { backgroundColor: colors.surfaceMuted, opacity: pressed ? 0.7 : base.opacity }]}
      >
        <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [base, { opacity: pressed ? 0.85 : base.opacity, overflow: 'hidden' }]}
    >
      <LinearGradient colors={[...brand.gradient]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.btn}>
        <Text style={[styles.label, { color: '#fff' }]}>{label}</Text>
      </LinearGradient>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { paddingVertical: 16, paddingHorizontal: 24, alignItems: 'center' },
  label: { fontSize: 16, fontWeight: '600', letterSpacing: 0.2 },
});
