import { frameOf, type SpriteSet } from './characters';
import { drawText, textWidth } from './font';
import type { LogoSet } from './logo';
import { C, PALETTE, rgb01 } from './palette';
import type { SkyState } from './sky';
import type { TimelineState } from './timeline';
import type { Activity, Track } from './track';

/** Start / finish arch ("gate") scenes, drawn as a full pixel-art stage over the 3D view. */

export type GateColor = 'red' | 'blue' | 'orange' | 'green' | 'black';

export interface GateOptions {
  text: string; // banner text, e.g. "KORGA UTR 2026"
  tagline: string; // beam under the banner, e.g. "CAN YOU SURVIVE?"
  color: GateColor;
}

interface Theme { main: string; dark: string; light: string; text: string; glow: string }
export const GATE_THEMES: Record<GateColor, Theme> = {
  red: { main: C.red, dark: C.wine, light: C.pink, text: C.ink, glow: C.wine },
  blue: { main: C.sky, dark: C.dusk, light: C.skyLight, text: C.ink, glow: C.dusk },
  orange: { main: C.orange, dark: C.coral, light: C.cream, text: C.ink, glow: C.coral },
  green: { main: C.greenLight, dark: C.green, light: C.lime, text: C.ink, glow: C.forest },
  black: { main: C.ink2, dark: C.ink, light: C.night, text: C.white, glow: C.plum },
};

