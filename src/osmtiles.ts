import type { BBox } from './dem';
import type { LineKind, Poi, PoiKind, WaterArea, WaterData, WaterLine } from './water';

/**
 * Rivers, lakes, roads and landmarks from pre-cut OpenStreetMap vector tiles (OpenFreeMap,
 * OpenMapTiles schema; © OpenStreetMap contributors, ODbL). The tiles are static files on a CDN,
 * so the whole map area arrives in a second or two instead of waiting on a live Overpass query.
 *
 * Only the tile coordinates of the map area are requested — nothing about the user or the file.
 */

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const MAX_Z = 14; // OpenFreeMap's most detailed level (~2.4 km squares at the equator)
const MAX_TILES = 160;
const PARALLEL = 24; // HTTP/2: one connection, many streams

let template: Promise<string> | null = null;
function tileTemplate(): Promise<string> {
  template ??= fetch(TILEJSON, { signal: AbortSignal.timeout(10_000) })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`TileJSON ${r.status}`))))
    .then((j: { tiles?: string[] }) => j.tiles?.[0] ?? Promise.reject(new Error('TileJSON without tiles')))
    .catch((e) => { template = null; throw e; });
  return template;
}

const lonToX = (lon: number, n: number) => ((lon + 180) / 360) * n;
const latToY = (lat: number, n: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
};

export function tileRange(b: BBox) {
  for (let z = MAX_Z; ; z--) {
    const n = 2 ** z;
    const x0 = Math.floor(lonToX(b.minLon, n)), x1 = Math.floor(lonToX(b.maxLon, n));
    const y0 = Math.floor(latToY(b.maxLat, n)), y1 = Math.floor(latToY(b.minLat, n));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES || z <= 10) return { z, x0, x1, y0, y1 };
  }
}

export async function loadTiles(b: BBox, onProgress?: (done: number, total: number) => void): Promise<WaterData> {
  const url = await tileTemplate();
  const { z, x0, x1, y0, y1 } = tileRange(b);
  const jobs: [number, number][] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) jobs.push([x, y]);

  const acc = new Acc();
  let done = 0, failed = 0, next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [x, y] = jobs[next++];
      const buf = await fetchTile(url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
      if (buf) decodeTile(buf, z, x, y, acc);
      else failed++;
      onProgress?.(++done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
  if (failed > jobs.length * 0.1) throw new Error(`${failed}/${jobs.length} map tiles failed`);
  return acc.finish();
}

async function fetchTile(url: string): Promise<Uint8Array | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (r.status === 204 || r.status === 404) return new Uint8Array(0); // empty sea / nothing mapped
      if (!r.ok) throw new Error(String(r.status));
      let buf = new Uint8Array(await r.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        buf = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      }
      return buf;
    } catch {
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  return null;
}

// ---------------------------------------------------------------- protobuf (Mapbox Vector Tile 2.1)

