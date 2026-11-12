import { C } from './palette';
import { sunPosition } from './sky';
import { clamp, sampleAt, type Checkpoint, type Track } from './track';
import { rng } from './zones';

/**
 * Local wildlife: a few animal encounters along the trail, picked for where the hike is (a hornbill
 * over a Malaysian rainforest, macaques by the trail, a tapir at night; marmots and ibex in the Alps;
 * deer and rabbits in temperate woods), the height and the time of day. Ground animals sit beside the
 * trail and dash off as you come close; birds cross the sky; butterflies flutter round you by day.
 */

export type Region = 'seasia' | 'tropics' | 'alpine' | 'temperate';
type Kind = 'ground' | 'fly' | 'flutter';

interface Species {
  id: string;
  name: string;
  kind: Kind;
  regions: Region[];
  day: boolean;
  night: boolean;
  minEle?: number;
  maxEle?: number;
  /** Frames (char maps, facing right), colour keys. */
  frames: string[][];
  keys: Record<string, string>;
  /** Ground animals: how they leave — 'flee' (run off sideways) or 'stay' (watch you go by). */
  leave?: 'flee' | 'hop' | 'stay';
}

const SPECIES: Species[] = [
  {
    id: 'hornbill', name: 'HORNBILL', kind: 'fly', regions: ['seasia'], day: true, night: false,
    frames: [
      ['....kk.......', '.....kkk.....', '......kkk....', 'wwkkkkkkkkyyo', '.....kk......'],
      ['.............', '.............', 'wwkkkkkkkkyyo', '.....kkk.....', '....kk.......'],
    ],
    keys: { k: C.ink, w: C.white, y: C.yellow, o: C.orange },
  },
  {
    id: 'macaque', name: 'MACAQUES', kind: 'ground', regions: ['seasia', 'tropics'], day: true, night: false, maxEle: 1600, leave: 'hop',
    frames: [
      ['...bbb..', '..bbbbb.', '..bffkf.', '..bfff..', '.bbbbb..', 'bbbbbbb.', 'bbbbbbbt', '.bb.bb.t'],
      ['...bbb..', '..bbbbb.', '..bfkff.', '..bfff..', '.bbbbbf.', 'bbbbbb..', 'bbbbbbbt', '.bb.bb.t'],
    ],
    keys: { b: C.brown, f: C.tan, k: C.ink, t: C.brownDark },
  },
  {
    id: 'tapir', name: 'MALAYAN TAPIR', kind: 'ground', regions: ['seasia'], day: false, night: true, maxEle: 1500, leave: 'flee',
    frames: [
      ['..kkwwwwwwkkk...', '.kkkwwwwwwwkkkk.', 'kkkkwwwwwwwkkkkk', '.kkkwwwwwwwkkkk.', '..kk.......kk...', '..kk.......kk...'],
      ['..kkwwwwwwkkk...', '.kkkwwwwwwwkkkk.', 'kkkkwwwwwwwkkkk.', '.kkkwwwwwwwkkkkk', '..kk.......kk...', '...kk.....kk....'],
    ],
    keys: { k: C.dusk, w: C.white }, // its black is drawn blue-grey so it shows at night
  },
  {
    id: 'parrot', name: 'PARROTS', kind: 'fly', regions: ['tropics'], day: true, night: false,
    frames: [['..g....', '...gg..', 'rgggggy'], ['.......', 'rgggggy', '...gg..']],
    keys: { g: C.greenLight, r: C.red, y: C.yellow },
  },
  {
    id: 'butterfly', name: 'BUTTERFLIES', kind: 'flutter', regions: ['seasia', 'tropics', 'temperate'], day: true, night: false, maxEle: 2200,
    frames: [['p.p', '.k.'], ['.p.', '.k.']],
    keys: { p: C.orange, k: C.ink },
  },
  {
    id: 'marmot', name: 'MARMOT', kind: 'ground', regions: ['alpine'], day: true, night: false, minEle: 1400, leave: 'flee',
    frames: [
      ['.bb...', 'bkbb..', '.bbb..', '.tbb..', '.bbbb.', '.bbbb.', '.b..b.'],
      ['......', '.bb...', 'bkbb..', '.tbb..', '.bbbb.', '.bbbb.', '.b..b.'],
    ],
    keys: { b: C.tan, k: C.ink, t: C.cream },
  },
  {
    id: 'ibex', name: 'IBEX', kind: 'ground', regions: ['alpine'], day: true, night: false, minEle: 1800, leave: 'stay',
    frames: [
      ['.hh.........', 'h..h........', '...bbb......', '..bkbbbbbbb.', '...b.bbbbbbb', '.....bbbbbb.', '.....b.b.b.b', '.....b.b.b.b'],
      ['.hh.........', 'h..h........', '...bbb......', '..bkbbbbbbb.', '...b.bbbbbbb', '.....bbbbbb.', '.....b.b.b.b', '......b.b.b.'],
    ],
    keys: { h: C.brownDark, b: C.rockDark, k: C.ink },
  },
  {
    id: 'eagle', name: 'GOLDEN EAGLE', kind: 'fly', regions: ['alpine'], day: true, night: false,
    frames: [['.....ww....', 'bbbbbbbbbbb', '..bbbbbbb..', '....b.b....'], ['.....ww....', '.bbbbbbbbb.', 'bb.bbbbb.bb', '....b.b....']],
    keys: { b: C.brownDark, w: C.cream },
  },
  {
    id: 'deer', name: 'DEER', kind: 'ground', regions: ['temperate'], day: true, night: true, maxEle: 2200, leave: 'flee',
    frames: [
      ['..b.b.......', '...bb.......', '..bkbb......', '...b.bbbbbb.', '.....bbbbbbw', '.....bbbbbb.', '.....b.b.b.b', '.....b.b.b.b'],
      ['..b.b.......', '...bb.......', '..bkbb......', '...b.bbbbbb.', '.....bbbbbbw', '.....bbbbbb.', '......b.b.b.', '.....b.b.b.b'],
    ],
    keys: { b: C.brown, k: C.ink, w: C.white },
  },
  {
    id: 'rabbit', name: 'RABBIT', kind: 'ground', regions: ['temperate', 'alpine'], day: true, night: false, maxEle: 2500, leave: 'hop',
    frames: [['.gg..', '.gg..', 'gkgg.', 'gggw.'], ['..gg.', '.gg..', 'gkgg.', 'gggw.']],
    keys: { g: C.rock, k: C.ink, w: C.white },
  },
  {
    id: 'hawk', name: 'HAWK', kind: 'fly', regions: ['temperate'], day: true, night: false,
    frames: [['bbbb.bbbb', '..bbbbb..', '...b.b...'], ['.bbbbbbb.', 'b.bbbbb.b', '...b.b...']],
    keys: { b: C.brown },
  },
];

