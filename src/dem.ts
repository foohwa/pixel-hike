/**
 * Elevation from the free AWS "Terrain Tiles" (Terrarium encoding).
 * https://registry.opendata.aws/terrain-tiles/
 */
import { cacheGet, cacheSet } from './cache';

const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const MAX_TILES = 30;

export interface Dem {
  /** Elevation in metres, or NaN outside the loaded area. */
  sample(lat: number, lon: number): number;
}

export interface BBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

function lonToX(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z;
}
function latToY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

/** Terrain tiles never change: keep them in this browser so a route opened before loads offline. */
async function tileBlob(url: string): Promise<Blob> {
  const hit = await cacheGet<Blob>(url);
  if (hit) return hit;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Elevation tile ${r.status}`);
  const b = await r.blob();
  void cacheSet(url, b);
  return b;
}

export async function loadDem(bbox: BBox, onProgress?: (done: number, total: number) => void): Promise<Dem> {
  let z = 14;
  let tx0 = 0, tx1 = 0, ty0 = 0, ty1 = 0;
  for (; z >= 6; z--) {
    tx0 = Math.floor(lonToX(bbox.minLon, z));
    tx1 = Math.floor(lonToX(bbox.maxLon, z));
    ty0 = Math.floor(latToY(bbox.maxLat, z));
    ty1 = Math.floor(latToY(bbox.minLat, z));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= MAX_TILES) break;
  }
  const cols = tx1 - tx0 + 1;
  const rows = ty1 - ty0 + 1;
  const W = cols * 256, H = rows * 256;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  let done = 0;
  const total = cols * rows;
  const jobs: Promise<void>[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const url = TILE_URL.replace('{z}', String(z)).replace('{x}', String(tx)).replace('{y}', String(ty));
      jobs.push(
        tileBlob(url)
          .then((b) => createImageBitmap(b))
          .then((img) => {
            ctx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256);
            onProgress?.(++done, total);
          }),
      );
    }
  }
  await Promise.all(jobs);

  const px = ctx.getImageData(0, 0, W, H).data;
  const h = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  }

  return {
    sample(lat, lon) {
      const fx = (lonToX(lon, z) - tx0) * 256 - 0.5;
      const fy = (latToY(lat, z) - ty0) * 256 - 0.5;
      if (fx < 0 || fy < 0 || fx > W - 1 || fy > H - 1) return NaN;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
      const ax = fx - x0, ay = fy - y0;
      const a = h[y0 * W + x0], b = h[y0 * W + x1], c = h[y1 * W + x0], d = h[y1 * W + x1];
      return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
    },
  };
}