class Reader {
  p: number;
  readonly v: DataView;
  readonly b: Uint8Array;
  readonly end: number;
  constructor(b: Uint8Array, start = 0, end = b.length) {
    this.b = b;
    this.end = end;
    this.p = start;
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  varint() {
    let r = 0, s = 0, x: number;
    do { x = this.b[this.p++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80);
    return r;
  }
  /** Calls fn(field, wireType) for each field; fn must consume length-delimited / varint values it wants. */
  each(fn: (field: number, wire: number) => boolean | void) {
    while (this.p < this.end) {
      const key = this.varint(), field = Math.floor(key / 8), wire = key & 7;
      const at = this.p;
      if (fn(field, wire) && this.p !== at) continue;
      this.p = at;
      this.skip(wire);
    }
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.p += 8;
    else if (wire === 2) this.p += this.varint();
    else if (wire === 5) this.p += 4;
    else throw new Error(`bad wire type ${wire}`);
  }
  bytes() { const n = this.varint(); const s = this.p; this.p += n; return [s, s + n] as const; }
  string() { const [s, e] = this.bytes(); return dec.decode(this.b.subarray(s, e)); }
  packed() {
    const [s, e] = this.bytes();
    const r = new Reader(this.b, s, e);
    const out: number[] = [];
    while (r.p < e) out.push(r.varint());
    return out;
  }
}
const dec = new TextDecoder();
const zz = (n: number) => (n % 2 === 1 ? -(n + 1) / 2 : n / 2);

type Tags = Record<string, string | number | boolean>;
type Pt = [number, number];

const LAYERS = new Set(['waterway', 'water', 'transportation', 'poi', 'mountain_peak', 'place']);

function decodeTile(buf: Uint8Array, z: number, tx: number, ty: number, acc: Acc) {
  const r = new Reader(buf);
  r.each((f, w) => {
    if (f !== 3 || w !== 2) return;
    const [s, e] = r.bytes();
    decodeLayer(new Reader(buf, s, e), z, tx, ty, acc);
    return true;
  });
}

function decodeLayer(r: Reader, z: number, tx: number, ty: number, acc: Acc) {
  let name = '';
  let extent = 4096;
  const keys: string[] = [];
  const values: (string | number | boolean)[] = [];
  const feats: [number, number][] = [];
  r.each((f, w) => {
    if (f === 1 && w === 2) { name = r.string(); return true; }
    if (f === 2 && w === 2) { const [s, e] = r.bytes(); feats.push([s, e]); return true; }
    if (f === 3 && w === 2) { keys.push(r.string()); return true; }
    if (f === 4 && w === 2) { values.push(readValue(r)); return true; }
    if (f === 5 && w === 0) { extent = r.varint(); return true; }
  });
  if (!LAYERS.has(name)) return;

  const n = 2 ** z;
  const toLatLon = ([px, py]: Pt): Pt => {
    const lon = ((tx + px / extent) / n) * 360 - 180;
    const yy = Math.PI * (1 - (2 * (ty + py / extent)) / n);
    return [r5((Math.atan(Math.sinh(yy)) * 180) / Math.PI), r5(lon)];
  };

  for (const [s, e] of feats) {
    const fr = new Reader(r.b, s, e);
    let type = 0;
    let tagIdx: number[] = [];
    let geom: number[] = [];
    fr.each((f, w) => {
      if (f === 2 && w === 2) { tagIdx = fr.packed(); return true; }
      if (f === 3 && w === 0) { type = fr.varint(); return true; }
      if (f === 4 && w === 2) { geom = fr.packed(); return true; }
    });
    const tags: Tags = {};
    for (let i = 0; i + 1 < tagIdx.length; i += 2) tags[keys[tagIdx[i]]] = values[tagIdx[i + 1]];
    acc.add(name, type, tags, decodeGeom(geom), extent, toLatLon);
  }
}

function readValue(r: Reader): string | number | boolean {
  const [s, e] = r.bytes();
  const vr = new Reader(r.b, s, e);
  let v: string | number | boolean = '';
  vr.each((f, w) => {
    if (f === 1 && w === 2) { v = vr.string(); return true; }
    if (f === 2 && w === 5) { v = vr.v.getFloat32(vr.p, true); vr.p += 4; return true; }
    if (f === 3 && w === 1) { v = vr.v.getFloat64(vr.p, true); vr.p += 8; return true; }
    if ((f === 4 || f === 5) && w === 0) { v = vr.varint(); return true; }
    if (f === 6 && w === 0) { v = zz(vr.varint()); return true; }
    if (f === 7 && w === 0) { v = vr.varint() !== 0; return true; }
  });
  return v;
}

/** MoveTo/LineTo/ClosePath commands → lists of points (one per MoveTo). */
function decodeGeom(g: number[]): Pt[][] {
  const parts: Pt[][] = [];
  let x = 0, y = 0, i = 0;
  let cur: Pt[] | null = null;
  while (i < g.length) {
    const cmd = g[i] & 7, count = g[i] >> 3;
    i++;
    if (cmd === 7) { if (cur?.length) cur.push(cur[0]); continue; }
    for (let k = 0; k < count && i + 1 < g.length; k++) {
      x += zz(g[i++]);
      y += zz(g[i++]);
      if (cmd === 1) { cur = []; parts.push(cur); }
      cur?.push([x, y]);
    }
  }
  return parts;
}

// ---------------------------------------------------------------- clipping (tiles overlap by a buffer)

/** Cuts a polyline to the tile square, so neighbouring tiles' pieces meet edge-to-edge. */
function clipLine(pts: Pt[], E: number): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  for (let i = 1; i < pts.length; i++) {
    const seg = clipSeg(pts[i - 1], pts[i], E);
    if (!seg) { if (cur.length > 1) out.push(cur); cur = []; continue; }
    const [a, b] = seg;
    if (!cur.length) cur.push(a);
    else if (cur[cur.length - 1][0] !== a[0] || cur[cur.length - 1][1] !== a[1]) { if (cur.length > 1) out.push(cur); cur = [a]; }
    cur.push(b);
    if (b !== pts[i]) { out.push(cur); cur = []; } // left the square
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** Liang–Barsky; returns the original point objects where they're inside. */
function clipSeg(a: Pt, b: Pt, E: number): [Pt, Pt] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, a[0]], [dx, E - a[0]], [-dy, a[1]], [dy, E - a[1]]] as const) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [
    t0 === 0 ? a : [a[0] + dx * t0, a[1] + dy * t0],
    t1 === 1 ? b : [a[0] + dx * t1, a[1] + dy * t1],
  ];
}

