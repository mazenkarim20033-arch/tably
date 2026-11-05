import * as Haptics from 'expo-haptics';

/** Small physical feedback for the moments that matter. Never throws: a phone without it just stays still. */
const safe = (run: () => Promise<void>) => {
  try {
    void run().catch(() => undefined);
  } catch {
    /* no haptics here */
  }
};

export const tap = () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
export const success = () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
export const warning = () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
