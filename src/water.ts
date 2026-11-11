import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { BBox } from './dem';
import { C } from './palette';
import { litMaterial, type Terrain } from './terrain';
import type { Track } from './track';

/**
 * Rivers, streams, lakes and roads from OpenStreetMap (© OpenStreetMap contributors, ODbL), fetched from
 * the public Overpass API for the diorama's area only, and cached in the browser per area.
 */

/** road = main road, minor = local tar road (residential / unclassified / service), track = dirt / 4WD. */
export type LineKind = 'river' | 'stream' | 'canal' | 'road' | 'minor' | 'track';
export interface WaterLine { name: string; kind: LineKind; pts: [number, number][] } // [lat, lon]
export interface WaterArea { name: string; ring: [number, number][] }
export interface WaterData { lines: WaterLine[]; areas: WaterArea[] }

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

export async function loadWater(b: BBox): Promise<WaterData> {
  const key = `pixelhike:water:v2:${[b.minLat, b.minLon, b.maxLat, b.maxLon].map((v) => v.toFixed(3)).join(',')}`;
  try {
    const hit = localStorage.getItem(key);
    if (hit) return JSON.parse(hit) as WaterData;
  } catch { /* storage unavailable */ }

  const bb = `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}`;
  const query = `[out:json][timeout:40];(way["waterway"~"^(river|stream|canal)$"](${bb});way["natural"="water"](${bb});relation["natural"="water"](${bb});way["highway"~"^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|unclassified|residential|living_street|service|track)$"](${bb}););out tags geom;`;
  let json: OverpassResult | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2 && !json; attempt++) {
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(45_000) });
        if (!res.ok) throw new Error(`${res.status}`);
        json = (await res.json()) as OverpassResult;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!json) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!json) throw lastErr ?? new Error('Overpass unavailable');

  const data = parse(json);
  try {
    const s = JSON.stringify(data);
    if (s.length < 3_000_000) localStorage.setItem(key, s);
  } catch { /* full — fine, just not cached */ }
  return data;
}

interface OsmPoint { lat: number; lon: number }
interface OsmElement {
  type: 'way' | 'relation';
  tags?: Record<string, string>;
  geometry?: OsmPoint[];
  members?: { type: string; role: string; geometry?: OsmPoint[] }[];
}
interface OverpassResult { elements: OsmElement[] }

function parse(res: OverpassResult): WaterData {
  const lines: WaterLine[] = [];
  const areas: WaterArea[] = [];
  const pts = (g: OsmPoint[]) => g.map((p) => [r5(p.lat), r5(p.lon)] as [number, number]);
  for (const e of res.elements) {
    const t = e.tags ?? {};
    if (t.water === 'wastewater') continue;
    const name = t.name ?? '';
    if (e.type === 'way' && t.highway && e.geometry?.length) {
      if (t.service === 'parking_aisle' || t.service === 'driveway' || t.access === 'private') continue;
      lines.push({ name, kind: roadKind(t), pts: pts(e.geometry) });
    } else if (e.type === 'way' && t.waterway && e.geometry?.length) {
      lines.push({ name, kind: t.waterway as WaterLine['kind'], pts: pts(e.geometry) });
    } else if (e.type === 'way' && t.natural === 'water' && e.geometry && e.geometry.length > 3) {
      areas.push({ name, ring: pts(e.geometry) });
    } else if (e.type === 'relation' && t.natural === 'water') {
      for (const ring of stitch((e.members ?? []).filter((m) => m.role === 'outer' && m.geometry?.length).map((m) => pts(m.geometry!)))) {
        if (ring.length > 3) areas.push({ name, ring });
      }
    }
  }
  return { lines, areas };
}