/** Sutherland–Hodgman against the tile square. */
function clipRing(ring: Pt[], E: number): Pt[] {
  let pts = ring;
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= 0, (a, b) => { const t = -a[0] / (b[0] - a[0]); return [0, a[1] + (b[1] - a[1]) * t]; }],
    [(p) => p[0] <= E, (a, b) => { const t = (E - a[0]) / (b[0] - a[0]); return [E, a[1] + (b[1] - a[1]) * t]; }],
    [(p) => p[1] >= 0, (a, b) => { const t = -a[1] / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * t, 0]; }],
    [(p) => p[1] <= E, (a, b) => { const t = (E - a[1]) / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * t, E]; }],
  ];
  for (const [ins, cut] of edges) {
    const out: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (ins(b)) { if (!ins(a)) out.push(cut(a, b)); out.push(b); } else if (ins(a)) out.push(cut(a, b));
    }
    pts = out;
    if (pts.length < 3) return [];
  }
  return pts;
}

const ringArea = (r: Pt[]) => r.reduce((s, [x, y], i) => { const [x2, y2] = r[(i + 1) % r.length]; return s + x * y2 - x2 * y; }, 0) / 2;
const onEdge = ([x, y]: Pt, E: number) => x === 0 || y === 0 || x === E || y === E;

// ---------------------------------------------------------------- tiles → the app's map data

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const nameOf = (t: Tags) => str(t.name) || str(t.name_en) || str(t['name:latin']) || str(t.name_int);

interface Piece { kind: LineKind; name: string; pts: Pt[]; open: [boolean, boolean] }
interface AreaPiece { ring: Pt[]; cls: string; edge: Pt[] }

class Acc {
  pieces: Piece[] = [];
  areas: AreaPiece[] = [];
  pois: Poi[] = [];
  /** Villages, hamlets and neighbourhoods: lanes around them are town streets. */
  places: Pt[] = [];

  add(layer: string, type: number, t: Tags, parts: Pt[][], E: number, ll: (p: Pt) => Pt) {
    const cls = str(t.class);
    if (layer === 'waterway' && type === 2) {
      if (cls !== 'river' && cls !== 'stream' && cls !== 'canal') return;
      if (t.brunnel === 'tunnel') return;
      this.lines(cls as LineKind, nameOf(t), parts, E, ll);
    } else if (layer === 'transportation' && type === 2) {
      const kind = roadKind(t);
      if (kind) this.lines(kind, '', parts, E, ll);
    } else if (layer === 'water' && type === 3) {
      if (cls === 'swimming_pool' || t.brunnel === 'tunnel') return;
      for (const ring of parts) {
        if (ring.length < 4 || ringArea(ring) <= 0) continue; // holes (negative area) are dropped, like before
        const clipped = clipRing(ring, E);
        if (clipped.length < 3) continue;
        this.areas.push({ ring: clipped.map(ll), cls, edge: clipped.filter((p) => onEdge(p, E)).map(ll) });
      }
    } else if (layer === 'place' && type === 1) {
      if (!/^(city|town|village|suburb|quarter|neighbourhood|hamlet)$/.test(cls)) return;
      for (const p of parts.flat()) if (p[0] >= 0 && p[1] >= 0 && p[0] < E && p[1] < E) this.places.push(ll(p));
    } else if ((layer === 'poi' || layer === 'mountain_peak') && type === 1) {
      const kind = poiKind(layer, t);
      if (!kind) return;
      for (const p of parts.flat()) {
        if (p[0] < 0 || p[1] < 0 || p[0] >= E || p[1] >= E) continue; // the neighbour tile owns it
        const [lat, lon] = ll(p);
        const ele = typeof t.ele === 'number' ? t.ele : parseFloat(str(t.ele));
        this.pois.push({ kind, name: nameOf(t), lat, lon, ...(Number.isFinite(ele) ? { ele } : {}) });
      }
    }
  }

  lines(kind: LineKind, name: string, parts: Pt[][], E: number, ll: (p: Pt) => Pt) {
    for (const part of parts) {
      for (const c of clipLine(part, E)) {
        this.pieces.push({ kind, name, pts: c.map(ll), open: [onEdge(c[0], E), onEdge(c[c.length - 1], E)] });
      }
    }
  }

  finish(): WaterData {
    const lines: WaterLine[] = join(this.pieces).map((p) => {
      let kind = p.kind;
      // the tiles lump residential lanes in with country roads: short ones, or ones in a village, are streets
      if (kind === 'minor' && (lengthM(p.pts) < 600 || inVillage(p.pts, this.places))) kind = 'street';
      return { name: p.name, kind, pts: p.pts };
    });
    return { lines, areas: groupAreas(this.areas), pois: this.pois };
  }
}

