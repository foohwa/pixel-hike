import { C } from './palette';

/** Hand-made pixel props and HUD icons. Each char is one pixel; '.' is transparent. Characters live in characters.ts. */
export const TENT = [
  '....k....',
  '...kak...',
  '..kaaak..',
  '.kaaAaak.',
  'kaaaAaaak',
  'kaaAkAaak',
  'kkkkkkkkk',
];

export const CAMPFIRE = [
  [
    '...y....',
    '..yoy...',
    '..yooy..',
    '.yorroy.',
    '.korrok.',
    'kLkLLkLk',
  ],
  [
    '....y...',
    '...yoy..',
    '..yooy..',
    '.yorrry.',
    '.korrok.',
    'kLkLLkLk',
  ],
];

/** Aid-station canopy for race checkpoints. */
export const AID = [
  'kkkkkkkkkkk',
  'kSWSWSWSWSk',
  'kkkkkkkkkkk',
  '.k.......k.',
  '.k.kkkkk.k.',
  '.k.kWWWk.k.',
  '.k.k...k.k.',
];

export const STOPWATCH = ['..kk...', '.kkkk..', 'kwwwwk.', 'kwwkwk.', 'kwkkwk.', 'kwwwwk.', '.kkkk..'];
export const THERMO = ['.kk.', 'kwwk', 'kwwk', 'krrk', 'krrk', 'krrk', '.kk.'];

export const HEART = ['.kk.kk.', 'kRrkrrk', 'krrrrrk', '.krrrk.', '..krk..', '...k...'];
export const SUN = ['...y...', '.y...y.', '..ooo..', 'y.ooo.y', '..ooo..', '.y...y.', '...y...'];
export const MOON = ['..mmm..', '.mm....', 'mm.....', 'mm.....', 'mm.....', '.mm....', '..mmm..'];
export const MOUNTAIN = ['...k...', '..kwk..', '.kgggk.', 'kgggggk', 'kkkkkkk'];
export const FOOT = ['..kk..', '.kook.', '.kook.', 'kooook', 'kkkkkk'];

const ICON_KEYS: Record<string, string> = {
  k: C.ink,
  r: C.red,
  R: C.pink,
  y: C.yellow,
  o: C.orange,
  m: C.cream,
  w: C.white,
  g: C.green,
  a: C.orange,
  A: C.wine,
  S: C.sky,
  W: C.white,
  L: C.brown,
};

const cache = new Map<string, HTMLCanvasElement>();

/** Rasterise a char-map sprite to a canvas (optionally mirrored), cached. */
export function spriteCanvas(rows: string[], keys: Record<string, string> = ICON_KEYS, flip = false): HTMLCanvasElement {
  const id = rows.join('|') + (flip ? 'F' : '') + JSON.stringify(keys);
  const hit = cache.get(id);
  if (hit) return hit;
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = keys[row[x]];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(flip ? w - 1 - x : x, y, 1, 1);
    }
  });
  cache.set(id, c);
  return c;
}

/** Draws a sprite with its bottom-centre at (x, y). */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  rows: string[],
  x: number,
  y: number,
  opts: { keys?: Record<string, string>; flip?: boolean; anchor?: 'bottom' | 'center' | 'topleft' } = {},
) {
  const c = spriteCanvas(rows, opts.keys, opts.flip);
  const anchor = opts.anchor ?? 'bottom';
  const dx = anchor === 'topleft' ? x : x - Math.floor(c.width / 2);
  const dy = anchor === 'topleft' ? y : anchor === 'center' ? y - Math.floor(c.height / 2) : y - c.height;
  ctx.drawImage(c, Math.round(dx), Math.round(dy));
}

/** Flag on a pole, cloth `color`, `raise` 0..1 (bottom to top), waving with `phase`. */
export function drawFlag(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  raise: number,
  phase: number,
  checkered = false,
) {
  const X = Math.round(x), Y = Math.round(y);
  const poleH = 15;
  // pole
  ctx.fillStyle = C.ink;
  ctx.fillRect(X - 1, Y - poleH - 1, 3, poleH + 1);
  ctx.fillStyle = C.greyLight;
  ctx.fillRect(X, Y - poleH, 1, poleH);
  ctx.fillStyle = C.yellow;
  ctx.fillRect(X, Y - poleH - 1, 1, 1);
  // cloth (7x5) with a small wave
  const top = Y - poleH + Math.round((1 - raise) * (poleH - 6));
  const cw = 7, ch = 5;
  for (let cx = 0; cx < cw; cx++) {
    const off = Math.round(Math.sin(cx * 0.9 - phase) * 0.7);
    const len = ch - (cx === cw - 1 ? 2 : cx === cw - 2 ? 1 : 0);
    const y0 = top + off + (ch - len) / 2;
    ctx.fillStyle = C.ink;
    ctx.fillRect(X + 1 + cx, Math.round(y0) - 1, 1, len + 2);
  }
  ctx.fillStyle = C.ink;
  ctx.fillRect(X + 1 + cw, top, 1, ch);
  for (let cx = 0; cx < cw; cx++) {
    const off = Math.round(Math.sin(cx * 0.9 - phase) * 0.7);
    const len = ch - (cx === cw - 1 ? 2 : cx === cw - 2 ? 1 : 0);
    const y0 = Math.round(top + off + (ch - len) / 2);
    for (let cy = 0; cy < len; cy++) {
      ctx.fillStyle = checkered ? (((cx >> 1) + ((cy + (ch - len) / 2) >> 1)) % 2 ? C.ink : C.white) : color;
      ctx.fillRect(X + 1 + cx, y0 + cy, 1, 1);
    }
  }
}

/** Moon disc of radius r with the real phase (0 new … 0.5 full … 1 new), lit side per hemisphere. */
export function drawMoon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, phase: number, dark: string) {
  const k = Math.cos(2 * Math.PI * phase);
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      if (x * x + y * y > r * r + r * 0.6) continue;
      const half = Math.sqrt(Math.max(1e-6, r * r - y * y));
      const xn = x / half;
      const lit = phase <= 0.5 ? xn >= k : xn <= -k;
      ctx.fillStyle = lit ? C.cream : dark;
      ctx.fillRect(Math.round(cx + x), Math.round(cy + y), 1, 1);
    }
  }
}
