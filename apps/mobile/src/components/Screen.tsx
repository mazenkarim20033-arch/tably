import type { ReactNode } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useTheme } from '../theme/ThemeProvider';
import { Icon } from './Icon';

/**
 * The frame every screen shares: a top bar with a back button, a large title, content that scrolls, and an optional
 * footer pinned to the bottom (the main action). Keeping this in one place keeps all screens aligned.
 */
export function Screen({
  title, subtitle, back = true, right, footer, scroll = true, onRefresh, children, gap,
}: {
  title?: string;
  subtitle?: ReactNode;
  back?: boolean;
  right?: ReactNode;
  footer?: ReactNode;
  scroll?: boolean;
  onRefresh?: () => void | Promise<void>;
  children: ReactNode;
  gap?: number;
}) {
  const { colors, space, font, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const bottom = footer ? 0 : insets.bottom;
  const header = (
    <>
      {(back || right) && (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 }}>
          {back ? (
            <Pressable
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
              accessibilityRole="button"
              accessibilityLabel="Back"
              hitSlop={8}
              style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted }}
            >
              <Icon name="chevron-left" size={22} color={colors.text} />
            </Pressable>
          ) : <View />}
          {right}
        </View>
      )}
      {title ? (
        <View style={{ gap: 4 }}>
          <Text accessibilityRole="header" style={{ ...font.largeTitle, color: colors.text }}>{title}</Text>
          {typeof subtitle === 'string' ? <Text style={{ ...font.callout, color: colors.textMuted }}>{subtitle}</Text> : subtitle ?? null}
        </View>
      ) : null}
    </>
  );
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      {scroll ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          showsVerticalScrollIndicator={false}
          refreshControl={onRefresh ? <RefreshControl refreshing={false} onRefresh={() => void onRefresh()} tintColor={colors.accent} /> : undefined}
          contentContainerStyle={{ padding: space.lg, paddingTop: space.sm, gap: gap ?? space.md, paddingBottom: (footer ? 150 : 0) + bottom + space.xl }}
        >
          {header}
          {children}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, padding: space.lg, paddingTop: space.sm, gap: gap ?? space.md, paddingBottom: bottom + space.lg }}>
          {header}
          {children}
        </View>
      )}
      {footer ? (
        <View
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: Math.max(insets.bottom, space.md),
            backgroundColor: colors.bg, borderTopColor: dark ? colors.border : 'transparent', borderTopWidth: 1, gap: space.sm,
          }}
        >
          {footer}
        </View>
      ) : null}
    </SafeAreaView>
  );
}