const UNPAVED = new Set(['unpaved', 'dirt', 'gravel', 'ground', 'earth', 'mud', 'sand', 'grass', 'compacted', 'fine_gravel']);

function roadKind(t: Tags): LineKind | null {
  const c = str(t.class);
  if (t.access === 'no' || t.service === 'parking_aisle' || t.service === 'driveway') return null;
  if (c === 'track') return t.surface === 'paved' ? 'minor' : 'track';
  if (!/^(motorway|trunk|primary|secondary|tertiary|minor|service)$/.test(c)) return null;
  if (t.surface === 'unpaved' || UNPAVED.has(str(t.surface))) return 'track';
  if (c === 'minor') return 'minor';
  if (c === 'service') return 'street';
  return 'road';
}

function poiKind(layer: string, t: Tags): PoiKind | null {
  const c = str(t.class), s = str(t.subclass);
  if (layer === 'mountain_peak') return c === 'peak' || c === 'volcano' ? 'peak' : null;
  if (s === 'viewpoint') return 'viewpoint';
  if (s === 'camp_site') return 'camp';
  if (s === 'waterfall') return 'waterfall';
  if (s === 'spring') return 'spring';
  return null;
}

const lengthM = (p: Pt[]) => {
  let L = 0;
  for (let i = 1; i < p.length; i++) {
    const dLat = (p[i][0] - p[i - 1][0]) * 111_320;
    const dLon = (p[i][1] - p[i - 1][1]) * 111_320 * Math.cos((p[i][0] * Math.PI) / 180);
    L += Math.hypot(dLat, dLon);
  }
  return L;
};

/** At least a third of the road lies within ~350 m of a mapped village / neighbourhood. */
function inVillage(pts: Pt[], places: Pt[]) {
  const R = 350 / 111_320;
  let hit = 0, n = 0;
  for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 24))) {
    n++;
    const [la, lo] = pts[i];
    const k = Math.cos((la * Math.PI) / 180);
    if (places.some(([pa, po]) => Math.abs(pa - la) < R && Math.abs(po - lo) * k < R && Math.hypot(pa - la, (po - lo) * k) < R)) hit++;
  }
  return hit * 3 >= n;
}

const TOL = 3e-5; // ~3 m: both tiles cut the same segment at the shared edge
const close = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < TOL && Math.abs(a[1] - b[1]) < TOL;

/** Rejoins pieces of one river/road that were cut at tile edges. */
function join(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  const buckets = new Map<string, Piece[]>();
  for (const p of pieces) {
    if (!p.open[0] && !p.open[1]) { out.push(p); continue; }
    const k = `${p.kind}|${p.name}`;
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(p);
  }
  for (const list of buckets.values()) {
    const live = [...list];
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < live.length; i++) {
        const a = live[i];
        if (!a.open[1] && !a.open[0]) continue;
        for (let j = 0; j < live.length; j++) {
          if (i === j) continue;
          const b = live[j];
          const aEnd = a.pts[a.pts.length - 1], aStart = a.pts[0];
          const bEnd = b.pts[b.pts.length - 1], bStart = b.pts[0];
          let joined: Piece | null = null;
          if (a.open[1] && b.open[0] && close(aEnd, bStart)) joined = { ...a, pts: a.pts.concat(b.pts.slice(1)), open: [a.open[0], b.open[1]] };
          else if (a.open[1] && b.open[1] && close(aEnd, bEnd)) joined = { ...a, pts: a.pts.concat([...b.pts].reverse().slice(1)), open: [a.open[0], b.open[0]] };
          else if (a.open[0] && b.open[1] && close(aStart, bEnd)) joined = { ...a, pts: b.pts.concat(a.pts.slice(1)), open: [b.open[0], a.open[1]] };
          if (!joined) continue;
          live[i] = joined;
          live.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
    out.push(...live);
  }
  return out;
}

/** Pieces of one lake from neighbouring tiles share points on the tile edge: give them one id so they get one water level. */
function groupAreas(pieces: AreaPiece[]): WaterArea[] {
  const parent = pieces.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < pieces.length; i++) {
    if (!pieces[i].edge.length) continue;
    for (let j = i + 1; j < pieces.length; j++) {
      if (!pieces[j].edge.length || pieces[i].cls !== pieces[j].cls) continue;
      if (pieces[i].edge.some((p) => pieces[j].edge.some((q) => close(p, q)))) parent[find(i)] = find(j);
    }
  }
  return pieces.map((p, i) => ({ name: '', ring: p.ring, ...(p.edge.length ? { group: `g${find(i)}` } : {}) }));
}
