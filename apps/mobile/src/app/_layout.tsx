import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider, useTheme } from '../theme/ThemeProvider';
import { loadServerUrl } from '../lib/config';

function Shell() {
  const { colors, name } = useTheme();
  return (
    <>
      <StatusBar style={name === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'fade' }} />
    </>
  );
}

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void loadServerUrl().finally(() => setReady(true)); // the saved server address must be known before any screen calls the API
  }, []);
  if (!ready) return null;
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}
