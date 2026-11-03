import Svg, { Defs, LinearGradient, Stop, Rect, Path, Circle } from 'react-native-svg';

export function Logo({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 1024 1024">
      <Defs>
        <LinearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#6D5BF7" />
          <Stop offset="1" stopColor="#22C8E8" />
        </LinearGradient>
      </Defs>
      <Rect width="1024" height="1024" rx="230" fill="url(#g)" />
      <Path
        fill="#fff"
        transform="translate(0 -20)"
        d="M300 196h424a28 28 0 0 1 28 28v548l-47 45-47-45-47 45-47-45-47 45-47-45-47 45-47-45-47 45-47-45-47 45-47-45V224a28 28 0 0 1 28-28z"
      />
      <Rect x="372" y="322" width="190" height="34" rx="17" fill="#6D5BF7" opacity={0.9} />
      <Rect x="372" y="406" width="280" height="34" rx="17" fill="#6D5BF7" opacity={0.35} />
      <Rect x="372" y="490" width="230" height="34" rx="17" fill="#6D5BF7" opacity={0.35} />
      <Circle cx="620" cy="642" r="62" fill="#22C8E8" />
      <Path d="M594 642l20 20 36-42" fill="none" stroke="#fff" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
