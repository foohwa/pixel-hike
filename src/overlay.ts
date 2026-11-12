import { frameOf, type Anim, type SpriteSet } from './characters';
import { drawGateScene, drawMiniArch, type GateOptions } from './gate';
import type { LogoSet } from './logo';
import { drawText, textWidth } from './font';
import { C, PALETTE, rgb01 } from './palette';
import type { SkyState } from './sky';
import { AID, CAMPFIRE, drawFlag, drawMoon, drawSprite, HEART, MOON, MOUNTAIN, STOPWATCH, SUN, TENT, THERMO } from './sprites';
import type { Timeline, TimelineState } from './timeline';
import { clamp, sampleAt, type Activity, type Checkpoint, type Track } from './track';
import { DECOR_KEYS, WARN_SIGN, ZONE_COLOR, type TrailZones } from './zones';
import type { EnvOptions } from './renderer';

export interface ScreenPoint { x: number; y: number; visible: boolean }

/** A trail-side prop, bottom-centre at (x, y). `lit` = inside the head-lamp's glow. */
export interface DecorItem { x: number; y: number; rows: string[]; lit: boolean }
export interface DecorFrame {
  items: DecorItem[];
  /** Fixed ropes beside technical stretches (screen polylines at ground level). */
  ropes: { x: number; y: number }[][];
  signs: DecorItem[];
}

/** Map sprites for this frame (see PixelRenderer.mapFrame): screen positions, q = distance / camera distance. */
export interface MapFrame {
  lamps: { x: number; y: number; q: number }[];
  rapids: { x: number; y: number; q: number }[];
  /** tx/ty = the route's direction on screen (the bridge deck follows it). */
  bridges: { x: number; y: number; q: number; tx: number; ty: number }[];
  vehicles: { x: number; y: number; left: boolean; moto: boolean; color: string }[];
  falls: { x: number; y: number; q: number }[];
  /**
   * A waterfall a short detour off the route, shown beside the trail where the route passes closest
   * (x/y), with an arrow sign at the trail edge (sx/sy) pointing towards it (left = arrow points left).
   */
  sideFalls: { x: number; y: number; q: number; sx: number; sy: number; left: boolean; sprite: boolean }[];
  camps: { x: number; y: number; q: number }[];
  springs: { x: number; y: number; q: number }[];
}

export interface DialState {
  isDay: boolean;
  frac: number; // 0..1 across the current day (sunrise→sunset) or night (sunset→sunrise)
  moonPhase: number;
}

export interface OverlayInput {
  ctx: CanvasRenderingContext2D;
  W: number;
  H: number;
  track: Track;
  activity: Activity;
  checkpoints: Checkpoint[];
  timeline: Timeline;
  state: TimelineState;
  sky: SkyState;
  dial: DialState;
  toasts: { text: string; t: number }[];
  title: string;
  tzOffsetMin: number;
  hero: SpriteSet;
  heroAt: ScreenPoint;
  facingLeft: boolean;
  pet: SpriteSet | null;
  petAt: ScreenPoint | null;
  petFacingLeft: boolean;
  /** Screen position of each enabled checkpoint. */
  cpScreen: Map<string, ScreenPoint>;
  showMinimap: boolean;
  logo: EventLogo | null;
  /** Start/finish arch scenes + mini arches on the map, or null. */
  gate: GateOptions | null;
  zones: TrailZones | null;
  /** Props along the trail for this frame (see PixelRenderer.decorFrame), or null. */
  decor: DecorFrame | null;
  map: MapFrame | null;
  /** Checkpoints built into the 3D scene (sites3d.ts): no sprite for these. */
  sited: Set<string> | null;
  env: EnvOptions;
}

export interface EventLogo {
  set: LogoSet;
  intro: boolean;
  badge: boolean;
  outro: boolean;
}

export const KIND_COLOR: Record<Checkpoint['kind'], string> = {
  start: C.greenLight,
  summit: C.red,
  peak: C.yellow,
  view: C.pink,
  rest: C.orange,
  camp: C.coral,
  cp: C.skyLight,
  finish: C.white,
};

const REST_SIGN = ['kkkkkkk', 'kmLmLmk', 'kLmLmLk', 'kkkkkkk', '..kLk..', '..kLk..', '..kLk..'];
const SIGN_KEYS = { k: C.ink, m: C.cream, L: C.brown };

export function drawOverlay(o: OverlayInput) {
  const { ctx, W, H } = o;
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;

  if (o.gate && (o.state.phase === 'gateStart' || o.state.phase === 'gateFinish')) {
    drawGateScene({
      ctx, W, H, state: o.state, sky: o.sky, gate: o.gate, hero: o.hero, pet: o.pet,
      logo: o.logo?.set ?? null, track: o.track, activity: o.activity, tzOffsetMin: o.tzOffsetMin,
    });
    return;
  }

  drawWorldSprites(o);
  drawBirds(o);
  drawHud(o);
  drawNext(o);
  drawBadge(o);
  drawToasts(o);
  drawBanner(o);
  drawTitleCard(o);
  drawOutroCard(o);
}

// ---------------------------------------------------------------- animation choice

/** Picks the animation for the current moment (shared by the hero and the companion). */
export function pickAnim(o: Pick<OverlayInput, 'state' | 'track' | 'activity' | 'sky'>): Anim {
  const { state, track } = o;
  if (state.phase === 'intro' || state.phase === 'gateStart') return 'idle';
  if (state.phase === 'outro' || state.phase === 'gateFinish') return 'cheer';
  if (state.phase === 'pause' && state.pauseCp) {
    switch (state.pauseCp.kind) {
      case 'rest':
      case 'cp':
        return 'rest';
      case 'camp':
        return o.sky.isNight ? 'sleep' : 'rest';
      case 'view':
        return 'idle';
      default:
        return 'cheer';
    }
  }
  const g = sampleAt(track, track.grade, state.d);
  if (g > 0.15) return 'climb';
  if (g < -0.15) return o.activity === 'trailrun' ? 'run' : 'descend';
  return o.activity === 'trailrun' ? 'run' : 'walk';
}

// ---------------------------------------------------------------- world sprites

function pixLine(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= n; i++) {
    const f = n ? i / n : 0;
    ctx.fillRect(Math.round(x0 + (x1 - x0) * f), Math.round(y0 + (y1 - y0) * f), 1, 1);
  }
}

