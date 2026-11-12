import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { cacheGet, cacheSet } from './cache';
import type { BBox } from './dem';
import { loadTiles } from './osmtiles';
import { C, rgb01 } from './palette';
import { LIGHT_GLSL, litMaterial, shared, type Terrain } from './terrain';
import { buildFalls, type FallSite } from './falls3d';
import { clamp, sampleAt, type Track } from './track';

/**
 * Rivers, streams, lakes, roads and a few landmarks (waterfalls, viewpoints, peaks, camps, springs)
 * from OpenStreetMap (© OpenStreetMap contributors, ODbL) for the diorama's area only.
 *
 * Where it comes from, fastest first:
 *  1. this browser's cache (IndexedDB) — a route opened before needs no network;
 *  2. a baked copy next to the private sample (public/samples/map-<area>.json, dev only);
 *  3. pre-cut vector tiles (osmtiles.ts) — a second or two — plus a tiny Overpass query for the
 *     springs and waterfalls the tiles leave out (in the background, never blocking);
 *  4. the full live Overpass query, if the tile server is down.
 */

/**
 * road = main road, minor = local tar road (unclassified / tertiary-ish), street = residential /
 * service lanes (only drawn near the route), track = dirt / 4WD.
 */
export type LineKind = 'river' | 'stream' | 'canal' | 'road' | 'minor' | 'street' | 'track';
/** `w` = width in metres when OSM knows it. */
export interface WaterLine { name: string; kind: LineKind; pts: [number, number][]; w?: number } // [lat, lon]
/** `group`: pieces of one lake cut at tile edges share it, so they get one water level. */
export interface WaterArea { name: string; ring: [number, number][]; group?: string }
export type PoiKind = 'waterfall' | 'viewpoint' | 'peak' | 'camp' | 'spring';
export interface Poi { kind: PoiKind; name: string; lat: number; lon: number; ele?: number }
/** `extras`: false while springs/waterfalls (not in the tiles) are still to be fetched. */
export interface WaterData { lines: WaterLine[]; areas: WaterArea[]; pois: Poi[]; extras?: boolean }

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

export const mapAreaKey = (b: BBox) => [b.minLat, b.minLon, b.maxLat, b.maxLon].map((v) => v.toFixed(3)).join('_');

export interface LoadOptions {
  onProgress?: (done: number, total: number) => void;
  /** Called later if springs/waterfalls arrive after the map was already returned. */
  onExtras?: (data: WaterData) => void;
}

export async function loadWater(b: BBox, opts: LoadOptions = {}): Promise<WaterData> {
  dropOldCache();
  const area = mapAreaKey(b);
  const key = `pixelhike:map:v4:${area}`;

  let data = (await cacheGet<WaterData>(key)) ?? (await baked(area));
  if (data) {
    if (!data.extras) void addExtras(b, data, key, opts);
    else void cacheSet(key, data);
    return data;
  }

  let tiles: WaterData | null = null;
  const extras = fetchExtras(b); // in parallel with the tiles
  try {
    tiles = await loadTiles(b, opts.onProgress);
  } catch (e) {
    console.warn('Map tiles unavailable, asking Overpass instead', e);
  }
  if (!tiles) {
    data = await loadOverpass(b);
    void cacheSet(key, data);
    return data;
  }
  // springs/waterfalls usually land at about the same time; don't hold the map back for long
  const quick = await Promise.race([extras, new Promise<null>((r) => setTimeout(() => r(null), 2500))]);
  data = { ...tiles, extras: false };
  if (quick) mergeExtras(data, quick);
  else void addExtras(b, data, key, opts, extras);
  void cacheSet(key, data);
  return data;
}

async function baked(area: string): Promise<WaterData | undefined> {
  if (!import.meta.env.DEV) return undefined;
  try {
    const r = await fetch(`/samples/map-${area}.json`);
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return undefined;
    return (await r.json()) as WaterData;
  } catch {
    return undefined;
  }
}

function dropOldCache() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith('pixelhike:water:')) localStorage.removeItem(k); // moved to IndexedDB
    }
  } catch { /* storage unavailable */ }
}

async function addExtras(b: BBox, data: WaterData, key: string, opts: LoadOptions, pending = fetchExtras(b)) {
  const pois = await pending;
  if (!pois) return; // try again next time the route is opened
  mergeExtras(data, pois);
  void cacheSet(key, data);
  opts.onExtras?.(data);
}

