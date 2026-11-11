import { C, PALETTE, rgb01 } from './palette';

/**
 * Event logos → crisp pixel art.
 *
 * 1. `prepareLogo` removes a flat background (e.g. the black square around a logo), crops to the
 *    artwork and keeps a ≤256 px copy (small enough to save with the track's edits).
 * 2. `LogoSet.get(height)` downsamples it to an exact pixel grid: each cell takes the *dominant*
 *    colour of its pixels (no blur), cells that are mostly background become transparent, and the
 *    colours are reduced to a handful (or snapped to the app palette).
 */

const MAX_SRC = 256;

export interface LogoSource {
  dataUrl: string; // background-free, cropped PNG
}

export async function prepareLogo(file: Blob): Promise<LogoSource> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  removeBackground(img);
  const box = opaqueBounds(img);
  if (!box) throw new Error('That image looks empty after removing its background.');
  ctx.putImageData(img, 0, 0);

  // crop + keep a modest copy
  const s = Math.min(1, MAX_SRC / Math.max(box.w, box.h));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(box.w * s));
  out.height = Math.max(1, Math.round(box.h * s));
  const octx = out.getContext('2d')!;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(c, box.x, box.y, box.w, box.h, 0, 0, out.width, out.height);
  return { dataUrl: out.toDataURL('image/png') };
}

/** If the border is one flat colour, make that colour transparent (soft edge for anti-aliasing). */
function removeBackground(img: ImageData) {
  const { width: w, height: h, data } = img;
  const border: number[] = [];
  const push = (x: number, y: number) => border.push((y * w + x) * 4);
  for (let x = 0; x < w; x += 2) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y += 2) { push(0, y); push(w - 1, y); }
  // already transparent around the edges? nothing to do
  if (border.filter((i) => data[i + 3] < 128).length > border.length * 0.6) return;
  const buckets = new Map<number, number[]>();
  for (const i of border) {
    const k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i);
  }
  const top = [...buckets.values()].sort((a, b) => b.length - a.length)[0];
  if (!top || top.length < border.length * 0.6) return; // busy border: leave the image alone
  const bg = [0, 1, 2].map((ch) => top.reduce((s, i) => s + data[i + ch], 0) / top.length);
  const lo = 40, hi = 110;
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);
    const a = d <= lo ? 0 : d >= hi ? 1 : (d - lo) / (hi - lo);
    data[i + 3] = Math.round(data[i + 3] * a);
  }
}

function opaqueBounds(img: ImageData) {
  const { width: w, height: h, data } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < 128) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export type LogoColors = 'logo' | 'palette';

export class LogoSet {
  private cache = new Map<string, HTMLCanvasElement>();
  private src: ImageData;
  readonly colors: LogoColors;
  private constructor(src: ImageData, colors: LogoColors) {
    this.src = src;
    this.colors = colors;
  }

  static async load(source: LogoSource, colors: LogoColors = 'logo'): Promise<LogoSet> {
    const img = new Image();
    img.src = source.dataUrl;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    return new LogoSet(ctx.getImageData(0, 0, c.width, c.height), colors);
  }

  get aspect() {
    return this.src.width / this.src.height;
  }

