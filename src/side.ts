/**
 * The side-scroller view: the hike as one long level seen from the side.
 *
 * x = distance along the track (loops and switchbacks unroll; you always walk right), y = the watch's
 * elevation, drawn steeper than real (capped, so the steepest bits don't turn into walls). Behind the
 * trail: a ridge layer from the real terrain beside the route and, far away, the skyline of the whole
 * hike (you can see the summit coming). Below the ground line a cut-through of soil and rock bands.
 *
 * Drawn on a 2D canvas in palette colours with the sky left transparent, so the renderer's post pass
 * adds the same sky, stars, sun, moon and clouds as the 3D view. The HUD, walker, checkpoints,
 * animals, banners and pop-ups are drawn by overlay.ts from the screen points this returns.
 */
import { C } from './palette';
import { clamp, gaussian, sampleAt, type Checkpoint, type Track } from './track';
import { treeline, type Scenery, type Terrain } from './terrain';
import { buildZones, decorDensity, decorSprite, DECOR_KEYS, rng, techSprite, type TrailZones, type ZoneStyle } from './zones';
import type { MapSprites, Surface, SurfaceInfo } from './water';
import type { Timeline, TimelineState } from './timeline';
import type { DecorFrame, DecorItem, MapFrame, ScreenPoint } from './overlay';
import { groundPose, type Encounter, type WildSprite } from './wildlife';
import { drawSprite } from './sprites';

export interface SideData {
  track: Track;
  terrain: Terrain;
  timeline: Timeline;
  checkpoints: Checkpoint[];
  /** The trail zones the user set up (only used for ropes / warning signs when switched on). */
  zones: TrailZones | null;
  scenery: Scenery;
  surface: SurfaceInfo | null;
}

export interface SideFrameInput {
  st: TimelineState;
  night: boolean;
  /** Head-lamp beam on the ground ahead. */
  beam: boolean;
  /** Valley mist 0..1. */
  mist: number;
  env: { water: boolean; landmarks: boolean };
  wild: Encounter[];
  sprites: MapSprites | null;
  crossings: { name: string; d: number }[];
  /** Poster still: the whole level, no walker. */
  snap: boolean;
}

export interface SideFrame {
  hero: ScreenPoint;
  pet: ScreenPoint;
  cpScreen: Map<string, ScreenPoint>;
  decor: DecorFrame | null;
  map: MapFrame | null;
  wild: WildSprite[];
  /** Roughly where the sky meets the land (game px from the top). */
  horizon: number;
  /** Walked distance in screen px (drifts the sky's clouds). */
  scroll: number;
}

/** How fast the level scrolls past (game px per video second) on average. */
const PX_PER_S = { wide: 50, tall: 36 };
/** Screen slope the steepest sustained climbs (98th percentile of the ~km-scale grade) are drawn at, at most. */
const MAX_SLOPE = 0.75;
const MAX_EXAG = 2.5;
const MIN_EXAG = 1.3;
/** Metres beside the route the ridge layer is taken from. */
const RIDGE_OFF = 800;
/** Zoomed out further than this (× the walking scale): trees become bumps on the ground line. */
const TREE_ZOOM = 2.6;

// ---------------------------------------------------------------- colours

const NIGHT_OF: Record<string, string> = {
  [C.greenLight]: C.forest, [C.green]: C.forestDeep, [C.forest]: C.tealDeep, [C.forestDeep]: C.ink2,
  [C.lime]: C.moss, [C.sage]: C.moss, [C.moss]: C.tealDeep, [C.tealDeep]: C.ink2,
  [C.brown]: C.brownDark, [C.brownDark]: C.ink2, [C.tan]: C.brownDark,
  [C.rock]: C.rockDark, [C.rockDark]: C.night, [C.greyLight]: C.rock, [C.white]: C.greyLight,
  [C.ink2]: C.ink, [C.skyLight]: C.dusk, [C.sky]: C.night, [C.skyPale]: C.dusk, [C.cream]: C.rock,
  [C.yellow]: C.orange,
};

const u32cache = new Map<string, number>();
function u32(hex: string) {
  let v = u32cache.get(hex);
  if (v == null) {
    const n = parseInt(hex.slice(1), 16);
    v = ((255 << 24) | ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff)) >>> 0;
    u32cache.set(hex, v);
  }
  return v;
}
const col = (hex: string, night: boolean) => u32(night ? NIGHT_OF[hex] ?? hex : hex);

