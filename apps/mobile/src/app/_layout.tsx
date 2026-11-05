import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Pressable, Text, View } from 'react-native';
import { ThemeProvider, useTheme } from '../theme/ThemeProvider';

/** If a screen crashes, show a calm way out instead of a blank screen (the theme itself may be what failed, so no theme here). */
export function ErrorBoundary({ retry }: { error: Error; retry: () => Promise<void> }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12, backgroundColor: '#F7F6FB' }}>
      <Text style={{ fontSize: 22, fontWeight: '700', color: '#1B1730', textAlign: 'center' }}>Something went wrong</Text>
      <Text style={{ fontSize: 16, color: '#5B5775', textAlign: 'center' }}>Your bills are safe. Try again, and if it keeps happening, close and reopen the app.</Text>
      <Pressable accessibilityRole="button" onPress={() => void retry()} style={{ marginTop: 8, paddingVertical: 14, paddingHorizontal: 28, borderRadius: 999, backgroundColor: '#6D5BF7' }}>
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>Try again</Text>
      </Pressable>
    </View>
  );
}

function Shell() {
  const { colors, name } = useTheme();
  return (
    <>
      <StatusBar style={name === 'dark' ? 'light' : 'dark'} />
      {/* Screens slide in like any iPhone app and can be swiped back, except the "bill created" screen: going back
          from there would land on a review screen for a bill that already exists. */}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'default' }}>
        <Stack.Screen name="index" options={{ animation: 'fade' }} />
        <Stack.Screen name="share" options={{ animation: 'fade', gestureEnabled: false }} />
        <Stack.Screen name="review" options={{ animation: 'fade' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}
