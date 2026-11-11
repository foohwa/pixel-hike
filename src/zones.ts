import { C } from './palette';
import type { Track } from './track';

/**
 * Trail zones: the trail is dressed by elevation (lowland jungle → montane forest → mossy forest,
 * or forest → meadow → rocky ridge outside the tropics) and steep stretches get "technical"
 * props (fixed ropes, roots, rock steps, a warning sign).
 */

export type ZoneStyle = 'jungle' | 'forest' | 'mossy' | 'rocky' | 'meadow' | 'plain';

export const ZONE_STYLES: ZoneStyle[] = ['jungle', 'forest', 'mossy', 'rocky', 'meadow', 'plain'];

export const ZONE_LABEL: Record<ZoneStyle, string> = {
  jungle: 'Lowland jungle',
  forest: 'Montane forest',
  mossy: 'Mossy forest',
  rocky: 'Rocky ridge',
  meadow: 'Alpine meadow',
  plain: 'Plain trail',
};

/** Fill / highlight colours for the elevation profile. */
export const ZONE_COLOR: Record<ZoneStyle, [string, string]> = {
  jungle: [C.forest, C.green],
  forest: [C.green, C.greenLight],
  mossy: [C.sage, C.lime],
  rocky: [C.rock, C.greyLight],
  meadow: [C.greenLight, C.cream],
  plain: [C.tan, C.cream],
};

export interface ZoneSettings {
  on: boolean;
  /** Three bands; bands[0].at is ignored (it starts at the bottom). */
  bands: { at: number; style: ZoneStyle }[];
  technical: boolean;
  labels: boolean;
}

/** Sensible defaults: real cloud-forest heights in the tropics, otherwise split the track's own range. */
export function defaultZones(track: Track): ZoneSettings {
  const { minEle, maxEle } = track.stats;
  const tropical = Math.abs(track.lat0) < 23.5;
  const r = Math.max(1, maxEle - minEle);
  const round = (v: number) => Math.round(v / 50) * 50;
  return {
    on: true,
    technical: true,
    labels: true,
    bands: tropical
      ? [{ at: 0, style: 'jungle' }, { at: 1000, style: 'forest' }, { at: 1500, style: 'mossy' }]
      : [{ at: 0, style: 'forest' }, { at: round(minEle + r * 0.55), style: 'meadow' }, { at: round(minEle + r * 0.8), style: 'rocky' }],
  };
}

export interface Run { d0: number; d1: number }
export interface ZoneRun extends Run { style: ZoneStyle }

export interface TrailZones {
  settings: ZoneSettings;
  runs: ZoneRun[];
  tech: Run[];
  styleAt(d: number): ZoneStyle;
  techAt(d: number): boolean;
}

const HYSTERESIS_M = 25; // elevation must clear a boundary by this much to switch zones
const MIN_RUN_M = 300; // shorter visits to a zone are absorbed by their neighbours
const STEEP = 0.28; // |rise/run| that counts as technical
const STEEP_MIN_M = 80;
const STEEP_GAP_M = 60;

