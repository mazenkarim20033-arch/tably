import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const svg = readFileSync(new URL('../brand/mark.svg', import.meta.url));
const out = (p) => new URL(`../${p}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const png = (size, p) => sharp(svg, { density: 300 }).resize(size, size).flatten({ background: '#6D5BF7' }).png().toFile(out(p));

await png(1024, 'apps/mobile/assets/icon.png');       // iOS: full-bleed, no alpha; iOS rounds it
await png(1024, 'apps/mobile/assets/splash-icon.png');
await png(1024, 'apps/mobile/assets/android-icon-foreground.png');
await png(48, 'apps/mobile/assets/favicon.png');
await png(180, 'apps/web/public/apple-touch-icon.png');
await png(512, 'apps/web/public/icon-512.png');
console.log('icons written');
