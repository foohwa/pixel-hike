import { frameOf, type SpriteSet } from './characters';
import { drawText, textWidth } from './font';
import type { LogoSet } from './logo';
import { KIND_COLOR } from './overlay';
import { C } from './palette';
import type { PixelRenderer } from './renderer';
import { sunPosition } from './sky';
import { drawFlag } from './sprites';
import { ACTIVITY_LABEL, clamp, sampleAt, type Activity, type Checkpoint, type Track } from './track';

/**
 * A still "level map" poster of the whole hike, 216×270 game pixels (4:5, ×5 = 1080×1350 for
 * Instagram): title + date, the route on the diorama (or map) with its checkpoints, the stats, your
 * photos as little polaroids, the elevation profile, and the character cheering.
 */
export const POSTER_W = 216;
export const POSTER_H = 270;

export interface PosterInput {
  renderer: PixelRenderer;
  track: Track;
  checkpoints: Checkpoint[];
  title: string;
  activity: Activity;
  tzOffsetMin: number;
  hero: SpriteSet;
  logo: LogoSet | null;
  /** Small pixel versions of up to 4 photos. */
  photos: HTMLCanvasElement[];
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string, border: string) {
  ctx.fillStyle = border;
  ctx.fillRect(x + 1, y, w - 2, h);
  ctx.fillRect(x, y + 1, w, h - 2);
  ctx.fillStyle = fill;
  ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
}

/** A good time of day to light the diorama: the sun ~40° up, during the hike if it was ever light. */
function posterLight(track: Track) {
  const { startTime, endTime } = track.stats;
  const score = (ms: number) => -Math.abs((sunPosition(ms, track.lat0, track.lon0).elevation * 180) / Math.PI - 40);
  let best = startTime, bs = -Infinity;
  for (let ms = startTime; ms <= endTime; ms += 20 * 60000) {
    const s = score(ms);
    if (s > bs) { bs = s; best = ms; }
  }
  if (bs < -25) {
    // never really light while you were out (a night run): use the next morning
    for (let ms = startTime; ms <= startTime + 30 * 3600_000; ms += 20 * 60000) {
      const s = score(ms);
      if (s > bs) { bs = s; best = ms; }
    }
  }
  return best;
}

