import { localToEpoch, readExif } from './exif';
import { drawText, textWidth } from './font';
import { C, PALETTE, rgb01 } from './palette';
import { clamp, sampleAt, type Track } from './track';

/**
 * "Moments" you add to the video yourself:
 * - photos from the hike, placed on the track by their GPS / time stamp: the walker stops, a camera
 *   flash, and the photo drops in as a little pixel-art polaroid;
 * - speech bubbles: a line the character says at a spot (typed out like game dialogue).
 */

export interface Bubble {
  id: string;
  d: number; // metres along the track
  text: string;
}

export type PhotoPlacement = 'gps' | 'time' | 'file' | 'manual';

export interface Photo {
  id: string;
  d: number;
  /** When it was taken (epoch ms), if known. */
  time: number | null;
  /** Small JPEG (≤ 240 px), kept with the track's saved edits. */
  src: string;
  caption: string;
  how: PhotoPlacement;
  enabled: boolean;
}

/** A photo ready to draw: its pixel-art version for the polaroid. */
export interface PhotoArt {
  id: string;
  d: number;
  time: number | null;
  caption: string;
  art: HTMLCanvasElement;
}

export type PhotoColors = 'palette' | 'full';

export const PHOTO_SECONDS = 2.6;
export const BUBBLE_SECONDS = 2.8;

let seq = 0;
export const newId = (p: string) => `${p}-${Date.now().toString(36)}${(seq++).toString(36)}`;

// ------------------------------------------------------------------ loading + placing photos

const SRC_MAX = 240;

/** Reads a photo file: a small JPEG copy + where/when it was taken (EXIF), if it says. */
export async function readPhoto(file: File) {
  const buf = await file.arrayBuffer();
  const meta = readExif(buf);
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(new Blob([buf], { type: file.type || 'image/jpeg' }), { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`Can't open ${file.name}${/\.hei[cf]$/i.test(file.name) ? ' (HEIC: export it as JPEG, or use Safari)' : ''}.`);
  }
  const s = Math.min(1, SRC_MAX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s));
  c.height = Math.max(1, Math.round(bmp.height * s));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return { src: c.toDataURL('image/jpeg', 0.85), meta, lastModified: file.lastModified };
}

/** Track distance at an epoch time (null if outside the hike). */
export function distAtTime(track: Track, ms: number): number | null {
  const t = track.time;
  if (ms < t[0] - 30 * 60000 || ms > t[track.n - 1] + 30 * 60000) return null;
  let lo = 0, hi = track.n - 1;
  if (ms <= t[0]) return 0;
  if (ms >= t[hi]) return track.stats.distance;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (t[m] <= ms) lo = m; else hi = m;
  }
  const f = t[hi] > t[lo] ? (ms - t[lo]) / (t[hi] - t[lo]) : 0;
  return (lo + f) * track.step;
}

/**
 * Where on the track a photo belongs: by GPS (nearest point, preferring the pass that matches the
 * time on a loop / out-and-back), else by its time stamp (camera offset, or the clock's time zone),
 * else by the file's date, else at `fallbackD` (the current scrub position).
 */
export function placePhoto(
  track: Track,
  r: Awaited<ReturnType<typeof readPhoto>>,
  tzOffsetMin: number,
  fallbackD: number,
): { d: number; time: number | null; how: PhotoPlacement } {
  const m = r.meta;
  let time: number | null = m.localTime ? localToEpoch(m.localTime, m.offsetMin ?? tzOffsetMin) : null;
  if (time != null && distAtTime(track, time) == null) time = null; // a different day: ignore it
  if (m.lat != null && m.lon != null) {
    const x = (m.lon - track.lon0) * track.mLon, z = -(m.lat - track.lat0) * track.mLat;
    let best = -1, bestCost = Infinity;
    for (let i = 0; i < track.n; i++) {
      const dist = Math.hypot(track.x[i] - x, track.z[i] - z);
      const cost = dist + (time != null ? (Math.abs(track.time[i] - time) / 60000) * 10 : 0);
      if (cost < bestCost) { bestCost = cost; best = i; }
    }
    if (best >= 0 && Math.hypot(track.x[best] - x, track.z[best] - z) < 1500) {
      return { d: best * track.step, time: time ?? track.time[best], how: 'gps' };
    }
  }
  if (time != null) return { d: distAtTime(track, time)!, time, how: 'time' };
  const fd = distAtTime(track, r.lastModified);
  if (fd != null) return { d: fd, time: r.lastModified, how: 'file' };
  return { d: fallbackD, time: null, how: 'manual' };
}

// ------------------------------------------------------------------ pixel-art version

const palRgb = PALETTE.map((h) => rgb01(h).map((v) => v * 255) as [number, number, number]);
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * The photo as chunky pixel art: shrunk to fit `maxW`×`maxH` (each pixel the average of its area),
 * then snapped to the game palette with a light ordered dither — or kept in its own colours,
 * posterised a little so it still reads as pixel art.
 */
