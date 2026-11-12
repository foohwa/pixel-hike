import { PALETTE, rgb01 } from './palette';
import type { PixelRenderer } from './renderer';

/**
 * Animated GIF export for chats. The frames are already pixel art in the 32-colour palette, so the
 * GIF uses one global colour table (the palette, plus any extra colours a logo or photo brings, up to
 * 256), each frame is LZW-compressed at game resolution and blown up by whole pixels.
 */
export interface GifOptions {
  duration: number;
  fps: number;
  /** Whole-pixel upscale (1 = 320×180, 2 = 640×360). */
  scale: number;
  onProgress?: (u: number) => void;
  signal?: AbortSignal;
}

export async function exportGif(r: PixelRenderer, opts: GifOptions): Promise<Blob> {
  const W = r.W, H = r.H, k = opts.scale;
  const OW = W * k, OH = H * k;
  const delay = Math.round(100 / opts.fps); // GIF time unit: 1/100 s
  const frames = Math.round(opts.duration * (100 / delay));

  // colour table: palette first, others added as they turn up (nearest palette colour once full)
  const table: number[] = PALETTE.map((h) => parseInt(h.slice(1), 16));
  const index = new Map<number, number>(table.map((c, i) => [c, i]));
  const palRgb = PALETTE.map((h) => rgb01(h).map((v) => v * 255));
  const lookup = (c: number) => {
    let i = index.get(c);
    if (i != null) return i;
    if (table.length < 256) {
      i = table.length;
      table.push(c);
    } else {
      const rr = c >> 16, gg = (c >> 8) & 255, bb = c & 255;
      let bd = Infinity;
      palRgb.forEach((p, j) => {
        const d = (rr - p[0]) ** 2 + (gg - p[1]) ** 2 + (bb - p[2]) ** 2;
        if (d < bd) { bd = d; i = j; }
      });
    }
    index.set(c, i!);
    return i!;
  };

  const grab = document.createElement('canvas');
  grab.width = W;
  grab.height = H;
  const gctx = grab.getContext('2d', { willReadFrequently: true })!;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const idx = new Uint8Array(OW * OH);
  for (let f = 0; f < frames; f++) {
    if (opts.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    r.renderAt((f * delay) / 100);
    gctx.drawImage(r.canvas, 0, 0);
    const px = gctx.getImageData(0, 0, W, H).data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const ci = lookup((px[o] << 16) | (px[o + 1] << 8) | px[o + 2]);
        for (let yy = 0; yy < k; yy++) idx.fill(ci, (y * k + yy) * OW + x * k, (y * k + yy) * OW + x * k + k);
      }
    }
    chunks.push(frameBlock(idx, OW, OH, delay));
    if (f % 4 === 0) {
      opts.onProgress?.(f / frames);
      await new Promise((res) => setTimeout(res, 0));
    }
  }

  // header + logical screen + global colour table (padded to a power of two) + loop forever
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, table.length))));
  const size = 1 << bits;
  const head = new Uint8Array(13 + size * 3 + 19);
  let p = 0;
  for (const ch of 'GIF89a') head[p++] = ch.charCodeAt(0);
  head[p++] = OW & 255; head[p++] = OW >> 8; head[p++] = OH & 255; head[p++] = OH >> 8;
  head[p++] = 0x80 | ((bits - 1) << 4) | (bits - 1); head[p++] = 0; head[p++] = 0;
  for (let i = 0; i < size; i++) {
    const c = table[i] ?? 0;
    head[p++] = c >> 16; head[p++] = (c >> 8) & 255; head[p++] = c & 255;
  }
  head.set([0x21, 0xff, 0x0b, ...[...'NETSCAPE2.0'].map((ch) => ch.charCodeAt(0)), 0x03, 0x01, 0, 0, 0], p);
  opts.onProgress?.(1);
  return new Blob([head, ...chunks, new Uint8Array([0x3b])], { type: 'image/gif' });
}

/** Graphic control (delay) + image descriptor + LZW data for one full frame. */
function frameBlock(idx: Uint8Array, w: number, h: number, delay: number): Uint8Array<ArrayBuffer> {
  const lzw = lzwEncode(idx, 8);
  const out = new Uint8Array(8 + 10 + 1 + lzw.length + Math.ceil(lzw.length / 255) + 1);
  let p = 0;
  out.set([0x21, 0xf9, 0x04, 0x04, delay & 255, delay >> 8, 0, 0], p); p += 8; // dispose: leave in place
  out.set([0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0], p); p += 10;
  out[p++] = 8; // min code size
  for (let i = 0; i < lzw.length; i += 255) {
    const n = Math.min(255, lzw.length - i);
    out[p++] = n;
    out.set(lzw.subarray(i, i + n), p);
    p += n;
  }
  out[p++] = 0;
  return out.subarray(0, p);
}

/** GIF-flavoured LZW (variable code width up to 12 bits, LSB-first). */
function lzwEncode(data: Uint8Array, minSize: number): Uint8Array<ArrayBuffer> {
  const clear = 1 << minSize, eoi = clear + 1;
  let size = minSize + 1, next = eoi + 1;
  // dictionary: (prefix code << 8 | byte) → code
  const dict = new Map<number, number>();
  const out: number[] = [];
  let cur = 0, nbits = 0;
  const emit = (code: number) => {
    cur |= code << nbits;
    nbits += size;
    while (nbits >= 8) { out.push(cur & 255); cur >>>= 8; nbits -= 8; }
  };
  emit(clear);
  let prefix = data[0];
  for (let i = 1; i < data.length; i++) {
    const c = data[i];
    const key = (prefix << 8) | c;
    const hit = dict.get(key);
    if (hit != null) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      emit(clear);
      dict.clear();
      size = minSize + 1;
      next = eoi + 1;
    }
    prefix = c;
  }
  emit(prefix);
  emit(eoi);
  if (nbits > 0) out.push(cur & 255);
  return Uint8Array.from(out);
}
