// Renders the full MP4 in headless Chrome and saves it. usage: node scripts/export-test.mjs out.mp4 [mode] [aspect] [scale]
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const [, , out, mode = '3d', aspect = 'landscape', scale = '4', dur = ''] = process.argv;
const base = process.env.BASE ?? 'http://localhost:5199';
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${base}/?sample&nodisk`);
await page.waitForFunction(() => window.__pixelHike && window.__pixelHike.duration > 0, null, { timeout: 120000 });
const t0 = Date.now();
const b64 = await page.evaluate(async ({ mode, aspect, scale, dur }) => {
  const h = window.__pixelHike; h.setMode(mode); h.setAspect(aspect);
  const blob = await h.exportMp4(Number(scale), dur ? Number(dur) : undefined);
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}, { mode, aspect, scale, dur });
writeFileSync(out, Buffer.from(b64, 'base64'));
console.log(`exported in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await browser.close();
