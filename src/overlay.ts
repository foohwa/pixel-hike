import { drawText, textWidth } from './font';
import { C } from './palette';
import type { SkyState } from './sky';
import { drawFlag, drawSprite, HEART, HIKER_FRAMES, AVATAR_KEYS, MOON, MOUNTAIN, SUN, TENT } from './sprites';
import type { Timeline, TimelineState } from './timeline';
import { clamp, sampleAt, type Checkpoint, type Track } from './track';

export interface ScreenPoint { x: number; y: number; visible: boolean }

export interface OverlayInput {
  ctx: CanvasRenderingContext2D;
  W: number;
  H: number;
  track: Track;
  checkpoints: Checkpoint[];
  timeline: Timeline;
  state: TimelineState;
  sky: SkyState;
  title: string;
  tzOffsetMin: number;
  hiker: ScreenPoint;
  facingLeft: boolean;
  /** Screen position of each enabled checkpoint. */
  cpScreen: Map<string, ScreenPoint>;
  showMinimap: boolean;
}

const FLAG_COLOR: Record<Checkpoint['kind'], string> = {
  start: C.greenLight,
  summit: C.red,
  peak: C.yellow,
  rest: C.orange,
  finish: C.white,
};

export function drawOverlay(o: OverlayInput) {
  const { ctx, W, H } = o;
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;

  drawWorldSprites(o);
  drawHud(o);
  drawBanner(o);
  drawTitleCard(o);
  drawOutroCard(o);
}

// ---------------------------------------------------------------- world sprites

