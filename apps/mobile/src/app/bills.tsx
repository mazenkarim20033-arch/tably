import { useState } from 'react';
import { Alert, View } from 'react-native';
import { router } from 'expo-router';
import { BillCard } from '../components/BillCard';
import { Callout, EmptyState } from '../components/Bits';
import { Screen } from '../components/Screen';
import { useTheme } from '../theme/ThemeProvider';
import { forgetBill } from '../lib/myBills';
import { useBills } from '../lib/useBills';

/** Everything this phone created. Live status comes from the server; if offline, the saved basics still show. */
export default function Bills() {
  const { space } = useTheme();
  const { rows, setRows, offline, reload } = useBills();
  const [removing, setRemoving] = useState(false);

  const remove = (id: string, store: string) =>
    Alert.alert(`Remove ${store}?`, 'It is no longer on the server, so this only clears it from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: () => {
          if (removing) return;
          setRemoving(true);
          void forgetBill(id).then(() => setRows((r) => r?.filter((x) => x.id !== id) ?? r)).finally(() => setRemoving(false));
        },
      },
    ]);

  return (
    <Screen title="Bills" subtitle={rows && rows.length > 0 ? `${rows.length} ${rows.length === 1 ? 'bill' : 'bills'} on this phone` : undefined} onRefresh={reload}>
      {offline && <Callout tone="warning" icon="refresh">Could not reach the server. Showing what is saved on this phone.</Callout>}
      {rows && rows.length === 0 && (
        <EmptyState
          icon="receipt"
          title="No bills yet"
          body="Scan a receipt and your bills will show up here, with who has paid."
          action="Scan a receipt"
          onAction={() => router.replace('/scan')}
        />
      )}
      <View style={{ gap: space.sm }}>
        {(rows ?? []).map((b) => (
          <BillCard key={b.id} bill={b} onRemove={b.live?.missing ? () => remove(b.id, b.store) : undefined} />
        ))}
      </View>
    </Screen>
  );
}
