import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { Icon, type IconName } from './Icon';
import { t } from '../lib/i18n';
import { Button } from './Button';

export type Tone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral';

function toneColors(tone: Tone, colors: ReturnType<typeof useTheme>['colors'], soft: ReturnType<typeof useTheme>['soft']) {
  switch (tone) {
    case 'success': return { fg: colors.success, bg: soft.success };
    case 'warning': return { fg: colors.warning, bg: soft.warning };
    case 'danger': return { fg: colors.danger, bg: soft.danger };
    case 'accent': return { fg: colors.accent, bg: soft.accent };
    default: return { fg: colors.textMuted, bg: colors.surfaceMuted };
  }
}

/** A short status label with a coloured dot. */
export function Badge({ label, tone = 'neutral', dot = true }: { label: string; tone?: Tone; dot?: boolean }) {
  const { colors, soft, font } = useTheme();
  const c = toneColors(tone, colors, soft);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, backgroundColor: c.bg }}>
      {dot ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.fg }} /> : null}
      <Text style={{ ...font.caption, color: c.fg, fontWeight: '600' }}>{t(label)}</Text>
    </View>
  );
}

const AVATAR_HUES = ['#6D5BF7', '#22A6C8', '#E8588D', '#F29B38', '#3FB68B', '#8A6DF0', '#D9534F', '#4C7BF4'];

/** A round initial, coloured from the name so the same person always looks the same. */
export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const { font } = useTheme();
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const bg = AVATAR_HUES[h % AVATAR_HUES.length]!;
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: bg }}>
      <Text style={{ ...font.headline, fontSize: size * 0.42, color: '#fff' }}>{initial}</Text>
    </View>
  );
}

/** A thin bar showing how much of something is done (0 to 1). */
export function ProgressBar({ value, tone = 'success' }: { value: number; tone?: Tone }) {
  const { colors, soft } = useTheme();
  const c = toneColors(tone, colors, soft);
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }} style={{ height: 8, borderRadius: 4, backgroundColor: colors.surfaceMuted, overflow: 'hidden' }}>
      <View style={{ width: `${pct * 100}%`, height: '100%', borderRadius: 4, backgroundColor: c.fg }} />
    </View>
  );
}

/** A message in a tinted box, for things that need attention. */
export function Callout({ tone = 'warning', icon = 'alert', children }: { tone?: Tone; icon?: IconName; children: ReactNode }) {
  const { colors, soft, font, space } = useTheme();
  const c = toneColors(tone, colors, soft);
  return (
    <View style={{ flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: 14, backgroundColor: c.bg, alignItems: 'flex-start' }}>
      <View style={{ paddingTop: 1 }}><Icon name={icon} size={18} color={c.fg} /></View>
      <Text style={{ ...font.callout, color: colors.text, flex: 1 }}>{typeof children === 'string' ? t(children) : children}</Text>
    </View>
  );
}

/** What a list shows when it is empty: an icon, a sentence of help, and the one thing to do next. */
export function EmptyState({ icon, title, body, action, onAction }: { icon: IconName; title: string; body: string; action?: string; onAction?: () => void }) {
  const { colors, soft, font, space } = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.xl, paddingHorizontal: space.md }}>
      <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: soft.accent, marginBottom: space.sm }}>
        <Icon name={icon} size={30} color={colors.accent} />
      </View>
      <Text style={{ ...font.title, fontSize: 20, color: colors.text, textAlign: 'center' }}>{t(title)}</Text>
      <Text style={{ ...font.callout, color: colors.textMuted, textAlign: 'center', maxWidth: 300 }}>{t(body)}</Text>
      {action && onAction ? <View style={{ marginTop: space.md, alignSelf: 'stretch' }}><Button label={action} onPress={onAction} /></View> : null}
    </View>
  );
}

/** A big figure with a small label above it. */
export function Stat({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  const { colors, soft, font } = useTheme();
  const c = tone ? toneColors(tone, colors, soft).fg : colors.text;
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={{ ...font.caption, color: colors.textFaint }}>{t(label)}</Text>
      <Text numberOfLines={1} adjustsFontSizeToFit style={{ ...font.number, color: c }}>{value}</Text>
    </View>
  );
}
