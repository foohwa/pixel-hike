import { C } from './palette';
import { clamp, gaussian, sampleAt, type Track } from './track';

/**
 * How hard the walker is working, from the heart rate (or, without one, from how steep it is).
 *
 * Thresholds come from the track's own heart rate, so every hike has its hardest stretches: the top
 * ~15% of the moving heart rate is "hard" (the sprite flashes yellow on each heartbeat, sweat drops
 * fly off), the top ~3% is "max" (red flashes like a game character taking damage, puffs of breath,
 * a heavier, slower step). Without a heart rate only steep climbs make the walker sweat.
 */
export interface Effort {
  /** 0 = easy … 1 = flat out, per track sample. */
  level: Float32Array;
  hasHr: boolean;
  /** Heart rate (bpm) where "hard" and "max" start, or null without a heart rate. */
  hard: number | null;
  max: number | null;
}

const cache = new WeakMap<Track, Effort>();

export function effortFor(track: Track): Effort {
  const hit = cache.get(track);
  if (hit) return hit;
  const level = new Float32Array(track.n);
  let hard: number | null = null, max: number | null = null;
  if (track.hasHr) {
    // smooth over ~150 m so a single noisy reading doesn't flash
    const hr = gaussian(Array.from(track.hr, (v) => (Number.isFinite(v) ? v : NaN)), 150 / track.step);
    const moving: number[] = [];
    for (let i = 0; i < track.n; i++) if (Number.isFinite(hr[i]) && Math.abs(track.grade[i]) < 2) moving.push(hr[i]);
    moving.sort((a, b) => a - b);
    if (moving.length > 20) {
      const q = (p: number) => moving[Math.min(moving.length - 1, Math.floor(moving.length * p))];
      hard = q(0.85);
      max = Math.max(hard + 3, q(0.97));
      // ramps up to 0.5 just below "hard", 0.5 → 1 between "hard" and "max"
      for (let i = 0; i < track.n; i++) {
        const v = hr[i];
        if (!Number.isFinite(v)) continue;
        level[i] = v < hard ? clamp((v - (hard - 8)) / 8, 0, 1) * 0.44 : 0.5 + 0.5 * clamp((v - hard) / (max - hard), 0, 1);
      }
    }
  }
  if (hard == null) {
    // no heart rate: steep climbs (> ~20 %) make you sweat, never "max"
    for (let i = 0; i < track.n; i++) level[i] = clamp((track.grade[i] - 0.18) / 0.12, 0, 1) * 0.7;
  }
  const e: Effort = { level, hasHr: hard != null, hard, max };
  cache.set(track, e);
  return e;
}

export interface EffortFx {
  /** Flash colour for the sprite and how strong right now (0 = none). */
  tint: string | null;
  k: number;
  /** Sweat drops flying off; breath puffs; play the step a bit slower. */
  sweat: boolean;
  puff: boolean;
  slow: boolean;
  /** "hard" | "max" | null — for the HUD. */
  zone: 'hard' | 'max' | null;
}

const NONE: EffortFx = { tint: null, k: 0, sweat: false, puff: false, slow: false, zone: null };

/**
 * The effect for the walker at track distance `d`, video time `t`. Flashes ride on the heartbeat
 * (the same beat the HUD heart pulses with), so they speed up as the heart rate climbs.
 */
export function effortAt(track: Track, d: number, t: number, moving: boolean): EffortFx {
  if (!moving) return NONE;
  const e = effortFor(track);
  const lv = sampleAt(track, e.level, d);
  if (lv < 0.45) return NONE;
  const hr = sampleAt(track, track.hr, d);
  const bpm = Number.isFinite(hr) ? hr : 120;
  const beat = (t * bpm) / 60;
  const ph = beat - Math.floor(beat);
  const max = e.hasHr && lv >= 0.95;
  if (max) {
    // damage-style blink: two quick red flashes per beat
    const on = ph < 0.12 || (ph > 0.24 && ph < 0.36);
    return { tint: C.red, k: on ? 0.85 : 0, sweat: true, puff: true, slow: true, zone: 'max' };
  }
  if (!e.hasHr) return { ...NONE, sweat: lv > 0.55 };
  return { tint: C.yellow, k: ph < 0.16 ? 0.55 : 0, sweat: true, puff: false, slow: false, zone: 'hard' };
}

const tinted = new WeakMap<HTMLCanvasElement, Map<string, HTMLCanvasElement>>();
/** A copy of a sprite frame washed with `color` at strength `k` (cached; k in 0.05 steps). */
export function tintFrame(src: HTMLCanvasElement, color: string, k: number): HTMLCanvasElement {
  const kk = Math.round(clamp(k, 0, 1) * 20) / 20;
  if (kk <= 0) return src;
  let m = tinted.get(src);
  if (!m) tinted.set(src, (m = new Map()));
  const key = `${color}${kk}`;
  const hit = m.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'source-atop';
  ctx.globalAlpha = kk;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  m.set(key, c);
  return c;
}

/**
 * Sweat drops arcing off the head and breath puffs in front of the face, drawn around the walker
 * whose feet are at (x, y) (16×16 sprite, bottom-centre). Deterministic in t.
 */
export function drawEffortFx(ctx: CanvasRenderingContext2D, fx: EffortFx, x: number, y: number, t: number, facingLeft: boolean) {
  if (fx.sweat) {
    for (let k = 0; k < 2; k++) {
      const u = (t * 1.6 + k * 0.5) % 1;
      if (u > 0.7) continue;
      const side = (k % 2 ? 1 : -1) * (facingLeft ? -1 : 1);
      const px = Math.round(x + side * (3 + u * 7));
      const py = Math.round(y - 15 - u * 5 + u * u * 12);
      ctx.fillStyle = C.skyLight;
      ctx.fillRect(px, py, 1, 2);
      ctx.fillStyle = C.white;
      ctx.fillRect(px, py, 1, 1);
    }
  }
  if (fx.puff) {
    const u = (t * 2.2) % 1;
    if (u < 0.75) {
      const dir = facingLeft ? -1 : 1;
      const px = Math.round(x + dir * (6 + u * 6));
      const py = Math.round(y - 11 - u * 2);
      ctx.fillStyle = C.white;
      ctx.fillRect(px, py, u < 0.4 ? 2 : 1, 1);
      if (u > 0.3) ctx.fillRect(px + dir, py - 1, 1, 1);
    }
  }
}
