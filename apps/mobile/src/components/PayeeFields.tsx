import { Switch, Text, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import type { PayeeForm } from '../lib/usePayeeForm';
import { TextField } from './Fields';

/** The fields for how friends can pay you. Used on the review screen and on the Payment details screen. */
export function PayeeFields({ form }: { form: PayeeForm }) {
  const { colors, space, font } = useTheme();
  return (
    <View style={{ gap: space.sm }}>
      <Text style={{ ...font.callout, color: colors.textMuted }}>
        Friends see the ways you accept and pick one when they pay. They send money from their own app; you confirm each payment yourself. Add at least one.
      </Text>
      <TextField label="Your name" value={form.name} onChange={form.setName} placeholder="Shown to friends" />
      <Text style={{ ...font.headline, color: colors.text, marginTop: space.sm }}>InstaPay</Text>
      <TextField label="InstaPay payment link (recommended)" value={form.link} onChange={form.setLink} placeholder="https://ipn.eg/..." autoCapitalize="none" autoCorrect={false} />
      <Text style={{ ...font.footnote, color: colors.textFaint }}>
        With a link, paying is one tap for your friends: InstaPay opens with you already filled in. In the InstaPay app, copy your own payment link and paste it here.
      </Text>
      <TextField label="InstaPay address" value={form.ipa} onChange={form.setIpa} placeholder="name@instapay" autoCapitalize="none" autoCorrect={false} />
      <TextField label="Phone number linked to InstaPay" value={form.phone} onChange={form.setPhone} placeholder="01012345678" keyboardType="number-pad" />
      <Text style={{ ...font.headline, color: colors.text, marginTop: space.sm }}>Other ways to get paid</Text>
      <TextField label={form.teldaOk ? 'Telda tag or number' : 'Telda tag or number · check'} uncertain={!form.teldaOk} value={form.telda} onChange={form.setTelda} placeholder="@yourtag" autoCapitalize="none" autoCorrect={false} />
      <TextField label={form.walletOk ? 'Mobile wallet number' : 'Mobile wallet number · check'} uncertain={!form.walletOk} value={form.wallet} onChange={form.setWallet} placeholder="01012345678" keyboardType="number-pad" />
      {form.wallet.trim() !== '' && <TextField label="Wallet name (optional)" value={form.walletName} onChange={form.setWalletName} placeholder="Vodafone Cash" />}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
        <Text style={{ ...font.body, color: colors.textMuted, flex: 1 }}>I also accept cash</Text>
        <Switch value={form.cash} onValueChange={form.setCash} />
      </View>
    </View>
  );
}