const UNPAVED = new Set(['unpaved', 'dirt', 'gravel', 'ground', 'earth', 'mud', 'sand', 'grass', 'compacted', 'fine_gravel']);
const PAVED = new Set(['asphalt', 'paved', 'concrete', 'concrete:plates', 'paving_stones', 'chipseal', 'sett']);
/** Local roads in OSM rarely say their surface; around villages in Malaysia they're nearly always tar. */
function roadKind(t: Record<string, string>): LineKind {
  const h = t.highway;
  if (h === 'track') return PAVED.has(t.surface) ? 'minor' : 'track';
  if (UNPAVED.has(t.surface)) return 'track';
  if (/^(motorway|trunk|primary|secondary|tertiary)/.test(h)) return 'road';
  return 'minor';
}

/** Joins multipolygon member ways end-to-end into closed rings. */
function stitch(parts: [number, number][][]): [number, number][][] {
  const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
  const rings: [number, number][][] = [];
  const left = parts.map((p) => [...p]);
  while (left.length) {
    let ring = left.shift()!;
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i];
        const end = ring[ring.length - 1];
        if (same(p[0], end)) ring = ring.concat(p.slice(1));
        else if (same(p[p.length - 1], end)) ring = ring.concat([...p].reverse().slice(1));
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    rings.push(ring);
  }
  return rings;
}

// ---------------------------------------------------------------- 3D

export interface WaterScene {
  group: THREE.Group;
  /** Track distances where the route crosses a named river or stream (for "SUNGAI KINTA" toasts). */
  crossings: { name: string; d: number }[];
  /** Line materials, so the renderer can dim them at night and keep their pixel width. */
  lineMats: { mat: LineMaterial; kind: DrawKind }[];
  dispose(): void;
}

type DrawKind = 'river' | 'stream' | 'road' | 'minor' | 'track';
const DRAW: Record<DrawKind, { day: string; night: string; px: number; clear: number }> = {
  track: { day: C.tan, night: C.brownDark, px: 1, clear: 0.25 },
  minor: { day: C.rock, night: C.night, px: 1, clear: 0.3 },
  road: { day: C.greyLight, night: C.rockDark, px: 2, clear: 0.45 },
  stream: { day: C.skyLight, night: C.night, px: 1, clear: 0.3 },
  river: { day: C.sky, night: C.dusk, px: 2, clear: 0.55 },
};
export const drawColor = (k: DrawKind, night: boolean) => (night ? DRAW[k].night : DRAW[k].day);

export function buildWater(data: WaterData, track: Track, terrain: Terrain, W: number, H: number): WaterScene {
  const group = new THREE.Group();
  const toXZ = (lat: number, lon: number) => [(lon - track.lon0) * track.mLon, -(lat - track.lat0) * track.mLat] as [number, number];
  const b = terrain.bounds;
  const inside = (x: number, z: number) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1;
  const s = terrain.spacing;
  const lift = s * 0.14;

  // rivers / streams: crisp 1–2 px lines draped on the terrain
  const segs: Record<DrawKind, number[]> = { river: [], stream: [], road: [], minor: [], track: [] };
  const xzLines: { name: string; pts: [number, number][] }[] = [];
  for (const l of data.lines) {
    const kind: DrawKind = l.kind === 'canal' ? 'river' : l.kind;
    const xz = l.pts.map(([la, lo]) => toXZ(la, lo));
    if (l.name && (kind === 'river' || kind === 'stream')) xzLines.push({ name: l.name, pts: xz });
    const out = segs[kind];
    for (let i = 1; i < xz.length; i++) {
      const [ax, az] = xz[i - 1], [bx, bz] = xz[i];
      if (!inside(ax, az) || !inside(bx, bz)) continue;
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (s / 3)));
      for (let k = 0; k < n; k++) {
        const x0 = ax + ((bx - ax) * k) / n, z0 = az + ((bz - az) * k) / n;
        const x1 = ax + ((bx - ax) * (k + 1)) / n, z1 = az + ((bz - az) * (k + 1)) / n;
        out.push(x0, terrain.worldY(x0, z0) + lift, z0, x1, terrain.worldY(x1, z1) + lift, z1);
      }
    }
  }
  // rivers and roads cut gaps in the canopy
  for (const k of Object.keys(DRAW) as DrawKind[]) clearBanks(terrain, segs[k], s * DRAW[k].clear);

  const lineMats: WaterScene['lineMats'] = [];
  for (const kind of ['track', 'minor', 'road', 'stream', 'river'] as const) {
    if (!segs[kind].length) continue;
    const g = new LineSegmentsGeometry();
    g.setPositions(segs[kind]);
    const mat = new LineMaterial({ color: new THREE.Color(DRAW[kind].day).getHex(), linewidth: DRAW[kind].px, worldUnits: false });
    mat.resolution.set(W, H);
    const line = new LineSegments2(g, mat);
    line.frustumCulled = false;
    line.renderOrder = 2;
    group.add(line);
    lineMats.push({ mat, kind });
  }

  // lakes / reservoirs: flat lit surfaces at the lowest shore height
  const lake = litMaterial(C.sky);
  for (const a of data.areas) {
    const ring = a.ring.map(([la, lo]) => toXZ(la, lo));
    if (!ring.some(([x, z]) => inside(x, z))) continue;
    const area = Math.abs(ring.reduce((acc, [x, z], i) => {
      const [x2, z2] = ring[(i + 1) % ring.length];
      return acc + x * z2 - x2 * z;
    }, 0)) / 2;
    if (area < s * s * 0.5) continue; // too small to see
    const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
    if (contour.length > 2 && contour[0].equals(contour[contour.length - 1])) contour.pop();
    let tris: number[][];
    try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch { continue; }
    let y = Infinity;
    for (const [x, z] of ring) y = Math.min(y, terrain.worldY(x, z));
    const pos: number[] = [];
    for (const t of tris) for (const i of t) pos.push(contour[i].x, y + lift * 0.5, contour[i].y);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.Mesh(g, lake);
    m.renderOrder = 1;
    group.add(m);
  }

  return {
    group,
    crossings: findCrossings(xzLines, track),
    lineMats,
    dispose() {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      lineMats.forEach((l) => l.mat.dispose());
      lake.dispose();
    },
  };
}

