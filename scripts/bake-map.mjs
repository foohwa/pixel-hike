// Saves the sample route's map data (rivers, roads, landmarks) next to the private sample, so the
// dev server serves it instantly and offline: public/samples/map-<area>.json (git-ignored, like the GPX).
// usage: node scripts/bake-map.mjs   (dev server running; BASE defaults to http://localhost:5199)
import { writeFileSync } from 'node:fs';
import { launch } from './browser.mjs';
const base = process.env.BASE ?? 'http://localhost:5199';
const browser = await launch();
const page = await browser.newPage();
await page.goto(`${base}/?sample=${process.env.SAMPLE ?? 'gpx'}&nodisk`);
await page.waitForFunction(() => window.__pixelHike && window.__pixelHike.duration > 0, null, { timeout: 120000 });
let out = await page.evaluate(() => window.__pixelHike.mapData());
// springs/waterfalls come from a separate small query; give it up to a minute
for (let i = 0; i < 30 && out && !out.data.extras; i++) {
  await page.waitForTimeout(2000);
  out = await page.evaluate(() => window.__pixelHike.mapData());
}
await browser.close();
if (!out) { console.error('No map data (is the Rivers/Landmarks switch on?)'); process.exit(1); }
const file = `public/samples/map-${out.area}.json`;
writeFileSync(file, JSON.stringify(out.data));
const d = out.data;
console.log(`${file}: ${d.lines.length} lines, ${d.areas.length} areas, ${d.pois.length} landmarks${d.extras ? '' : ' (springs/waterfalls missing: Overpass was busy, run again later)'}`);