/** Surface top / body / soil colours per zone. */
const GROUND: Record<ZoneStyle, [string, string, string]> = {
  jungle: [C.greenLight, C.green, C.brown],
  forest: [C.greenLight, C.green, C.brown],
  mossy: [C.lime, C.sage, C.brown],
  rocky: [C.greyLight, C.rock, C.rockDark],
  meadow: [C.lime, C.greenLight, C.brown],
  plain: [C.greenLight, C.green, C.brown],
};
/** Below the topsoil: base colour, strata line colour, and the solid colour further down. */
const DEEP = { base: C.brownDark, line: C.brown, stone: C.rockDark };
const DEEP_ROCK = { base: C.rockDark, line: C.rock, stone: C.greyLight };

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const dith = (x: number, y: number) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
function hash(x: number, y: number) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- trees (DECOR_KEYS letters)

const CANOPY = [
  '...FFgF....',
  '..FggGgF.F.',
  '.FgGGggFgF.',
  'FgGgggFggGF',
  'FggFgggFggF',
  '.FFFfgFFFf.',
  '...f.b.f...',
  '.....b.....',
];
const ROUND = ['..FgF..', '.FgGgF.', 'FgGggFF', 'FggFggF', '.FfgFf.', '..fbf..'];
const PINE = ['...F...', '..fFF..', '...F...', '..fFF..', '.fFFFF.', '..fFF..', '.fFFFF.', 'fFFFFFF'];
const MOSSY = ['..lGGl..', '.lGgGgl.', 'lGgBgGGl', 'l.lBBl.l', 'l..Bl..G', '...B....'];
const PALM = ['.GG...GG.', 'GggG.GggG', 'g..GgG..g', '...gbg...', '....b....'];

/** A tree: crown rows on a trunk of `trunk` px (a little root flare at the bottom). */
const treeCache = new Map<string, string[]>();
function tree(crown: string[], trunk: number, lean = 0) {
  const id = crown.join('|') + trunk + ':' + lean;
  let rows = treeCache.get(id);
  if (!rows) {
    const w = crown[0].length, mid = Math.floor(w / 2);
    rows = [...crown];
    for (let k = 0; k < trunk; k++) {
      const off = k < trunk / 2 ? lean : 0;
      const r = Array(w).fill('.');
      if (k === trunk - 1) { r[mid - 1] = 'B'; r[mid] = 'b'; r[mid + 1] = 'B'; }
      else r[clamp(mid + off, 0, w - 1)] = k % 3 === 1 ? 'B' : 'b';
      rows.push(r.join(''));
    }
    treeCache.set(id, rows);
  }
  return rows;
}

/** Tree for a slot: undefined = none. */
function treeFor(style: ZoneStyle, scenery: Scenery, ele: number, r: () => number): string[] | undefined {
  const p = r();
  switch (style) {
    case 'jungle':
      if (r() > 0.85) return undefined;
      if (ele < 600 && p < 0.15) return tree(PALM, 6 + Math.floor(r() * 4), r() < 0.5 ? -1 : 1);
      if (p < 0.3) return tree(CANOPY, 12 + Math.floor(r() * 6)); // emergent giants
      if (p < 0.75) return tree(CANOPY, 3 + Math.floor(r() * 4));
      return tree(ROUND, 2 + Math.floor(r() * 3));
    case 'forest':
      if (r() > 0.72) return undefined;
      if (scenery === 'alpine') return p < 0.85 ? tree(PINE, 1 + Math.floor(r() * 3)) : tree(ROUND, 3);
      return p < 0.6 ? tree(ROUND, 2 + Math.floor(r() * 4)) : tree(CANOPY, 3 + Math.floor(r() * 3));
    case 'mossy':
      if (r() > 0.6) return undefined;
      return tree(MOSSY, Math.floor(r() * 2));
    case 'meadow':
      if (r() > 0.16) return undefined;
      return tree(PINE, Math.floor(r() * 2));
    case 'plain':
      if (r() > 0.35) return undefined;
      return tree(ROUND, 2 + Math.floor(r() * 3));
    default:
      return undefined;
  }
}

