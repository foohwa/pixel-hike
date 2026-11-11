import type { RawPoint } from './gpx';

export type CheckpointKind = 'start' | 'summit' | 'peak' | 'rest' | 'finish';

export interface Checkpoint {
  id: string;
  kind: CheckpointKind;
  d: number; // metres along the track
  name: string;
  ele: number;
  time: number; // epoch ms
  enabled: boolean;
  restMin?: number;
}

export interface TrackStats {
  distance: number;
  duration: number; // ms
  movingTime: number; // ms
  ascent: number;
  descent: number;
  maxEle: number;
  minEle: number;
  avgHr: number | null;
  maxHr: number | null;
  startTime: number;
  endTime: number;
}

/** A GPS track resampled to even distance steps, in local metres (x = east, z = south). */
export interface Track {
  n: number;
  step: number;
  d: Float64Array;
  x: Float64Array;
  z: Float64Array;
  ele: Float64Array; // watch elevation, smoothed
  time: Float64Array;
  hr: Float32Array; // NaN when missing
  hdx: Float32Array; // smoothed heading (unit vector)
  hdz: Float32Array;
  cost: Float64Array; // cumulative playback weight, 0..1
  lat0: number;
  lon0: number;
  mLat: number; // metres per degree
  mLon: number;
  hasTime: boolean;
  hasHr: boolean;
  hasEle: boolean;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  stats: TrackStats;
  checkpoints: Checkpoint[];
}

export function toLatLon(t: Pick<Track, 'lat0' | 'lon0' | 'mLat' | 'mLon'>, x: number, z: number) {
  return { lat: t.lat0 - z / t.mLat, lon: t.lon0 + x / t.mLon };
}

