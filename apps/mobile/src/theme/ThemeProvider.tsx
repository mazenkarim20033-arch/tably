import { createContext, useContext, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { palette, space, radius, type Colors, type ThemeName } from '@tably/core';

type Theme = { name: ThemeName; colors: Colors; space: typeof space; radius: typeof radius };

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const name: ThemeName = useColorScheme() === 'dark' ? 'dark' : 'light';
  return (
    <ThemeContext.Provider value={{ name, colors: palette[name], space, radius }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): Theme {
  const t = useContext(ThemeContext);
  if (!t) throw new Error('useTheme must be used inside ThemeProvider');
  return t;
}