/** Crown bumps on a skyline: height of the bump at column phase k (0..5) for a tree of size s. */
const BUMP_ROUND = [0, 1, 2, 2, 1, 0];
const BUMP_PINE = [0, 1, 3, 1, 0, 0];

/** Zoomed out, keep only some trees / props (each slot drops out at its own zoom, so they thin out smoothly). */
function keepAt(slot: number, zoom: number) {
  return zoom <= 1.3 || rng(slot * 7 + 1)() < 1.3 / zoom;
}

function ease(x: number) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

interface Prep {
  key: string;
  exag: number;
  /** Average walking speed, metres along the track per video second. */
  speed: number;
  styles: TrailZones;
  /** Terrain height (m) beside the route, smoothed, per track sample. */
  ridge: Float64Array;
  /** Whole-hike skyline (smoothed elevation), per track sample. */
  far: Float64Array;
  /** Camera height (m) per track sample, smoothed over about a screen width (keyed by sigma). */
  camEle: { sigma: number; ele: Float64Array } | null;
  tl: number;
}

export class SideScene {
  readonly canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private buf: Uint32Array;
  private W = 320;
  private H = 180;
  private data: SideData | null = null;
  private prep: Prep | null = null;
  /** Ground line (y of the top surface pixel) per screen column, this frame. */
  private gy = new Int16Array(0);

  constructor() {
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.img = this.ctx.createImageData(1, 1);
    this.buf = new Uint32Array(1);
    this.resize(320, 180);
  }

  resize(W: number, H: number) {
    this.W = W;
    this.H = H;
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx.imageSmoothingEnabled = false;
    this.img = this.ctx.createImageData(W, H);
    this.buf = new Uint32Array(this.img.data.buffer);
    this.gy = new Int16Array(W);
  }

  setData(data: SideData) {
    this.data = data;
    const { track, terrain, timeline, scenery } = data;
    const key = [track.n, track.stats.distance, terrain.size, timeline.moveSeconds, scenery].join('|');
    if (this.prep?.key === key && this.prepFor === track && this.prepTerrain === terrain) return;
    this.prepFor = track;
    this.prepTerrain = terrain;

    // exaggerate the relief, but keep the steepest sustained climbs under MAX_SLOPE on screen
    // (grade over ~400 m: what a screen's worth of trail looks like, not every steep step)
    const far = gaussian(track.ele, 300 / track.step);
    const lag = Math.max(1, Math.round(200 / track.step));
    const g: number[] = [];
    for (let i = lag; i < track.n - lag; i += lag) g.push(Math.abs(far[i + lag] - far[i - lag]) / (track.d[i + lag] - track.d[i - lag] || 1));
    g.sort((a, b) => a - b);
    const g98 = g[Math.floor(g.length * 0.98)] || 0.1;
    const exag = clamp(MAX_SLOPE / Math.max(0.05, g98), MIN_EXAG, MAX_EXAG);

    const tl = treeline(track.lat0);
    const bands: { at: number; style: ZoneStyle }[] = scenery === 'tropical'
      ? [{ at: 0, style: 'jungle' }, { at: 1000, style: 'forest' }, { at: 1500, style: 'mossy' }]
      : scenery === 'alpine'
        ? [{ at: 0, style: 'forest' }, { at: tl - 150, style: 'meadow' }, { at: tl + 450, style: 'rocky' }]
        : [{ at: 0, style: 'plain' }, { at: 1e6, style: 'meadow' }, { at: 2e6, style: 'rocky' }];
    const styles = buildZones(track, { on: true, technical: false, labels: false, bands });

    // the ridge behind: real terrain RIDGE_OFF to one side of the route (the higher side on average)
    const n = track.n;
    const side = (s: number) => {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        out[i] = terrain.heightAt(track.x[i] - track.hdz[i] * RIDGE_OFF * s, track.z[i] + track.hdx[i] * RIDGE_OFF * s);
      }
      return out;
    };
    const a = side(1), b = side(-1);
    let sa = 0, sb = 0;
    for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
    const ridge = gaussian(sa >= sb ? a : b, 250 / track.step);