function mergeExtras(data: WaterData, pois: Poi[]) {
  for (const p of pois) {
    const dup = data.pois.some((q) => q.kind === p.kind && Math.abs(q.lat - p.lat) < 5e-4 && Math.abs(q.lon - p.lon) < 5e-4);
    if (!dup) data.pois.push(p);
  }
  data.extras = true;
}

/** Springs and waterfalls: the vector tiles don't carry them. A points-only query — light and quick. */
async function fetchExtras(b: BBox): Promise<Poi[] | null> {
  const bb = `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}`;
  const query = `[out:json][timeout:20];(node["waterway"="waterfall"](${bb});node["natural"~"^(spring|waterfall)$"](${bb}););out;`;
  // the public servers are often "at capacity" for a minute or two: back off and try again
  for (let round = 0; round < 4; round++) {
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(25_000) });
        if (!res.ok) throw new Error(`${res.status}`);
        return parse((await res.json()) as OverpassResult).pois;
      } catch { /* next server */ }
    }
    await new Promise((r) => setTimeout(r, 5000 * 2 ** round));
  }
  return null;
}

async function loadOverpass(b: BBox): Promise<WaterData> {
  const bb = `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}`;
  const query = `[out:json][timeout:60];(` +
    `way["waterway"~"^(river|stream|canal)$"](${bb});way["natural"="water"](${bb});relation["natural"="water"](${bb});` +
    `way["highway"~"^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|unclassified|residential|living_street|service|track)$"](${bb});` +
    `node["waterway"="waterfall"](${bb});node["natural"~"^(peak|spring|waterfall)$"](${bb});` +
    `node["tourism"~"^(viewpoint|camp_site)$"](${bb});way["tourism"="camp_site"](${bb});` +
    `);out tags geom;`;
  let json: OverpassResult | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3 && !json; attempt++) {
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(65_000) });
        if (!res.ok) throw new Error(`${res.status}`);
        json = (await res.json()) as OverpassResult;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!json) await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
  }
  if (!json) throw lastErr ?? new Error('Overpass unavailable');
  return { ...parse(json), extras: true };
}

interface OsmPoint { lat: number; lon: number }
interface OsmElement {
  type: 'node' | 'way' | 'relation';
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: OsmPoint[];
  members?: { type: string; role: string; geometry?: OsmPoint[] }[];
}
interface OverpassResult { elements: OsmElement[] }

function parse(res: OverpassResult): WaterData {
  const lines: WaterLine[] = [];
  const areas: WaterArea[] = [];
  const pois: Poi[] = [];
  const pts = (g: OsmPoint[]) => g.map((p) => [r5(p.lat), r5(p.lon)] as [number, number]);
  for (const e of res.elements) {
    const t = e.tags ?? {};
    if (t.water === 'wastewater') continue;
    const name = t.name ?? t['name:en'] ?? '';
    const poi = poiKind(t);
    if (poi) {
      let lat = e.lat, lon = e.lon;
      if (e.type === 'way' && e.geometry?.length) {
        lat = e.geometry.reduce((s, p) => s + p.lat, 0) / e.geometry.length;
        lon = e.geometry.reduce((s, p) => s + p.lon, 0) / e.geometry.length;
      }
      if (lat == null || lon == null) continue;
      const ele = parseFloat(t.ele);
      pois.push({ kind: poi, name, lat: r5(lat), lon: r5(lon), ...(Number.isFinite(ele) ? { ele } : {}) });
    } else if (e.type === 'way' && t.highway && e.geometry?.length) {
      if (t.service === 'parking_aisle' || t.service === 'driveway' || t.access === 'private') continue;
      lines.push({ name, kind: roadKind(t), pts: pts(e.geometry) });
    } else if (e.type === 'way' && t.waterway && e.geometry?.length) {
      const w = parseFloat(t.width);
      lines.push({ name, kind: t.waterway as WaterLine['kind'], pts: pts(e.geometry), ...(w > 0 && w < 500 ? { w } : {}) });
    } else if (e.type === 'way' && t.natural === 'water' && e.geometry && e.geometry.length > 3) {
      areas.push({ name, ring: pts(e.geometry) });
    } else if (e.type === 'relation' && t.natural === 'water') {
      for (const ring of stitch((e.members ?? []).filter((m) => m.role === 'outer' && m.geometry?.length).map((m) => pts(m.geometry!)))) {
        if (ring.length > 3) areas.push({ name, ring });
      }
    }
  }
  return { lines, areas, pois };
}

