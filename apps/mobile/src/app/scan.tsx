import { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { readReceipt } from '@tably/core';
import { Button } from '../components/Button';
import { useTheme } from '../theme/ThemeProvider';
import { isOcrAvailable, recognizeText } from '../../modules/tably-vision';
import { startDraft, updateDraft } from '../lib/draftStore';

export default function Scan() {
  const { colors, space } = useTheme();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function process(uri: string) {
    setBusy(true);
    setMessage(null);
    try {
      await startDraft(uri);
      try {
        const result = await recognizeText(uri);
        updateDraft({ ocr: result.lines, ocrSize: { width: result.width, height: result.height }, receipt: readReceipt(result.lines) });
      } catch (e) {
        // Keep the photo and let the user type the receipt in; never fake a result.
        updateDraft({ ocrError: e instanceof Error ? e.message : 'Text recognition failed.' });
      }
      router.replace('/review');
    } catch {
      setMessage('Could not save the photo. Please try again.');
      setBusy(false);
    }
  }

  async function camera() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return setMessage('Camera access is off. Enable it in Settings, or choose a photo instead.');
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

  return (
    <SafeAreaView style={{ flex: 1, padding: space.lg, justifyContent: 'space-between', backgroundColor: colors.bg }}>
      <View style={{ gap: space.sm, marginTop: space.xl }}>
        <Text style={{ color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.6 }}>Scan a receipt</Text>
        <Text style={{ color: colors.textMuted, fontSize: 16, lineHeight: 24 }}>
          Lay the receipt flat in good light and fit it in the frame. You can review everything before sharing.
        </Text>
        {!isOcrAvailable && (
          <Text style={{ color: colors.warning, fontSize: 14, marginTop: space.sm }}>
            Text recognition only works in the iPhone build. Here you can attach a photo and type the receipt in.
          </Text>
        )}
        {message && <Text style={{ color: colors.danger, fontSize: 14 }}>{message}</Text>}
        {busy && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: space.md }}>
            <ActivityIndicator color={colors.accent} />
            <Text style={{ color: colors.textMuted }}>Reading your receipt…</Text>
          </View>
        )}
      </View>
      <View style={{ gap: space.sm }}>
        <Button label="Take a photo" onPress={camera} disabled={busy} />
        <Button label="Choose from photos" variant="quiet" onPress={library} disabled={busy} />
        <Button label="Enter manually" variant="quiet" onPress={manual} disabled={busy} />
      </View>
    </SafeAreaView>
  );
}
