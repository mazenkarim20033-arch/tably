import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

/**
 * The TABLY mark, drawn once. A receipt with price stubs and a bold total, and a check badge: the bill, settled.
 * `glyph` is the receipt and badge alone (transparent), used for the splash screen and Android's adaptive icon;
 * `mark` adds the gradient background (full-bleed: iOS rounds the corners itself).
 * Keep apps/mobile/src/components/Logo.tsx in step with this geometry.
 */
const teeth = Array.from({ length: 8 }, () => 'l-32.5 40 -32.5 -40').join(' ');
const receipt = `M252 206a36 36 0 0 1 36-36H736a36 36 0 0 1 36 36V808 ${teeth} V206z`;
const bar = (x, y, w, fill, o = 1) => `<rect x="${x}" y="${y}" width="${w}" height="36" rx="18" fill="${fill}" opacity="${o}"/>`;
const body = `
  <defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="22"/>
      <feOffset dy="22"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.28"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <g filter="url(#shadow)"><path fill="#fff" d="${receipt}"/></g>
  ${bar(316, 280, 210, '#6D5BF7')}${bar(598, 280, 110, '#6D5BF7', 0.35)}
  ${bar(316, 370, 270, '#6D5BF7', 0.35)}${bar(618, 370, 90, '#6D5BF7', 0.35)}
  ${bar(316, 460, 180, '#6D5BF7', 0.35)}${bar(598, 460, 110, '#6D5BF7', 0.35)}
  <rect x="316" y="548" width="392" height="6" rx="3" fill="#6D5BF7" opacity="0.18"/>
  ${bar(316, 596, 120, '#3B2FB8')}${bar(578, 596, 130, '#3B2FB8')}
  <circle cx="726" cy="754" r="104" fill="#fff"/>
  <circle cx="726" cy="754" r="90" fill="#4F3FD6"/>
  <path d="M684 756l30 30 58-68" fill="none" stroke="#fff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>`;

const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7B5CFA"/><stop offset="1" stop-color="#1FC8E8"/></linearGradient>
    <radialGradient id="h" cx="0.18" cy="0.08" r="0.9"><stop offset="0" stop-color="#fff" stop-opacity="0.30"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#g)"/>
  <rect width="1024" height="1024" fill="url(#h)"/>${body}
</svg>`;
const glyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${body}</svg>`;
writeFileSync(new URL('../brand/mark.svg', import.meta.url), mark);
writeFileSync(new URL('../brand/glyph.svg', import.meta.url), glyph);

const out = (p) => new URL(`../${p}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const full = (size, p) => sharp(Buffer.from(mark), { density: 300 }).resize(size, size).flatten({ background: '#6D5BF7' }).png().toFile(out(p));
const clear = (size, p, pad = 0) =>
  sharp(Buffer.from(glyph), { density: 300 }).resize(size - pad * 2, size - pad * 2)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(out(p));

await full(1024, 'apps/mobile/assets/icon.png'); // iOS: full-bleed, no alpha; iOS rounds it
await clear(1024, 'apps/mobile/assets/splash-icon.png', 120); // transparent receipt on the splash colour
await clear(1024, 'apps/mobile/assets/android-icon-foreground.png', 170); // inside Android's safe zone
await full(48, 'apps/mobile/assets/favicon.png');
await full(180, 'apps/web/public/apple-touch-icon.png');
await full(512, 'apps/web/public/icon-512.png');
console.log('icons written');