export interface GateInput {
  ctx: CanvasRenderingContext2D;
  W: number;
  H: number;
  state: TimelineState;
  sky: SkyState;
  gate: GateOptions;
  hero: SpriteSet;
  pet: SpriteSet | null;
  logo: LogoSet | null;
  track: Track;
  activity: Activity;
  tzOffsetMin: number;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

export function drawGateScene(g: GateInput) {
  const { ctx, W, H, state, sky } = g;
  const start = state.phase === 'gateStart';
  const u = state.gateU;
  const theme = GATE_THEMES[g.gate.color];
  const portrait = H > W;

  // ---- layout
  const horizon = Math.round(H * (portrait ? 0.5 : 0.56));
  const archW = Math.round(Math.min(W * (portrait ? 0.88 : 0.7), 236));
  const x0 = Math.round(W / 2 - archW / 2), x1 = x0 + archW;
  const pillarW = Math.max(41, Math.round(archW * 0.18));
  const bannerH = portrait ? 28 : 30; // tall enough for a readable logo
  const archTop = horizon - Math.round(H * (portrait ? 0.2 : 0.33));
  const ground = horizon + Math.round(H * (portrait ? 0.14 : 0.24)); // where the arch & runner stand

  // ---- sky, stars, tree line, grass
  const skyCols = 6;
  for (let r = 0; r < horizon; r++) {
    const f = Math.min(skyCols - 1, Math.floor((r / horizon) * skyCols)) / (skyCols - 1);
    ctx.fillStyle = nearest([0, 1, 2].map((i) => sky.top[i] + (sky.bottom[i] - sky.top[i]) * f) as [number, number, number]);
    ctx.fillRect(0, r, W, 1);
  }
  if (sky.stars > 0.3) {
    for (let k = 0; k < 70; k++) {
      const sx = (k * 97 + 13) % W, sy = (k * 57 + 7) % Math.max(1, horizon - 14);
      if ((k + Math.floor(state.t * 3)) % 9 === 0) continue; // twinkle
      ctx.fillStyle = k % 5 ? C.white : C.cream;
      ctx.fillRect(sx, sy, 1, 1);
    }
  }
  const treeCol = sky.isNight ? C.ink : C.forestDeep;
  for (let x = 0; x < W; x++) {
    const h = 5 + Math.round(3 * Math.sin(x * 0.11) + 2 * Math.sin(x * 0.37 + 1) + ((x * 7919) % 5) / 2);
    ctx.fillStyle = treeCol;
    ctx.fillRect(x, horizon - h, 1, h);
  }
  ctx.fillStyle = sky.isNight ? C.forestDeep : C.green;
  ctx.fillRect(0, horizon, W, H - horizon);
  ctx.fillStyle = sky.isNight ? C.tealDeep : C.forest;
  for (let y = horizon; y < H; y += 2) for (let x = (y >> 1) % 4; x < W; x += 4) ctx.fillRect(x, y, 1, 1);
  // grass tufts
  ctx.fillStyle = sky.isNight ? C.forest : C.greenLight;
  for (let k = 0; k < 60; k++) {
    const gx = (k * 131) % W, gy = horizon + 4 + ((k * 71) % (H - horizon - 6));
    ctx.fillRect(gx, gy, 1, 2);
    ctx.fillRect(gx + 2, gy + 1, 1, 1);
  }

  // ---- coloured light pooling on the grass
  dither(ctx, W / 2, ground + 2, archW * 0.55, Math.min(44, (H - ground) * 0.9 + 10), theme.glow, 0.55);
  dither(ctx, W / 2, ground - 4, archW * 0.3, 16, C.plum, 0.5);

  // ---- start / finish line
  ctx.fillStyle = C.white;
  for (let x = x0 + pillarW; x < x1 - pillarW; x += 4) ctx.fillRect(x, ground, 2, 1);

  // ---- tagline beam: between the pillars, or across the whole arch when it doesn't fit
  const tag = g.gate.tagline.toUpperCase();
  const between = archW - 2 * pillarW - 6;
  const wideBeam = !!tag && textWidth(tag) > between;
  const beamH = tag ? 11 : 0;
  const labelY = archTop + bannerH + 5 + (wideBeam ? beamH : 0);

  // ---- pillars
  const label = start ? 'START' : 'FINISH';
  for (const px of [x0, x1 - pillarW]) {
    const inner = px === x0 ? px + pillarW - 4 : px;
    box(ctx, px, archTop + bannerH - 1, pillarW, ground - archTop - bannerH + 1, theme.main);
    ctx.fillStyle = theme.dark;
    ctx.fillRect(inner, archTop + bannerH, 4, ground - archTop - bannerH - 1);
    const roomy = textWidth(label) <= pillarW - 10;
    const cx = px + pillarW / 2 + (roomy ? (px === x0 ? -2 : 2) : 0);
    drawText(ctx, label, cx, labelY, theme.text, { align: 'center' });
    // generic sponsor-board blocks
    const rows = Math.max(1, Math.floor((ground - labelY - 21) / 9));
    for (let r = 0; r < rows; r++) {
      const by = labelY + 12 + r * 9;
      ctx.fillStyle = [C.cream, C.white, C.yellow, C.skyPale][r % 4];
      ctx.fillRect(Math.round(cx - 9), by, 7, 4);
      ctx.fillStyle = [C.white, C.cream, C.skyPale, C.yellow][r % 4];
      ctx.fillRect(Math.round(cx + 2), by, 7, 4);
    }
    // ballast blocks at the feet
    box(ctx, px - 3, ground - 4, pillarW + 6, 6, C.ink2);
  }

  // ---- banner
  box(ctx, x0, archTop, archW, bannerH, theme.main);
  ctx.fillStyle = theme.light;
  ctx.fillRect(x0 + 2, archTop + 2, archW - 4, 1);
  let logoW = 0;
  if (g.logo) {
    const lg = g.logo.get(bannerH - 8, false);
    logoW = lg.width + 6;
    for (const lx of [x0 + 3, x1 - 3 - logoW]) {
      box(ctx, lx, archTop + 3, logoW, bannerH - 6, C.ink);
      ctx.drawImage(lg, lx + 3, archTop + 4);
    }
  }
  const text = (g.gate.text || 'START').toUpperCase();
  const room = archW - 2 * logoW - 10;
  const scale = textWidth(text, 2) <= room ? 2 : 1;
  let shown = text;
  if (textWidth(shown, scale) > room) shown = shown.slice(0, Math.max(1, Math.floor((room + 1) / 6)));
  drawText(ctx, shown, W / 2, archTop + Math.round((bannerH - 7 * scale) / 2), theme.text, { align: 'center', scale });

  if (tag) {
    const beamY = archTop + bannerH;
    const bx = wideBeam ? x0 : x0 + pillarW - 1;
    const bw = wideBeam ? archW : archW - 2 * pillarW + 2;
    box(ctx, bx, beamY - 1, bw, beamH, theme.dark);
    const room2 = bw - 6;
    drawText(ctx, textWidth(tag) > room2 ? tag.slice(0, Math.floor((room2 + 1) / 6)) : tag, W / 2, beamY + 1, theme.light, { align: 'center' });
  }

  // ---- runner (+ buddy), drawn 2× so they read as the hero of the shot
  const S = 2;
  const run = g.activity === 'trailrun';
  let heroX = W / 2;
  let anim: Parameters<typeof frameOf>[1] = 'idle';
  const flip = false;
  if (start) {
    if (u > 0.84) {
      anim = run ? 'run' : 'walk';
      heroX = W / 2 + ((u - 0.84) / 0.16) * (W * 0.65);
    }
  } else if (u < 0.35) {
    anim = run ? 'run' : 'walk';
    heroX = -12 + (u / 0.35) * (W / 2 + 12);
  } else anim = 'cheer';
  const drawChar = (set: SpriteSet, x: number, tOff: number) => {
    const f = frameOf(set, anim, state.t + tOff, flip);
    ctx.fillStyle = C.ink;
    ctx.fillRect(Math.round(x - 8), ground - 1, 17, 2);
    ctx.drawImage(f, Math.round(x - 8 * S), ground - 16 * S + 1, 16 * S, 16 * S);
  };
  if (g.pet) drawChar(g.pet, heroX - 30, 0.13);
  drawChar(g.hero, heroX, 0);

  // ---- big text: countdown / finisher
  const midY = archTop + bannerH + (tag ? 14 : 6);
  if (start) {
    const steps: [number, number, string, string][] = [
      [0.3, 0.48, '3', C.white], [0.48, 0.66, '2', C.white], [0.66, 0.84, '1', C.white], [0.84, 1.01, 'GO!', C.yellow],
    ];
    for (const [a, b, s, col] of steps) {
      if (u < a || u >= b) continue;
      const pop = Math.min(1, (u - a) / 0.04);
      const sc = pop < 1 ? 5 : 4;
      drawText(ctx, s, W / 2, midY + (pop < 1 ? -2 : 0), col, { align: 'center', scale: sc, shadow: C.ink });
    }
    if (u < 0.3) {
      const d = new Date(g.track.stats.startTime + g.tzOffsetMin * 60000);
      const info = `START ${hhmm(d)}`;
      plate(ctx, W / 2, H - 16, info);
    }
  } else if (u >= 0.35) {
    const head = run ? 'FINISHER!' : 'FINISH!';
    const hs = textWidth(head, 3) < archW - 2 * pillarW ? 3 : textWidth(head, 2) < archW - 8 ? 2 : 1;
    drawText(ctx, head, W / 2, midY + (hs < 3 ? 6 : 0), C.yellow, { align: 'center', scale: hs, shadow: C.ink });
    const el = g.track.stats.endTime - g.track.stats.startTime;
    plate(ctx, W / 2, H - 16, run ? elapsed(el) : hhmm(new Date(g.track.stats.endTime + g.tzOffsetMin * 60000)));
    confetti(ctx, W / 2, ground - 20, (u - 0.35) * 3.8);
  }

  // ---- pixel dissolve into / out of the 3D view
  const fade = start ? clamp01((u - 0.9) / 0.1) : clamp01(1 - u / 0.08);
  if (fade > 0) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (BAYER4[(y & 3) * 4 + (x & 3)] / 16 < fade) ctx.clearRect(x, y, 1, 1);
      }
    }
  }
}

