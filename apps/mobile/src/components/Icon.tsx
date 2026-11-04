import Svg, { Circle, Path, Rect } from 'react-native-svg';

/** Line icons (24 x 24 grid, 2 px round strokes), drawn here so the app needs no icon font. */
const PATHS = {
  'chevron-right': ['M9 18l6-6-6-6'],
  'chevron-left': ['M15 18l-6-6 6-6'],
  check: ['M20 6L9 17l-5-5'],
  plus: ['M12 5v14M5 12h14'],
  minus: ['M5 12h14'],
  close: ['M18 6L6 18M6 6l12 12'],
  camera: ['M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z'],
  image: ['M21 15l-3.086-3.086a2 2 0 0 0-2.828 0L6 21'],
  share: ['M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13'],
  receipt: ['M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z', 'M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8', 'M12 17.5v-11'],
  clock: ['M12 6v6l4 2'],
  edit: ['M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z'],
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  send: ['M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z'],
  users: ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75'],
  wallet: ['M21 12V7H5a2 2 0 0 1 0-4h14v4M3 5v14a2 2 0 0 0 2 2h16v-5M18 12a2 2 0 0 0 0 4h4v-4z'],
  alert: ['M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4M12 17h.01'],
  lock: ['M7 11V7a5 5 0 0 1 10 0v4'],
  trash: ['M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  refresh: ['M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15'],
  bell: ['M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0'],
  scan: ['M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10'],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22, color = '#000', strokeWidth = 2 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {PATHS[name].map((d, i) => <Path key={i} d={d} />)}
      {name === 'camera' && <Circle cx="12" cy="13" r="3" />}
      {name === 'image' && <><Rect x="3" y="3" width="18" height="18" rx="2" /><Circle cx="9" cy="9" r="2" /></>}
      {name === 'clock' && <Circle cx="12" cy="12" r="10" />}
      {name === 'users' && <Circle cx="9" cy="7" r="4" />}
      {name === 'lock' && <Rect x="3" y="11" width="18" height="11" rx="2" />}
    </Svg>
  );
}
