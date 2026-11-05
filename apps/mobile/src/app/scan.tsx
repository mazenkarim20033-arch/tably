import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { brand, readReceipt } from '@tably/core';
import { Callout } from '../components/Bits';
import { Card } from '../components/Card';
import { Icon, type IconName } from '../components/Icon';
import { Screen } from '../components/Screen';
import { useTheme } from '../theme/ThemeProvider';
import { isOcrAvailable, recognizeText } from '../../modules/tably-vision';
import { startDraft, updateDraft } from '../lib/draftStore';
import { t, useLang } from '../lib/i18n';

const READ_LIMIT_MS = 60_000;

/** Give up waiting after `ms`: the person is sent to type the receipt in, rather than left on a spinner. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(t('Reading took too long. Retake the photo or type the receipt in.'))), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

export default function Scan() {
  useLang();
  const { colors, space, font, soft } = useTheme();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function process(uri: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    // Let the "reading" overlay draw before the heavy work starts, so the screen never looks frozen.
    await new Promise((resolve) => setTimeout(resolve, 80));
    try {
      await startDraft(uri);
      try {
        const result = await withTimeout(recognizeText(uri), READ_LIMIT_MS);
        updateDraft({ ocr: result.lines, ocrSize: { width: result.width, height: result.height }, receipt: readReceipt(result.lines) });
      } catch (e) {
        // Keep the photo and let the user type the receipt in; never fake a result.
        updateDraft({ ocrError: e instanceof Error ? e.message : t('Text recognition failed.') });
      }
      router.replace('/review');
    } catch {
      setMessage(t('Could not save the photo. Please try again.'));
      setBusy(false);
    }
  }

  async function camera() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return setMessage(t('Camera access is off. Enable it in Settings, or choose a photo instead.'));
    const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
    if (!res.canceled && res.assets[0]) await process(res.assets[0].uri);
  }

  async function library() {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (!res.canceled && res.assets[0]) await process(res.assets[0].uri);
  }

  async function manual() {
    await startDraft(null);
    router.replace('/review');
  }

  const option = (icon: IconName, title: string, body: string, onPress: () => void) => (
    <Card onPress={onPress} style={{ flex: 1, gap: space.sm }}>
      <View style={{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: soft.accent }}>
        <Icon name={icon} size={20} color={colors.accent} />
      </View>
      <Text style={{ ...font.headline, color: colors.text }}>{t(title)}</Text>
      <Text style={{ ...font.footnote, color: colors.textMuted }}>{t(body)}</Text>
    </Card>
  );

  return (
    <Screen
      title="Scan a receipt"
      subtitle="You can check everything before you share."
      overlay={busy ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(8,10,20,0.78)', padding: space.xl }}>
          <View style={{ alignItems: 'center', gap: space.md, padding: space.xl, borderRadius: 28, backgroundColor: colors.surface, minWidth: 240 }}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={{ ...font.headline, color: colors.text }}>{t('Reading your receipt…')}</Text>
            <Text style={{ ...font.footnote, color: colors.textMuted, textAlign: 'center' }}>{t('This takes a few seconds.')}</Text>
          </View>
        </View>
      ) : undefined}
    >
      {!isOcrAvailable && (
        <Callout tone="warning">Text recognition is not available in this build. Here you can attach a photo and type the receipt in.</Callout>
      )}
      {message && <Callout tone="danger">{message}</Callout>}

      <Pressable onPress={camera} accessibilityRole="button" accessibilityLabel={t('Take a photo of the receipt')} style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1, borderRadius: 28, overflow: 'hidden' })}>
        <LinearGradient colors={[...brand.gradient]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ padding: space.lg, paddingVertical: space.xl, gap: space.md, minHeight: 200, justifyContent: 'flex-end' }}>
          <View style={{ position: 'absolute', top: space.lg, right: space.lg, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.22)' }}>
            <Icon name="camera" size={28} color="#fff" />
          </View>
          <Text style={{ ...font.title, fontSize: 26, color: '#fff' }}>{t('Take a photo')}</Text>
          <Text style={{ ...font.callout, color: 'rgba(255,255,255,0.88)', maxWidth: 260 }}>{t('Fit the whole receipt in the frame. TABLY reads it on your phone.')}</Text>
        </LinearGradient>
      </Pressable>

      <View style={{ flexDirection: 'row', gap: space.sm }}>
        {option('image', 'From photos', 'Use a picture you already took.', library)}
        {option('edit', 'Type it in', 'Enter the items yourself.', manual)}
      </View>

      <Card style={{ gap: 6 }}>
        <Text style={{ ...font.headline, color: colors.text }}>{t('For the best read')}</Text>
        <Text style={{ ...font.callout, color: colors.textMuted }}>
          {t('Lay the receipt flat in good light and include the total at the bottom. Folds and glare make digits harder to read. Your photo stays on this phone unless you choose to ask an AI for a second opinion.')}
        </Text>
      </Card>

    </Screen>
  );
}