/** Little arch marking the start / finish on the map (instead of a flag). */
export function drawMiniArch(ctx: CanvasRenderingContext2D, x: number, y: number, color: GateColor) {
  const th = GATE_THEMES[color];
  const X = Math.round(x) - 11, Y = Math.round(y) - 15;
  box(ctx, X, Y, 22, 6, th.main);
  box(ctx, X, Y + 5, 4, 11, th.main);
  box(ctx, X + 18, Y + 5, 4, 11, th.main);
  ctx.fillStyle = th.text;
  ctx.fillRect(X + 4, Y + 2, 14, 1);
  ctx.fillStyle = C.white;
  for (let k = 0; k < 3; k++) ctx.fillRect(X + 6 + k * 4, Y + 15, 2, 1);
}

// ---------------------------------------------------------------- helpers

function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string) {
  x = Math.round(x); y = Math.round(y);
  ctx.fillStyle = C.ink;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = fill;
  ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
}

function plate(ctx: CanvasRenderingContext2D, cx: number, y: number, text: string) {
  const w = textWidth(text) + 12;
  box(ctx, cx - w / 2, y - 3, w, 13, C.cream);
  drawText(ctx, text, cx, y, C.ink, { align: 'center' });
}

function dither(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, col: string, strength: number) {
  ctx.fillStyle = col;
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d > 1) continue;
      if (BAYER4[(y & 3) * 4 + (x & 3)] / 16 < (1 - d) * strength) ctx.fillRect(x, y, 1, 1);
    }
  }
}

function confetti(ctx: CanvasRenderingContext2D, cx: number, cy: number, age: number) {
  if (age < 0 || age > 2.5) return;
  const cols = [C.red, C.yellow, C.skyLight, C.pink, C.white, C.greenLight];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let k = 0; k < 48; k++) {
    const vx = (rnd() - 0.5) * 120, vy = -50 - rnd() * 70;
    ctx.fillStyle = cols[k % cols.length];
    ctx.fillRect(Math.round(cx + vx * age), Math.round(cy + vy * age + 70 * age * age), k % 3 ? 1 : 2, 1);
  }
}

const pal = PALETTE.map((h) => [h, ...rgb01(h)] as [string, number, number, number]);
function nearest(c: [number, number, number]) {
  let best = pal[0][0], bd = Infinity;
  for (const [h, r, g, b] of pal) {
    const d = (r - c[0]) ** 2 * 0.22 + (g - c[1]) ** 2 * 0.45 + (b - c[2]) ** 2 * 0.33;
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
function elapsed(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
