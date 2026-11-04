import type { ReactNode } from 'react';
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';

/** A rounded surface. `tone` outlines it: amber when something needs a look, red when something is wrong. */
export function Card({ children, tone, style }: { children: ReactNode; tone?: 'warning' | 'danger'; style?: ViewStyle }) {
  const { colors, radius, space } = useTheme();
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderColor: tone === 'warning' ? colors.warning : tone === 'danger' ? colors.danger : colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        padding: space.md,
        gap: space.sm,
        ...style,
      }}
    >
      {children}
    </View>
  );
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
  const { colors, space } = useTheme();
  return (
    <Card tone={tone}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600' }}>{title}</Text>
          {!open && summary ? <Text numberOfLines={2} style={{ color: colors.textMuted, fontSize: 14 }}>{summary}</Text> : null}
        </View>
        <Text style={{ color: colors.accent, fontWeight: '600' }}>{open ? 'Done' : 'Edit'}</Text>
      </Pressable>
      {open ? <View style={{ gap: space.sm }}>{children}</View> : null}
    </Card>
  );
}