  /** Pixel-art version `height` px tall; `outline` adds a 1 px dark edge so it reads over the map. */
  get(height: number, outline = false): HTMLCanvasElement {
    const key = `${height}|${outline}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const px = pixelate(this.src, height, this.colors);
    const out = outline ? addOutline(px) : px;
    this.cache.set(key, out);
    return out;
  }
}

function pixelate(src: ImageData, H: number, colors: LogoColors): HTMLCanvasElement {
  const s = src.height / H;
  const W = Math.max(1, Math.round(src.width / s));
  const { data, width: sw } = src;
  const cells: ([number, number, number] | null)[] = [];
  const step = Math.max(1, Math.floor(s / 6));
  for (let cy = 0; cy < H; cy++) {
    for (let cx = 0; cx < W; cx++) {
      const x0 = Math.floor(cx * s), x1 = Math.max(x0 + 1, Math.floor((cx + 1) * s));
      const y0 = Math.floor(cy * s), y1 = Math.max(y0 + 1, Math.floor((cy + 1) * s));
      let n = 0, cover = 0;
      const buckets = new Map<number, { w: number; r: number; g: number; b: number }>();
      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          const i = (Math.min(y, src.height - 1) * sw + Math.min(x, sw - 1)) * 4;
          n++;
          const a = data[i + 3] / 255;
          if (a < 0.05) continue;
          cover += a;
          const k = ((data[i] >> 5) << 6) | ((data[i + 1] >> 5) << 3) | (data[i + 2] >> 5);
          const bk = buckets.get(k) ?? { w: 0, r: 0, g: 0, b: 0 };
          bk.w += a; bk.r += data[i] * a; bk.g += data[i + 1] * a; bk.b += data[i + 2] * a;
          buckets.set(k, bk);
        }
      }
      if (cover / n < 0.32) { cells.push(null); continue; }
      let best: { w: number; r: number; g: number; b: number } | null = null;
      for (const b of buckets.values()) if (!best || b.w > best.w) best = b;
      cells.push([best!.r / best!.w, best!.g / best!.w, best!.b / best!.w]);
    }
  }

  const opaque = cells.filter((c): c is [number, number, number] => !!c);
  const target = colors === 'palette'
    ? PALETTE.map((h) => rgb01(h).map((v) => v * 255) as [number, number, number])
    : kmeans(opaque, Math.min(6, Math.max(2, opaque.length)));

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  cells.forEach((col, i) => {
    if (!col) return;
    const [r, g, b] = nearest(col, target);
    ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    ctx.fillRect(i % W, Math.floor(i / W), 1, 1);
  });
  return c;
}

function nearest(c: [number, number, number], set: [number, number, number][]) {
  let best = set[0], bd = Infinity;
  for (const p of set) {
    const d = (p[0] - c[0]) ** 2 * 0.3 + (p[1] - c[1]) ** 2 * 0.45 + (p[2] - c[2]) ** 2 * 0.25;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

/** Tiny deterministic k-means for picking the logo's few real colours. */
function kmeans(pts: [number, number, number][], k: number): [number, number, number][] {
  if (pts.length === 0) return [[255, 255, 255]];
  // farthest-point init (deterministic)
  const cents: [number, number, number][] = [pts[0]];
  while (cents.length < k) {
    let far = pts[0], fd = -1;
    for (const p of pts) {
      const d = Math.min(...cents.map((c) => (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2));
      if (d > fd) { fd = d; far = p; }
    }
    if (fd < 300) break; // remaining colours are near-duplicates
    cents.push(far);
  }
  for (let it = 0; it < 12; it++) {
    const acc = cents.map(() => [0, 0, 0, 0]);
    for (const p of pts) {
      const j = cents.indexOf(nearest(p, cents));
      acc[j][0] += p[0]; acc[j][1] += p[1]; acc[j][2] += p[2]; acc[j][3]++;
    }
    acc.forEach((a, j) => { if (a[3]) cents[j] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  // drop colours that only appear on a sliver of edge pixels (anti-aliasing leftovers)
  const counts = cents.map(() => 0);
  for (const p of pts) counts[cents.indexOf(nearest(p, cents))]++;
  const keep = cents.filter((_, j) => counts[j] >= Math.max(2, pts.length * 0.04));
  return keep.length ? keep : cents;
}

function addOutline(src: HTMLCanvasElement): HTMLCanvasElement {
  const w = src.width + 2, h = src.height + 2;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 1, 1);
  const a = ctx.getImageData(0, 0, w, h).data;
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && a[(y * w + x) * 4 + 3] > 0;
  ctx.fillStyle = C.ink;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (on(x, y)) continue;
      if (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1)) ctx.fillRect(x, y, 1, 1);
    }
  }
  return c;
}