export function drawPoster(p: PosterInput): HTMLCanvasElement | null {
  const { track } = p;
  const c = document.createElement('canvas');
  c.width = POSTER_W;
  c.height = POSTER_H;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const W = POSTER_W, H = POSTER_H;

  // paper: dark ink with a double pixel frame
  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.night;
  ctx.fillRect(3, 3, W - 6, 1); ctx.fillRect(3, H - 4, W - 6, 1); ctx.fillRect(3, 3, 1, H - 6); ctx.fillRect(W - 4, 3, 1, H - 6);
  ctx.fillStyle = C.coral;
  for (const [x, y] of [[3, 3], [W - 4, 3], [3, H - 4], [W - 4, H - 4]]) ctx.fillRect(x - 1, y - 1, 3, 3);

  // title + date line
  let title = (p.title || 'MY HIKE').toUpperCase();
  let scale = 2;
  if (textWidth(title, 2) > W - 20) scale = 1;
  while (textWidth(title, scale) > W - 16) title = title.slice(0, -1);
  drawText(ctx, title, W / 2, scale === 2 ? 10 : 13, C.yellow, { scale, align: 'center', shadow: C.red });
  const date = new Date(track.stats.startTime + p.tzOffsetMin * 60000);
  const sub = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}  -  ${ACTIVITY_LABEL[p.activity].toUpperCase()}`;
  drawText(ctx, sub, W / 2, 28, C.skyLight, { align: 'center' });

  // the map
  const photos = p.photos.slice(0, 4);
  const mx = 8, my = 39, mw = W - 16, mh = photos.length ? 96 : 132;
  const snap = p.renderer.snapshot(mw, mh, posterLight(track));
  if (!snap) return null;
  ctx.fillStyle = C.cream;
  ctx.fillRect(mx - 1, my - 1, mw + 2, mh + 2);
  ctx.drawImage(snap.image, mx, my);
  // checkpoint flags (start/finish too), summit name tags
  const cps = p.checkpoints.filter((cp) => cp.enabled).sort((a, b) => b.d - a.d);
  for (const cp of cps) {
    const pt = snap.points.get(cp.id);
    if (!pt?.visible || pt.x < 2 || pt.x > mw - 2 || pt.y < 16 || pt.y > mh) continue;
    drawFlag(ctx, mx + pt.x, my + pt.y, KIND_COLOR[cp.kind], 1, cp.d * 0.01, cp.kind === 'finish');
  }
  const top = p.checkpoints.filter((cp) => cp.enabled && cp.kind === 'summit')[0];
  const tp = top && snap.points.get(top.id);
  if (top && tp?.visible) {
    let name = top.name.toUpperCase();
    while (name.length > 4 && textWidth(name) > 90) name = name.slice(0, -1);
    const label = `${name} ${Math.round(top.ele).toLocaleString('en-US')}M`;
    const lw = textWidth(label) + 6;
    const lx = clamp(mx + tp.x - lw / 2, mx + 2, mx + mw - lw - 2), ly = clamp(my + tp.y - 29, my + 2, my + mh - 12);
    box(ctx, Math.round(lx), Math.round(ly), lw, 11, C.cream, C.ink);
    drawText(ctx, label, Math.round(lx) + 3, Math.round(ly) + 2, C.wine);
  }

  // stats: 3 × 2 tiles
  const s = track.stats;
  const km = (s.distance * track.distScale) / 1000;
  const h = Math.floor(s.duration / 3600_000), m = Math.round((s.duration % 3600_000) / 60_000);
  const tiles: [string, string][] = [
    ['DISTANCE', `${km.toFixed(1)} KM`],
    ['TIME', `${h}H ${String(m).padStart(2, '0')}M`],
    ['ELEV GAIN', `${Math.round(s.ascent).toLocaleString('en-US')} M`],
    ['HIGHEST', `${Math.round(s.maxEle).toLocaleString('en-US')} M`],
  ];
  if (s.avgHr) tiles.push(['AVG HR', `${Math.round(s.avgHr)} BPM`]);
  const camps = p.checkpoints.filter((cp) => cp.enabled && cp.kind === 'camp').length;
  if (p.activity === 'camphike' && camps) tiles.push(['NIGHTS', String(camps)]);
  else if (s.calories) tiles.push(['CALORIES', Math.round(s.calories).toLocaleString('en-US')]);
  else if (p.activity === 'trailrun') tiles.push(['AVG PACE', `${Math.floor(s.duration / 1000 / km / 60)}:${String(Math.round((s.duration / 1000 / km) % 60)).padStart(2, '0')}/KM`]);
  while (tiles.length < 6) tiles.push(['STOPS', String(p.checkpoints.filter((cp) => cp.enabled && cp.kind !== 'start' && cp.kind !== 'finish').length)]);
  let y = my + mh + 5;
  const tw = Math.floor((mw - 8) / 3);
  tiles.slice(0, 6).forEach(([k, v], i) => {
    const x = mx + (i % 3) * (tw + 4), yy = y + Math.floor(i / 3) * 20;
    box(ctx, x, yy, tw, 18, C.ink2, C.night);
    drawText(ctx, k, x + 3, yy + 2, C.rock);
    let val = v;
    while (val.length > 3 && textWidth(val) > tw - 6) val = val.slice(0, -1);
    drawText(ctx, val, x + tw - 3, yy + 10, C.yellow, { align: 'right' });
  });
  y += 40 + 4;

  // photos: little taped polaroids
  if (photos.length) {
    const pw = Math.floor((mw - (photos.length - 1) * 6) / photos.length);
    photos.forEach((ph, i) => {
      const sc = Math.min((pw - 4) / ph.width, 26 / ph.height, 1);
      const iw = Math.round(ph.width * sc), ih = Math.round(ph.height * sc);
      const cx = mx + i * (pw + 6) + Math.round((pw - iw - 4) / 2);
      const cy = y + 2 + (i % 2);
      ctx.fillStyle = C.ink2;
      ctx.fillRect(cx + 1, cy + 1, iw + 4, ih + 7);
      box(ctx, cx, cy, iw + 4, ih + 7, C.white, C.greyLight);
      ctx.drawImage(ph, cx + 2, cy + 2, iw, ih);
      ctx.fillStyle = C.cream;
      ctx.fillRect(cx + Math.round(iw / 2) - 2, cy - 1, 8, 2);
    });
    y += 38;
  }

  // elevation profile
  const ph = 22;
  box(ctx, mx, y, mw, ph, C.ink2, C.night);
  const iw = mw - 4;
  const { minEle, maxEle, distance } = s;
  const range = Math.max(1, maxEle - minEle);
  const hAt = (col: number) => 1 + Math.round(((sampleAt(track, track.ele, (col / (iw - 1)) * distance) - minEle) / range) * (ph - 9));
  for (let col = 0; col < iw; col++) {
    const hh = hAt(col);
    ctx.fillStyle = C.green;
    ctx.fillRect(mx + 2 + col, y + ph - 2 - hh, 1, hh);
    ctx.fillStyle = C.lime;
    ctx.fillRect(mx + 2 + col, y + ph - 2 - hh, 1, 1);
  }
  for (const cp of p.checkpoints) {
    if (!cp.enabled || cp.kind === 'start') continue;
    const col = Math.round((cp.d / distance) * (iw - 1));
    const x = mx + 2 + col, yy = y + ph - 2 - hAt(col);
    ctx.fillStyle = KIND_COLOR[cp.kind];
    ctx.fillRect(x, yy - 4, 1, 4);
    ctx.fillRect(x + 1, yy - 4, 2, 2);
  }
  y += ph + 4;

  // footer: the character cheering, the app name, the event logo
  const fy = H - 8;
  ctx.drawImage(frameOf(p.hero, 'cheer', 0.3, false), mx, fy - 16);
  drawText(ctx, 'PIXEL', mx + 20, fy - 12, C.yellow);
  drawText(ctx, 'HIKE', mx + 20 + textWidth('PIXEL ') , fy - 12, C.skyLight);
  if (p.logo) {
    const img = p.logo.get(Math.min(18, Math.floor(60 / p.logo.aspect)), true);
    ctx.drawImage(img, mx + mw - img.width, fy - img.height);
  } else {
    drawText(ctx, `${km.toFixed(0)} KM OF ADVENTURE`, mx + mw, fy - 12, C.rock, { align: 'right' });
  }
  return c;
}

/** The poster scaled up with crisp pixels (×5 = 1080×1350). */
export function upscale(src: HTMLCanvasElement, k: number) {
  const c = document.createElement('canvas');
  c.width = src.width * k;
  c.height = src.height * k;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
