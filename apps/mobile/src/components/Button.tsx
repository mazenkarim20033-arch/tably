import { useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { brand } from '@tably/core';
import { useTheme } from '../theme/ThemeProvider';
import { Icon, type IconName } from './Icon';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';
type Props = {
  label: string;
  onPress: () => void;
  /** `quiet` is the old name of `secondary`. */
  variant?: Variant;
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  size?: 'md' | 'lg' | 'sm';
};

/** One button for the whole app: a gradient primary, a soft secondary, a text-only ghost and a red danger. */
export function Button({ label, onPress, variant = 'primary', icon, loading, disabled, size = 'md' }: Props) {
  const { colors, radius, font, shadow, soft } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const press = (to: number) => Animated.spring(scale, { toValue: to, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  const v: Variant = variant === 'quiet' ? 'secondary' : variant;
  const off = disabled || loading;
  const height = size === 'lg' ? 58 : size === 'sm' ? 38 : 52;
  const textColor = v === 'primary' ? '#fff' : v === 'danger' ? colors.danger : v === 'ghost' ? colors.accent : colors.text;
  const fontSize = size === 'sm' ? 14 : 16;

  const content = (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height, paddingHorizontal: size === 'sm' ? 16 : 22 }}>
      {loading ? <ActivityIndicator color={textColor} /> : icon ? <Icon name={icon} size={size === 'sm' ? 16 : 19} color={textColor} /> : null}
      <Text style={{ ...font.headline, fontSize, color: textColor, letterSpacing: 0.1 }}>{label}</Text>
    </View>
  );

  return (
    <Animated.View style={{ transform: [{ scale }], opacity: off ? 0.5 : 1 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !!off, busy: !!loading }}
        disabled={off}
        onPress={onPress}
        onPressIn={() => press(0.97)}
        onPressOut={() => press(1)}
        style={[
          { borderRadius: radius.pill, overflow: 'hidden' },
          v === 'primary' ? shadow.glow : null,
          v === 'secondary' ? { backgroundColor: colors.surfaceMuted } : null,
          v === 'danger' ? { backgroundColor: soft.danger } : null,
        ]}
      >
        {v === 'primary' ? (
          <LinearGradient colors={[...brand.gradient]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
            {content}
          </LinearGradient>
        ) : content}
      </Pressable>
    </Animated.View>
  );
}