export function buildTrack(raw: RawPoint[]): Track {
  if (raw.length < 2) throw new Error('The track needs at least 2 points.');

  // --- local projection around the bbox centre ---
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of raw) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
  }
  const lat0 = (minLat + maxLat) / 2;
  const lon0 = (minLon + maxLon) / 2;
  const phi = (lat0 * Math.PI) / 180;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const mLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);

  const N = raw.length;
  const rx = new Float64Array(N), rz = new Float64Array(N), rd = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    rx[i] = (raw[i].lon - lon0) * mLon;
    rz[i] = -(raw[i].lat - lat0) * mLat;
    if (i > 0) rd[i] = rd[i - 1] + Math.hypot(rx[i] - rx[i - 1], rz[i] - rz[i - 1]);
  }
  const total = rd[N - 1];
  if (total < 50) throw new Error('This track is too short to animate.');

  // --- fill time / elevation / heart rate ---
  const hasTime = raw.filter((p) => p.time != null).length > N * 0.5;
  const hasEle = raw.filter((p) => p.ele != null).length > N * 0.5;
  const hasHr = raw.filter((p) => p.hr != null).length > N * 0.5;

  const rt = fillSeries(raw.map((p) => p.time));
  if (!hasTime) {
    // No timestamps (e.g. a planned route): assume a steady 4 km/h starting at 07:00 today.
    const start = new Date();
    start.setHours(7, 0, 0, 0);
    for (let i = 0; i < N; i++) rt[i] = start.getTime() + (rd[i] / (4000 / 3600)) * 1000;
  }
  const re = hasEle ? fillSeries(raw.map((p) => p.ele)) : new Float64Array(N);
  const rh = hasHr ? fillSeries(raw.map((p) => p.hr)) : new Float64Array(N).fill(NaN);

  // --- resample at even distance steps ---
  const step = clamp(total / 8000, 3, 25);
  const n = Math.ceil(total / step) + 1;
  const d = new Float64Array(n), x = new Float64Array(n), z = new Float64Array(n);
  const ele = new Float64Array(n), time = new Float64Array(n), hr = new Float32Array(n);
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = Math.min(k * step, total);
    while (j < N - 2 && rd[j + 1] < target) j++;
    const seg = rd[j + 1] - rd[j];
    const f = seg > 0 ? clamp((target - rd[j]) / seg, 0, 1) : 0;
    d[k] = target;
    x[k] = lerp(rx[j], rx[j + 1], f);
    z[k] = lerp(rz[j], rz[j + 1], f);
    ele[k] = lerp(re[j], re[j + 1], f);
    time[k] = lerp(rt[j], rt[j + 1], f);
    hr[k] = lerp(rh[j], rh[j + 1], f);
  }

  const xs = gaussian(x, Math.max(1, 10 / step));
  const zs = gaussian(z, Math.max(1, 10 / step));
  const eleS = gaussian(ele, 40 / step);

  // --- heading (heavily smoothed so the camera doesn't wobble) ---
  const hdx = new Float32Array(n), hdz = new Float32Array(n);
  {
    const w = Math.max(1, Math.round(150 / step));
    const ax = new Float64Array(n), az = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - w), b = Math.min(n - 1, i + w);
      const dx = xs[b] - xs[a], dz = zs[b] - zs[a];
      const l = Math.hypot(dx, dz) || 1;
      ax[i] = dx / l; az[i] = dz / l;
    }
    const sx = gaussian(ax, 350 / step), sz = gaussian(az, 350 / step);
    for (let i = 0; i < n; i++) {
      const l = Math.hypot(sx[i], sz[i]) || 1;
      hdx[i] = sx[i] / l; hdz[i] = sz[i] / l;
    }
  }

  // --- stops (from raw points: stayed within 40 m) ---
  const stops = findStops(rx, rz, rt, rd, 40, 5 * 60_000);

  // --- stats ---
  let ascent = 0, descent = 0;
  {
    let ref = eleS[0];
    for (let i = 1; i < n; i++) {
      const diff = eleS[i] - ref;
      if (diff > 5) { ascent += diff; ref = eleS[i]; }
      else if (diff < -5) { descent -= diff; ref = eleS[i]; }
    }
  }
  let maxEle = -Infinity, minEle = Infinity, maxIdx = 0;
  for (let i = 0; i < n; i++) {
    if (eleS[i] > maxEle) { maxEle = eleS[i]; maxIdx = i; }
    minEle = Math.min(minEle, eleS[i]);
  }
  let hrSum = 0, hrN = 0, hrMax = 0;
  if (hasHr) for (const v of rh) if (Number.isFinite(v)) { hrSum += v; hrN++; hrMax = Math.max(hrMax, v); }
  const duration = rt[N - 1] - rt[0];
  const stopped = stops.reduce((s, st) => s + st.duration, 0);

  const stats: TrackStats = {
    distance: total,
    duration,
    movingTime: Math.max(0, duration - stopped),
    ascent,
    descent,
    maxEle,
    minEle,
    avgHr: hrN ? hrSum / hrN : null,
    maxHr: hrN ? hrMax : null,
    startTime: rt[0],
    endTime: rt[N - 1],
  };

  // --- playback cost: mix of distance and (stop-capped) moving time, so steep climbs play slower ---
  const cost = new Float64Array(n);
  {
    const dts: number[] = [];
    for (let i = 0; i < n - 1; i++) dts.push(Math.max(0, time[i + 1] - time[i]));
    const sorted = [...dts].sort((a, b) => a - b);
    const cap = (sorted[Math.floor(sorted.length / 2)] || 1) * 4;
    const capped = dts.map((v) => Math.min(v, cap));
    const sumDt = capped.reduce((a, b) => a + b, 0) || 1;
    const wT = hasTime ? 0.45 : 0;
    for (let i = 0; i < n - 1; i++) {
      const dd = (d[i + 1] - d[i]) / total;
      cost[i + 1] = cost[i] + (1 - wT) * dd + wT * (capped[i] / sumDt);
    }
    const last = cost[n - 1] || 1;
    for (let i = 0; i < n; i++) cost[i] /= last;
  }

  // --- bounds ---
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, xs[i]); maxX = Math.max(maxX, xs[i]);
    minZ = Math.min(minZ, zs[i]); maxZ = Math.max(maxZ, zs[i]);
  }

  const track: Track = {
    n, step, d, x: xs, z: zs, ele: eleS, time, hr, hdx, hdz, cost,
    lat0, lon0, mLat, mLon, hasTime, hasHr, hasEle,
    bounds: { minX, maxX, minZ, maxZ },
    stats,
    checkpoints: [],
  };
  track.checkpoints = detectCheckpoints(track, maxIdx, stops);
  return track;
}

// ---------------------------------------------------------------------------

interface Stop { d: number; duration: number; time: number }

function findStops(rx: Float64Array, rz: Float64Array, rt: Float64Array, rd: Float64Array, radius: number, minMs: number): Stop[] {
  const out: Stop[] = [];
  const N = rx.length;
  let i = 0;
  while (i < N) {
    let j = i;
    while (j + 1 < N && Math.hypot(rx[j + 1] - rx[i], rz[j + 1] - rz[i]) < radius) j++;
    const dur = rt[j] - rt[i];
    if (dur >= minMs) {
      out.push({ d: rd[i], duration: dur, time: rt[i] });
      i = j + 1;
    } else i++;
  }
  return out;
}

