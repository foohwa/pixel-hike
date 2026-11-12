// End-to-end check of checkpoint persistence, the "you are here" row and MP4 audio.
// usage: node scripts/e2e.mjs [outdir]   (needs the dev server on :5199 and public/samples/hike.gpx)
import { launch } from './browser.mjs';
import { writeFileSync } from 'node:fs';
const out = process.argv[2] ?? '.';
const base = process.env.BASE ?? 'http://localhost:5199';
const browser = await launch(['--autoplay-policy=no-user-gesture-required']);
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
let t0 = Date.now();
const step = (name) => { console.log(`-- ${name} (+${((Date.now() - t0) / 1000).toFixed(1)}s)`); };
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) process.exitCode = 1; };
const load = async () => {
  await page.goto(`${base}/?sample&nodisk`);
  await page.waitForFunction(() => window.__pixelHike && window.__pixelHike.duration > 0, null, { timeout: 120000 });
  await page.waitForTimeout(400);
};
const names = () => page.$$eval('#cps li[data-d] input[type=text]', (els) => els.map((e) => e.value));

step('load');
await load();
const before = await names();
console.log('auto checkpoints:', before.join(', '));

step('1. edit checkpoints');
// 1. rename the first REST by typing, delete PEAK 2 with its ✕, add a checkpoint at t=50
const rowOf = async (name) => (await names()).indexOf(name);
await page.locator('#cps li[data-d]').nth(await rowOf('REST')).locator('input[type=text]').fill('WATERFALL');
await page.locator('#cps li[data-d]').nth(await rowOf('PEAK 2')).locator('button.del').click();
await page.evaluate(() => window.__pixelHike.seek(50));
await page.click('#addCp');
await page.waitForTimeout(500);
const edited = await names();
console.log('after edits:', edited.join(', '));
ok(edited.includes('WATERFALL'), 'rename applied');
ok(!edited.includes('PEAK 2'), 'deleted PEAK 2');
ok(edited.includes('VIEWPOINT'), 'added a custom checkpoint');
ok((await page.textContent('#saved')).includes('saved'), `saved indicator: "${await page.textContent('#saved')}"`);

step('2. switch activity');
// 2. switching activity keeps edits
await page.click('#activity button[data-v=trailrun]');
await page.waitForTimeout(300);
const run = await names();
console.log('trail run:', run.join(', '));
ok(run.includes('WATERFALL') && !run.includes('PEAK 2') && run.includes('VIEWPOINT'), 'edits survive switching to Trail run');
await page.click('#activity button[data-v=hike]');
await page.waitForTimeout(300);
ok((await names()).includes('WATERFALL'), 'edits survive switching back to Hike');
await page.click('#activity button[data-v=trailrun]');
await page.waitForTimeout(600);

step('3. reload');
// 3. reload restores
await load();
const restored = await names();
console.log('after reload:', restored.join(', '));
ok(restored.includes('WATERFALL') && !restored.includes('PEAK 2') && restored.includes('VIEWPOINT'), 'edits restored after reload');
ok(await page.$eval('#activity button.on', (b) => b.dataset.v) === 'trailrun', 'activity restored (trail run)');
ok((await page.textContent('#saved')).includes('restored'), 'restored indicator shown');

step('4. you-are-here');
// 4. you-are-here row
await page.evaluate(() => window.__pixelHike.seek(31.2));
const here = await page.textContent('#cps li.here');
const prev = await page.$eval('#cps li.here', (el) => el.previousElementSibling?.querySelector('input[type=text]')?.value ?? '(top)');
console.log('here:', here, '| after:', prev);
ok(!!here && here.includes('YOU ARE HERE'), 'you-are-here row present');
await page.locator('#cps').screenshot({ path: `${out}/e2e-cps.png` });

step('5. music + MP4 export');
// 5. music + export with audio
const sdur = await page.evaluate(() => window.__pixelHike.soundtrackReady());
ok(sdur > 30, `soundtrack rendered (${sdur.toFixed(1)} s)`);
console.log('credit:', await page.textContent('#musicCredit'));
const b64 = await page.evaluate(async () => {
  const blob = await window.__pixelHike.exportMp4(4, 3);
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
});
const mp4 = Buffer.from(b64, 'base64');
writeFileSync(`${out}/e2e-clip.mp4`, mp4);
ok(mp4.includes('mp4a') || mp4.includes('Opus'), `MP4 has an audio track (${(mp4.length / 1e3).toFixed(0)} kB)`);
console.log(`wrote ${out}/e2e-clip.mp4`);

step('6. backup / wipe / restore');
// 6. backup → wipe browser storage → reload → restore from the file
const dl = page.waitForEvent('download');
await page.click('#backupCps');
const backupPath = `${out}/e2e-edits-backup.json`;
await (await dl).saveAs(backupPath);
await page.evaluate(() => window.__pixelHike.forgetSaved());
await load();
const wiped = await names();
ok(!wiped.includes('WATERFALL'), `storage wiped → edits gone (${wiped.join(', ')})`);
await page.setInputFiles('#restoreCps', backupPath);
await page.waitForTimeout(800);
const back = await names();
console.log('after restore:', back.join(', '));
ok(back.includes('WATERFALL') && !back.includes('PEAK 2') && back.includes('VIEWPOINT'), 'edits restored from the backup file');
ok(await page.$eval('#activity button.on', (b) => b.dataset.v) === 'trailrun', 'settings restored from the backup file');
await load();
ok((await names()).includes('WATERFALL'), 'restored edits are saved again (survive another reload)');

// clean up the saved state so the next run starts fresh
await page.evaluate(() => window.__pixelHike.forgetSaved());
await browser.close();
step('done');