export interface Encounter {
  species: Species;
  d: number;
  /** Which side of the trail (ground animals), or which way it flies. */
  side: 1 | -1;
  seed: number;
}

export function regionOf(track: Track, alpineScenery: boolean): Region {
  const lat = track.lat0, lon = track.lon0;
  if (Math.abs(lat) < 23.5) return lon > 90 && lon < 160 ? 'seasia' : 'tropics';
  if (alpineScenery || track.stats.maxEle > 1800) return 'alpine';
  return 'temperate';
}

/** A handful of encounters along the track (deterministic per track), clear of the checkpoints. */
export function planWildlife(track: Track, region: Region, checkpoints: Checkpoint[]): Encounter[] {
  const L = track.stats.distance;
  const count = clamp(Math.round(L / 6000), 2, 12);
  const spacing = L / count;
  const rnd = rng(Math.round(track.stats.startTime / 1000) % 100000 + 17);
  const out: Encounter[] = [];
  let lastId = '';
  for (let k = 0; k < count; k++) {
    const d = clamp((k + 0.25 + rnd() * 0.5) * spacing, 600, L - 600);
    if (checkpoints.some((c) => c.enabled && Math.abs(c.d - d) < 400)) continue;
    const ele = sampleAt(track, track.ele, d);
    const ms = sampleAt(track, track.time, d);
    const day = (sunPosition(ms, track.lat0, track.lon0).elevation * 180) / Math.PI > -4;
    const fits = SPECIES.filter((s) =>
      s.regions.includes(region) && (day ? s.day : s.night) &&
      (s.minEle == null || ele >= s.minEle) && (s.maxEle == null || ele <= s.maxEle));
    // not the same animal twice in a row, unless it's the only one around (a tapir on a jungle night)
    const seen = (id: string) => out.filter((e) => e.species.id === id).length;
    const ok = (fits.length > 1 ? fits.filter((s) => s.id !== lastId) : fits).filter((s) => seen(s.id) < 2); // each at most twice
    if (!ok.length) continue;
    const species = ok[Math.floor(rnd() * ok.length)];
    lastId = species.id;
    out.push({ species, d, side: rnd() < 0.5 ? -1 : 1, seed: Math.floor(rnd() * 1e6) });
  }
  return out;
}