export async function pixelatePhoto(src: string, colors: PhotoColors, maxW = 84, maxH = 64): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const s = Math.min(maxW / img.width, maxH / img.height);
  const w = Math.max(8, Math.round(img.width * s)), h = Math.max(8, Math.round(img.height * s));
  // shrink in halves so every output pixel averages its whole area (no aliasing)
  let cur: CanvasImageSource = img, cw = img.width, ch = img.height;
  while (cw / 2 > w && ch / 2 > h) {
    const c = document.createElement('canvas');
    c.width = Math.round(cw / 2); c.height = Math.round(ch / 2);
    const x = c.getContext('2d')!;
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, c.width, c.height);
    cur = c; cw = c.width; ch = c.height;
  }
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // a touch more contrast + saturation: photos shrunk this far go flat
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
      let r = l + (d[i] - l) * 1.25, g = l + (d[i + 1] - l) * 1.25, b = l + (d[i + 2] - l) * 1.25;
      r = (r - 128) * 1.08 + 128; g = (g - 128) * 1.08 + 128; b = (b - 128) * 1.08 + 128;
      const dith = (BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * (colors === 'palette' ? 26 : 18);
      r += dith; g += dith; b += dith;
      if (colors === 'palette') {
        let best = palRgb[0], bd = Infinity;
        for (const p of palRgb) {
          const dist = (r - p[0]) ** 2 * 0.22 + (g - p[1]) ** 2 * 0.45 + (b - p[2]) ** 2 * 0.33;
          if (dist < bd) { bd = dist; best = p; }
        }
        [r, g, b] = best;
      } else {
        const q = (v: number) => Math.round(clamp(v, 0, 255) / 255 * 7) / 7 * 255; // 8 levels per channel
        r = q(r); g = q(g); b = q(b);
      }
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
  return out;
}

// ------------------------------------------------------------------ drawing

function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string, border: string) {
  ctx.fillStyle = border;
  ctx.fillRect(x + 1, y, w - 2, h);
  ctx.fillRect(x, y + 1, w, h - 2);
  ctx.fillStyle = fill;
  ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
}

/** Text the bitmap font can draw (upper case; anything it lacks becomes a space). */
export function speakable(s: string) {
  return s.toUpperCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^A-Z0-9:.,\-/!?&'%+^~*°()#<> ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function wrap(text: string, maxChars: number, maxLines: number) {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (let w of words) {
    while (w.length > maxChars) { // a very long word: hard break
      if (line) { lines.push(line); line = ''; }
      lines.push(w.slice(0, maxChars));
      w = w.slice(maxChars);
    }
    if (!line) line = w;
    else if (line.length + 1 + w.length <= maxChars) line += ' ' + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, maxChars - 1) + '.';
  }
  return lines;
}

/**
 * A speech bubble above the walker (feet at hx, hy), typed out over the first half second, with a
 * little tail pointing at their head. `age` = seconds since it appeared.
 */
export function drawBubble(ctx: CanvasRenderingContext2D, text: string, hx: number, hy: number, age: number, W: number, H: number, beside = false) {
  if (age < 0 || age > BUBBLE_SECONDS) return;
  const portrait = H > W;
  const lines = wrap(speakable(text), portrait ? 20 : 22, 3);
  if (!lines.length) return;
  const total = lines.join(' ').length;
  let shown = Math.floor(clamp(age / Math.max(0.35, Math.min(1.1, total * 0.035)), 0, 1) * total);
  const bw = Math.max(...lines.map((l) => textWidth(l))) + 10;
  const bh = lines.length * 9 + 6;
  const pop = age < 0.08 ? 1 : 0; // one frame of "pop" when it appears
  const out = age > BUBBLE_SECONDS - 0.15;
  if (out && Math.floor(age * 30) % 2) return; // blinks away
  const headY = hy - 17;
  if (beside) {
    // a banner is up at the top: talk from the left of the walker instead, tail pointing at the head
    // (the summit sign stands on the right)
    let bx = Math.round(hx - 11 - bw), by = Math.round(headY - bh / 2 + 2 - pop);
    if (bx < 3) bx = Math.round(hx + 11);
    by = clamp(by, H > W ? 140 : 98, H - 30 - bh); // below the banner
    const left = bx < hx;
    box(ctx, bx, by, bw, bh, C.white, C.ink);
    const ty = clamp(headY + 2, by + 3, by + bh - 4), tx = left ? bx + bw - 1 : bx;
    ctx.fillStyle = C.ink;
    for (let k = 0; k < 4; k++) ctx.fillRect(left ? tx + k : tx - k, ty - 1 + Math.floor(k / 2), 1, 3 - k);
    ctx.fillStyle = C.white;
    ctx.fillRect(left ? tx - 1 : tx, ty, 2, 1);
    drawLines(ctx, lines, bx, by, shown);
    return;
  }
  let bx = Math.round(hx - bw / 2 + 6), by = Math.round(headY - 5 - bh - pop);
  bx = clamp(bx, 3, W - 3 - bw);
  by = clamp(by, 34, H - 30 - bh);
  // tail: from the bubble's bottom edge down towards the head
  const tx = clamp(hx + 2, bx + 4, bx + bw - 6), ty = by + bh;
  box(ctx, bx, by, bw, bh, C.white, C.ink);
  ctx.fillStyle = C.ink;
  for (let k = 0; k < 4; k++) ctx.fillRect(tx - 1 + k, ty - 1 + k, 3 - k, 1);
  ctx.fillStyle = C.white;
  ctx.fillRect(tx, ty - 1, 2, 1);
  ctx.fillRect(tx + 1, ty, 1, 1);
  drawLines(ctx, lines, bx, by, shown);
}

