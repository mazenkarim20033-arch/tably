import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Button } from '../components/Button';
import { Card, SectionTitle } from '../components/Card';
import { Screen } from '../components/Screen';
import { useTheme } from '../theme/ThemeProvider';
import { clearAllLocal } from '../lib/myBills';
import { success } from '../lib/haptics';
import { layoutMatches, setLang, t, useLang, type Lang } from '../lib/i18n';

const FACTS: Array<{ title: string; body: string }> = [
  { title: 'Your receipt photo', body: 'It is read on your phone and stays on your phone. If you choose "Check with AI", only the few lines TABLY is unsure about are cut out and sent once to an AI service. They are not kept.' },
  { title: 'The bill you share', body: 'The items, totals, the payment details you add and the names friends type are stored on the TABLY server so the link works. Shared links stop working after about 30 days.' },
  { title: 'Money', body: 'TABLY never moves money. Friends send it from their own bank or wallet app, and you confirm each payment yourself.' },
  { title: 'On this phone', body: 'Your bills list, the keys that let you manage them and your saved payment details are kept here. Clearing them does not delete bills already shared.' },
];

/** What TABLY does with the person's data, the language switch, and the button that clears what the phone keeps. */
export default function About() {
  const { colors, space, font, radius } = useTheme();
  const lang = useLang();
  const [busy, setBusy] = useState(false);

  const pick = (next: Lang) => {
    if (next === lang) return;
    setLang(next);
    // Words change at once; the left-to-right / right-to-left layout needs the app to be opened again.
    if (!layoutMatches()) Alert.alert(t('Language'), t('Close and open the app again to finish switching the layout direction.'));
  };

  const clear = () =>
    Alert.alert(t('Clear data on this phone?'), t('Your bills list, saved payment details and saved photos are removed from this phone. Bills you already shared stay online until their link expires, but you will not be able to manage them from here.'), [
      { text: t('Cancel'), style: 'cancel' },
      {
        text: t('Clear'), style: 'destructive',
        onPress: () => {
          setBusy(true);
          void clearAllLocal().then(() => {
            success();
            router.replace('/');
          }).catch(() => Alert.alert(t('Could not clear everything'), t('Please try again.'))).finally(() => setBusy(false));
        },
      },
    ]);

  return (
    <Screen title="About TABLY" subtitle="Scan a receipt, share a link, everyone pays their own share.">
      <SectionTitle>Language</SectionTitle>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        {([['en', 'English'], ['ar', 'العربية']] as Array<[Lang, string]>).map(([code, label]) => (
          <Pressable
            key={code}
            onPress={() => pick(code)}
            accessibilityRole="button"
            accessibilityState={{ selected: lang === code }}
            style={{ flex: 1, alignItems: 'center', paddingVertical: 14, borderRadius: radius.pill, backgroundColor: lang === code ? colors.accent : colors.surfaceMuted }}
          >
            <Text style={{ ...font.headline, color: lang === code ? colors.accentText : colors.text }}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <SectionTitle>Your data</SectionTitle>
      <View style={{ gap: space.sm }}>
        {FACTS.map((f) => (
          <Card key={f.title} style={{ gap: 4 }}>
            <Text style={{ ...font.headline, color: colors.text }}>{t(f.title)}</Text>
            <Text style={{ ...font.callout, color: colors.textMuted }}>{t(f.body)}</Text>
          </Card>
        ))}
      </View>
      <Button label="Clear data on this phone" variant="danger" icon="trash" loading={busy} onPress={clear} />
      <Text style={{ ...font.footnote, color: colors.textFaint, textAlign: 'center', marginTop: space.sm }}>
        {t('Version {v}', { v: Constants.expoConfig?.version ?? '' })}
      </Text>
    </Screen>
  );
}