export const wildName = (e: Encounter) => e.species.name;

/** One drawable animal this frame (screen position = bottom-centre). */
export interface WildSprite { x: number; y: number; rows: string[]; keys: Record<string, string>; flip: boolean; a: number }

/**
 * A ground animal's screen pose: `rel` = metres the walker is past it (negative = still coming),
 * `px` its resting screen spot, `out` the screen direction away from the trail (unit).
 */
export function groundPose(e: Encounter, rel: number, t: number, px: { x: number; y: number }, out: { x: number; y: number }, scale: number): WildSprite | null {
  const s = e.species;
  const leaveAt = -40; // starts reacting just before you reach it
  const u = clamp((rel - leaveAt) / 260, 0, 1); // 0 = sitting … 1 = gone
  if (u >= 1) return null;
  const run = s.leave === 'stay' ? 0 : u;
  const fr = run > 0 ? Math.floor(t * 8) % s.frames.length : Math.floor(t * 1.5 + e.seed) % s.frames.length;
  const hop = s.leave === 'hop' && run > 0 ? -Math.abs(Math.sin(t * 14)) * 3 : 0;
  const away = run * 34 * scale;
  return {
    x: Math.round(px.x + out.x * away),
    y: Math.round(px.y + out.y * away * 0.5 + hop),
    rows: s.frames[fr],
    keys: s.keys,
    flip: run > 0 ? out.x < 0 : e.side < 0,
    a: s.leave === 'stay' ? clamp(1 - (rel - 200) / 200, 0, 1) : 1 - clamp((u - 0.6) / 0.4, 0, 1),
  };
}

/** Flying / fluttering animals for this video time (screen space). */
export function airSprites(
  list: { e: Encounter; t: number }[],
  t: number,
  W: number,
  H: number,
  hero: { x: number; y: number; visible: boolean },
): WildSprite[] {
  const out: WildSprite[] = [];
  for (const { e, t: t0 } of list) {
    const age = t - t0;
    const s = e.species;
    if (s.kind === 'fly') {
      const dur = s.id === 'eagle' ? 6 : 4.2;
      if (age < 0 || age > dur) continue;
      const u = age / dur;
      const dir = e.side;
      const baseY = Math.round(H * (H > W ? 0.3 : 0.24));
      const n = s.id === 'parrot' ? 3 : 1;
      for (let i = 0; i < n; i++) {
        const lag = i * 0.06;
        const uu = u - lag;
        if (uu < 0) continue;
        const x = dir > 0 ? -16 + uu * (W + 32) : W + 16 - uu * (W + 32);
        // eagles soar in a slow wave, others flap along
        const y = baseY + i * 4 + (s.id === 'eagle' ? Math.sin(uu * 6) * 10 : Math.sin(uu * 9 + i) * 2);
        const fr = s.id === 'eagle' ? (Math.sin(uu * 6) > 0.6 ? 1 : 0) : Math.floor(t * 6 + i) % s.frames.length;
        out.push({ x: Math.round(x), y: Math.round(y), rows: s.frames[fr], keys: s.keys, flip: dir < 0, a: 1 });
      }
    } else if (s.kind === 'flutter') {
      if (age < -0.5 || age > 3.5 || !hero.visible) continue;
      const cols = [C.orange, C.yellow, C.skyLight];
      for (let i = 0; i < 2; i++) {
        const ph = e.seed * 0.001 + i * 2.1;
        const x = hero.x + Math.sin(t * 1.3 + ph) * (10 + i * 6) + (i ? 8 : -8);
        const y = hero.y - 12 + Math.cos(t * 1.7 + ph) * 5 - i * 3;
        out.push({ x: Math.round(x), y: Math.round(y), rows: s.frames[Math.floor(t * 9 + i) % 2], keys: { ...s.keys, p: cols[(e.seed + i) % 3] }, flip: false, a: 1 });
      }
    }
  }
  return out;
}
