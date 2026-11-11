import { C, rgb01 } from './palette';

type V3 = [number, number, number];

/** Sun position (radians). Azimuth measured clockwise from north. Good to ~0.5°. */
export function sunPosition(ms: number, lat: number, lon: number): { elevation: number; azimuth: number } {
  const rad = Math.PI / 180;
  const d = ms / 86400000 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  const ha = gmst * 15 * rad + lon * rad - ra;
  const la = lat * rad;
  const elevation = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  const azimuth = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
  return { elevation, azimuth };
}

export interface SkyState {
  top: V3;
  bottom: V3;
  sunColor: V3;
  ambient: V3;
  lightDir: V3; // towards the light, local frame (x east, y up, z south)
  stars: number;
  lamp: number; // headlamp strength 0..1
  isNight: boolean;
}

interface Stop {
  e: number; // sun elevation, degrees
  top: string;
  bottom: string;
  sun: V3;
  amb: V3;
  stars: number;
  lamp: number;
}

const STOPS: Stop[] = [
  { e: -18, top: C.ink, bottom: C.ink2, sun: [0.2, 0.25, 0.4], amb: [0.17, 0.21, 0.32], stars: 1, lamp: 1 },
  { e: -9, top: C.ink2, bottom: C.plum, sun: [0.28, 0.28, 0.46], amb: [0.24, 0.25, 0.38], stars: 0.7, lamp: 1 },
  { e: -3, top: C.dusk, bottom: C.pink, sun: [0.7, 0.55, 0.55], amb: [0.5, 0.48, 0.55], stars: 0, lamp: 0.5 },
  { e: 3, top: C.sky, bottom: C.orange, sun: [0.8, 0.62, 0.46], amb: [0.66, 0.64, 0.62], stars: 0, lamp: 0 },
  { e: 14, top: C.sky, bottom: C.skyPale, sun: [0.62, 0.6, 0.52], amb: [0.68, 0.7, 0.7], stars: 0, lamp: 0 },
];

const mix3 = (a: V3, b: V3, f: number): V3 => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];

export function skyAt(ms: number, lat: number, lon: number): SkyState {
  const { elevation, azimuth } = sunPosition(ms, lat, lon);
  const eDeg = (elevation * 180) / Math.PI;

  let k = 0;
  while (k < STOPS.length - 2 && eDeg > STOPS[k + 1].e) k++;
  const a = STOPS[k], b = STOPS[k + 1];
  const f = Math.min(1, Math.max(0, (eDeg - a.e) / (b.e - a.e)));

  // Light direction: sun (kept a bit high so slopes still read) blended with a fixed "moon".
  const sunEl = Math.max(elevation, (18 * Math.PI) / 180);
  const sunDir: V3 = [Math.sin(azimuth) * Math.cos(sunEl), Math.sin(sunEl), -Math.cos(azimuth) * Math.cos(sunEl)];
  const mEl = (45 * Math.PI) / 180, mAz = (225 * Math.PI) / 180;
  const moonDir: V3 = [Math.sin(mAz) * Math.cos(mEl), Math.sin(mEl), -Math.cos(mAz) * Math.cos(mEl)];
  const w = Math.min(1, Math.max(0, (eDeg + 8) / 7));
  const ld = mix3(moonDir, sunDir, w);
  const l = Math.hypot(...ld);

  return {
    top: mix3(rgb01(a.top), rgb01(b.top), f),
    bottom: mix3(rgb01(a.bottom), rgb01(b.bottom), f),
    sunColor: mix3(a.sun, b.sun, f),
    ambient: mix3(a.amb, b.amb, f),
    lightDir: [ld[0] / l, ld[1] / l, ld[2] / l],
    stars: a.stars + (b.stars - a.stars) * f,
    lamp: a.lamp + (b.lamp - a.lamp) * f,
    isNight: eDeg < -4,
  };
}

// ---------------------------------------------------------------------------
// Moon (low-precision formulas after SunCalc, BSD-2 © Vladimir Agafonkin)

const RAD = Math.PI / 180;
const OBLIQ = RAD * 23.4397;
const daysJ2000 = (ms: number) => ms / 86400000 - 10957.5;
const raOf = (l: number, b: number) => Math.atan2(Math.sin(l) * Math.cos(OBLIQ) - Math.tan(b) * Math.sin(OBLIQ), Math.cos(l));
const decOf = (l: number, b: number) => Math.asin(Math.sin(b) * Math.cos(OBLIQ) + Math.cos(b) * Math.sin(OBLIQ) * Math.sin(l));

function sunCoords(d: number) {
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  return { dec: decOf(L, 0), ra: raOf(L, 0) };
}

function moonCoords(d: number) {
  const L = RAD * (218.316 + 13.176396 * d);
  const M = RAD * (134.963 + 13.064993 * d);
  const F = RAD * (93.272 + 13.22935 * d);
  const l = L + RAD * 6.289 * Math.sin(M);
  const b = RAD * 5.128 * Math.sin(F);
  return { ra: raOf(l, b), dec: decOf(l, b), dist: 385001 - 20905 * Math.cos(M) };
}

/** Moon elevation/azimuth (radians, azimuth clockwise from north). */
export function moonPosition(ms: number, lat: number, lon: number) {
  const d = daysJ2000(ms);
  const c = moonCoords(d);
  const H = RAD * (280.16 + 360.9856235 * d) + RAD * lon - c.ra;
  const phi = RAD * lat;
  const elevation = Math.asin(Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H));
  const azimuth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(c.dec) * Math.cos(phi)) + Math.PI;
  return { elevation, azimuth };
}

/** 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter. */
export function moonPhase(ms: number): number {
  const d = daysJ2000(ms);
  const s = sunCoords(d), m = moonCoords(d), sdist = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(
    Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra),
  );
  return 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI;
}

export interface SunEvent { kind: 'sunrise' | 'sunset'; ms: number }

/** Sunrise / sunset moments between two times (sun centre crossing -0.833°). */
export function sunEvents(fromMs: number, toMs: number, lat: number, lon: number): SunEvent[] {
  const h0 = -0.833 * RAD;
  const f = (ms: number) => sunPosition(ms, lat, lon).elevation - h0;
  const out: SunEvent[] = [];
  const step = 5 * 60_000;
  let prevT = fromMs, prevV = f(fromMs);
  for (let t = fromMs + step; t <= toMs + step; t += step) {
    const v = f(t);
    if (Math.sign(v) !== Math.sign(prevV)) {
      let a = prevT, b = t;
      for (let k = 0; k < 20; k++) {
        const m = (a + b) / 2;
        if (Math.sign(f(m)) === Math.sign(prevV)) a = m; else b = m;
      }
      out.push({ kind: v > 0 ? 'sunrise' : 'sunset', ms: (a + b) / 2 });
    }
    prevT = t; prevV = v;
  }
  return out;
}