/** The bubble's text, the first `shown` characters of it (typewriter). */
function drawLines(ctx: CanvasRenderingContext2D, lines: string[], bx: number, by: number, shown: number) {
  lines.forEach((l, i) => {
    drawText(ctx, l.slice(0, Math.max(0, shown)), bx + 5, by + 4 + i * 9, C.ink);
    shown -= l.length + 1;
  });
}

/**
 * The photo moment: a camera flash, then the polaroid drops in, sits, and slides away.
 * `u` 0..1 through the stop.
 */
export function drawPolaroid(ctx: CanvasRenderingContext2D, p: PhotoArt, caption: string, u: number, W: number, H: number, hero: { x: number; y: number; visible: boolean }) {
  // flash: the whole frame goes white for an instant, dissolving out
  if (u < 0.08) {
    const a = 1 - u / 0.08;
    ctx.fillStyle = C.white;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if ((BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16 < a) ctx.fillRect(x, y, 1, 1);
    }
  }
  const art = p.art;
  const pad = 4, capH = caption ? 13 : 6;
  const cw = art.width + pad * 2, chh = art.height + pad + capH;
  const inU = clamp((u - 0.05) / 0.16, 0, 1);
  const outU = clamp((u - 0.86) / 0.14, 0, 1);
  if (inU <= 0 || outU >= 1) return;
  const drop = easeOutBack(inU);
  // beside the walker (so you see who took it), or above them on a tall screen
  const portrait = H > W;
  let cx = Math.round(W / 2 - cw / 2), restY = Math.round(H / 2 - chh / 2 - 6);
  if (hero.visible && !portrait) cx = hero.x < W / 2 ? hero.x + 16 : hero.x - 16 - cw;
  if (hero.visible && portrait) restY = hero.y - 26 - chh;
  cx = Math.round(clamp(cx, 6, W - 6 - cw));
  restY = Math.round(clamp(restY, portrait ? 60 : 34, H - 26 - chh));
  const y = Math.round(restY - (1 - drop) * (restY + chh + 8) + outU * outU * (H - restY + 8));
  // a 1-px drop shadow, the card, the photo, the caption
  ctx.fillStyle = C.ink;
  ctx.fillRect(cx + 2, y + 2, cw, chh);
  box(ctx, cx, y, cw, chh, C.white, C.greyLight);
  ctx.drawImage(art, cx + pad, y + pad);
  ctx.fillStyle = C.ink2;
  ctx.fillRect(cx + pad, y + pad + art.height, art.width, 1);
  if (caption) {
    let cap = speakable(caption);
    while (cap.length > 3 && textWidth(cap) > cw - 6) cap = cap.slice(0, -1);
    drawText(ctx, cap, cx + cw / 2, y + pad + art.height + 4, C.ink2, { align: 'center' });
  }
  // a strip of tape on top
  ctx.fillStyle = C.cream;
  ctx.fillRect(cx + Math.round(cw / 2) - 7, y - 2, 14, 4);
}

function easeOutBack(x: number) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

/** Bubbles → when each shows in the video (one at a time, nudged so they don't overlap). */
export function scheduleBubbles(bubbles: Bubble[], at: (d: number) => number | null, minT: number) {
  const out: { text: string; t: number }[] = [];
  for (const b of [...bubbles].sort((a, c) => a.d - c.d)) {
    const t = at(b.d);
    if (t == null || !speakable(b.text)) continue;
    const last = out[out.length - 1];
    out.push({ text: b.text, t: Math.max(t, minT, last ? last.t + BUBBLE_SECONDS + 0.2 : -Infinity) });
  }
  return out;
}

/** Elevation + time line for a photo with no caption of its own. */
export function photoCaption(track: Track, p: PhotoArt, tzOffsetMin: number) {
  if (p.caption.trim()) return p.caption;
  const ms = p.time ?? sampleAt(track, track.time, p.d);
  const dt = new Date(ms + tzOffsetMin * 60000);
  const hm = `${String(dt.getUTCHours()).padStart(2, '0')}:${String(dt.getUTCMinutes()).padStart(2, '0')}`;
  return `${hm}  ${((p.d * track.distScale) / 1000).toFixed(1)} KM`;
}