    this.prep = {
      key, exag, styles, ridge, far, tl, camEle: null,
      speed: track.stats.distance / Math.max(1, timeline.moveSeconds),
    };
  }
  private prepFor: Track | null = null;
  private prepTerrain: Terrain | null = null;

  /** Metres per px along the track while walking (before any zoom). */
  private walkScale() {
    const p = this.prep!;
    const pxps = this.W < this.H ? PX_PER_S.tall : PX_PER_S.wide;
    return clamp(p.speed / pxps, 1.2, 160);
  }

  private camEle(mx: number) {
    const p = this.prep!, track = this.data!.track;
    const sigma = Math.round((this.W * mx * 0.45) / track.step);
    if (!p.camEle || p.camEle.sigma !== sigma) p.camEle = { sigma, ele: gaussian(track.ele, sigma) };
    return p.camEle.ele;
  }

  /** Ground height (m) for a screen column `mx` metres wide centred on track distance d. */
  private groundEle(d: number, mx: number) {
    const track = this.data!.track;
    if (mx <= track.step * 3) return sampleAt(track, track.ele, d);
    let m = -Infinity;
    for (let k = -2; k <= 2; k++) m = Math.max(m, sampleAt(track, track.ele, d + (k * mx) / 5));
    return m;
  }

  private surfaceAt(d: number): Surface {
    const runs = this.data!.surface?.runs;
    if (!runs?.length) return 'trail';
    let lo = 0, hi = runs.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (runs[m].d0 <= d) lo = m; else hi = m - 1;
    }
    return runs[lo].kind;
  }

  frame(f: SideFrameInput): SideFrame {
    const data = this.data!, p = this.prep!;
    const { track, timeline, checkpoints, scenery } = data;
    const { st, night } = f;
    const W = this.W, H = this.H, buf = this.buf, gy = this.gy;
    const L = track.stats.distance;
    const { minEle, maxEle } = track.stats;
    const range = Math.max(30, maxEle - minEle);
    const midEle = (minEle + maxEle) / 2;
    const eH = sampleAt(track, track.ele, st.d);

    // ---- camera: follow (walking scale, walker left of centre) ↔ overview (the whole level)
    let u = 1;
    if (f.snap || st.phase === 'gateStart') u = 0;
    else if (st.phase === 'intro') u = ease(clamp((st.introT - 0.9) / (timeline.intro - 0.9), 0, 1));
    else if (st.phase === 'outro') u = 1 - ease(clamp(st.outroU / 0.55, 0, 1));
    let mxF = this.walkScale();
    const myF0 = mxF / p.exag;
    // at a viewpoint, pull back for a wider look while you stand there
    if (st.phase === 'pause' && st.pauseCp?.kind === 'view') {
      const z = Math.sin(Math.PI * clamp(st.pauseU, 0, 1));
      mxF *= 1 + 1.4 * z * z;
    }
    const myF = myF0 * (mxF / this.walkScale());
    const mxO = L / (W * 0.9);
    const myO = Math.max(range / (H * 0.45), mxO / 8);
    const camE = sampleAt(track, this.camEle(this.walkScale()), st.d);
    const hxF = Math.round(W * (W < H ? 0.32 : 0.36));
    const hyF = clamp(Math.round(H * 0.6 - (eH - camE) / myF), Math.round(H * 0.32), Math.round(H * 0.78));
    const hxO = W / 2 + (st.d - L / 2) / mxO;
    const hyO = H * 0.6 - (eH - midEle) / myO;
    const mx = Math.exp(Math.log(mxO) + (Math.log(mxF) - Math.log(mxO)) * u);
    const my = Math.exp(Math.log(myO) + (Math.log(myF) - Math.log(myO)) * u);
    const hx = Math.round(hxO + (hxF - hxO) * u);
    const hy = Math.round(hyO + (hyF - hyO) * u);
    const zoom = mx / this.walkScale(); // 1 = walking scale

    // world pixel grid: columns / rows fixed to the world, so the ground scrolls in whole pixels
    const base = Math.round(st.d / mx);
    const vb = Math.round(eH / my);
    const dAt = (x: number) => (base + x - hx) * mx;
    const sx = (d: number) => hx + Math.round(d / mx) - base;
    const sy = (e: number) => hy + vb - Math.round(e / my);

    buf.fill(0); // sky: transparent, the post pass paints it

    // ---- far: the whole hike's skyline, slowly drifting (fades in as the camera reaches the walker)
    const layers = clamp((u - 0.35) / 0.4, 0, 1);
    const horizon = Math.round(H * 0.58);
    if (layers > 0) {
      const kf = Math.min(Math.max(W * 2.4, 480) / L, 0.22 / mx);
      // never taller than a quarter of its width, or a fast cut squeezes the summit into a needle
      const fh = Math.min(H * 0.26, L * kf * 0.25);
      const lift = clamp(((eH - midEle) / my) * 0.12, -H * 0.1, H * 0.1);
      const top = col(C.skyLight, night), body = col(C.sky, night);
      const snowLine = scenery === 'alpine' ? p.tl + 900 : Infinity;
      for (let x = 0; x < W; x++) {
        const df = st.d + (x - hx) / kf;
        const e = sampleAt(track, p.far, df);
        const y0 = Math.round(horizon + lift - ((e - minEle) / range) * fh);
        for (let y = Math.max(0, y0); y < H; y++) {
          if (dith(x, y) > layers) continue;
          buf[y * W + x] = y === y0 ? (e > snowLine ? col(C.white, night) : top) : body;
        }
      }
      // a tiny flag on the summit still to come
      for (const cp of checkpoints) {
        if (!cp.enabled || cp.kind !== 'summit' || cp.d < st.d + W * mx * 0.7) continue;
        const x = Math.round(hx + (cp.d - st.d) * kf);
        if (x < 1 || x > W - 3) continue;
        const e = sampleAt(track, p.far, cp.d);
        const y0 = Math.round(horizon + lift - ((e - minEle) / range) * fh);
        for (let k = 1; k <= 4; k++) if (y0 - k >= 0) buf[(y0 - k) * W + x] = col(C.ink2, night);
        for (const [ox, oy] of [[1, 4], [2, 4], [1, 3]]) if (y0 - oy >= 0) buf[(y0 - oy) * W + x + ox] = u32(C.red);
      }

      // ---- ridge: the real terrain beside the route, half speed, with tree crowns along the top
      const baseM = Math.round(st.d / mx / 2);
      for (let x = 0; x < W; x++) {
        const wx = baseM + x - hx;
        const dm = wx * mx * 2;
        const e = sampleAt(track, p.ridge, dm);
        const y0 = Math.round(hy - ((e - eH) / my) * 0.5 - H * 0.12);
        const alpine = scenery === 'alpine';
        const bare = alpine ? e > p.tl : false;
        const snow = alpine && e > p.tl + 700;
        const bodyHex = bare ? C.rockDark : alpine ? C.forest : scenery === 'tropical' ? C.moss : C.sage;
        const topHex = snow ? C.white : bare ? C.rock : alpine ? C.green : C.sage;
        // crowns: a tree every 6 columns (pines in the mountains), none above the treeline
        let bump = 0;
        if (!bare) {
          const k = ((wx % 6) + 6) % 6, t = Math.floor(wx / 6);
          const size = 1 + Math.floor(hash(t, 7) * 2.2);
          bump = Math.round(((alpine ? BUMP_PINE : BUMP_ROUND)[k] * size) / 2);
        }
        const yb = Math.max(0, y0 - bump);
        for (let y = yb; y < H; y++) {
          if (dith(x, y) > layers) continue;
          const crown = y < y0;
          buf[y * W + x] = col(crown ? (alpine ? C.forest : C.moss) : y === y0 && !bump ? topHex : bodyHex, night);
        }
      }
    }

    // ---- the trail's own ground, with a cut-through of soil and rock below
    const lampFrom = hx + 3, lampTo = hx + 66;
    let eMin = Infinity, eMax = -Infinity;
    const zoneAt: ZoneStyle[] = new Array(W);
    const snowLine = scenery === 'alpine' ? p.tl + 900 : Infinity;
    for (let x = 0; x < W; x++) {
      const wx = base + x - hx;
      const d = dAt(x);
      const e = this.groundEle(d, mx);
      eMin = Math.min(eMin, e); eMax = Math.max(eMax, e);
      const y0 = sy(e);
      gy[x] = y0;
      const style = p.styles.styleAt(clamp(d, 0, L));
      zoneAt[x] = style;
      const [topHex, bodyHex, soilHex] = GROUND[style];
      const surf = d < 0 || d > L ? 'trail' : this.surfaceAt(d);
      const snow = e > snowLine;
      const deep = style === 'rocky' ? DEEP_ROCK : DEEP;
      // overview: tree crowns as bumps on the ground line
      let bump = 0;
      if (zoom > TREE_ZOOM && style !== 'rocky' && style !== 'meadow' && !snow) {
        const k = ((wx % 6) + 6) % 6;
        if (hash(Math.floor(wx / 6), 3) < 0.7) bump = BUMP_ROUND[k];
      }
      const lampX = f.beam && x >= lampFrom && x <= lampTo ? 1 - (x - lampFrom) / (lampTo - lampFrom) : 0;
      for (let y = Math.max(0, y0 - bump); y < H; y++) {
        const k = y - y0;
        let hex: string;
        if (k < 0) hex = C.forest;
        else if (surf === 'road' && k <= 2) hex = k === 0 ? C.rock : (wx & 7) < 3 && k === 1 ? C.cream : C.ink2;
        else if (surf === 'track' && k <= 1) hex = k === 0 ? C.tan : hash(wx, 1) < 0.3 ? C.rock : C.brown;
        else if (k === 0) hex = snow ? C.white : topHex;
        else if (k === 1) hex = snow ? C.greyLight : surf === 'trail' && zoom < TREE_ZOOM ? C.tan : bodyHex;
        else if (k === 2) hex = snow ? C.greyLight : bodyHex;
        else if (k <= 5) hex = hash(wx, y) < 0.12 ? C.brownDark : soilHex;
        else {
          // calm horizontal strata lines (a little broken, sparser further down) and the odd stone
          const wy = vb + hy - y;
          const stratum = ((wy + ((wx >> 4) & 1)) % 8 + 8) % 8 === 0 && hash(wx >> 2, wy) > (k > 24 ? 0.6 : 0.25);
          const stone = hash(wx >> 1, wy >> 1) < 0.018;
          hex = stone ? deep.stone : stratum ? deep.line : deep.base;
        }
        // the head-lamp lights the ground just ahead of you
        const lit = lampX > 0 && k >= -3 && k <= 4 && dith(x, y) < lampX * 1.3;
        buf[y * W + x] = col(hex, night && !lit);
      }
    }

    // ---- valley mist: fills the air (and the far layers) below a line low in the view
    if (f.mist > 0.02 && u > 0.5) {
      const eM = eMin + Math.max(30, (eMax - eMin) * 0.4);
      const yM = sy(eM);
      const mc = u32(night ? C.dusk : C.skyPale);
      for (let x = 0; x < W; x++) {
        for (let y = Math.max(0, yM); y < gy[x] && y < H; y++) {
          // a fog bank: dithered at its top, nearly solid down in the valley (always see-through at night,
          // where a solid band of blue would read as a lake)
          const k = clamp((y - yM) / 10, 0, 1) * clamp(0.35 + f.mist, 0, night ? 0.4 : 1);
          if (dith(x + 1, y) < k) buf[y * W + x] = mc;
        }
      }
    }

    this.ctx.putImageData(this.img, 0, 0);
    const ctx = this.ctx;
    const ghy = gy[clamp(hx, 0, W - 1)];
    const gAt = (x: number) => (x >= 0 && x < W ? gy[x] : sy(this.groundEle(dAt(x), mx)));
    const keys = (x: number) => (night && !(f.beam && x >= hx - 4 && x <= lampTo) ? DECOR_KEYS.night : DECOR_KEYS.day);

    // ---- trees behind the trail
    // (placed in metres along the trail, so they hold still while the camera zooms)
    if (zoom <= TREE_ZOOM) {
      const slot = 9 * this.walkScale();
      const s0 = Math.floor(dAt(-14) / slot), s1 = Math.ceil(dAt(W + 14) / slot);
      for (let s = s0; s <= s1; s++) {
        if (!keepAt(s, zoom)) continue;
        const r = rng(s * 31 + 7);
        const d = (s + r() * 0.55) * slot;
        const x = sx(d);
        if (d < -200 || d > L + 200) continue;
        const e = this.groundEle(d, mx);
        if (e > snowLine) continue;
        const rows = treeFor(p.styles.styleAt(clamp(d, 0, L)), scenery, e, r);
        if (!rows) continue;
        drawSprite(ctx, rows, x, gAt(x) + 1, { keys: keys(x) });
      }
    }

    // ---- rivers: a gap in the ground with a little bridge over it (too small to show zoomed out)
    if (f.env.water && zoom <= TREE_ZOOM) {
      const ds: number[] = [];
      for (const c of [...f.crossings.map((c) => c.d), ...(f.sprites?.bridges ?? []).map((b) => b.d)]) {
        if (ds.every((v) => Math.abs(v - c) > 80)) ds.push(c);
      }
      for (const d of ds) {
        const x = sx(d);
        if (x < -12 || x > W + 12) continue;
        this.drawBridge(x, gAt(x), st.t, night);
      }
    }

    // ---- screen points for the overlay
    const cpScreen = new Map<string, ScreenPoint>();
    for (const cp of checkpoints) {
      const x = sx(cp.d);
      cpScreen.set(cp.id, { x, y: gAt(x), visible: x > -24 && x < W + 24 });
    }
    const hero = { x: hx, y: ghy, visible: !f.snap };
    const pet = { x: hx - 11, y: gAt(hx - 11), visible: !f.snap };

    const walking = (st.phase === 'move' || st.phase === 'pause') && !f.snap;
    const decor = walking && zoom <= TREE_ZOOM ? this.decorFrame(hx, base, zoom, dAt, gAt, sx, night, f.beam, lampTo) : null;
    const map = walking ? this.mapFrame(f, sx, dAt, gAt, night) : null;

    const wild: WildSprite[] = [];
    if (walking) {
      for (const e of f.wild) {
        if (e.species.kind !== 'ground') continue;
        const x = sx(e.d);
        if (x < -20 || x > W + 20) continue;
        const pose = groundPose(e, st.d - e.d, st.t, { x, y: gAt(x) - 1 }, { x: e.side, y: 0 }, 1);
        if (pose) wild.push(pose);
      }
    }

    return { hero, pet, cpScreen, decor, map, wild, horizon, scroll: base };
  }

  private drawBridge(x: number, y: number, t: number, night: boolean) {
    const ctx = this.ctx;
    const hw = 7;
    const water = night ? [C.night, C.dusk] : [C.sky, C.skyLight];
    // the river below the deck
    for (let xx = -hw; xx <= hw; xx++) {
      for (let yy = 1; yy <= 6; yy++) {
        const glint = ((xx + Math.floor(t * 8) + yy * 3) % 7 + 7) % 7 === 0 && yy === 2;
        ctx.fillStyle = glint ? (night ? C.skyLight : C.white) : yy < 3 ? water[1] : water[0];
        ctx.fillRect(x + xx, y + yy, 1, 1);
      }
    }
    ctx.fillStyle = night ? C.ink2 : C.rockDark;
    ctx.fillRect(x - hw - 1, y + 1, 1, 6);
    ctx.fillRect(x + hw + 1, y + 1, 1, 6);
    // deck, posts and a rail
    ctx.fillStyle = night ? C.brownDark : C.brown;
    ctx.fillRect(x - hw - 2, y, hw * 2 + 5, 1);
    ctx.fillStyle = night ? C.ink2 : C.brownDark;
    ctx.fillRect(x - hw - 2, y + 1, hw * 2 + 5, 1);
    for (let xx = -hw - 2; xx <= hw + 2; xx += 3) ctx.fillRect(x + xx, y - 3, 1, 3);
    ctx.fillStyle = night ? C.brownDark : C.tan;
    ctx.fillRect(x - hw - 2, y - 3, hw * 2 + 5, 1);
  }

  /** Trail-side props by zone (in front of the ground line), plus ropes / warning signs on steep bits. */
  private decorFrame(
    hx: number, base: number, zoom: number, dAt: (x: number) => number,
    gAt: (x: number) => number, sx: (d: number) => number, night: boolean, beam: boolean, lampTo: number,
  ): DecorFrame {
    const p = this.prep!, data = this.data!;
    const L = data.track.stats.distance;
    const W = this.W;
    const items: DecorItem[] = [];
    const slot = 7 * this.walkScale();
    const s0 = Math.floor(dAt(-10) / slot), s1 = Math.ceil(dAt(W + 10) / slot);
    for (let s = s0; s <= s1; s++) {
      if (!keepAt(s + 5000, zoom)) continue;
      const r = rng(s * 17 + 3);
      const d = (s + r() * 0.8) * slot;
      const x = sx(d);
      if (Math.abs(x - hx) < 8) continue; // keep the walker readable
      if (d < 0 || d > L) continue;
      const style = p.styles.styleAt(d);
      if (r() > decorDensity(style) * 0.42) continue;
      const rows = decorSprite(style, r(), false);
      if (!rows) continue;
      items.push({ x, y: gAt(x) + 2, rows, lit: !night || (beam && x >= hx - 4 && x <= lampTo) });
    }
    const ropes: DecorFrame['ropes'] = [];
    const signs: DecorItem[] = [];
    const z = data.zones;
    if (z?.settings.on && z.settings.technical) {
      for (const run of z.tech) {
        const a = sx(run.d0), b = sx(run.d1);
        if (b < -4 || a > W + 4) continue;
        const line: { x: number; y: number }[] = [];
        for (let x = Math.max(-2, a); x <= Math.min(W + 2, b); x += 3) line.push({ x, y: gAt(x) });
        if (line.length > 1) ropes.push(line);
        if (a >= 0 && a < W && run.d1 - run.d0 >= 150) signs.push({ x: a - 4, y: gAt(a - 4), rows: [], lit: true });
        for (let x = Math.max(0, a); x <= Math.min(W - 1, b); x += 5) {
          // roots and rock steps on the trail itself
          items.push({ x, y: gAt(x) + 1, rows: techSprite(rng(x + base)()), lit: true });
        }
      }
    }
    return { items, ropes, signs };
  }

  /** Street lights and traffic on roads, camps / springs / waterfalls beside the trail. */
  private mapFrame(
    f: SideFrameInput, sx: (d: number) => number, dAt: (x: number) => number, gAt: (x: number) => number, night: boolean,
  ): MapFrame {
    const data = this.data!;
    const W = this.W;
    const out: MapFrame = { lamps: [], rapids: [], bridges: [], vehicles: [], falls: [], sideFalls: [], camps: [], springs: [] };
    const spot = (x: number, y: number) => ({ x, y, q: 0.7, a: 1, far: false });
    const runs = data.surface?.runs ?? [];
    if (f.env.water) {
      const COLORS = [C.red, C.sky, C.white, C.yellow, C.greenLight, C.orange];
      runs.forEach((run, i) => {
        if (run.kind !== 'road') return;
        const a = Math.max(-8, sx(run.d0)), b = Math.min(W + 8, sx(run.d1));
        if (b - a < 6) return;
        if (night) {
          // one every ~36 px at walking scale, fixed to the road
          const gap = 36 * this.walkScale();
          for (let x = a + 1; x <= b; x++) if (Math.floor(dAt(x) / gap) !== Math.floor(dAt(x - 1) / gap)) out.lamps.push(spot(x, gAt(x)));
        }
        if (b - a < 40) return;
        const r = rng(i * 13 + 5);
        const left = r() < 0.5;
        const span = b - a;
        const pos = (r() * span + f.st.t * (20 + r() * 14)) % span;
        const x = Math.round(left ? b - pos : a + pos);
        out.vehicles.push({ x, y: gAt(x), a: 1, far: false, left, moto: r() < 0.4, color: COLORS[Math.floor(r() * COLORS.length)] });
      });
    }
    if (f.env.landmarks && f.sprites) {
      for (const p of f.sprites.pois) {
        if (p.kind === 'waterfall') {
          const d = p.d ?? (p.near.off < 2500 ? p.near.d : null);
          if (d == null) continue;
          const x = sx(d);
          if (x < -30 || x > W + 30) continue;
          // off the route: a sign at the trail and the falls behind it; on it: just the falls
          if (p.d == null) out.sideFalls.push({ ...spot(x + 22, gAt(x + 22) - 3), sx: x + 6, sy: gAt(x + 6), left: false, sprite: true });
          else out.falls.push({ ...spot(x + 20, gAt(x + 20) - 2), q: 1 });
        } else if (p.d != null && (p.kind === 'camp' || p.kind === 'spring')) {
          if (p.kind === 'camp' && data.checkpoints.some((c) => c.enabled && c.kind !== 'start' && Math.abs(c.d - p.d!) < 300)) continue;
          const x = sx(p.d);
          if (x < -16 || x > W + 16) continue;
          (p.kind === 'camp' ? out.camps : out.springs).push(spot(x, gAt(x)));
        }
      }
    }
    return out;
  }
}