function detectCheckpoints(t: Track, maxIdx: number, stops: Stop[]): Checkpoint[] {
  const { n, d, ele, time, stats } = t;
  const at = (i: number) => ({ d: d[i], ele: ele[i], time: time[i] });
  const cps: Checkpoint[] = [];

  cps.push({ id: 'start', kind: 'start', name: 'START', enabled: true, ...at(0) });

  const range = stats.maxEle - stats.minEle;
  const hasClimb = t.hasEle && range > 30;
  if (hasClimb) {
    cps.push({ id: 'summit', kind: 'summit', name: 'SUMMIT', enabled: true, ...at(maxIdx) });

    // Other peaks by topographic prominence along the profile.
    const minProm = Math.max(60, range * 0.06);
    const w = Math.max(1, Math.round(100 / t.step));
    const cands: { i: number; prom: number }[] = [];
    for (let i = 1; i < n - 1; i++) {
      let isMax = true;
      for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) {
        if (ele[k] > ele[i]) { isMax = false; break; }
      }
      if (!isMax || i === maxIdx) continue;
      let lMin = ele[i], rMin = ele[i];
      for (let k = i - 1; k >= 0 && ele[k] <= ele[i]; k--) lMin = Math.min(lMin, ele[k]);
      for (let k = i + 1; k < n && ele[k] <= ele[i]; k++) rMin = Math.min(rMin, ele[k]);
      const prom = ele[i] - Math.max(lMin, rMin);
      if (prom >= minProm) cands.push({ i, prom });
    }
    cands.sort((a, b) => b.prom - a.prom);
    const minSep = Math.max(800, stats.distance * 0.03);
    const chosen: number[] = [];
    for (const c of cands) {
      if (chosen.length >= 5) break;
      const dc = d[c.i];
      if (dc < 500 || stats.distance - dc < 500) continue;
      if (Math.abs(dc - d[maxIdx]) < minSep) continue;
      if (chosen.some((ci) => Math.abs(d[ci] - dc) < minSep)) continue;
      chosen.push(c.i);
    }
    chosen.sort((a, b) => a - b);
    chosen.forEach((ci, k) => {
      cps.push({ id: `peak${k}`, kind: 'peak', name: `PEAK ${k + 1}`, enabled: true, ...at(ci) });
    });
  }

  // Long rests (12+ min), the 4 longest, away from start/finish/peaks.
  const rests = stops
    .filter((s) => s.duration >= 12 * 60_000 && s.d > 300 && stats.distance - s.d > 300)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 4)
    .filter((s) => !cps.some((c) => Math.abs(c.d - s.d) < 300));
  rests.forEach((s, k) => {
    const i = Math.min(n - 1, Math.round(s.d / t.step));
    const min = Math.round(s.duration / 60_000);
    cps.push({ id: `rest${k}`, kind: 'rest', name: 'REST', enabled: true, restMin: min, ...at(i), time: s.time });
  });

  cps.push({ id: 'finish', kind: 'finish', name: 'FINISH', enabled: true, ...at(n - 1) });
  return cps.sort((a, b) => a.d - b.d);
}

// --- sampling helpers -------------------------------------------------------

export function indexAt(t: Track, dist: number): { i: number; f: number } {
  const dd = clamp(dist, 0, t.stats.distance);
  const i = Math.min(Math.floor(dd / t.step), t.n - 2);
  const seg = t.d[i + 1] - t.d[i];
  return { i, f: seg > 0 ? clamp((dd - t.d[i]) / seg, 0, 1) : 0 };
}

export function sampleAt(t: Track, arr: ArrayLike<number>, dist: number): number {
  const { i, f } = indexAt(t, dist);
  return lerp(arr[i], arr[i + 1], f);
}

/** Distance along the track at a given playback cost (0..1). */
export function distAtCost(t: Track, c: number): number {
  const cost = t.cost;
  let lo = 0, hi = t.n - 1;
  if (c <= 0) return 0;
  if (c >= 1) return t.stats.distance;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cost[mid] < c) lo = mid; else hi = mid;
  }
  const span = cost[hi] - cost[lo];
  const f = span > 0 ? (c - cost[lo]) / span : 0;
  return lerp(t.d[lo], t.d[hi], f);
}

// --- math ---------------------------------------------------------------

export function clamp(v: number, a: number, b: number) {
  return v < a ? a : v > b ? b : v;
}
export function lerp(a: number, b: number, f: number) {
  return a + (b - a) * f;
}

export function gaussian(src: ArrayLike<number>, sigma: number): Float64Array {
  const n = src.length;
  const out = new Float64Array(n);
  if (sigma < 0.5) {
    for (let i = 0; i < n; i++) out[i] = src[i];
    return out;
  }
  const r = Math.ceil(sigma * 3);
  const k = new Float64Array(2 * r + 1);
  for (let j = -r; j <= r; j++) k[j + r] = Math.exp(-(j * j) / (2 * sigma * sigma));
  for (let i = 0; i < n; i++) {
    let s = 0, ws = 0;
    for (let j = -r; j <= r; j++) {
      const idx = i + j;
      if (idx < 0 || idx >= n) continue;
      const w = k[j + r];
      s += src[idx] * w; ws += w;
    }
    out[i] = s / ws;
  }
  return out;
}

/** Fill nulls by linear interpolation (and nearest at the ends). */
function fillSeries(vals: (number | null)[]): Float64Array {
  const n = vals.length;
  const out = new Float64Array(n).fill(NaN);
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    if (v == null) continue;
    out[i] = v;
    if (prev >= 0 && i - prev > 1) {
      for (let k = prev + 1; k < i; k++) out[k] = lerp(out[prev], v, (k - prev) / (i - prev));
    } else if (prev < 0) {
      for (let k = 0; k < i; k++) out[k] = v;
    }
    prev = i;
  }
  if (prev >= 0) for (let k = prev + 1; k < n; k++) out[k] = out[prev];
  return out;
}
