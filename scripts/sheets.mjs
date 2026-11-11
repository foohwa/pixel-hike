// Writes the built-in sprite sheets (standard layout) to docs/sprites/. usage: node scripts/sheets.mjs
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const base = process.env.BASE ?? 'http://localhost:5199';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
await page.goto(base);
await page.waitForFunction(() => window.__pixelHike);
for (const c of ['hiker', 'runner', 'dog', 'cat']) {
  for (const gender of ['male', 'female']) {
    for (const [suffix, scale, guides] of [['', 1, false], ['-8x-guides', 8, true]]) {
      const url = await page.evaluate(([c, s, g, gen]) => window.__pixelHike.sheetDataUrl(c, s, g, gen), [c, scale, guides, gender]);
      const name = gender === 'male' ? c : `${c}-female`;
      writeFileSync(`docs/sprites/${name}${suffix}.png`, Buffer.from(url.split(',')[1], 'base64'));
    }
  }
}
console.log('wrote docs/sprites/*.png');
await browser.close();
