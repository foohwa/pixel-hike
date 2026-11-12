// Draws the app icons (the hiker on a pixel mountain) with the app's own sprites and palette.
// usage: node scripts/make-icons.mjs   (needs the dev server on :5199) → public/icon-*.png
import { launch } from './browser.mjs';
import { writeFileSync } from 'node:fs';
const base = process.env.BASE ?? 'http://localhost:5199';
const browser = await launch();
const page = await browser.newPage();
await page.goto(`${base}/?nodisk`);
const out = await page.evaluate(async () => {
  const { builtInSet, frameOf } = await import('/src/characters.ts');
  const { C } = await import('/src/palette.ts');
  // 32×32 pixel art: night-to-dawn sky, a mountain with a snowy top, a flag, the hiker cheering
  const art = document.createElement('canvas');
  art.width = 32; art.height = 32;
  const g = art.getContext('2d');
  const rows = [C.ink, C.ink2, C.night, C.dusk, C.purple, C.pink, C.orange, C.yellow];
  for (let y = 0; y < 32; y++) { g.fillStyle = rows[Math.min(rows.length - 1, Math.floor(y / 3))]; g.fillRect(0, y, 32, 1); }
  g.fillStyle = C.white; for (const [x, y] of [[4, 3], [11, 2], [26, 4], [20, 1], [29, 8], [2, 9]]) g.fillRect(x, y, 1, 1);
  const peak = (cx, top, col) => { g.fillStyle = col; for (let y = top; y < 32; y++) { const w = (y - top) * 1.6; g.fillRect(Math.round(cx - w), y, Math.round(w * 2) + 1, 1); } };
  peak(7, 17, C.tealDeep); peak(25, 15, C.moss); peak(16, 9, C.forest);
  g.fillStyle = C.white; for (let y = 9; y < 13; y++) { const w = (y - 9) * 1.6; g.fillRect(Math.round(16 - w), y, Math.round(w * 2) + 1, 1); }
  g.fillStyle = C.green; g.fillRect(0, 27, 32, 5); g.fillStyle = C.greenLight; g.fillRect(0, 27, 32, 1);
  g.fillStyle = C.coral; for (let x = 4; x < 30; x++) g.fillRect(x, 29 + (x % 6 < 3 ? 0 : 1), 1, 1);
  g.fillStyle = C.ink; g.fillRect(16, 2, 1, 8); g.fillStyle = C.red; g.fillRect(17, 2, 4, 3);
  g.drawImage(frameOf(builtInSet('hiker'), 'cheer', 0.2, false), 8, 13);
  const up = (n, pad = 0) => {
    const c = document.createElement('canvas'); c.width = n; c.height = n;
    const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
    x.fillStyle = C.ink; x.fillRect(0, 0, n, n);
    x.drawImage(art, pad, pad, n - pad * 2, n - pad * 2);
    return c.toDataURL('image/png').split(',')[1];
  };
  return { i192: up(192), i512: up(512), m512: up(512, 64), apple: up(180), fav: up(32) };
});
writeFileSync('public/icon-192.png', Buffer.from(out.i192, 'base64'));
writeFileSync('public/icon-512.png', Buffer.from(out.i512, 'base64'));
writeFileSync('public/icon-maskable-512.png', Buffer.from(out.m512, 'base64'));
writeFileSync('public/apple-touch-icon.png', Buffer.from(out.apple, 'base64'));
writeFileSync('public/favicon-32.png', Buffer.from(out.fav, 'base64'));
await browser.close();
console.log('icons written to public/');
