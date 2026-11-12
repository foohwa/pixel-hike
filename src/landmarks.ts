import type { Terrain } from './terrain';
import type { Checkpoint, Track } from './track';
import { nearestOnRoute, type WaterData } from './water';

/**
 * Viewpoints along the route, as 'view' checkpoints (the walker stops and the camera pulls back for a
 * look around): OpenStreetMap viewpoints right beside the trail, plus spots the terrain itself says are
 * open — high points where the land falls away in most directions. Under a rainforest canopy that's
 * only "could have a view"; the user can switch any of them off in the checkpoint list.
 */

const ON_ROUTE = 80; // metres: an OSM point this close to the track counts as "on the trail"
const MAX_VIEWS = 5;

export interface ViewSpot { d: number; name: string; source: 'osm' | 'terrain'; score: number; dir: number }

/** OSM viewpoints beside the trail + the most open terrain spots, spread out along the route. */
export function findViews(track: Track, terrain: Terrain | null, data: WaterData | null, taken: number[]): ViewSpot[] {
  const out: ViewSpot[] = [];
  const free = (d: number, gap: number) => !taken.some((t) => Math.abs(t - d) < gap) && !out.some((o) => Math.abs(o.d - d) < gap);

  for (const p of data?.pois ?? []) {
    if (p.kind !== 'viewpoint') continue;
    const x = (p.lon - track.lon0) * track.mLon, z = -(p.lat - track.lat0) * track.mLat;
    const at = nearestOnRoute(track, x, z);
    if (at.off > ON_ROUTE || !free(at.d, 600)) continue;
    const sc = terrain ? openness(track, terrain, at.d) : { score: 0, dir: 0 };
    out.push({ d: at.d, name: p.name || 'Viewpoint', source: 'osm', score: sc.score, dir: sc.dir });
  }

  if (terrain && terrain.maxH - terrain.minH > 150) {
    const L = track.stats.distance;
    const cands: ViewSpot[] = [];
    for (let d = 400; d < L - 400; d += 100) {
      const sc = openness(track, terrain, d);
      cands.push({ d, name: 'Scenic view', source: 'terrain', score: sc.score, dir: sc.dir });
    }
    // local maxima only, best first, well apart from each other and from summits / peaks / OSM views
    const peaks = cands.filter((c, i) => (i === 0 || c.score >= cands[i - 1].score) && (i === cands.length - 1 || c.score >= cands[i + 1].score));
    peaks.sort((a, b) => b.score - a.score);
    const gap = Math.max(3000, L * 0.08);
    for (const c of peaks) {
      if (out.length >= MAX_VIEWS || c.score < 0.07) break;
      if (free(c.d, gap)) out.push(c);
    }
  }
  return out.sort((a, b) => a.d - b.d);
}

/**
 * How open the outlook is at distance d: the mean, over 16 compass directions, of how far the horizon
 * sits *below* eye level (radians, ≥ 0). A summit or a narrow ridge scores high; a valley floor ~0.
 * `dir` = the compass direction (radians, 0 = north, clockwise) with the deepest drop — where to look.
 */
export function openness(track: Track, terrain: Terrain, d: number) {
  const i = Math.min(track.n - 1, Math.round(d / track.step));
  const x = track.x[i], z = track.z[i];
  const eye = terrain.heightAt(x, z) + 2;
  const RS = [150, 250, 400, 600, 900, 1300, 1800, 2500, 3300, 4200];
  let sum = 0, best = -Infinity, dir = 0;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const sx = Math.sin(a), sz = -Math.cos(a);
    let hor = -Infinity;
    for (const r of RS) hor = Math.max(hor, Math.atan2(terrain.heightAt(x + sx * r, z + sz * r) - eye, r));
    const drop = Math.max(0, -hor);
    sum += drop;
    if (drop > best) { best = drop; dir = a; }
  }
  return { score: sum / 16, dir };
}

/** 'view' checkpoints for the spots found by findViews (auto-detected, so the user can delete or edit them). */
export function viewCheckpoints(track: Track, views: ViewSpot[]): Checkpoint[] {
  return views.map((v, k) => {
    const i = Math.min(track.n - 1, Math.round(v.d / track.step));
    return {
      id: `view${k}`,
      kind: 'view' as const,
      name: v.name.toUpperCase(),
      d: v.d,
      ele: track.ele[i],
      time: track.time[i],
      leaveTime: track.time[i],
      enabled: true,
    };
  });
}

/**
 * Names auto-detected checkpoints after what's mapped there: summits / peaks ("SUMMIT", "PEAK 2") take
 * the OSM peak's name, rest stops ("REST") the camp they're at ("KEM BALAK"). User-edited ones are kept.
 */
export function namePeaks(track: Track, cps: Checkpoint[], data: WaterData | null) {
  const pois = data?.pois ?? [];
  const nearest = (cp: Checkpoint, kind: 'peak' | 'camp', within: number) => {
    const i = Math.min(track.n - 1, Math.round(cp.d / track.step));
    let best = within, name = '';
    for (const p of pois) {
      if (p.kind !== kind || !p.name) continue;
      const x = (p.lon - track.lon0) * track.mLon, z = -(p.lat - track.lat0) * track.mLat;
      const o = Math.hypot(track.x[i] - x, track.z[i] - z);
      if (o < best) { best = o; name = p.name; }
    }
    return name;
  };
  for (const cp of cps) {
    if (cp.pinned) continue;
    let name = '';
    if ((cp.kind === 'summit' || cp.kind === 'peak') && /^(SUMMIT|PEAK \d+)$/.test(cp.name)) name = nearest(cp, 'peak', 200);
    else if (cp.kind === 'rest' && cp.name === 'REST') name = nearest(cp, 'camp', 350);
    if (name) cp.name = name.toUpperCase();
  }
}
