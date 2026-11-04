import Svg, { Circle, Defs, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

const TEETH = Array.from({ length: 8 }, () => 'l-32.5 40 -32.5 -40').join(' ');
const RECEIPT = `M252 206a36 36 0 0 1 36-36H736a36 36 0 0 1 36 36V808 ${TEETH} V206z`;

/**
 * The TABLY mark: a receipt with price stubs and a bold total, and a check badge. Same drawing as the app icon
 * (scripts/make-icons.mjs); `plain` draws just the receipt and badge, for use on top of a coloured background.
 */
export function Logo({ size = 64, plain = false }: { size?: number; plain?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 1024 1024">
      <Defs>
        <LinearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#7B5CFA" />
          <Stop offset="1" stopColor="#1FC8E8" />
        </LinearGradient>
        <RadialGradient id="lh" cx="0.18" cy="0.08" r="0.9">
          <Stop offset="0" stopColor="#fff" stopOpacity={0.3} />
          <Stop offset="1" stopColor="#fff" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      {!plain && <Rect width="1024" height="1024" rx="230" fill="url(#lg)" />}
      {!plain && <Rect width="1024" height="1024" rx="230" fill="url(#lh)" />}
      <Path fill="#fff" d={RECEIPT} />
      <Rect x="316" y="280" width="210" height="36" rx="18" fill="#6D5BF7" />
      <Rect x="598" y="280" width="110" height="36" rx="18" fill="#6D5BF7" opacity={0.35} />
      <Rect x="316" y="370" width="270" height="36" rx="18" fill="#6D5BF7" opacity={0.35} />
      <Rect x="618" y="370" width="90" height="36" rx="18" fill="#6D5BF7" opacity={0.35} />
      <Rect x="316" y="460" width="180" height="36" rx="18" fill="#6D5BF7" opacity={0.35} />
      <Rect x="598" y="460" width="110" height="36" rx="18" fill="#6D5BF7" opacity={0.35} />
      <Rect x="316" y="548" width="392" height="6" rx="3" fill="#6D5BF7" opacity={0.18} />
      <Rect x="316" y="596" width="120" height="36" rx="18" fill="#3B2FB8" />
      <Rect x="578" y="596" width="130" height="36" rx="18" fill="#3B2FB8" />
      <Circle cx="726" cy="754" r="104" fill="#fff" />
      <Circle cx="726" cy="754" r="90" fill="#4F3FD6" />
      <Path d="M684 756l30 30 58-68" fill="none" stroke="#fff" strokeWidth="26" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
