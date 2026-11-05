import { useState } from 'react';
import { Alert, Text } from 'react-native';
import { router } from 'expo-router';
import { Button } from '../components/Button';
import { Callout } from '../components/Bits';
import { PayeeFields } from '../components/PayeeFields';
import { Screen } from '../components/Screen';
import { useTheme } from '../theme/ThemeProvider';
import { applyPayeeToBills } from '../lib/applyPayee';
import { savePayee } from '../lib/myBills';
import { usePayeeForm } from '../lib/usePayeeForm';

/**
 * Where friends should pay you, saved once on this phone. Every new bill uses it automatically, so friends get your
 * InstaPay link without you typing it again; one tap also updates the bills you already made.
 */
export default function PaymentDetails() {
  const { colors, font } = useTheme();
  const form = usePayeeForm();
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    await savePayee(form.payee);
    setBusy(false);
    Alert.alert('Saved', 'Every new bill will use these. Do you also want to update the bills you already shared?', [
      { text: 'Just new bills', onPress: () => router.back() },
      {
        text: 'Update my bills',
        onPress: async () => {
          setBusy(true);
          const r = await applyPayeeToBills(form.payee);
          setBusy(false);
          Alert.alert(
            'Done',
            `${r.updated} ${r.updated === 1 ? 'bill' : 'bills'} updated.${r.skipped > 0 ? ` ${r.skipped} could not change, because someone already started paying or the bill is gone.` : ''}`,
            [{ text: 'OK', onPress: () => router.back() }],
          );
        },
      },
    ]);
  }

  return (
    <Screen
      title="Payment details"
      subtitle="Saved on this phone. Friends see them when they pay."
      footer={<Button label="Save" size="lg" loading={busy} disabled={!form.loaded || !form.hasPayee || !form.valid} onPress={save} />}
    >
      {form.loaded && !form.hasPayee && <Callout tone="accent" icon="wallet">Add your name and at least one way to be paid, then tap Save.</Callout>}
      <PayeeFields form={form} />
      <Text style={{ ...font.footnote, color: colors.textFaint }}>
        These stay on your phone and are shared only with people who open one of your bill links.
      </Text>
    </Screen>
  );
}
