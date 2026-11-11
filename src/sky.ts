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
  { e: -18, top: C.ink, bottom: C.ink2, sun: [0.32, 0.36, 0.6], amb: [0.26, 0.28, 0.44], stars: 1, lamp: 1 },
  { e: -9, top: C.ink2, bottom: C.plum, sun: [0.38, 0.36, 0.6], amb: [0.3, 0.3, 0.46], stars: 0.7, lamp: 1 },
  { e: -3, top: C.dusk, bottom: C.pink, sun: [0.75, 0.55, 0.55], amb: [0.42, 0.38, 0.5], stars: 0, lamp: 0.5 },
  { e: 3, top: C.sky, bottom: C.orange, sun: [1.0, 0.75, 0.52], amb: [0.5, 0.47, 0.52], stars: 0, lamp: 0 },
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
