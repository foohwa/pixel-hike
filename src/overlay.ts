import { frameOf, type Anim, type SpriteSet } from './characters';
import { drawText, textWidth } from './font';
import { C, PALETTE, rgb01 } from './palette';
import type { SkyState } from './sky';
import { AID, CAMPFIRE, drawFlag, drawMoon, drawSprite, HEART, MOON, MOUNTAIN, STOPWATCH, SUN, TENT, THERMO } from './sprites';
import type { Timeline, TimelineState } from './timeline';
import { clamp, sampleAt, type Activity, type Checkpoint, type Track } from './track';

export interface ScreenPoint { x: number; y: number; visible: boolean }

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

  drawWorldSprites(o);
  drawHud(o);
  drawToasts(o);
  drawBanner(o);
  drawTitleCard(o);
  drawOutroCard(o);
}

// ---------------------------------------------------------------- animation choice

/** Picks the animation for the current moment (shared by the hero and the companion). */
export function pickAnim(o: Pick<OverlayInput, 'state' | 'track' | 'activity' | 'sky'>): Anim {
  const { state, track } = o;
  if (state.phase === 'intro') return 'idle';
  if (state.phase === 'outro') return 'cheer';
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

function drawWorldSprites(o: OverlayInput) {
  const { ctx, state, timeline } = o;
  const t = state.t;

  for (const cp of o.checkpoints) {
    if (!cp.enabled) continue;
    const p = o.cpScreen.get(cp.id);
    if (!p || !p.visible) continue;
    const reachT = timeline.reachTimes.get(cp.id);
    const reached = cp.kind === 'start' || (reachT != null && t >= reachT && state.phase !== 'intro');
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
        drawSprite(ctx, AID, p.x + 15, p.y);
        break;
      default: {
        const raise = cp.kind === 'start' ? 1 : reached ? clamp((t - (reachT ?? 0)) / 0.5, 0, 1) : 0;
        drawFlag(ctx, p.x, p.y, reached ? KIND_COLOR[cp.kind] : C.rock, raise, t * 7, cp.kind === 'finish' && reached);
      }
    }
  }

  const anim = pickAnim(o);

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
  if (state.phase === 'intro' && state.t < o.timeline.intro - 0.5) return;
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
    const y0 = W < H ? H - 4 - 18 - 18 : 30;
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
  for (let c = 0; c < iw; c++) {
    const hgt = hAt(c);
    const x = x0 + 2 + c;
    const yb = y0 + 1 + ph;
    ctx.fillStyle = c <= cur ? C.green : C.rockDark;
    ctx.fillRect(x, yb - hgt, 1, hgt);
    ctx.fillStyle = c <= cur ? C.lime : C.rock;
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
  if (age < 0 || age > (state.phase === 'pause' ? 99 : 0.35) || state.phase === 'outro') return;
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
  let scale = 2;
  if (textWidth(title, 2) > W - 24) scale = 1;
  if (textWidth(title, 1) > W - 16) title = title.slice(0, Math.floor((W - 16) / 6));
  const bw = Math.max(textWidth(title, scale), textWidth(sub)) + 16;
  const bh = 7 * scale + 7 + 12;
  const drop = easeOutBack(clamp(age * 4, 0, 1));
  const top = H > W ? 84 : 44; // keep clear of the dial / minimap
  const y = Math.round(top - (1 - drop) * (top + 20));
  const x = Math.round(W / 2 - bw / 2);
  panel(ctx, x, y, bw, bh, C.cream, C.ink);
  ctx.fillStyle = KIND_COLOR[cp.kind] === C.white ? C.ink : KIND_COLOR[cp.kind];
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
  const statStr = `${((track.stats.distance * track.distScale) / 1000).toFixed(1)} KM  ^${fmtInt(track.stats.ascent)} M`;
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
  const km = (s.distance * track.distScale) / 1000;
  const run = o.activity === 'trailrun';
  const rows: [string, string][] = [['DISTANCE', `${km.toFixed(1)} KM`]];
  if (run) {
    rows.push(['TIME', elapsedText(s.duration)]);
    rows.push(['AVG PACE', `${paceText(s.duration / 1000 / km)}/KM`]);
  } else rows.push(['TIME', elapsedText(s.duration, false)]);
  rows.push(['ASCENT', `${fmtInt(s.ascent)} M`]);
  if (!run) rows.push(['HIGHEST', `${fmtInt(s.maxEle)} M`]);
  const camps = o.checkpoints.filter((c) => c.enabled && c.kind === 'camp').length;
  if (o.activity === 'camphike' && camps) rows.push(['NIGHTS', String(camps)]);
  if (s.avgHr) rows.push(['AVG HR', `${Math.round(s.avgHr)} BPM`]);
  if (s.calories && rows.length < 7) rows.push(['CALORIES', `${fmtInt(s.calories)}`]);
  const header = run ? 'FINISHER!' : o.activity === 'camphike' ? 'TRIP COMPLETE!' : 'HIKE COMPLETE!';
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
