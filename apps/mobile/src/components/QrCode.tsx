import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import qrcode from 'qrcode-generator';

/** A QR code for a link, always dark on white with a quiet border so any camera reads it, in light or dark mode. */
export function QrCode({ value, size = 184 }: { value: string; size?: number }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    // One path for the whole code: a thousand separate shapes would be slow to draw.
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
    return { n, d };
  }, [value]);
  return (
    <View accessibilityRole="image" accessibilityLabel="QR code for the bill link" style={{ padding: 12, backgroundColor: '#fff', borderRadius: 16, alignSelf: 'center' }}>
      <Svg width={size} height={size} viewBox={`0 0 ${cells.n} ${cells.n}`}>
        <Path d={cells.d} fill="#000" />
      </Svg>
    </View>
  );
}