function poiKind(t: Record<string, string>): PoiKind | null {
  if (t.waterway === 'waterfall' || t.natural === 'waterfall') return 'waterfall';
  if (t.tourism === 'viewpoint') return 'viewpoint';
  if (t.tourism === 'camp_site') return 'camp';
  if (t.natural === 'peak') return 'peak';
  if (t.natural === 'spring') return 'spring';
  return null;
}

const UNPAVED = new Set(['unpaved', 'dirt', 'gravel', 'ground', 'earth', 'mud', 'sand', 'grass', 'compacted', 'fine_gravel']);
const PAVED = new Set(['asphalt', 'paved', 'concrete', 'concrete:plates', 'paving_stones', 'chipseal', 'sett']);
/** Local roads in OSM rarely say their surface; around villages in Malaysia they're nearly always tar. */
function roadKind(t: Record<string, string>): LineKind {
  const h = t.highway;
  if (h === 'track') return PAVED.has(t.surface) ? 'minor' : 'track';
  if (UNPAVED.has(t.surface)) return 'track';
  if (/^(motorway|trunk|primary|secondary|tertiary)/.test(h)) return 'road';
  if (h === 'residential' || h === 'living_street' || h === 'service') return 'street';
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

/** World-space spots the overlay decorates each frame (see PixelRenderer.mapFrame). */
export interface MapSprites {
  /** Where the route crosses a river (or a stream on a road): a little bridge. */
  bridges: { x: number; y: number; z: number; d: number }[];
  /** Street lights along roads near the route (x, y, z triples), lit at night. */
  lamps: Float32Array;
  /** Roads near the route that vehicles drive along. */
  paths: { pts: Float32Array; cum: Float32Array; len: number; cx: number; cz: number; r: number; main: boolean }[];
  /** Steep stretches of stream: white water (x, y, z triples). */
  rapids: Float32Array;
  /** Landmarks; `d` = distance along the route when it's right beside the trail, else null. */
  pois: { kind: PoiKind; name: string; x: number; y: number; z: number; d: number | null; near: { d: number; off: number } }[];
}

export interface WaterScene {
  group: THREE.Group;
  /** Track distances where the route crosses a named river or stream (for "SUNGAI KINTA" toasts). */
  crossings: { name: string; d: number }[];
  /** Line materials with their day / night colours (the renderer swaps them at dusk). */
  lineMats: { mat: LineMaterial; day: string; night: string }[];
  /** River surface uniforms: glint strength + colour (sun sparkle by day, moonlight at night). */
  river: { uGlint: { value: number }; uGlintThr: { value: number }; uGlintCol: { value: THREE.Vector3 } } | null;
  sprites: MapSprites;
  /** 3D waterfalls built into the terrain (shown in the 3D view with landmarks on). */
  falls: THREE.Group | null;
  dispose(): void;
}

type DrawKind = 'river' | 'stream' | 'road' | 'minor' | 'street' | 'track';
/**
 * Lines are drawn in layers so they read as pixel-art map features: a main road is a dark 3-px band
 * with a grey core and a dashed centre line; dirt tracks are dotted; rivers also get a real-width
 * surface (see riverRibbon) that takes over when the camera is close enough for it to be wider.
 */
const LAYERS: { kind: DrawKind; day: string; night: string; px: number; dash?: [number, number]; order: number }[] = [
  { kind: 'street', day: C.rock, night: C.ink2, px: 1, order: 2 },
  { kind: 'track', day: C.tan, night: C.brownDark, px: 1, dash: [22, 12], order: 2 },
  { kind: 'minor', day: C.rock, night: C.night, px: 1, order: 2 },
  { kind: 'road', day: C.rockDark, night: C.ink2, px: 3, order: 3 },
  { kind: 'road', day: C.rock, night: C.night, px: 1, order: 4 },
  { kind: 'road', day: C.cream, night: C.rockDark, px: 1, dash: [14, 20], order: 5 },
  { kind: 'stream', day: C.skyLight, night: C.night, px: 1, order: 2 },
  { kind: 'river', day: C.sky, night: C.dusk, px: 2, order: 2 },
];
/** Canopy cleared either side of each kind, × terrain spacing. */
const CLEAR: Record<DrawKind, number> = { track: 0.25, street: 0.3, minor: 0.3, road: 0.45, stream: 0.3, river: 0.55 };
/** Residential lanes / service roads are only drawn this close to the route (the town grid gets busy). */
const STREET_NEAR = 900;

export function buildWater(data: WaterData, track: Track, terrain: Terrain, W: number, H: number): WaterScene {
  const group = new THREE.Group();
  const toXZ = (lat: number, lon: number) => [(lon - track.lon0) * track.mLon, -(lat - track.lat0) * track.mLat] as [number, number];
  const b = terrain.bounds;
  const inside = (x: number, z: number) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1;
  const s = terrain.spacing;
  const lift = s * 0.14;
  const near = routeProximity(track);

  const segs: Record<DrawKind, number[]> = { river: [], stream: [], road: [], minor: [], street: [], track: [] };
  const named: { name: string; pts: [number, number][] }[] = [];
  const crossable: { pts: [number, number][]; river: boolean }[] = [];
  const ribbons: { pts: [number, number][]; w: number }[] = [];
  const lampSrc: { pts: [number, number][]; every: number }[] = [];
  const paths: MapSprites['paths'] = [];
  const rapids: number[] = [];

  for (const l of data.lines) {
    const kind: DrawKind = l.kind === 'canal' ? 'river' : l.kind;
    const xz = l.pts.map(([la, lo]) => toXZ(la, lo));
    const water = kind === 'river' || kind === 'stream';
    if (water && l.name) named.push({ name: l.name, pts: xz });
    if (water) crossable.push({ pts: xz, river: kind === 'river' });
    const out = segs[kind];
    let run: [number, number][] = [];
    const flush = () => {
      if (run.length > 1 && kind === 'river') ribbons.push({ pts: run, w: l.w ?? (l.kind === 'canal' ? 10 : 24) });
      run = [];
    };
    for (let i = 1; i < xz.length; i++) {
      const [ax, az] = xz[i - 1], [bx, bz] = xz[i];
      if (!inside(ax, az) || !inside(bx, bz)) { flush(); continue; }
      if (kind === 'street' && !near(ax, az, STREET_NEAR) && !near(bx, bz, STREET_NEAR)) { flush(); continue; }
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (s / 3)));
      if (!run.length) run.push([ax, az]);
      for (let k = 0; k < n; k++) {
        const x0 = ax + ((bx - ax) * k) / n, z0 = az + ((bz - az) * k) / n;
        const x1 = ax + ((bx - ax) * (k + 1)) / n, z1 = az + ((bz - az) * (k + 1)) / n;
        out.push(x0, terrain.worldY(x0, z0) + lift, z0, x1, terrain.worldY(x1, z1) + lift, z1);
        run.push([x1, z1]);
      }
    }
    flush();

    // roads near the route: street lights, and the longer ones get traffic
    if (kind === 'road' || kind === 'minor' || kind === 'street') {
      const close = xz.filter(([x, z]) => inside(x, z) && near(x, z, 1500));
      // lit: main roads and town streets (country lanes into the hills are dark)
      if (close.length > 1 && kind !== 'minor') lampSrc.push({ pts: xz.filter(([x, z]) => inside(x, z)), every: kind === 'road' ? 90 : 180 });
      if (kind !== 'street' && close.length > 1) {
        const p = xz.filter(([x, z]) => inside(x, z));
        const cum = [0];
        for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
        const len = cum[cum.length - 1];
        if (len > 300) {
          const pts = new Float32Array(p.length * 3);
          let cx = 0, cz = 0;
          p.forEach(([x, z], i) => { pts.set([x, terrain.worldY(x, z), z], i * 3); cx += x; cz += z; });
          cx /= p.length; cz /= p.length;
          const r = Math.max(...p.map(([x, z]) => Math.hypot(x - cx, z - cz)));
          paths.push({ pts, cum: Float32Array.from(cum), len, cx, cz, r, main: kind === 'road' });
        }
      }
    }
    // white water where a stream drops steeply
    if (water) {
      let next = 55;
      for (let i = 1; i < xz.length; i++) {
        const [ax, az] = xz[i - 1], [bx, bz] = xz[i];
        const L = Math.hypot(bx - ax, bz - az);
        let u = next;
        for (; u < L; u += 110) {
          const f = u / L, x = ax + (bx - ax) * f, z = az + (bz - az) * f;
          if (!inside(x, z) || !near(x, z, 2500)) continue;
          const fx = (bx - ax) / L, fz = (bz - az) / L;
          const drop = Math.abs(terrain.heightAt(x, z) - terrain.heightAt(x + fx * 40, z + fz * 40)) / 40;
          if (drop > 0.18) rapids.push(x, terrain.worldY(x, z), z);
        }
        next = u - L;
      }
    }
  }
  // rivers and roads cut gaps in the canopy
  for (const k of Object.keys(CLEAR) as DrawKind[]) clearBanks(terrain, segs[k], s * CLEAR[k]);

  const lineMats: WaterScene['lineMats'] = [];
  for (const ly of LAYERS) {
    if (!segs[ly.kind].length) continue;
    const g = new LineSegmentsGeometry();
    g.setPositions(segs[ly.kind]);
    const mat = new LineMaterial({ color: new THREE.Color(ly.day).getHex(), linewidth: ly.px, worldUnits: false, dashed: !!ly.dash });
    if (ly.dash) { mat.dashSize = ly.dash[0]; mat.gapSize = ly.dash[1]; }
    mat.resolution.set(W, H);
    const line = new LineSegments2(g, mat);
    if (ly.dash) line.computeLineDistances();
    line.frustumCulled = false;
    line.renderOrder = ly.order;
    group.add(line);
    lineMats.push({ mat, day: ly.day, night: ly.night });
  }

  // rivers: a real-width water surface over the pixel line (wins when it's wider than 2 px)
  let river: WaterScene['river'] = null;
  let riverMat: THREE.ShaderMaterial | null = null;
  if (ribbons.length) {
    riverMat = riverMaterial();
    river = riverMat.uniforms as unknown as WaterScene['river'];
    const mesh = new THREE.Mesh(riverRibbon(ribbons, terrain, lift * 1.1), riverMat);
    mesh.renderOrder = 6;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  // lakes / reservoirs: flat lit surfaces at the lowest shore height
  const lake = litMaterial(C.sky);
  const level = new Map<string, number>(); // one level per lake, even when it came in tile-sized pieces
  for (const a of data.areas) {
    if (!a.group) continue;
    let y = level.get(a.group) ?? Infinity;
    for (const [la, lo] of a.ring) {
      const [x, z] = toXZ(la, lo);
      if (inside(x, z)) y = Math.min(y, terrain.worldY(x, z));
    }
    level.set(a.group, y);
  }
  for (const a of data.areas) {
    const ring = a.ring.map(([la, lo]) => toXZ(la, lo));
    if (!ring.some(([x, z]) => inside(x, z))) continue;
    const area = Math.abs(ring.reduce((acc, [x, z], i) => {
      const [x2, z2] = ring[(i + 1) % ring.length];
      return acc + x * z2 - x2 * z;
    }, 0)) / 2;
    if (area < s * s * 0.5 && !a.group) continue; // too small to see
    const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
    if (contour.length > 2 && contour[0].equals(contour[contour.length - 1])) contour.pop();
    let tris: number[][];
    try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch { continue; }
    let y = a.group ? level.get(a.group)! : Infinity;
    if (!Number.isFinite(y)) for (const [x, z] of ring) y = Math.min(y, terrain.worldY(x, z));
    const pos: number[] = [];
    for (const t of tris) for (const i of t) pos.push(contour[i].x, y + lift * 0.5, contour[i].y);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.Mesh(g, lake);
    m.renderOrder = 1;
    group.add(m);
  }

  // ---- sprite anchors
  const roadSegs = [...segs.road, ...segs.minor, ...segs.street, ...segs.track];
  const bridges: MapSprites['bridges'] = [];
  for (const h of routeCrossings(crossable, track)) {
    // only where the route is on a road / track: on a jungle trail you wade (or it's a log)
    if (!nearSegs(roadSegs, h.x, h.z, h.river ? 35 : 25)) continue;
    if (bridges.some((o) => Math.abs(o.d - h.d) < 150)) continue;
    bridges.push({ x: h.x, y: terrain.worldY(h.x, h.z) + lift, z: h.z, d: h.d });
  }

  const lamps: number[] = [];
  for (const src of lampSrc) {
    let next = src.every / 2;
    for (let i = 1; i < src.pts.length && lamps.length < 12000; i++) {
      const [ax, az] = src.pts[i - 1], [bx, bz] = src.pts[i];
      const L = Math.hypot(bx - ax, bz - az);
      let u = next;
      for (; u < L; u += src.every) {
        const x = ax + ((bx - ax) * u) / L, z = az + ((bz - az) * u) / L;
        if (near(x, z, 1500)) lamps.push(x, terrain.worldY(x, z), z);
      }
      next = u - L;
    }
  }

  const pois: MapSprites['pois'] = [];
  for (const p of data.pois ?? []) {
    const [x, z] = toXZ(p.lat, p.lon);
    if (!inside(x, z)) continue;
    const at = nearestOnRoute(track, x, z);
    pois.push({ kind: p.kind, name: p.name, x, y: terrain.worldY(x, z), z, d: at.off < 80 ? at.d : null, near: at });
  }
  const falls = fallSites(pois, track);
  const fallScene = falls.length ? buildFalls(falls, terrain) : null;
  // clear the canopy round each waterfall so it isn't buried in trees
  for (const f of falls) {
    const y = terrain.worldY(f.x, f.z);
    clearBanks(terrain, [f.x, y, f.z, f.x - f.fx * f.h * 1.2, y, f.z - f.fz * f.h * 1.2], f.h * 0.95);
  }

  return {
    group,
    crossings: findCrossings(named, track),
    lineMats,
    river,
    sprites: { bridges, lamps: Float32Array.from(lamps), paths, rapids: Float32Array.from(rapids), pois },
    falls: fallScene?.group ?? null,
    dispose() {
      fallScene?.dispose();
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      lineMats.forEach((l) => l.mat.dispose());
      riverMat?.dispose();
      lake.dispose();
    },
  };
}