export function buildZones(track: Track, settings: ZoneSettings): TrailZones {
  const { n, step, ele, grade } = track;
  const bands = settings.bands;
  const bandOf = (e: number) => (e >= bands[2].at ? 2 : e >= bands[1].at ? 1 : 0);

  // 1. band per sample, with hysteresis so a wobble around a boundary doesn't flicker
  const idx = new Uint8Array(n);
  let cur = bandOf(ele[0]);
  for (let i = 0; i < n; i++) {
    const b = bandOf(ele[i]);
    if (b > cur && ele[i] >= bands[b].at + HYSTERESIS_M) cur = b;
    else if (b < cur && ele[i] < bands[cur].at - HYSTERESIS_M) cur = b;
    idx[i] = cur;
  }

  // 2. run-length + absorb short runs
  let raw: { i0: number; i1: number; b: number }[] = [];
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && idx[j + 1] === idx[i]) j++;
    raw.push({ i0: i, i1: j, b: idx[i] });
    i = j + 1;
  }
  const minSamples = MIN_RUN_M / step;
  let changed = true;
  while (changed && raw.length > 1) {
    changed = false;
    for (let k = 0; k < raw.length; k++) {
      const r = raw[k];
      if (r.i1 - r.i0 + 1 >= minSamples) continue;
      const into = k > 0 ? k - 1 : k + 1;
      raw[into] = { i0: Math.min(raw[into].i0, r.i0), i1: Math.max(raw[into].i1, r.i1), b: raw[into].b };
      raw.splice(k, 1);
      changed = true;
      break;
    }
    // merge neighbours that ended up in the same band
    raw = raw.reduce<typeof raw>((acc, r) => {
      const last = acc[acc.length - 1];
      if (last && last.b === r.b) last.i1 = r.i1;
      else acc.push({ ...r });
      return acc;
    }, []);
  }
  const runs: ZoneRun[] = raw.map((r) => ({ d0: r.i0 * step, d1: (r.i1 + 1) * step, style: bands[r.b].style }));
  // merge runs that share a style (two bands can use the same look)
  const merged: ZoneRun[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.style === r.style) last.d1 = r.d1;
    else merged.push({ ...r });
  }

  // 3. technical stretches: steep, long enough, small gaps bridged
  const tech: Run[] = [];
  if (settings.technical) {
    let start = -1;
    let lastSteep = -1e9;
    for (let i = 0; i < n; i++) {
      const steep = Math.abs(grade[i]) >= STEEP;
      if (steep) {
        if (start < 0 || (i - lastSteep) * step > STEEP_GAP_M) {
          if (start >= 0 && (lastSteep - start) * step >= STEEP_MIN_M) tech.push({ d0: start * step, d1: lastSteep * step });
          start = i;
        }
        lastSteep = i;
      }
    }
    if (start >= 0 && (lastSteep - start) * step >= STEEP_MIN_M) tech.push({ d0: start * step, d1: lastSteep * step });
  }

  const find = <T extends Run>(arr: T[], d: number) => {
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (d < arr[m].d0) hi = m - 1;
      else if (d >= arr[m].d1) lo = m + 1;
      else return arr[m];
    }
    return null;
  };

  return {
    settings,
    runs: merged,
    tech,
    styleAt: (d) => find(merged, d)?.style ?? merged[merged.length - 1]?.style ?? 'plain',
    techAt: (d) => !!find(tech, d),
  };
}

/** Kilometres spent in each style + on technical ground (for the sidebar hint). */
export function zoneSummary(z: TrailZones) {
  const km: Partial<Record<ZoneStyle, number>> = {};
  for (const r of z.runs) km[r.style] = (km[r.style] ?? 0) + (r.d1 - r.d0) / 1000;
  const techKm = z.tech.reduce((s, r) => s + (r.d1 - r.d0) / 1000, 0);
  return { km, techKm };
}

// ---------------------------------------------------------------- sprites

/**
 * Trail-side props. Keys: f forestDeep, F forest, g green, G greenLight, l lime, s sage, m moss,
 * b brown, B brownDark, t tan, r rock, R rockDark, w greyLight/white, y yellow, o orange,
 * x red, A wine, p pink, P purple, c cream, k ink.
 */
const DAY: Record<string, string> = {
  f: C.forestDeep, F: C.forest, g: C.green, G: C.greenLight, l: C.lime, s: C.sage, m: C.moss,
  b: C.brown, B: C.brownDark, t: C.tan, r: C.rock, R: C.rockDark, w: C.greyLight, y: C.yellow,
  o: C.orange, x: C.red, A: C.wine, p: C.pink, P: C.purple, c: C.cream, k: C.ink,
};

/** Same props after dark (outside the head-lamp's reach). */
const NIGHT: Record<string, string> = {
  f: C.ink2, F: C.tealDeep, g: C.forestDeep, G: C.forest, l: C.moss, s: C.moss, m: C.tealDeep,
  b: C.brownDark, B: C.ink2, t: C.brownDark, r: C.rockDark, R: C.night, w: C.rockDark, y: C.orange,
  o: C.coral, x: C.wine, A: C.plum, p: C.plum, P: C.plum, c: C.rock, k: C.ink,
};

export const DECOR_KEYS = { day: DAY, night: NIGHT };

