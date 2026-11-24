import { ANIM_INFO, ANIMS, type Anim, type SpriteSet } from './characters';

/**
 * A character pack: your own character in two sizes (e.g. made with Grok Imagine from a finish photo).
 *
 * - **big** frames (~64 px tall) for the shots where the character is on stage: the start / finish arch
 *   scenes and the poster;
 * - **trail** frames (~28 px tall), used everywhere on the trail instead of the 16 px sprite.
 *
 * One PNG, 320 px wide, facing right, feet on each cell's bottom edge, centred, rows in the standard order
 * (idle, walk, run, climb, descend, cheer, rest, sleep), up to 4 frames per row, empty cells left out:
 * - y 0–640: the big frames, 80 × 80 px cells (4 × 8);
 * - y 640–960 (optional): the trail frames, 40 × 40 px cells (4 × 8, left half).
 * So 320 × 640 (big only) or 320 × 960 (both), or an exact integer upscale. Colours are used as they are
 * (not snapped to the game palette), so a likeness keeps its shades.
 */
export const BIG_CELL = 80;
export const TRAIL_CELL = 40;
const COLS = 4;
const PACK_W = BIG_CELL * COLS, BIG_H = BIG_CELL * ANIMS.length, TRAIL_H = TRAIL_CELL * ANIMS.length;

/** Rows a pack may leave empty, and what plays instead (the first that exists). */
const STAND_IN: Record<Anim, Anim[]> = {
  idle: ['walk', 'run'],
  walk: ['run', 'idle'],
  run: ['walk', 'idle'],
  climb: ['walk', 'run', 'idle'],
  descend: ['walk', 'run', 'idle'],
  cheer: ['idle', 'walk'],
  rest: ['idle', 'walk'],
  sleep: ['rest', 'idle', 'walk'],
};

export interface BigSet {
  frames: Partial<Record<Anim, HTMLCanvasElement[]>>;
  /** The trail-size set (replaces the 16 px sprite on the trail), or null if the pack has none. */
  trail: SpriteSet | null;
  /** The pack as a PNG data URL (saved with the track's edits). */
  dataUrl: string;
}

/** Cut the non-empty cells of one block of the sheet into frames per animation (hard alpha). */
function cut(img: HTMLImageElement, k: number, top: number, cell: number) {
  const frames: Partial<Record<Anim, HTMLCanvasElement[]>> = {};
  ANIMS.forEach((anim, row) => {
    for (let col = 0; col < COLS; col++) {
      const c = document.createElement('canvas');
      c.width = c.height = cell;
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, col * cell * k, (top + row * cell) * k, cell * k, cell * k, 0, 0, cell, cell);
      const id = ctx.getImageData(0, 0, cell, cell);
      let any = false;
      for (let i = 3; i < id.data.length; i += 4) {
        id.data[i] = id.data[i] > 127 ? 255 : 0; // hard alpha (pixel art)
        if (id.data[i]) any = true;
      }
      if (!any) continue;
      ctx.putImageData(id, 0, 0);
      (frames[anim] ??= []).push(c);
    }
  });
  return frames;
}

function mirror(c: HTMLCanvasElement) {
  const f = document.createElement('canvas');
  f.width = c.width;
  f.height = c.height;
  const ctx = f.getContext('2d')!;
  ctx.translate(c.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(c, 0, 0);
  return f;
}

/** The head-lamp: the brightest warm pixel in the top third of the standing frame. */
function findLamp(f: HTMLCanvasElement | undefined): [number, number] | null {
  if (!f) return null;
  const d = f.getContext('2d')!.getImageData(0, 0, f.width, f.height).data;
  let top = f.height;
  for (let i = 3; i < d.length; i += 4) if (d[i]) { top = Math.floor((i >> 2) / f.width); break; }
  let best: [number, number] | null = null, bv = 600;
  for (let y = top; y < top + (f.height - top) / 3; y++) {
    for (let x = 0; x < f.width; x++) {
      const i = (y * f.width + x) * 4;
      if (!d[i + 3]) continue;
      const v = d[i] + d[i + 1] + d[i + 2] - Math.max(0, d[i + 2] - d[i + 1]); // bright, not blue
      if (v > bv) { bv = v; best = [x, y]; }
    }
  }
  return best;
}

/** Height of the figure in a frame (bottom-anchored): rows from the first opaque one down. */
function standHeight(f: HTMLCanvasElement) {
  const d = f.getContext('2d')!.getImageData(0, 0, f.width, f.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) return f.height - Math.floor((i >> 2) / f.width);
  return f.height;
}

function trailSet(frames: Partial<Record<Anim, HTMLCanvasElement[]>>): SpriteSet | null {
  if (!Object.keys(frames).length) return null;
  const all = {} as Record<Anim, HTMLCanvasElement[]>;
  for (const a of ANIMS) {
    const own = frames[a];
    const sub = own?.length ? own : STAND_IN[a].map((b) => frames[b]).find((l) => l?.length);
    all[a] = sub ?? Object.values(frames).find((l) => l?.length)!;
  }
  const flipped = Object.fromEntries(ANIMS.map((a) => [a, all[a].map(mirror)])) as Record<Anim, HTMLCanvasElement[]>;
  return { frames: all, flipped, lamp: findLamp(all.idle[0]), size: standHeight(all.idle[0]) };
}

export async function loadBigSheet(dataUrl: string): Promise<BigSet> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const k = img.naturalWidth / PACK_W;
  const h = img.naturalHeight / (k || 1);
  if (!Number.isInteger(k) || k < 1 || (h !== BIG_H && h !== BIG_H + TRAIL_H)) {
    throw new Error(`Character pack must be ${PACK_W}×${BIG_H} or ${PACK_W}×${BIG_H + TRAIL_H} px (or an exact multiple).`);
  }
  const frames = cut(img, k, 0, BIG_CELL);
  const trail = h > BIG_H ? trailSet(cut(img, k, BIG_H, TRAIL_CELL)) : null;
  if (!Object.keys(frames).length && !trail) throw new Error('Character pack is empty.');
  return { frames, trail, dataUrl };
}

/** The big frame for an animation at time t, or null when the pack has none (use the normal sprite). */
export function bigFrameOf(big: BigSet | null | undefined, anim: Anim, t: number): HTMLCanvasElement | null {
  const list = big?.frames[anim] ?? (anim === 'walk' ? big?.frames.run : undefined);
  if (!list?.length) return null;
  return list[Math.floor(t * ANIM_INFO[anim].fps) % list.length];
}