function drawDecor(o: OverlayInput) {
  const dec = o.decor;
  if (!dec) return;
  const { ctx } = o;
  const night = o.sky.lamp > 0.5;
  const keys = (lit: boolean) => (night && !lit ? DECOR_KEYS.night : DECOR_KEYS.day);
  for (const it of dec.items) drawSprite(ctx, it.rows, it.x, it.y + 1, { keys: keys(it.lit) });

  // fixed ropes: posts every other point, rope sagging between post tops
  for (const line of dec.ropes) {
    ctx.fillStyle = night ? C.coral : C.orange;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 2; // a little sag below the 3-px posts
      pixLine(ctx, a.x, a.y - 3, mx, my);
      pixLine(ctx, mx, my, b.x, b.y - 3);
    }
    line.forEach((p, i) => {
      if (i % 2) return;
      ctx.fillStyle = night ? C.ink2 : C.brownDark;
      ctx.fillRect(p.x, p.y - 3, 1, 4);
      ctx.fillStyle = night ? C.rockDark : C.tan;
      ctx.fillRect(p.x, p.y - 4, 1, 1);
    });
  }
  for (const s of dec.signs) drawSprite(ctx, WARN_SIGN, s.x, s.y + 1, { keys: keys(true) });
}

// ---------------------------------------------------------------- map sprites

const CAR = [
  '..kkkk..',
  '.kbkbbk.',
  'kkrrrrrk',
  'krrrrrry',
  '.kk..kk.',
];
const MOTO = [
  '...h..',
  '..kbk.',
  '.kkkky',
  'kk..kk',
];
/**
 * Waterfall sprites: g/G moss, r/R rock, w falling water (streaks scroll down), f foam (flickers),
 * p splash pool. Drawn by drawFallSprite with the animation applied per pixel.
 */
const FALL_L = [
  '...gGGg.gGgg...',
  '..gGrrRgRrrGg..',
  '.gGrRRwwwRrrGg.',
  '.grRrwwwwwRrRg.',
  '..rRrwwwwwrRr..',
  '.grrRwwwwwRrrg.',
  '..rRrwwwwwrRr..',
  '..rrRwwwwwRrr..',
  '.grRrwwwwwrRrg.',
  '..rRrwwwwwRrr..',
  '.rrRrwwwwwrRrr.',
  'rrRrfwfwfwfrRrr',
  '.ppfpfpfpfpfpp.',
  '..ppppppppppp..',
];
const FALL_M = [
  '..gGgGg..',
  '.gRrrrRg.',
  '.rRwwwRr.',
  '.rrwwwrr.',
  '.rRwwwRr.',
  '.rrwwwrr.',
  'rRrwwwrRr',
  '.pfwfwfp.',
  '..ppppp..',
];
function drawFallSprite(ctx: CanvasRenderingContext2D, rows: string[], x: number, y: number, t: number, night: boolean) {
  const w = rows[0].length, h = rows.length;
  const x0 = Math.round(x - w / 2), y0 = Math.round(y - h + 2);
  const water = night ? [C.dusk, C.sky, C.skyLight] : [C.sky, C.skyLight, C.white];
  const scroll = Math.floor(t * 10), flick = Math.floor(t * 6);
  const col: Record<string, string> = night
    ? { g: C.tealDeep, G: C.moss, r: C.ink2, R: C.night, p: C.dusk }
    : { g: C.forest, G: C.greenLight, r: C.rockDark, R: C.rock, p: C.sky };
  rows.forEach((row, yy) => {
    for (let xx = 0; xx < row.length; xx++) {
      const ch = row[xx];
      if (ch === '.') continue;
      ctx.fillStyle =
        ch === 'w' ? water[(((yy - scroll + xx * 2) % 3) + 3) % 3]
        : ch === 'f' ? ((xx + flick) % 2 ? (night ? C.skyLight : C.white) : water[1])
        : col[ch];
      ctx.fillRect(x0 + xx, y0 + yy, 1, 1);
    }
  });
}

const ARROW_SIGN = ['kkkkkkk', 'kmmmamk', 'kaaaaak', 'kmmmamk', 'kkkkkkk', '...L...', '...L...'];

/**
 * A waterfall: mossy rock walls, water streaming down (2·hw+1 px wide, h tall) and a splash pool,
 * bottom-centre at (x, y).
 */
function drawFall(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, hw: number, t: number, night: boolean) {
  const top = y - h;
  // rock walls and the lip, with a little moss
  ctx.fillStyle = night ? C.ink2 : C.rockDark;
  ctx.fillRect(x - hw - 2, top, 2, h);
  ctx.fillRect(x + hw + 1, top, 2, h);
  ctx.fillRect(x - hw - 1, top - 1, hw * 2 + 3, 1);
  ctx.fillStyle = night ? C.tealDeep : C.green;
  ctx.fillRect(x - hw - 2, top - 1, 2, 1);
  ctx.fillRect(x + hw + 1, top + 2, 1, 2);
  ctx.fillRect(x - hw - 2, top + Math.floor(h / 2), 1, 2);
  // falling water: streaks scrolling down
  const water = night ? [C.dusk, C.sky, C.skyLight] : [C.sky, C.skyLight, C.white];
  const scroll = Math.floor(t * 10);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = -hw; xx <= hw; xx++) {
      ctx.fillStyle = water[(((yy - scroll + xx * 2) % 3) + 3) % 3];
      ctx.fillRect(x + xx, top + yy, 1, 1);
    }
  }
  // splash pool with foam
  ctx.fillStyle = night ? C.dusk : C.sky;
  ctx.fillRect(x - hw - 3, y, hw * 2 + 7, 1);
  ctx.fillRect(x - hw - 1, y + 1, hw * 2 + 3, 1);
  ctx.fillStyle = night ? C.skyLight : C.white;
  const sp = Math.floor(t * 5) % 2;
  ctx.fillRect(x - hw - 1 - sp, y - 1, 2, 1);
  ctx.fillRect(x + hw + sp, y - 1, 2, 1);
  ctx.fillRect(x - 1 + sp, y, 2, 1);
}

const CAMP_SIGN = ['kkkkkkk', 'kmmammk', 'kmaaamk', 'kkkkkkk', '...L...', '...L...'];
const DROP = ['.s.', 'sSs', 'SsS', '.S.'];

