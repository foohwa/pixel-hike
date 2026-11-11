// usage: node scripts-shot.mjs <outdir> <mode> <aspect> t1 t2 ...
import { chromium } from 'playwright';
const [, , out, mode = '3d', aspect = 'landscape', ...ts] = process.argv;
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5199/?sample');
await page.waitForFunction(() => window.__pixelHike && window.__pixelHike.duration > 0, null, { timeout: 120000 });
const info = await page.evaluate(({ mode, aspect }) => {
  const h = window.__pixelHike; h.setMode(mode); h.setAspect(aspect);
  return { duration: h.duration, stats: h.stats, cps: h.checkpoints.map(c => ({ id: c.id, kind: c.kind, km: +(c.d/1000).toFixed(2), ele: Math.round(c.ele), rest: c.restMin })), reach: [...h.timeline.reachTimes.entries()] };
}, { mode, aspect });
console.log(JSON.stringify(info));
for (const t of ts) {
  await page.evaluate((t) => window.__pixelHike.seek(Number(t)), t);
  await page.waitForTimeout(50);
  await page.locator('#view').screenshot({ path: `${out}/${mode}-${aspect}-t${t}.png` });
}
if (process.env.FULL) await page.screenshot({ path: `${out}/full-${mode}.png` });
await browser.close();
