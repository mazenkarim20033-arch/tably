import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme, type TextStyle, type ViewStyle } from 'react-native';
import { palette, space, radius, type Colors, type ThemeName } from '@tably/core';

/** Type scale. Every text style in the app comes from here so sizes and weights stay consistent. */
export const font = {
  largeTitle: { fontSize: 32, fontWeight: '800', letterSpacing: -1, lineHeight: 38 },
  title: { fontSize: 24, fontWeight: '700', letterSpacing: -0.5, lineHeight: 30 },
  headline: { fontSize: 17, fontWeight: '600', lineHeight: 22 },
  body: { fontSize: 16, fontWeight: '400', lineHeight: 23 },
  callout: { fontSize: 15, fontWeight: '400', lineHeight: 21 },
  footnote: { fontSize: 13, fontWeight: '400', lineHeight: 18 },
  caption: { fontSize: 12, fontWeight: '500', lineHeight: 16, letterSpacing: 0.2 },
  number: { fontSize: 17, fontWeight: '600', lineHeight: 22, fontVariant: ['tabular-nums'] },
} as const satisfies Record<string, TextStyle>;

type Soft = { accent: string; success: string; warning: string; danger: string };

type Theme = {
  name: ThemeName;
  dark: boolean;
  colors: Colors;
  /** The same hues at a low opacity, for badge and banner backgrounds. */
  soft: Soft;
  space: typeof space;
  radius: typeof radius;
  font: typeof font;
  /** A soft drop shadow on light backgrounds; dark backgrounds use their border instead. */
  shadow: { card: ViewStyle; lifted: ViewStyle; glow: ViewStyle };
};

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const name: ThemeName = useColorScheme() === 'dark' ? 'dark' : 'light';
  const theme = useMemo<Theme>(() => {
    const colors = palette[name];
    const dark = name === 'dark';
    return {
      name, dark, colors,
      soft: {
        accent: `${colors.accent}${dark ? '26' : '1A'}`,
        success: `${colors.success}${dark ? '26' : '1A'}`,
        warning: `${colors.warning}${dark ? '26' : '1F'}`,
        danger: `${colors.danger}${dark ? '26' : '1A'}`,
      },
      space, radius, font,
      shadow: {
        card: dark ? {} : { shadowColor: '#1B1F3B', shadowOpacity: 0.06, shadowRadius: 14, shadowOffset: { width: 0, height: 4 } },
        lifted: dark ? {} : { shadowColor: '#1B1F3B', shadowOpacity: 0.12, shadowRadius: 24, shadowOffset: { width: 0, height: 10 } },
        glow: { shadowColor: colors.accent, shadowOpacity: dark ? 0.35 : 0.3, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
      },
    };
  }, [name]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const t = useContext(ThemeContext);
  if (!t) throw new Error('useTheme must be used inside ThemeProvider');
  return t;
}
