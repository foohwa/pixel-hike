// Screenshots of the preview at given video times.
// usage: node scripts/shot.mjs <outdir> <3d|2d> <landscape|portrait> t1 t2 ...
// env: BASE (default http://localhost:5199), SAMPLE=fit, PREFIX=name, SETUP='h.setActivity("trailrun")'
import { chromium } from 'playwright';
const [, , out, mode = '3d', aspect = 'landscape', ...ts] = process.argv;
const base = process.env.BASE ?? 'http://localhost:5199';
const prefix = process.env.PREFIX ?? `${mode}-${aspect}`;
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${base}/?sample=${process.env.SAMPLE ?? 'gpx'}`);
await page.waitForFunction(() => window.__pixelHike && window.__pixelHike.duration > 0, null, { timeout: 120000 });
const info = await page.evaluate(({ mode, aspect, setup }) => {
  const h = window.__pixelHike;
  h.setMode(mode); h.setAspect(aspect);
  if (setup) new Function('h', setup)(h);
  return {
    duration: h.duration, speedup: Math.round(h.speedup),
    cps: h.checkpoints.filter((c) => c.enabled).map((c) => `${c.kind}@${(c.d / 1000).toFixed(1)}km t=${h.timeline.reachTimes.get(c.id)?.toFixed(1)}`),
    toasts: h._renderer.toasts.map((x) => `${x.text} t=${x.t.toFixed(1)}`),
    stats: { asc: Math.round(h.stats.ascent), cal: h.stats.calories, temp: h.stats.avgTemp },
  };
}, { mode, aspect, setup: process.env.SETUP ?? '' });
console.log(JSON.stringify(info, null, 1));
for (const t of ts) {
  await page.evaluate((t) => window.__pixelHike.seek(Number(t)), t);
  await page.locator('#view').screenshot({ path: `${out}/${prefix}-t${t}.png` });
}
if (process.env.FULL) await page.screenshot({ path: `${out}/${prefix}-full.png` });
await browser.close();
