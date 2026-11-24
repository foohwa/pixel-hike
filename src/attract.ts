/**
 * The empty preview's "attract mode": a little hiker walking past scrolling ridges at night, drawn on a
 * 2D canvas behind the "drop a file" prompt, so the first screen already shows what you're about to make.
 * Stops as soon as a track is loaded. With reduced motion it's one still frame.
 */
import { builtInSet, frameOf } from './characters';
import { drawText } from './font';
import { C } from './palette';

const W = 160, H = 90, GROUND = 74;

function ridge(x: number, seed: number, amp: number, base: number) {
  return Math.round(base - amp * (0.55 * Math.sin(x * 0.045 + seed) + 0.3 * Math.sin(x * 0.11 + seed * 2.3) + 0.15 * Math.sin(x * 0.23 + seed * 5.1)));
}

const STARS = Array.from({ length: 34 }, (_, i) => [(i * 47 + 13) % W, (i * 29 + 7) % 44, i % 5]);

export function startAttract(canvas: HTMLCanvasElement, isDone: () => boolean) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const hero = builtInSet('hiker');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let lastDraw = -1;

  function draw(secs: number) {
    // sky in bands, darkest at the top
    const bands = [C.ink, '#1f2238', C.ink2];
    bands.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(0, i * 16, W, 16); });
    ctx.fillStyle = C.ink2;
    ctx.fillRect(0, 48, W, H - 48);
    for (const [x, y, k] of STARS) {
      ctx.fillStyle = k === 0 && Math.floor(secs * 2 + x) % 3 === 0 ? C.yellow : C.white;
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.fillStyle = C.cream; // a crescent moon
    ctx.fillRect(134, 9, 6, 6);
    ctx.fillStyle = C.ink;
    ctx.fillRect(136, 8, 5, 5);

    // far ridge, near hills, then the trail; each scrolls at its own speed
    const far = secs * 3, near = secs * 9, trail = secs * 18;
    for (let x = 0; x < W; x++) {
      const fy = ridge(x + far, 1.7, 9, 50);
      ctx.fillStyle = C.night;
      ctx.fillRect(x, fy, 1, GROUND - fy);
      const ny = ridge(x + near, 4.2, 5, 64);
      ctx.fillStyle = C.forestDeep;
      ctx.fillRect(x, ny, 1, GROUND - ny);
    }
    // pines on the near hills
    for (let i = 0; i < 9; i++) {
      const x = Math.round(((i * 37 - near * 1.0) % (W + 20) + W + 20) % (W + 20)) - 10;
      const base = ridge(x + near, 4.2, 5, 64) + 2;
      ctx.fillStyle = C.forest;
      for (let r = 0; r < 7; r++) ctx.fillRect(x - Math.floor(r / 2), base - 8 + r, 1 + Math.floor(r / 2) * 2, 1);
      ctx.fillStyle = C.brownDark;
      ctx.fillRect(x, base - 1, 1, 2);
    }
    ctx.fillStyle = C.forestDeep;
    ctx.fillRect(0, GROUND, W, H - GROUND);
    ctx.fillStyle = C.tan; // the trail
    ctx.fillRect(0, GROUND, W, 2);
    ctx.fillStyle = C.brown;
    for (let x = -(Math.floor(trail) % 8); x < W; x += 8) ctx.fillRect(x, GROUND + 3, 3, 1);

    drawText(ctx, 'PIXEL HIKE', W / 2, 10, C.yellow, { align: 'center', scale: 2, shadow: C.red });
    const f = frameOf(hero, 'walk', still ? 0.2 : secs, false);
    ctx.drawImage(f, 56, GROUND - f.height);
  }

  function tick(now: number) {
    if (isDone()) return;
    if (still) {
      if (lastDraw < 0) { draw(0); lastDraw = 0; }
    } else if (now - lastDraw > 80) { // ~12 fps: it's pixel art, and the tab stays light
      draw(now / 1000);
      lastDraw = now;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
