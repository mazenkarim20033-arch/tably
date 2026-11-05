import { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Button } from '../components/Button';
import { Card, SectionTitle } from '../components/Card';
import { Screen } from '../components/Screen';
import { useTheme } from '../theme/ThemeProvider';
import { clearAllLocal } from '../lib/myBills';
import { success } from '../lib/haptics';

const FACTS: Array<{ title: string; body: string }> = [
  { title: 'Your receipt photo', body: 'It is read on your phone and stays on your phone. If you choose "Check with AI", only the few lines TABLY is unsure about are cut out and sent once to an AI service. They are not kept.' },
  { title: 'The bill you share', body: 'The items, totals, the payment details you add and the names friends type are stored on the TABLY server so the link works. Shared links stop working after about 30 days.' },
  { title: 'Money', body: 'TABLY never moves money. Friends send it from their own bank or wallet app, and you confirm each payment yourself.' },
  { title: 'On this phone', body: 'Your bills list, the keys that let you manage them and your saved payment details are kept here. Clearing them does not delete bills already shared.' },
];

/** What TABLY does with the person's data, and the one button that clears what it keeps on the phone. */
export default function About() {
  const { colors, space, font } = useTheme();
  const [busy, setBusy] = useState(false);

  const clear = () =>
    Alert.alert('Clear data on this phone?', 'Your bills list, saved payment details and saved photos are removed from this phone. Bills you already shared stay online until their link expires, but you will not be able to manage them from here.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear', style: 'destructive',
        onPress: () => {
          setBusy(true);
          void clearAllLocal().then(() => {
            success();
            router.replace('/');
          }).catch(() => Alert.alert('Could not clear everything', 'Please try again.')).finally(() => setBusy(false));
        },
      },
    ]);

  return (
    <Screen title="About TABLY" subtitle="Scan a receipt, share a link, everyone pays their own share.">
      <SectionTitle>Your data</SectionTitle>
      <View style={{ gap: space.sm }}>
        {FACTS.map((f) => (
          <Card key={f.title} style={{ gap: 4 }}>
            <Text style={{ ...font.headline, color: colors.text }}>{f.title}</Text>
            <Text style={{ ...font.callout, color: colors.textMuted }}>{f.body}</Text>
          </Card>
        ))}
      </View>
      <Button label="Clear data on this phone" variant="danger" icon="trash" loading={busy} onPress={clear} />
      <Text style={{ ...font.footnote, color: colors.textFaint, textAlign: 'center', marginTop: space.sm }}>
        Version {Constants.expoConfig?.version ?? ''}
      </Text>
    </Screen>
  );
}
