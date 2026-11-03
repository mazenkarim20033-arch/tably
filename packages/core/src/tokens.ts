/** TABLY design tokens, shared by the mobile app and the shared-bill web page. */

export const palette = {
  light: {
    bg: '#F7F8FB',
    surface: '#FFFFFF',
    surfaceMuted: '#EEF0F6',
    border: '#E3E6EF',
    text: '#0E1220',
    textMuted: '#5B6275',
    textFaint: '#8A90A2',
    accent: '#6D5BF7',
    accentAlt: '#22C8E8',
    accentText: '#FFFFFF',
    success: '#13A06F',
    warning: '#C78A0B',
    danger: '#D6455D',
  },
  dark: {
    bg: '#0A0C14',
    surface: '#121624',
    surfaceMuted: '#1A1F31',
    border: '#242A40',
    text: '#EEF0F8',
    textMuted: '#A0A7BC',
    textFaint: '#6D7490',
    accent: '#8B7CFF',
    accentAlt: '#3CD6F2',
    accentText: '#0A0C14',
    success: '#3DD598',
    warning: '#F0B64A',
    danger: '#FF6B83',
  },
} as const;

export type ThemeName = keyof typeof palette;
export type Colors = { [K in keyof (typeof palette)['light']]: string };

export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 } as const;
export const radius = { sm: 10, md: 16, lg: 24, pill: 999 } as const;

export const type = {
  display: { size: 36, weight: '700', tracking: -1 },
  title: { size: 24, weight: '600', tracking: -0.5 },
  body: { size: 16, weight: '400', tracking: 0 },
  label: { size: 13, weight: '500', tracking: 0.2 },
  mono: { size: 15, weight: '500', tracking: 0 },
} as const;

export const brand = {
  name: 'TABLY',
  tagline: 'Split the bill, not the friendship.',
  gradient: ['#6D5BF7', '#22C8E8'] as const,
} as const;
