import type { ReactNode } from 'react';
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { Icon } from './Icon';

/** A rounded surface. `tone` outlines it: amber when something needs a look, red when something is wrong. */
export function Card({ children, tone, style, onPress }: { children: ReactNode; tone?: 'warning' | 'danger' | 'accent'; style?: ViewStyle; onPress?: () => void }) {
  const { colors, radius, space, shadow } = useTheme();
  const box: ViewStyle = {
    backgroundColor: colors.surface,
    borderColor: tone === 'warning' ? colors.warning : tone === 'danger' ? colors.danger : tone === 'accent' ? colors.accent : colors.border,
    borderWidth: tone ? 1.5 : 1,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.sm,
    ...shadow.card,
    ...style,
  };
  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [box, { opacity: pressed ? 0.85 : 1 }]}>
        {children}
      </Pressable>
    );
  }
  return <View style={box}>{children}</View>;
}

/** A card section whose body folds away; the header always shows a one-line summary. */
export function Section({
  title, summary, open, onToggle, tone, children,
}: {
  title: string;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  tone?: 'warning' | 'danger';
  children: ReactNode;
}) {
  const { colors, space, font } = useTheme();
  return (
    <Card tone={tone}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ ...font.headline, color: colors.text }}>{title}</Text>
          {!open && summary ? <Text numberOfLines={2} style={{ ...font.footnote, color: colors.textMuted }}>{summary}</Text> : null}
        </View>
        <Text style={{ ...font.callout, color: colors.accent, fontWeight: '600' }}>{open ? 'Done' : 'Edit'}</Text>
      </Pressable>
      {open ? <View style={{ gap: space.sm }}>{children}</View> : null}
    </Card>
  );
}

/** A small heading above a group of cards. */
export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  const { colors, font, space } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: space.sm }}>
      <Text accessibilityRole="header" style={{ ...font.title, fontSize: 20, color: colors.text }}>{children}</Text>
      {right}
    </View>
  );
}

/** A tappable row for lists of actions: icon, title, optional detail, chevron. */
export function ListRow({
  icon, title, detail, onPress, tone, last, disabled,
}: {
  icon?: Parameters<typeof Icon>[0]['name'];
  title: string;
  detail?: string;
  onPress: () => void;
  tone?: 'danger';
  last?: boolean;
  disabled?: boolean;
}) {
  const { colors, space, font, soft } = useTheme();
  const c = tone === 'danger' ? colors.danger : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 14, opacity: disabled ? 0.45 : pressed ? 0.6 : 1,
        borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.border,
      })}
    >
      {icon ? (
        <View style={{ width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: tone === 'danger' ? soft.danger : soft.accent }}>
          <Icon name={icon} size={18} color={tone === 'danger' ? colors.danger : colors.accent} />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text style={{ ...font.body, color: c, fontWeight: '500' }}>{title}</Text>
        {detail ? <Text style={{ ...font.footnote, color: colors.textMuted }}>{detail}</Text> : null}
      </View>
      <Icon name="chevron-right" size={18} color={colors.textFaint} />
    </Pressable>
  );
}