/** Rivers cut gaps in the canopy: hide trees standing within `r` of a water line. */
function clearBanks(terrain: Terrain, segs: number[], r: number) {
  if (!segs.length) return;
  const cell = r * 2;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < segs.length; i += 6) {
    const k = `${Math.floor(segs[i] / cell)},${Math.floor(segs[i + 2] / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  }
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (const mesh of terrain.trees) {
    let changed = false;
    for (let t = 0; t < mesh.count; t++) {
      mesh.getMatrixAt(t, m);
      m.decompose(p, q, sc);
      if (sc.x === 0) continue;
      const kx = Math.floor(p.x / cell), kz = Math.floor(p.z / cell);
      let near = false;
      for (let dx = -1; dx <= 1 && !near; dx++) for (let dz = -1; dz <= 1 && !near; dz++) {
        for (const i of grid.get(`${kx + dx},${kz + dz}`) ?? []) {
          if (distSeg(p.x, p.z, segs[i], segs[i + 2], segs[i + 3], segs[i + 5]) < r) { near = true; break; }
        }
      }
      if (near) { mesh.setMatrixAt(t, zero); changed = true; }
    }
    if (changed) mesh.instanceMatrix.needsUpdate = true;
  }
}

function distSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const vx = bx - ax, vz = bz - az;
  const l2 = vx * vx + vz * vz;
  const u = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / l2)) : 0;
  return Math.hypot(px - ax - vx * u, pz - az - vz * u);
}

/** Where the route crosses each named river/stream (each name at most once per 15 km). */
function findCrossings(lines: { name: string; pts: [number, number][] }[], t: Track) {
  const cell = 250;
  const grid = new Map<string, number[]>();
  const stride = Math.max(1, Math.round(20 / t.step));
  for (let i = 0; i + stride < t.n; i += stride) {
    const kx = Math.floor(t.x[i] / cell), kz = Math.floor(t.z[i] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const k = `${kx + dx},${kz + dz}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    }
  }
  const hits: { name: string; d: number }[] = [];
  for (const l of lines) {
    for (let j = 1; j < l.pts.length; j++) {
      const [ax, az] = l.pts[j - 1], [bx, bz] = l.pts[j];
      const cand = grid.get(`${Math.floor(ax / cell)},${Math.floor(az / cell)}`);
      if (!cand) continue;
      for (const i of cand) {
        const i2 = Math.min(t.n - 1, i + stride);
        const u = segX(ax, az, bx, bz, t.x[i], t.z[i], t.x[i2], t.z[i2]);
        if (u != null) hits.push({ name: l.name, d: t.d[i] + (t.d[i2] - t.d[i]) * u });
      }
    }
  }
  hits.sort((a, b) => a.d - b.d);
  const out: typeof hits = [];
  for (const h of hits) if (!out.some((o) => o.name === h.name && Math.abs(o.d - h.d) < 15000)) out.push(h);
  return out;
}

