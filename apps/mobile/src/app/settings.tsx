import { useState } from 'react';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Button } from '../components/Button';
import { TextField } from '../components/Fields';
import { useTheme } from '../theme/ThemeProvider';
import { apiUrl, checkServer, normalizeServerUrl, saveServerUrl } from '../lib/config';

/** Where the app finds the TABLY server. Paste the address the server's tunnel printed. */
export default function Settings() {
  const { colors, space } = useTheme();
  const [text, setText] = useState(apiUrl());
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function test(andSave: boolean) {
    const url = normalizeServerUrl(text);
    if (!url) return setStatus({ ok: false, msg: 'That is not a valid https address. Example: https://something.trycloudflare.com' });
    setBusy(true);
    setStatus(null);
    const ok = await checkServer(url);
    if (ok && andSave) {
      await saveServerUrl(url);
      setText(url);
    }
    setStatus(
      ok
        ? { ok: true, msg: andSave ? 'Saved. The app will use this server.' : 'TABLY server found at this address.' }
        : { ok: false, msg: 'No TABLY server answered there. Is your PC on and the tunnel running? Free tunnel addresses change each time it restarts.' },
    );
    setBusy(false);
  }

  return (
    <SafeAreaView style={{ flex: 1, padding: space.lg, justifyContent: 'space-between', backgroundColor: colors.bg }}>
      <View style={{ gap: space.md, marginTop: space.xl }}>
        <Text style={{ color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.6 }}>Server settings</Text>
        <Text style={{ color: colors.textMuted, fontSize: 16, lineHeight: 24 }}>
          Paste the address your TABLY server prints when it starts. Friends open links on this same address.
        </Text>
        <TextField label="Server address" value={text} onChange={setText} placeholder="https://something.trycloudflare.com" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        {status && <Text style={{ color: status.ok ? colors.success : colors.danger, fontSize: 14 }}>{status.msg}</Text>}
      </View>
      <View style={{ gap: space.sm }}>
        <Button label={busy ? 'Checking…' : 'Check and save'} onPress={() => void test(true)} disabled={busy} />
        <Button label="Check only" variant="quiet" onPress={() => void test(false)} disabled={busy} />
        <Button label="Back" variant="quiet" onPress={() => router.back()} />
      </View>
    </SafeAreaView>
  );
}