function drawWorldSprites(o: OverlayInput) {
  const { ctx, state, timeline } = o;
  const t = state.t;

  // flags behind the hiker
  for (const cp of o.checkpoints) {
    if (!cp.enabled) continue;
    const p = o.cpScreen.get(cp.id);
    if (!p || !p.visible) continue;
    const reachT = timeline.reachTimes.get(cp.id);
    const reached = reachT != null && t >= reachT && state.phase !== 'intro' ? true : cp.kind === 'start';
    if (cp.kind === 'rest') {
      drawSprite(ctx, TENT, p.x, p.y);
      continue;
    }
    const raise = reached ? clamp((t - (reachT ?? 0)) / 0.5, 0, 1) : 0;
    drawFlag(ctx, p.x, p.y, reached ? FLAG_COLOR[cp.kind] : C.rock, cp.kind === 'start' ? 1 : raise, t * 7, cp.kind === 'finish' && reached);
  }

  // hiker
  const h = o.hiker;
  if (!h.visible) return;
  let frame: string[];
  let jump = 0;
  const pauseKind = state.pauseCp?.kind;
  if (state.phase === 'pause' && pauseKind === 'rest') frame = HIKER_FRAMES.sit;
  else if (state.phase === 'pause' || state.phase === 'outro') {
    const beat = Math.floor(t * 5) % 2 === 0;
    frame = beat ? HIKER_FRAMES.cheer : HIKER_FRAMES.stand;
    jump = beat ? 2 : 0;
  } else if (state.phase === 'intro') frame = HIKER_FRAMES.stand;
  else frame = [HIKER_FRAMES.walk1, HIKER_FRAMES.stand, HIKER_FRAMES.walk2, HIKER_FRAMES.stand][Math.floor(t * 8) % 4];

  // shadow
  ctx.fillStyle = C.ink;
  ctx.fillRect(Math.round(h.x) - 4, Math.round(h.y) - 1, 9, 2);
  drawSprite(ctx, frame, h.x, h.y - jump, { keys: AVATAR_KEYS, flip: o.facingLeft });

  // headlamp sparkle at night
  if (o.sky.lamp > 0.5 && state.phase !== 'outro') {
    ctx.fillStyle = Math.floor(t * 4) % 2 ? C.cream : C.yellow;
    ctx.fillRect(Math.round(h.x) + (o.facingLeft ? -1 : 0), Math.round(h.y) - 14 - jump, 1, 1);
  }

  // zZz while resting
  if (state.phase === 'pause' && pauseKind === 'rest') {
    const u = state.pauseU;
    for (let k = 0; k < 2; k++) {
      const uu = (u * 1.5 + k / 2) % 1;
      if (uu > 0.85) continue;
      drawText(ctx, 'Z', h.x + 6 + uu * 8, h.y - 16 - uu * 16, C.white, { shadow: C.ink });
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

function clockText(ms: number, tzOffsetMin: number) {
  const d = new Date(ms + tzOffsetMin * 60000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function drawHud(o: OverlayInput) {
  const { ctx, W, track, state, sky } = o;
  if (state.phase === 'intro' && state.t < o.timeline.intro - 0.5) return;
  const d = state.d;
  const ele = sampleAt(track, track.ele, d);
  const time = sampleAt(track, track.time, d);
  const hr = sampleAt(track, track.hr, d);

  // top-left: distance + elevation
  const distStr = `${(d / 1000).toFixed(1)} KM`;
  const eleStr = `${fmtInt(ele)} M`;
  const lw = Math.max(textWidth(distStr), textWidth(eleStr) + 10) + 8;
  panel(ctx, 4, 4, lw, 22);
  drawText(ctx, distStr, 8, 7, C.yellow);
  drawSprite(ctx, MOUNTAIN, 8, 16, { anchor: 'topleft' });
  drawText(ctx, eleStr, 18, 16, C.white);

  // top-right: clock + heart rate
  const clock = clockText(time, o.tzOffsetMin);
  const hrStr = Number.isFinite(hr) ? String(Math.round(hr)) : '';
  const rw = Math.max(textWidth(clock), textWidth(hrStr)) + 20;
  const rh = hrStr ? 22 : 13;
  panel(ctx, W - 4 - rw, 4, rw, rh);
  drawSprite(ctx, sky.isNight ? MOON : SUN, W - rw + 1, 7, { anchor: 'topleft' });
  drawText(ctx, clock, W - 8, 7, C.white, { align: 'right' });
  if (hrStr) {
    const beat = (state.t * hr) / 60;
    const big = beat - Math.floor(beat) < 0.22;
    drawSprite(ctx, HEART, W - rw + 1 + (big ? 0 : 0), 16 + (big ? 0 : 1), { anchor: 'topleft' });
    drawText(ctx, hrStr, W - 8, 16, big ? C.pink : C.white, { align: 'right' });
  }

  if (o.showMinimap) drawMinimap(o, W - 4 - 42, 4 + rh + 3, 42);
  drawProfile(o);
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
  const { minEle, maxEle, distance } = track.stats;
  const range = Math.max(1, maxEle - minEle);
  const cur = Math.round((state.d / distance) * (iw - 1));
  for (let c = 0; c < iw; c++) {
    const hgt = 1 + Math.round(((cache.cols[c] - minEle) / range) * (ph - 3));
    const x = x0 + 2 + c;
    const yb = y0 + 1 + ph;
    ctx.fillStyle = c <= cur ? C.green : C.rockDark;
    ctx.fillRect(x, yb - hgt, 1, hgt);
    ctx.fillStyle = c <= cur ? C.lime : C.rock;
    ctx.fillRect(x, yb - hgt, 1, 1);
  }
  // checkpoint ticks
  for (const cp of o.checkpoints) {
    if (!cp.enabled || cp.kind === 'start') continue;
    const c = Math.round((cp.d / distance) * (iw - 1));
    const hgt = 1 + Math.round(((cache.cols[Math.min(iw - 1, c)] - minEle) / range) * (ph - 3));
    const x = x0 + 2 + c, y = y0 + 1 + ph - hgt;
    ctx.fillStyle = FLAG_COLOR[cp.kind];
    if (cp.kind === 'finish') ctx.fillStyle = C.white;
    ctx.fillRect(x, y - 4, 1, 4);
    ctx.fillRect(x + 1, y - 4, 2, 2);
  }
  // current marker
  const hgt = 1 + Math.round(((cache.cols[Math.min(iw - 1, Math.max(0, cur))] - minEle) / range) * (ph - 3));
  const mx = x0 + 2 + cur, my = y0 + 1 + ph - hgt;
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
    const ox = x0Center(b.minX, b.maxX, span, inner);
    const oz = x0Center(b.minZ, b.maxZ, span, inner);
    const pts: number[] = [];
    let lx = -999, lz = -999;
    for (let i = 0; i < track.n; i++) {
      const px = Math.round(((track.x[i] - b.minX) / span) * inner + ox);
      const pz = Math.round(((track.z[i] - b.minZ) / span) * inner + oz);
      if (px === lx && pz === lz) continue;
      pts.push(px, pz, i);
      lx = px; lz = pz;
    }
    cache = { size, pts: Int16Array.from(pts.map((v, k) => (k % 3 === 2 ? Math.min(32767, Math.round((v / track.n) * 32767)) : v))) };
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

function x0Center(min: number, max: number, span: number, inner: number) {
  return ((1 - (max - min) / span) * inner) / 2;
}

// ---------------------------------------------------------------- banners / cards

function drawBanner(o: OverlayInput) {
  const { ctx, W, H, state, track } = o;
  const lr = state.lastReached;
  if (!lr || lr.cp.kind === 'start') return;
  const age = state.t - lr.t;
  if (age < 0 || age > (state.phase === 'pause' ? 99 : 0.35) || state.phase === 'outro') return;
  const cp = lr.cp;
  const exclaim = cp.kind === 'summit' || cp.kind === 'finish';
  let title = cp.name.toUpperCase() + (exclaim && !cp.name.endsWith('!') ? '!' : '');
  const time = clockText(cp.time, o.tzOffsetMin);
  const sub =
    cp.kind === 'rest'
      ? `${cp.restMin ?? ''} MIN BREAK  ${time}`
      : cp.kind === 'finish'
        ? `${(track.stats.distance / 1000).toFixed(1)} KM  ${time}`
        : `${fmtInt(cp.ele)} M  ${time}`;
  let scale = 2;
  if (textWidth(title, 2) > W - 24) scale = 1;
  if (textWidth(title, 1) > W - 16) title = title.slice(0, Math.floor((W - 16) / 6));
  const bw = Math.max(textWidth(title, scale), textWidth(sub)) + 16;
  const bh = 7 * scale + 7 + 12;
  const drop = easeOutBack(clamp(age * 4, 0, 1));
  const top = H > W ? 84 : 30; // portrait: clear the minimap
  const y = Math.round(top - (1 - drop) * (top + 20));
  const x = Math.round(W / 2 - bw / 2);
  panel(ctx, x, y, bw, bh, C.cream, C.ink);
  ctx.fillStyle = FLAG_COLOR[cp.kind] === C.white ? C.ink : FLAG_COLOR[cp.kind];
  ctx.fillRect(x + 2, y + 2, bw - 4, 2);
  drawText(ctx, title, W / 2, y + 6, C.ink, { scale, align: 'center' });
  drawText(ctx, sub, W / 2, y + 7 * scale + 9, C.wine, { align: 'center' });
}

function drawTitleCard(o: OverlayInput) {
  const { ctx, W, H, state, track } = o;
  const end = o.timeline.intro - 0.6;
  if (state.t > end) return;
  const slide = clamp((state.t - (end - 0.3)) / 0.3, 0, 1);
  const date = new Date(track.stats.startTime + o.tzOffsetMin * 60000);
  const dateStr = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  const statStr = `${(track.stats.distance / 1000).toFixed(1)} KM  ^${fmtInt(track.stats.ascent)} M`;
  let title = o.title.toUpperCase();
  let scale = 2;
  if (textWidth(title, 2) > W - 28) scale = 1;
  if (textWidth(title, 1) > W - 20) title = title.slice(0, Math.floor((W - 20) / 6));
  const bw = Math.max(textWidth(title, scale), textWidth(dateStr), textWidth(statStr)) + 20;
  const bh = 7 * scale + 32;
  const x = Math.round(W / 2 - bw / 2);
  const y = Math.round(H / 2 - bh / 2 - 10 - slide * (H / 2 + bh));
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
  const hours = Math.floor(s.duration / 3600000);
  const mins = Math.round((s.duration % 3600000) / 60000);
  const rows: [string, string][] = [
    ['DISTANCE', `${(s.distance / 1000).toFixed(1)} KM`],
    ['TIME', hours ? `${hours}H ${String(mins).padStart(2, '0')}M` : `${mins} MIN`],
    ['ASCENT', `${fmtInt(s.ascent)} M`],
    ['HIGHEST', `${fmtInt(s.maxEle)} M`],
  ];
  if (s.avgHr) rows.push(['AVG HR', `${Math.round(s.avgHr)} BPM`]);
  const header = 'HIKE COMPLETE!';
  const labelW = 9 * 6;
  const valW = Math.max(...rows.map((r) => textWidth(r[1])));
  const bw = Math.max(textWidth(header), labelW + valW) + 16;
  const bh = 16 + rows.length * 10 + 4;
  const u = easeOutBack(clamp((state.outroU - 0.2) * 3, 0, 1));
  const x = Math.round(W / 2 - bw / 2);
  const y = Math.round(H / 2 - bh / 2 - 8 + (1 - u) * (H / 2 + bh));
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