/**
 * Where each waterfall stands in 3D. One within ~2.5 km of the route is brought up beside the trail
 * where the route passes closest (on the side it really lies), sized to read at the follow camera's
 * distance; one on the trail sits just beside it; farther ones stay where they are, a bit smaller.
 */
function fallSites(pois: MapSprites['pois'], track: Track): FallSite[] {
  const b = track.bounds;
  const camDist = clamp(Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.1, 500, 2600); // same as the renderer's rig
  const H = camDist * 0.115;
  const out: FallSite[] = [];
  for (const p of pois) {
    if (p.kind !== 'waterfall') continue;
    if (p.near.off < 2500) {
      const d = p.near.d;
      const ax = sampleAt(track, track.x, d), az = sampleAt(track, track.z, d);
      const hx = sampleAt(track, track.hdx, d), hz = sampleAt(track, track.hdz, d);
      const side = Math.sign(hx * (p.z - az) - hz * (p.x - ax)) || 1;
      const nx = -hz * side, nz = hx * side, nl = Math.hypot(nx, nz) || 1;
      const off = camDist * 0.12;
      out.push({ x: ax + (nx / nl) * off, z: az + (nz / nl) * off, fx: -nx / nl, fz: -nz / nl, h: H });
    } else {
      const i = Math.min(track.n - 1, Math.round(p.near.d / track.step));
      let fx = track.x[i] - p.x, fz = track.z[i] - p.z;
      const l = Math.hypot(fx, fz) || 1;
      fx /= l; fz /= l;
      out.push({ x: p.x + fx * H * 0.6, z: p.z + fz * H * 0.6, fx, fz, h: H * 0.7 });
    }
  }
  return out;
}