const FERN = ['..G.G..', '.G.g.G.', 'G.ggg.G', '.ggggg.', '..fgf..'];
const PALM = ['.GG.GG.', 'GggGggG', 'g..b..g', '...b...', '...b...', '..fbf..'];
const TARO = ['.ggg.', 'gGGgg', 'gGggf', '.gff.', '..b..'];
const VINE_BUSH = ['..g.g..', '.gFgFg.', 'gFgxgFg', '.fFFFf.'];
const BUSH = ['.fFF.', 'fFGFF', 'fFFFf', '.fff.'];
const PINE = ['..F..', '.fFF.', '..F..', '.fFFF', 'fFFFF', '..b..'];
const MUSHROOM = ['.xwx.', 'xxxxx', '..w..'];
const LOG = ['.BbbbB', 'BtbbbB', '.BBBB.'];
const MOSS_MOUND = ['..lGl..', '.lGGGl.', 'lGgGgGl', 'gmgmgmg'];
const PITCHER = ['.xx', 'xAx', 'xAx', 'Gx.'];
/** Stunted, moss-wrapped tree with beard moss hanging off its crown. */
const MOSSY_TREE = ['..lGGl..', '.lGgGgl.', 'lGgBgGGl', 'l.lBBl.l', 'l..Bl..G', '...B....', '.lmBml..'];
const MOSS_CARPET = ['.lGl.lGl', 'GgmgGgmg'];
const MOSSY_LOG = ['.lGlGll.', 'GmBBBBmG', '.BtBtBB.'];
const BOULDER = ['.RRR..', 'RrrwR.', 'RrrrrR', 'RRrRRR', '.kkkk.'];
const SCREE = ['r.R.', '.r.r'];
const TUFT = ['l.l.l', '.GlG.', '..g..'];
const FLOWER_Y = ['.y.', 'yoy', '.g.', '.g.'];
const FLOWER_P = ['p.p', '.P.', '.g.'];
const PEBBLE = ['rR'];
const LEAVES = ['b.t', '.B.'];
const SPECK = ['g'];

type Pick = [string[], number][];

const SETS: Record<ZoneStyle, { density: number; near: Pick; far: string[][] }> = {
  jungle: { density: 2.3, near: [[FERN, 4], [PALM, 2], [TARO, 2], [VINE_BUSH, 2], [LEAVES, 1]], far: [SPECK, ['gF']] },
  forest: { density: 1.4, near: [[BUSH, 4], [PINE, 3], [MUSHROOM, 1], [LOG, 1], [FERN, 1]], far: [['F'], ['fF']] },
  mossy: { density: 2, near: [[MOSS_MOUND, 4], [MOSSY_TREE, 3], [MOSS_CARPET, 3], [MOSSY_LOG, 1], [PITCHER, 1]], far: [['l'], ['lG']] },
  rocky: { density: 1.3, near: [[BOULDER, 3], [SCREE, 3], [TUFT, 2], [PEBBLE, 2]], far: [['r'], ['rR']] },
  meadow: { density: 1.4, near: [[TUFT, 4], [FLOWER_Y, 2], [FLOWER_P, 2], [PEBBLE, 1]], far: [['G'], ['lG']] },
  plain: { density: 0, near: [], far: [] },
};

/** Things that sit on the trail itself in technical stretches. */
const ROOTS = ['B.bB.', '.BB.B'];
const ROCK_STEP = ['.rr.', 'rRRr'];
export const WARN_SIGN = ['...k...', '..kyk..', '.kykyk.', 'kyykyyk', '.kyyyk.', '..kkk..', '...k...', '...B...', '...B...'];

export function decorDensity(style: ZoneStyle) {
  return SETS[style].density;
}

/** Deterministic choice of prop for `style` (`far` props are 1–2 px specks). */
export function decorSprite(style: ZoneStyle, r: number, far: boolean): string[] | null {
  const set = SETS[style];
  if (far) return set.far.length ? set.far[Math.floor(r * set.far.length) % set.far.length] : null;
  const total = set.near.reduce((s, [, w]) => s + w, 0);
  let acc = r * total;
  for (const [rows, w] of set.near) {
    if ((acc -= w) < 0) return rows;
  }
  return set.near[0]?.[0] ?? null;
}

export function techSprite(r: number): string[] {
  return r < 0.5 ? ROOTS : ROCK_STEP;
}

/** Small deterministic hash → [0,1) stream. */
export function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
