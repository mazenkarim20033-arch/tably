import { useState } from 'react';
import { Text, TextInput, View, type TextInputProps } from 'react-native';
import { parseAmount, type Minor } from '@tably/core';
import { useTheme } from '../theme/ThemeProvider';

const fmt = (m: Minor | null) => (m === null ? '' : (m / 100).toFixed(2));

type BaseProps = { label?: string; uncertain?: boolean; width?: number | `${number}%` };

export function TextField({
  label, value, onChange, uncertain, width, onFocus, onBlur, ...rest
}: BaseProps & { value: string; onChange: (v: string) => void } & Omit<TextInputProps, 'value' | 'onChangeText' | 'onChange'>) {
  const { colors, radius, soft, font, dark } = useTheme();
  const [focused, setFocused] = useState(false);
  const border = uncertain ? colors.warning : focused ? colors.accent : 'transparent';
  return (
    <View style={{ gap: 6, width }}>
      {label && <Text style={{ ...font.footnote, fontWeight: '500', color: uncertain ? colors.warning : colors.textMuted }}>{label}{uncertain ? ' · check' : ''}</Text>}
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholderTextColor={colors.textFaint}
        selectionColor={colors.accent}
        keyboardAppearance={dark ? 'dark' : 'light'}
        onFocus={(e) => { setFocused(true); onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); onBlur?.(e); }}
        style={{
          color: colors.text, backgroundColor: uncertain ? soft.warning : colors.surfaceMuted, borderColor: border, borderWidth: 1.5,
          borderRadius: radius.md - 2, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16,
        }}
        {...rest}
      />
    </View>
  );
}

/** Money input: keeps what the user typed, commits only unambiguous amounts. */
export function AmountField({
  label, value, onChange, uncertain, width, placeholder,
}: BaseProps & { value: Minor | null; onChange: (v: Minor | null) => void; placeholder?: string }) {
  const [text, setText] = useState(fmt(value));
  const [focused, setFocused] = useState(false);
  const parsed = text.trim() === '' ? null : parseAmount(text);
  const invalid = text.trim() !== '' && parsed === null;
  // When the value changes from outside (e.g. a re-scan), show it unless the user is typing.
  const shown = focused ? text : parsed === value || (value === null && text === '') ? text : fmt(value);
  return (
    <TextField
      label={label}
      value={shown}
      width={width}
      uncertain={uncertain || invalid}
      placeholder={placeholder ?? '0.00'}
      keyboardType="decimal-pad"
      onFocus={() => { setText(shown); setFocused(true); }}
      onBlur={() => {
        setFocused(false);
        if (!invalid && parsed !== null) setText(fmt(parsed));
      }}
      onChange={(t) => {
        setText(t);
        const p = t.trim() === '' ? null : parseAmount(t);
        if (t.trim() === '' || p !== null) onChange(p);
      }}
    />
  );
}