/** Fraction along segment C→D where it crosses A→B, or null. */
function segX(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number) {
  const r1 = bx - ax, r2 = bz - az, s1 = dx - cx, s2 = dz - cz;
  const den = r1 * s2 - r2 * s1;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * s2 - (cz - az) * s1) / den;
  const u = ((cx - ax) * r2 - (cz - az) * r1) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? u : null;
}

// ---------------------------------------------------------------- route surface

export type Surface = 'road' | 'track' | 'trail';
export interface SurfaceInfo {
  runs: { d0: number; d1: number; kind: Surface }[];
  km: Record<Surface, number>;
}

/** Which parts of the route follow a tar road, a dirt track, or neither (= trail). */
export function routeSurface(data: WaterData, track: Track): SurfaceInfo {
  const toXZ = (lat: number, lon: number) => [(lon - track.lon0) * track.mLon, -(lat - track.lat0) * track.mLat] as [number, number];
  const cell = 60, near = 22;
  const grid = new Map<string, [number, number, number, number, Surface][]>();
  for (const l of data.lines) {
    if (l.kind !== 'road' && l.kind !== 'minor' && l.kind !== 'track') continue;
    const kind: Surface = l.kind === 'track' ? 'track' : 'road';
    const xz = l.pts.map(([la, lo]) => toXZ(la, lo));
    for (let i = 1; i < xz.length; i++) {
      const [ax, az] = xz[i - 1], [bx, bz] = xz[i];
      const seg: [number, number, number, number, Surface] = [ax, az, bx, bz, kind];
      const x0 = Math.floor((Math.min(ax, bx) - near) / cell), x1 = Math.floor((Math.max(ax, bx) + near) / cell);
      const z0 = Math.floor((Math.min(az, bz) - near) / cell), z1 = Math.floor((Math.max(az, bz) + near) / cell);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 400) continue;
      for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
        const k = `${gx},${gz}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(seg);
      }
    }
  }
  const stride = Math.max(1, Math.round(10 / track.step));
  const samples: { d: number; kind: Surface }[] = [];
  for (let i = 0; i < track.n; i += stride) {
    const x = track.x[i], z = track.z[i];
    let best = near, kind: Surface = 'trail';
    for (const [ax, az, bx, bz, k] of grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []) {
      const dd = distSeg(x, z, ax, az, bx, bz);
      if (dd < best) { best = dd; kind = k; }
    }
    samples.push({ d: track.d[i], kind });
  }
  // runs, with blips under 150 m absorbed by their neighbours
  let runs: SurfaceInfo['runs'] = [];
  for (const smp of samples) {
    const last = runs[runs.length - 1];
    if (last && last.kind === smp.kind) last.d1 = smp.d;
    else runs.push({ d0: last ? last.d1 : 0, d1: smp.d, kind: smp.kind });
  }
  const merged: SurfaceInfo['runs'] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && (r.d1 - r.d0 < 150 || last.kind === r.kind)) last.d1 = r.d1;
    else merged.push({ ...r });
  }
  runs = merged;
  if (runs.length) runs[runs.length - 1].d1 = track.stats.distance;
  const km: Record<Surface, number> = { road: 0, track: 0, trail: 0 };
  for (const r of runs) km[r.kind] += ((r.d1 - r.d0) * track.distScale) / 1000;
  return { runs, km };
}
