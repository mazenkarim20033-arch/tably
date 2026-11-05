import type { ReactNode } from 'react';
import { currentLang, setLang, useLang } from './i18n';

const HUES = ['#6D5BF7', '#22A6C8', '#E8588D', '#F29B38', '#3FB68B', '#8A6DF0', '#D9534F', '#4C7BF4'];

/** A round initial, coloured from the name so the same person always looks the same. */
export function Av({ name, size = 28 }: { name: string; size?: number }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className="av" aria-hidden style={{ width: size, height: size, fontSize: size * 0.44, background: HUES[h % HUES.length] }}>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** The TABLY mark (same drawing as the app icon), small. */
export function Mark({ size = 28 }: { size?: number }) {
  const teeth = Array.from({ length: 8 }, () => 'l-32.5 40 -32.5 -40').join(' ');
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden>
      <defs>
        <linearGradient id="mk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7B5CFA" /><stop offset="1" stopColor="#1FC8E8" /></linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="230" fill="url(#mk)" />
      <path fill="#fff" d={`M252 206a36 36 0 0 1 36-36H736a36 36 0 0 1 36 36V808 ${teeth} V206z`} />
      <rect x="316" y="280" width="210" height="36" rx="18" fill="#6D5BF7" />
      <rect x="598" y="280" width="110" height="36" rx="18" fill="#6D5BF7" opacity=".35" />
      <rect x="316" y="370" width="270" height="36" rx="18" fill="#6D5BF7" opacity=".35" />
      <rect x="618" y="370" width="90" height="36" rx="18" fill="#6D5BF7" opacity=".35" />
      <rect x="316" y="460" width="180" height="36" rx="18" fill="#6D5BF7" opacity=".35" />
      <rect x="598" y="460" width="110" height="36" rx="18" fill="#6D5BF7" opacity=".35" />
      <rect x="316" y="596" width="120" height="36" rx="18" fill="#3B2FB8" />
      <rect x="578" y="596" width="130" height="36" rx="18" fill="#3B2FB8" />
      <circle cx="726" cy="754" r="104" fill="#fff" />
      <circle cx="726" cy="754" r="90" fill="#4F3FD6" />
      <path d="M684 756l30 30 58-68" fill="none" stroke="#fff" strokeWidth="26" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand({ right }: { right?: ReactNode }) {
  const lang = useLang();
  return (
    <header className="brandbar">
      <span className="brand"><Mark size={30} /><span>TABLY</span></span>
      <span className="brandright">
        {right}
        <button type="button" className="langbtn" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')} aria-label={lang === 'ar' ? 'English' : 'العربية'}>{lang === 'ar' ? 'EN' : 'عربي'}</button>
      </span>
    </header>
  );
}

export function Tick({ tone = 'success' }: { tone?: 'success' | 'warning' | 'danger' }) {
  const d = tone === 'success' ? 'M20 6L9 17l-5-5' : tone === 'warning' ? 'M12 6v6l4 2' : 'M18 6L6 18M6 6l12 12';
  return (
    <span className={`tick tick-${tone}`} aria-hidden>
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        {tone === 'warning' && <circle cx="12" cy="12" r="10" />}
        <path d={d} />
      </svg>
    </span>
  );
}

export const niceDate = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(currentLang() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