/** Flat strip `w` metres wide along each polyline, draped at the centre line's height. */
function riverRibbon(lines: { pts: [number, number][]; w: number }[], terrain: Terrain, lift: number) {
  const pos: number[] = [], side: number[] = [], along: number[] = [], idx: number[] = [];
  for (const { pts, w } of lines) {
    const base = pos.length / 3;
    let cum = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i];
      if (i) cum += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
      const a = pts[Math.max(0, i - 1)], c = pts[Math.min(pts.length - 1, i + 1)];
      let tx = c[0] - a[0], tz = c[1] - a[1];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const y = terrain.worldY(x, z) + lift;
      const hw = w / 2;
      pos.push(x - tz * hw, y, z + tx * hw, x + tz * hw, y, z - tx * hw);
      side.push(-1, 1);
      along.push(cum, cum);
      if (i) {
        const k = base + i * 2;
        idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
  g.setIndex(idx);
  return g;
}

/** Water with lighter banks and glints drifting downstream (OSM rivers are drawn in flow direction). */
function riverMaterial() {
  const v3 = (hex: string) => new THREE.Vector3(...rgb01(hex));
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: {
      ...shared,
      uWater: { value: v3(C.sky) },
      uBank: { value: v3(C.sage) },
      uGlint: { value: 1 },
      uGlintThr: { value: 0.88 },
      uGlintCol: { value: v3(C.skyPale) },
    },
    vertexShader: /* glsl */ `
      attribute float aSide; attribute float aAlong;
      varying vec3 vW; varying float vSide; varying float vAlong;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz; vSide = aSide; vAlong = aAlong;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      ${LIGHT_GLSL}
      uniform vec3 uWater; uniform vec3 uBank; uniform float uGlint; uniform float uGlintThr; uniform vec3 uGlintCol;
      varying vec3 vW; varying float vSide; varying float vAlong;
      void main() {
        float s = abs(vSide);
        vec3 col = shade(s > 0.7 ? uBank : uWater, vec3(0.0, 1.0, 0.0), vW);
        float h = hash(floor(vec2((vAlong - uTime * 26.0) / 9.0, vSide * 2.0 + 4.0)));
        if (s < 0.6 && h > uGlintThr) col = mix(col, uGlintCol, uGlint);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

/** Is (x, z) within R metres of the route? (grid of route samples, built once per track) */
function routeProximity(track: Track) {
  const cell = 500;
  const grid = new Map<string, number[]>();
  const stride = Math.max(1, Math.round(50 / track.step));
  for (let i = 0; i < track.n; i += stride) {
    const k = `${Math.floor(track.x[i] / cell)},${Math.floor(track.z[i] / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  }
  return (x: number, z: number, R: number) => {
    const span = Math.ceil(R / cell);
    const kx = Math.floor(x / cell), kz = Math.floor(z / cell);
    for (let dx = -span; dx <= span; dx++) for (let dz = -span; dz <= span; dz++) {
      for (const i of grid.get(`${kx + dx},${kz + dz}`) ?? []) {
        if (Math.hypot(track.x[i] - x, track.z[i] - z) < R) return true;
      }
    }
    return false;
  };
}

/** Closest route sample to (x, z): its distance along the track and how far off the route the point is. */
export function nearestOnRoute(track: Track, x: number, z: number) {
  let best = Infinity, d = 0;
  for (let i = 0; i < track.n; i++) {
    const o = Math.hypot(track.x[i] - x, track.z[i] - z);
    if (o < best) { best = o; d = track.d[i]; }
  }
  return { d, off: best };
}

function nearSegs(segs: number[], x: number, z: number, r: number) {
  for (let i = 0; i < segs.length; i += 6) {
    if (Math.abs(segs[i] - x) > r + 60 || Math.abs(segs[i + 2] - z) > r + 60) continue;
    if (distSeg(x, z, segs[i], segs[i + 2], segs[i + 3], segs[i + 5]) < r) return true;
  }
  return false;
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

/** Every point where the route crosses one of `lines` (x/z of the crossing and distance along the route). */
function routeCrossings(lines: { pts: [number, number][]; river: boolean }[], t: Track) {
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
  const hits: { d: number; x: number; z: number; river: boolean }[] = [];
  for (const l of lines) {
    for (let j = 1; j < l.pts.length; j++) {
      const [ax, az] = l.pts[j - 1], [bx, bz] = l.pts[j];
      const cand = grid.get(`${Math.floor(ax / cell)},${Math.floor(az / cell)}`);
      if (!cand) continue;
      for (const i of cand) {
        const i2 = Math.min(t.n - 1, i + stride);
        const u = segX(ax, az, bx, bz, t.x[i], t.z[i], t.x[i2], t.z[i2]);
        if (u == null) continue;
        hits.push({ d: t.d[i] + (t.d[i2] - t.d[i]) * u, x: t.x[i] + (t.x[i2] - t.x[i]) * u, z: t.z[i] + (t.z[i2] - t.z[i]) * u, river: l.river });
      }
    }
  }
  // rivers first, so a river and a stream at the same spot keep the river's bridge
  return hits.sort((a, b) => Number(b.river) - Number(a.river) || a.d - b.d);
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
    if (l.kind !== 'road' && l.kind !== 'minor' && l.kind !== 'street' && l.kind !== 'track') continue;
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