function drawMap(o: OverlayInput) {
  const m = o.map;
  if (!m) return;
  const { ctx } = o;
  const t = o.state.t;
  const night = o.sky.lamp > 0.5;

  // street lights: a post and a warm bulb (town lights from afar)
  for (const l of m.lamps) {
    if (l.q < 1.3) {
      ctx.fillStyle = C.ink2;
      ctx.fillRect(l.x, l.y - 3, 1, 3);
      ctx.fillStyle = C.cream;
      ctx.fillRect(l.x, l.y - 4, 1, 1);
      if (l.q < 0.8) {
        ctx.fillStyle = C.yellow;
        ctx.fillRect(l.x - 1, l.y - 4, 1, 1);
        ctx.fillRect(l.x + 1, l.y - 4, 1, 1);
      }
    } else {
      ctx.fillStyle = l.q < 2.2 ? C.cream : C.yellow;
      ctx.fillRect(l.x, l.y - 1, 1, 1);
    }
  }

  // white water on steep streams: a rock with foam churning round it
  for (const r of m.rapids) {
    const ph = Math.floor(t * 6 + r.x * 0.7) % 3;
    ctx.fillStyle = night ? C.ink2 : C.rockDark;
    ctx.fillRect(r.x, r.y - 1, 1, 1);
    ctx.fillStyle = night ? C.rockDark : C.white;
    ctx.fillRect(r.x - 1 + ph, r.y, 1, 1);
    if (r.q < 1.1) ctx.fillRect(r.x + 1 - ph, r.y - 2 + (ph & 1), 1, 1);
  }

  // waterfalls at their real spot, sized by distance
  for (const f of m.falls) {
    if (f.q < 1.2) drawFallSprite(ctx, FALL_M, f.x, f.y, t, night);
    else drawFall(ctx, f.x, f.y, f.q < 2.2 ? 8 : 5, 2, t, night);
  }
  // …and one just off the route, brought up beside the trail with a sign pointing the way
  for (const f of m.sideFalls) {
    if (!f.sprite) { /* 3D: the waterfall is part of the terrain, just the sign here */ }
    else if (f.q < 2.6) drawFallSprite(ctx, FALL_L, f.x, f.y, t, night);
    else drawFallSprite(ctx, FALL_M, f.x, f.y, t, night);
    drawSprite(ctx, ARROW_SIGN, f.sx, f.sy + 1, { keys: { k: C.ink, m: C.cream, a: C.sky, L: C.brown }, flip: f.left });
  }

  // bridges: a plank deck along the route with a rail and posts either side
  for (const b of m.bridges) {
    const L = Math.round(clamp(6 / Math.max(0.8, b.q), 3, 7));
    const nx = -b.ty, ny = b.tx;
    const at = (s: number, a: number) => [Math.round(b.x + b.tx * s + nx * a), Math.round(b.y + b.ty * s + ny * a)];
    ctx.fillStyle = night ? C.brownDark : C.brown;
    for (let s = -L; s <= L; s++) for (const a of [-1, 0, 1]) { const [x, y] = at(s, a); ctx.fillRect(x, y, 1, 1); }
    ctx.fillStyle = night ? C.ink2 : C.tan;
    for (let s = -L; s <= L; s += 2) { const [x, y] = at(s, 0); ctx.fillRect(x, y, 1, 1); }
    ctx.fillStyle = C.ink;
    for (let s = -L; s <= L; s++) {
      for (const a of [-2, 2]) {
        const [x, y] = at(s, a);
        ctx.fillRect(x, y - 1, 1, 1);
        if (s % 3 === 0 || Math.abs(s) === L) ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  // traffic
  for (const v of m.vehicles) {
    const rows = v.moto ? MOTO : CAR;
    const keys = { k: C.ink, r: v.color === C.white && night ? C.rock : v.color, b: night ? C.ink2 : C.skyLight, y: C.yellow, h: v.color };
    drawSprite(ctx, rows, v.x, v.y + 1, { keys, flip: v.left });
    if (night) {
      // headlight beam on the road ahead
      ctx.fillStyle = C.cream;
      const dx = v.left ? -1 : 1;
      const fx = v.x + dx * (Math.ceil(rows[0].length / 2) + 1);
      ctx.fillRect(fx, v.y - 1, 1, 1);
      ctx.fillRect(fx + dx, v.y - 1, 1, 1);
      ctx.fillStyle = C.yellow;
      ctx.fillRect(fx + dx * 2, v.y - 1, 1, 1);
      ctx.fillStyle = C.red; // tail light
      ctx.fillRect(v.x - dx * Math.ceil(rows[0].length / 2), v.y - 2, 1, 1);
    }
  }

  // camps beside the trail: a little tent sign; springs: a bobbing water drop
  for (const c of m.camps) drawSprite(ctx, CAMP_SIGN, c.x + 7, c.y + 1, { keys: { k: C.ink, m: C.cream, a: C.orange, L: C.brown } });
  for (const s of m.springs) {
    const bob = Math.floor(t * 2) % 2;
    drawSprite(ctx, DROP, s.x + 6, s.y - 2 - bob, { keys: { s: C.skyLight, S: C.sky } });
  }
}

function drawWorldSprites(o: OverlayInput) {
  const { ctx, state, timeline } = o;
  const t = state.t;

  drawMap(o);
  drawDecor(o);

  for (const cp of o.checkpoints) {
    if (!cp.enabled) continue;
    const p = o.cpScreen.get(cp.id);
    if (!p || !p.visible) continue;
    const reachT = timeline.reachTimes.get(cp.id);
    const reached = cp.kind === 'start' || (reachT != null && t >= reachT && state.phase !== 'intro');
    if (o.sited?.has(cp.id)) {
      // built into the 3D scene (sites3d.ts); only the summit's name board shows while you stand there
      if (o.env.signs && (cp.kind === 'summit' || cp.kind === 'peak') && state.phase === 'pause' && state.pauseCp?.id === cp.id) drawSummitSign(ctx, cp, p.x, p.y, o.W);
      continue;
    }
    switch (cp.kind) {
      // props sit just beside the trail so the characters don't cover them
      case 'camp':
        drawSprite(ctx, TENT, p.x + 3, p.y - 7);
        drawSprite(ctx, CAMPFIRE[Math.floor(t * 6) % 2], p.x + 13, p.y + 1);
        break;
      case 'rest':
        drawSprite(ctx, REST_SIGN, p.x + 13, p.y, { keys: SIGN_KEYS });
        break;
      case 'cp':
        if (o.env.signs) drawSprite(ctx, AID_TENT, p.x + 17, p.y + 1, { keys: AID_KEYS });
        else drawSprite(ctx, AID, p.x + 15, p.y);
        break;
      default: {
        if (o.env.signs && (cp.kind === 'summit' || cp.kind === 'peak')) {
          // the summit signboard: small from afar, full size with name + height while you're standing there
          const here = state.phase === 'pause' && state.pauseCp?.id === cp.id;
          if (here) drawSummitSign(ctx, cp, p.x, p.y, o.W);
          else drawSprite(ctx, SIGN_SMALL, p.x + 9, p.y + 1, { keys: SIGN_KEYS2 });
        }
        if (o.gate && (cp.kind === 'start' || cp.kind === 'finish')) {
          drawMiniArch(ctx, p.x, p.y, o.gate.color);
          break;
        }
        const raise = cp.kind === 'start' ? 1 : reached ? clamp((t - (reachT ?? 0)) / 0.5, 0, 1) : 0;
        drawFlag(ctx, p.x, p.y, reached ? KIND_COLOR[cp.kind] : C.rock, raise, t * 7, cp.kind === 'finish' && reached);
      }
    }
  }

  const anim = pickAnim(o);

  drawFireflies(o);

  // companion trots a little behind
  if (o.pet && o.petAt?.visible) {
    const p = o.petAt;
    ctx.fillStyle = C.ink;
    ctx.fillRect(p.x - 4, p.y - 1, 9, 2);
    ctx.drawImage(frameOf(o.pet, anim, t + 0.13, o.petFacingLeft), p.x - 8, p.y - 16);
  }

  const h = o.heroAt;
  if (!h.visible) return;
  ctx.fillStyle = C.ink;
  ctx.fillRect(h.x - 4, h.y - 1, 9, 2);
  ctx.drawImage(frameOf(o.hero, anim, t, o.facingLeft), h.x - 8, h.y - 16);

  // head-lamp sparkle at night
  if (o.hero.lamp && o.sky.lamp > 0.5 && anim !== 'sleep' && state.phase !== 'outro') {
    const lx = o.facingLeft ? 15 - o.hero.lamp[0] : o.hero.lamp[0];
    ctx.fillStyle = Math.floor(t * 4) % 2 ? C.cream : C.yellow;
    ctx.fillRect(h.x - 8 + lx, h.y - 16 + o.hero.lamp[1], 1, 1);
  }

  // zZz while sleeping at camp
  if (anim === 'sleep') {
    for (let k = 0; k < 2; k++) {
      const uu = (t * 0.6 + k / 2) % 1;
      if (uu > 0.85) continue;
      drawText(ctx, 'Z', h.x + 4 + uu * 8, h.y - 14 - uu * 16, C.white, { shadow: C.ink });
    }
  }

  // confetti after reaching a peak / finish
  const lr = state.lastReached;
  if (lr && (lr.cp.kind === 'summit' || lr.cp.kind === 'peak' || lr.cp.kind === 'finish')) {
    const age = t - lr.t;
    if (age >= 0 && age < 1.8) {
      const colors = [C.red, C.yellow, C.skyLight, C.pink, C.white, C.greenLight];
      let seed = hashStr(lr.cp.id);
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
      const n = lr.cp.kind === 'summit' ? 36 : 20;
      for (let k = 0; k < n; k++) {
        const vx = (rnd() - 0.5) * 70;
        const vy = -40 - rnd() * 50;
        const px = h.x + vx * age;
        const py = h.y - 10 + vy * age + 60 * age * age;
        ctx.fillStyle = colors[k % colors.length];
        ctx.fillRect(Math.round(px), Math.round(py), k % 3 === 0 ? 2 : 1, 1);
      }
    }
  }
}

// ---------------------------------------------------------------- HUD

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string = C.ink, border: string = C.skyPale) {
  x = Math.round(x); y = Math.round(y);
  ctx.fillStyle = border;
  ctx.fillRect(x + 1, y, w - 2, h);
  ctx.fillRect(x, y + 1, w, h - 2);
  ctx.fillStyle = fill;
  ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
}

function fmtInt(v: number) {
  return Math.round(v).toLocaleString('en-US');
}

export function clockText(ms: number, tzOffsetMin: number) {
  const d = new Date(ms + tzOffsetMin * 60000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function elapsedText(ms: number, seconds = true) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return seconds ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${h}H ${String(m).padStart(2, '0')}M`;
}

function paceText(secPerKm: number) {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0 || secPerKm > 3600) return '--:--';
  return `${Math.floor(secPerKm / 60)}:${String(Math.round(secPerKm % 60)).padStart(2, '0')}`;
}

function drawHud(o: OverlayInput) {
  const { ctx, W, track, state, sky } = o;
  if (state.phase === 'gateStart' || (state.phase === 'intro' && state.introT < o.timeline.intro - 0.5)) return;
  const d = state.d;
  const ele = sampleAt(track, track.ele, d);
  const hr = sampleAt(track, track.hr, d);
  const temp = sampleAt(track, track.temp, d);
  const run = o.activity === 'trailrun';

  // top-left: distance, elevation (+ pace for runs)
  const lines: [string[] | null, string, string][] = [
    [null, `${((d * track.distScale) / 1000).toFixed(1)} KM`, C.yellow],
    [MOUNTAIN, `${fmtInt(ele)} M`, C.white],
  ];
  if (run) {
    const pace = sampleAt(track, track.pace, d) / track.distScale;
    lines.push([null, `${paceText(pace)}/KM`, C.skyLight]);
  }
  const lw = Math.max(...lines.map(([icon, s]) => textWidth(s) + (icon ? 10 : 0))) + 8;
  panel(ctx, 4, 4, lw, 4 + lines.length * 9);
  lines.forEach(([icon, s, col], i) => {
    const y = 7 + i * 9;
    if (icon) drawSprite(ctx, icon, 8, y + (icon.length < 7 ? 1 : 0), { anchor: 'topleft' });
    drawText(ctx, s, icon ? 18 : 8, y, col);
  });

  // top-right: clock (or race timer), heart rate, temperature
  const right: [string[], string, string][] = [];
  if (run) right.push([STOPWATCH, elapsedText(state.clockMs - track.stats.startTime), C.white]);
  else right.push([sky.isNight ? MOON : SUN, clockText(state.clockMs, o.tzOffsetMin), C.white]);
  if (Number.isFinite(hr)) {
    const beat = (state.t * hr) / 60;
    const big = beat - Math.floor(beat) < 0.22;
    right.push([HEART, String(Math.round(hr)), big ? C.pink : C.white]);
  }
  if (Number.isFinite(temp)) right.push([THERMO, `${Math.round(temp)}°C`, C.white]);
  const rw = Math.max(...right.map(([, s]) => textWidth(s))) + 20;
  const rh = 4 + right.length * 9;
  panel(ctx, W - 4 - rw, 4, rw, rh);
  right.forEach(([icon, s, col], i) => {
    const y = 7 + i * 9;
    drawSprite(ctx, icon, W - rw + 1 + Math.floor((7 - icon[0].length) / 2), y, { anchor: 'topleft' });
    drawText(ctx, s, W - 8, y, col, { align: 'right' });
  });

  drawDial(o);
  if (o.showMinimap) drawMinimap(o, W - 4 - 42, 4 + rh + 3, 42);
  drawProfile(o);
}

const palRgb = PALETTE.map((h) => [h, ...rgb01(h)] as [string, number, number, number]);
function nearestHex(c: [number, number, number]) {
  let best = palRgb[0][0], bd = Infinity;
  for (const [h, r, g, b] of palRgb) {
    const d = (r - c[0]) ** 2 * 0.22 + (g - c[1]) ** 2 * 0.45 + (b - c[2]) ** 2 * 0.33;
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}

/** Little window at the top showing the sun or moon travelling over the horizon. */
function drawDial(o: OverlayInput) {
  const { ctx, W, sky, dial } = o;
  const w = 38, h = 22;
  let x = Math.round(W / 2 - w / 2);
  let y = 4;
  if (W < 200) {
    // portrait: tuck it under the left panel so nothing overlaps
    x = 4;
    y = 4 + 4 + 2 * 9 + 3 + (o.activity === 'trailrun' ? 9 : 0);
  }
  panel(ctx, x, y, w, h);
  const ix = x + 1, iy = y + 1, iw = w - 2, ih = h - 2;
  const groundH = 4;
  const skyH = ih - groundH;
  for (let r = 0; r < skyH; r++) {
    const f = r / Math.max(1, skyH - 1);
    const c: [number, number, number] = [
      sky.top[0] + (sky.bottom[0] - sky.top[0]) * f,
      sky.top[1] + (sky.bottom[1] - sky.top[1]) * f,
      sky.top[2] + (sky.bottom[2] - sky.top[2]) * f,
    ];
    ctx.fillStyle = nearestHex(c);
    ctx.fillRect(ix, iy + r, iw, 1);
  }
  if (sky.stars > 0.3) {
    ctx.fillStyle = C.white;
    for (const [sx, sy] of [[3, 2], [9, 5], [16, 1], [24, 4], [30, 2], [33, 7], [6, 9]]) ctx.fillRect(ix + sx, iy + sy, 1, 1);
  }
  const gy = iy + skyH;
  ctx.fillStyle = C.green;
  ctx.fillRect(ix, gy, iw, 1);
  ctx.fillStyle = C.forest;
  ctx.fillRect(ix, gy + 1, iw, groundH - 1);
  ctx.fillStyle = C.forestDeep;
  for (let k = 0; k < 5; k++) ctx.fillRect(ix + 4 + k, gy - Math.min(k, 4 - k), 1, 1 + Math.min(k, 4 - k));

  const cx = ix + iw / 2;
  const rx = iw / 2 - 5, ry = skyH - 4;
  const ang = Math.PI * (1 - clamp(dial.frac, 0, 1));
  const px = Math.round(cx + Math.cos(ang) * rx);
  const py = Math.round(gy - 1 - Math.sin(ang) * ry);
  ctx.save();
  ctx.beginPath();
  ctx.rect(ix, iy, iw, skyH);
  ctx.clip();
  if (dial.isDay) drawSprite(ctx, SUN, px, py, { anchor: 'center' });
  else drawMoon(ctx, px, py, 3, dial.moonPhase, C.night);
  ctx.restore();
}

function drawToasts(o: OverlayInput) {
  const { ctx, W, H, state } = o;
  for (const toast of o.toasts) {
    const age = state.t - toast.t;
    if (age < 0 || age > 2.2) continue;
    const w = textWidth(toast.text) + 10;
    const slide = Math.min(1, age * 5);
    const y0 = W < H ? H - 4 - 18 - 18 - (o.env.splits ? 16 : 0) : 30;
    const y = Math.round(y0 + (1 - slide) * (W < H ? 8 : -8));
    panel(ctx, Math.round(W / 2 - w / 2), y, w, 12, C.cream, C.ink);
    drawText(ctx, toast.text, W / 2, y + 3, C.plum, { align: 'center' });
  }
}

const profileCache = new WeakMap<Track, { w: number; cols: Float32Array }>();

function drawProfile(o: OverlayInput) {
  const { ctx, W, H, track, state } = o;
  const x0 = 4, w = W - 8, ph = 16;
  const y0 = H - 4 - ph - 2;
  panel(ctx, x0, y0, w, ph + 2);
  const iw = w - 4;
  let cache = profileCache.get(track);
  if (!cache || cache.w !== iw) {
    const cols = new Float32Array(iw);
    for (let c = 0; c < iw; c++) cols[c] = sampleAt(track, track.ele, (c / (iw - 1)) * track.stats.distance);
    cache = { w: iw, cols };
    profileCache.set(track, cache);
  }
  const cols = cache.cols;
  const { minEle, maxEle, distance } = track.stats;
  const range = Math.max(1, maxEle - minEle);
  const cur = Math.round((state.d / distance) * (iw - 1));
  const hAt = (c: number) => 1 + Math.round(((cols[clamp(c, 0, iw - 1)] - minEle) / range) * (ph - 3));
  const z = o.zones?.settings.on ? o.zones : null;
  for (let c = 0; c < iw; c++) {
    const hgt = hAt(c);
    const x = x0 + 2 + c;
    const yb = y0 + 1 + ph;
    const dc = (c / (iw - 1)) * distance;
    // zones colour the walked part; ahead stays grey with a zone-coloured ridge line
    const [fill, top] = z ? ZONE_COLOR[z.styleAt(dc)] : [C.green, C.lime];
    ctx.fillStyle = c <= cur ? fill : C.rockDark;
    ctx.fillRect(x, yb - hgt, 1, hgt);
    ctx.fillStyle = z?.techAt(dc) ? C.orange : c <= cur ? top : z ? fill : C.rock;
    ctx.fillRect(x, yb - hgt, 1, 1);
  }
  for (const cp of o.checkpoints) {
    if (!cp.enabled || cp.kind === 'start') continue;
    const c = Math.round((cp.d / distance) * (iw - 1));
    const x = x0 + 2 + c, y = y0 + 1 + ph - hAt(c);
    ctx.fillStyle = KIND_COLOR[cp.kind];
    ctx.fillRect(x, y - 4, 1, 4);
    ctx.fillRect(x + 1, y - 4, 2, 2);
  }
  const mx = x0 + 2 + cur, my = y0 + 1 + ph - hAt(cur);
  ctx.fillStyle = C.ink;
  ctx.fillRect(mx - 2, my - 4, 5, 4);
  ctx.fillStyle = C.coral;
  ctx.fillRect(mx - 1, my - 3, 3, 2);
  ctx.fillRect(mx, my - 1, 1, 1);
}

const miniCache = new WeakMap<Track, { size: number; pts: Int16Array }>();

function drawMinimap(o: OverlayInput, x: number, y: number, size: number) {
  const { ctx, track, state } = o;
  panel(ctx, x, y, size, size);
  let cache = miniCache.get(track);
  if (!cache || cache.size !== size) {
    const b = track.bounds;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) || 1;
    const inner = size - 8;
    const ox = ((1 - (b.maxX - b.minX) / span) * inner) / 2;
    const oz = ((1 - (b.maxZ - b.minZ) / span) * inner) / 2;
    const pts: number[] = [];
    let lx = -999, lz = -999;
    for (let i = 0; i < track.n; i++) {
      const px = Math.round(((track.x[i] - b.minX) / span) * inner + ox);
      const pz = Math.round(((track.z[i] - b.minZ) / span) * inner + oz);
      if (px === lx && pz === lz) continue;
      pts.push(px, pz, Math.round((i / track.n) * 32767));
      lx = px; lz = pz;
    }
    cache = { size, pts: Int16Array.from(pts) };
    miniCache.set(track, cache);
  }
  const prog = Math.round((state.d / track.stats.distance) * 32767);
  const p = cache.pts;
  let cx = 0, cz = 0;
  for (let k = 0; k < p.length; k += 3) {
    const done = p[k + 2] <= prog;
    ctx.fillStyle = done ? C.yellow : C.rockDark;
    ctx.fillRect(x + 4 + p[k], y + 4 + p[k + 1], 1, 1);
    if (done) { cx = p[k]; cz = p[k + 1]; }
  }
  if (Math.floor(state.t * 4) % 2 === 0 || state.phase !== 'move') {
    ctx.fillStyle = C.red;
    ctx.fillRect(x + 3 + cx, y + 3 + cz, 3, 3);
  }
}

// ---------------------------------------------------------------- banners / cards

function stayText(min: number) {
  return min >= 60 ? `${Math.floor(min / 60)}H ${String(min % 60).padStart(2, '0')}M` : `${min} MIN`;
}

function drawBanner(o: OverlayInput) {
  const { ctx, W, H, state, track } = o;
  const lr = state.lastReached;
  if (!lr || lr.cp.kind === 'start') return;
  const age = state.t - lr.t;
  if (age < 0 || age > (state.phase === 'pause' ? 99 : 0.35) || state.phase === 'outro' || state.phase === 'gateFinish') return;
  const cp = lr.cp;
  const run = o.activity === 'trailrun';
  const exclaim = cp.kind === 'summit' || cp.kind === 'finish';
  let title =
    cp.kind === 'finish' && run && cp.name === 'FINISH' ? 'FINISHER!' : cp.name.toUpperCase() + (exclaim && !cp.name.endsWith('!') ? '!' : '');
  const time = clockText(cp.time, o.tzOffsetMin);
  const elapsed = elapsedText(cp.time - track.stats.startTime);
  const km = `${((cp.d * track.distScale) / 1000).toFixed(1)} KM`;
  let sub: string;
  switch (cp.kind) {
    case 'rest': sub = `${stayText(cp.stayMin ?? 0)} BREAK  ${time}`; break;
    case 'camp': sub = `${stayText(cp.stayMin ?? 0)} STAY  ${time}`; break;
    case 'cp': sub = run ? `${km}  ${elapsed}` : `${km}  ${time}`; break;
    case 'finish': sub = run ? elapsed : `${km}  ${time}`; break;
    default: sub = `${fmtInt(cp.ele)} M  ${run ? elapsed : time}`;
  }
  // with signboards on, the name is on the sign; the banner just celebrates
  if (o.env.signs && (cp.kind === 'summit' || cp.kind === 'peak') && state.phase === 'pause') title = cp.kind === 'summit' ? 'SUMMIT!' : 'PEAK!';
  const leg = o.env.splits ? legText(o, cp) : null;
  let scale = 2;
  if (textWidth(title, 2) > W - 24) scale = 1;
  if (textWidth(title, 1) > W - 16) title = title.slice(0, Math.floor((W - 16) / 6));
  const bw = Math.max(textWidth(title, scale), textWidth(sub), leg ? textWidth(leg) : 0) + 16;
  const bh = 7 * scale + 7 + 12 + (leg ? 9 : 0);
  const drop = easeOutBack(clamp(age * 4, 0, 1));
  // at a viewpoint the banner gets out of the way after a second so you can see the view
  const away = cp.kind === 'view' && o.env.landmarks ? clamp((age - 1.1) * 4, 0, 1) : 0;
  const top = H > W ? 84 : 44; // keep clear of the dial / minimap
  const y = Math.round(top - (1 - drop + away) * (top + bh + 20));
  const x = Math.round(W / 2 - bw / 2);
  panel(ctx, x, y, bw, bh, C.cream, C.ink);
  ctx.fillStyle = KIND_COLOR[cp.kind] === C.white ? C.ink : KIND_COLOR[cp.kind];
  ctx.fillRect(x + 2, y + 2, bw - 4, 2);
  drawText(ctx, title, W / 2, y + 6, C.ink, { scale, align: 'center' });
  drawText(ctx, sub, W / 2, y + 7 * scale + 9, C.wine, { align: 'center' });
  if (leg) drawText(ctx, leg, W / 2, y + 7 * scale + 18, C.forest, { align: 'center' });
}

// ---------------------------------------------------------------- splits

const idxOf = (t: Track, d: number) => clamp(Math.round(d / t.step), 0, t.n - 1);
function gainBetween(t: Track, d0: number, d1: number) {
  return t.asc[idxOf(t, d1)] - t.asc[idxOf(t, d0)];
}

/** "+8.4 KM ^620 M 2:15" for the leg that ends at `cp`. */
function legText(o: OverlayInput, cp: Checkpoint): string | null {
  if (cp.kind === 'start') return null;
  const prev = o.checkpoints
    .filter((c) => c.enabled && c.d < cp.d - 1)
    .sort((a, b) => b.d - a.d)[0];
  if (!prev) return null;
  const t = o.track;
  const km = ((cp.d - prev.d) * t.distScale) / 1000;
  const gain = gainBetween(t, prev.d, cp.d);
  const ms = Math.max(0, cp.time - prev.leaveTime);
  const h = Math.floor(ms / 3600_000), m = Math.round((ms % 3600_000) / 60_000);
  const dur = h ? `${h}:${String(m).padStart(2, '0')}` : `${m} MIN`;
  return `+${km.toFixed(1)} KM  ^${fmtInt(gain)} M  ${dur}`;
}

/** Bottom-left: what's coming up. */
function drawNext(o: OverlayInput) {
  const { ctx, W, H, state, track } = o;
  if (!o.env.splits || state.phase !== 'move') return;
  const next = o.checkpoints
    .filter((c) => c.enabled && c.kind !== 'start' && c.d > state.d + 30)
    .sort((a, b) => a.d - b.d)[0];
  if (!next) return;
  const km = ((next.d - state.d) * track.distScale) / 1000;
  const gain = gainBetween(track, state.d, next.d);
  const tail = `${km.toFixed(1)} KM${gain >= 10 ? ` ^${fmtInt(gain)} M` : ''}`;
  const maxW = Math.floor(W * (o.logo?.badge ? 0.64 : 0.9)) - 12;
  let name = next.name.toUpperCase();
  const fixed = textWidth(`NEXT  ${tail}`) + 8;
  while (name.length > 3 && fixed + textWidth(name) > maxW) name = name.slice(0, -1);
  if (name !== next.name.toUpperCase()) name = name.slice(0, -1) + '.';
  const y = H - 4 - 18 - 3 - 11;
  const w = fixed + textWidth(name) + 6;
  panel(ctx, 4, y, w, 11);
  ctx.fillStyle = KIND_COLOR[next.kind] === C.white ? C.cream : KIND_COLOR[next.kind];
  ctx.fillRect(7, y + 3, 2, 5);
  drawText(ctx, 'NEXT', 12, y + 2, C.rock);
  drawText(ctx, name, 12 + textWidth('NEXT ') + 4, y + 2, C.white);
  drawText(ctx, tail, 4 + w - 4, y + 2, C.yellow, { align: 'right' });
}

// ---------------------------------------------------------------- signs & tents

const SIGN_KEYS2 = { k: C.ink, m: C.cream, L: C.brown, r: C.red };
const SIGN_SMALL = ['kkkkkkk', 'kmrmrmk', 'kmmmmmk', 'kkkkkkk', '.kL.Lk.', '.kL.Lk.', '.kL.Lk.'];

const AID_KEYS = { k: C.ink, S: C.red, W: C.white, s: C.skin, r: C.coral, h: C.brownDark, b: C.skyLight, w: C.white, t: C.tan, L: C.brown };
/** Aid station: striped canopy, a volunteer behind a table with water jugs and cups. */
const AID_TENT = [
  '.kkkkkkkkkkkkkkk.',
  'kSWSWSWSWSWSWSWSk',
  'kkkkkkkkkkkkkkkkk',
  '.k.............k.',
  '.k..hh.........k.',
  '.k..ss..bb.ww..k.',
  '.k.rrrr.bb.ww..k.',
  '.kkkkkkkkkkkkkkk.',
  '.k.L.........L.k.',
  '.k.L.........L.k.',
];

/** Summit signboard ("GUNUNG KORBU / 2,183 M") on two posts, beside the hiker. */
function drawSummitSign(ctx: CanvasRenderingContext2D, cp: Checkpoint, x: number, y: number, W: number) {
  let name = cp.name.toUpperCase();
  while (name.length > 4 && textWidth(name) > 96) name = name.slice(0, -1);
  const ele = `${fmtInt(cp.ele)} M`;
  const bw = Math.max(textWidth(name), textWidth(ele)) + 8;
  const bh = 21;
  const postH = 7;
  // to the right of the hiker unless that runs off screen
  let bx = x + 14;
  if (bx + bw > W - 4) bx = x - 14 - bw;
  const by = y - postH - bh;
  ctx.fillStyle = C.ink;
  ctx.fillRect(bx + 3, by + bh, 3, postH);
  ctx.fillRect(bx + bw - 6, by + bh, 3, postH);
  ctx.fillStyle = C.brown;
  ctx.fillRect(bx + 4, by + bh, 1, postH);
  ctx.fillRect(bx + bw - 5, by + bh, 1, postH);
  panel(ctx, bx, by, bw, bh, C.cream, C.brownDark);
  ctx.fillStyle = C.red;
  ctx.fillRect(bx + 2, by + 2, bw - 4, 1);
  drawText(ctx, name, bx + bw / 2, by + 4, C.wine, { align: 'center' });
  drawText(ctx, ele, bx + bw / 2, by + 12, C.ink, { align: 'center' });
}

// ---------------------------------------------------------------- life

/** Fireflies blinking around the hiker on warm, low jungle nights. */
function drawFireflies(o: OverlayInput) {
  const { ctx, state, sky, track } = o;
  if (!o.env.life || o.env.scenery !== 'tropical' || sky.lamp < 0.6) return;
  if (state.phase !== 'move' && state.phase !== 'pause') return;
  const ele = sampleAt(track, track.ele, state.d);
  if (ele > 1300) return;
  const h = o.heroAt;
  if (!h.visible) return;
  const t = state.t;
  for (let k = 0; k < 9; k++) {
    const ph = k * 1.7;
    const blink = (t * 0.9 + k * 0.37) % 1;
    if (blink > 0.55) continue;
    const fx = h.x + Math.sin(t * 0.6 + ph) * (18 + k * 3) + Math.sin(t * 1.7 + ph * 2) * 4;
    const fy = h.y - 8 + Math.cos(t * 0.5 + ph * 1.3) * (9 + (k % 3) * 4);
    if (Math.abs(fx - h.x) < 6 && fy > h.y - 17 && fy < h.y + 1) continue; // not on the hiker
    ctx.fillStyle = blink < 0.25 ? C.lime : C.yellow;
    ctx.fillRect(Math.round(fx), Math.round(fy), 1, 1);
  }
}

const BIRD = [['k...k', '.k.k.'], ['.....', 'kk.kk']];
/** A small flock crossing the sky around sunrise and sunset. */
function drawBirds(o: OverlayInput) {
  const { ctx, W, H, state, dial } = o;
  if (!o.env.life || state.phase !== 'move' && state.phase !== 'pause') return;
  if (!dial.isDay || (dial.frac > 0.07 && dial.frac < 0.93)) return;
  const period = 9;
  const u = (state.t % period) / 6.5; // 6.5 s to cross, then a gap
  if (u > 1) return;
  const baseY = W > H ? 96 : Math.round(H * 0.36); // below the checkpoint banner
  const flock = [[0, 0], [-7, 3], [-13, -2], [-19, 4], [-25, 1]];
  for (let i = 0; i < flock.length; i++) {
    const [dx, dy] = flock[i];
    const x = Math.round(-30 + u * (W + 60) + dx);
    const y = Math.round(baseY + dy + Math.sin(u * 9 + i) * 1.5);
    drawSprite(ctx, BIRD[Math.floor(state.t * 5 + i) % 2], x, y, { keys: { k: C.ink2 } });
  }
}

function drawTitleCard(o: OverlayInput) {
  const { ctx, W, H, state, track } = o;
  const end = o.timeline.intro - 0.6;
  if (state.phase !== 'intro' || state.introT > end) return;
  const slide = clamp((state.introT - (end - 0.3)) / 0.3, 0, 1);
  const date = new Date(track.stats.startTime + o.tzOffsetMin * 60000);
  const dateStr = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  const statStr = `${((track.stats.distance * track.distScale) / 1000).toFixed(1)} KM  ^${fmtInt(track.stats.ascent)} M`;
  let title = o.title.toUpperCase();
  let scale = 2;
  if (textWidth(title, 2) > W - 28) scale = 1;
  if (textWidth(title, 1) > W - 20) title = title.slice(0, Math.floor((W - 20) / 6));
  const bw = Math.max(textWidth(title, scale), textWidth(dateStr), textWidth(statStr)) + 20;
  const bh = 7 * scale + 32;
  const x = Math.round(W / 2 - bw / 2);
  // event logo sits on its own dark plate above the card (logos are usually made for dark backgrounds)
  const logo = o.logo?.intro ? o.logo.set.get(logoHeight(o, W > H ? 48 : 56, bw), false) : null;
  const plateH = logo ? logo.height + 10 : 0;
  const stackH = bh + (logo ? plateH + 4 : 0);
  const top = Math.round(H / 2 - stackH / 2 - 10 - slide * (H / 2 + stackH));
  if (logo) {
    const pw = Math.max(logo.width + 14, 40);
    panel(ctx, W / 2 - pw / 2, top, pw, plateH, C.ink, C.cream);
    ctx.drawImage(logo, Math.round(W / 2 - logo.width / 2), top + 5);
  }
  const y = top + (logo ? plateH + 4 : 0);
  panel(ctx, x, y, bw, bh, C.cream, C.ink);
  ctx.fillStyle = C.coral;
  ctx.fillRect(x + 2, y + 2, bw - 4, 2);
  drawText(ctx, title, W / 2, y + 8, C.ink, { scale, align: 'center' });
  drawText(ctx, dateStr, W / 2, y + 7 * scale + 12, C.wine, { align: 'center' });
  drawText(ctx, statStr, W / 2, y + 7 * scale + 22, C.forest, { align: 'center' });
}

function drawOutroCard(o: OverlayInput) {
  const { ctx, W, H, state, track } = o;
  if (state.phase !== 'outro' || state.outroU < 0.2) return;
  const s = track.stats;
  const km = (s.distance * track.distScale) / 1000;
  const run = o.activity === 'trailrun';
  const rows: [string, string][] = [['DISTANCE', `${km.toFixed(1)} KM`]];
  if (run) {
    rows.push(['TIME', elapsedText(s.duration)]);
    rows.push(['AVG PACE', `${paceText(s.duration / 1000 / km)}/KM`]);
  } else rows.push(['TIME', elapsedText(s.duration, false)]);
  rows.push(['ELEV GAIN', `${fmtInt(s.ascent)} M`]);
  if (!run) rows.push(['HIGHEST', `${fmtInt(s.maxEle)} M`]);
  const camps = o.checkpoints.filter((c) => c.enabled && c.kind === 'camp').length;
  if (o.activity === 'camphike' && camps) rows.push(['NIGHTS', String(camps)]);
  if (s.avgHr) rows.push(['AVG HR', `${Math.round(s.avgHr)} BPM`]);
  if (s.calories && rows.length < 7) rows.push(['CALORIES', `${fmtInt(s.calories)}`]);
  const header = run ? 'FINISHER!' : o.activity === 'camphike' ? 'TRIP COMPLETE!' : 'HIKE COMPLETE!';
  const labelW = 10 * 6; // longest label (ELEV GAIN) + a gap
  const valW = Math.max(...rows.map((r) => textWidth(r[1])));
  const bw = Math.max(textWidth(header), labelW + valW) + 16;
  const bh = 16 + rows.length * 10 + 4;
  const u = easeOutBack(clamp((state.outroU - 0.2) * 3, 0, 1));
  const x = Math.round(W / 2 - bw / 2);
  const logo = o.logo?.outro ? o.logo.set.get(logoHeight(o, W > H ? 28 : 40, bw), false) : null;
  const plateH = logo ? logo.height + 8 : 0;
  const stackH = bh + (logo ? plateH + 3 : 0);
  const top = Math.round(H / 2 - stackH / 2 - 12 + (1 - u) * (H / 2 + stackH));
  if (logo) {
    const pw = Math.max(logo.width + 12, 36);
    panel(ctx, W / 2 - pw / 2, top, pw, plateH, C.ink, C.cream);
    ctx.drawImage(logo, Math.round(W / 2 - logo.width / 2), top + 4);
  }
  const y = top + (logo ? plateH + 3 : 0);
  panel(ctx, x, y, bw, bh, C.cream, C.ink);
  ctx.fillStyle = C.red;
  ctx.fillRect(x + 2, y + 2, bw - 4, 2);
  drawText(ctx, header, W / 2, y + 6, C.ink, { align: 'center' });
  rows.forEach(([k, v], i) => {
    const ry = y + 17 + i * 10;
    drawText(ctx, k, x + 8, ry, C.wine);
    drawText(ctx, v, x + bw - 8, ry, C.ink, { align: 'right' });
  });
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function easeOutBack(x: number) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function hashStr(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Logo height that fits: the preferred size, shrunk if the logo would be wider than `maxW`. */
function logoHeight(o: OverlayInput, preferred: number, maxW: number) {
  const a = o.logo!.set.aspect;
  return Math.max(10, Math.min(preferred, Math.floor((Math.max(maxW, o.W * 0.6) - 14) / a)));
}

/** Small logo in the bottom-right corner while the hike plays. */
function drawBadge(o: OverlayInput) {
  const { ctx, W, H, state } = o;
  if (!o.logo?.badge || state.phase !== 'move' && state.phase !== 'pause') return;
  const h = W > H ? 20 : 22;
  const img = o.logo.set.get(Math.min(h, Math.floor((W * 0.3) / o.logo.set.aspect)), true);
  const profileTop = H - 4 - 18;
  ctx.drawImage(img, W - 4 - img.width, profileTop - 3 - img.height);
}
