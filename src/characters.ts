import { C, type ColorName } from './palette';

/**
 * Pixel Hike sprite standard v1 — see docs/SPRITE_SPEC.md.
 *
 *  - every frame is 16×16, facing RIGHT, feet on the bottom row (anchor = bottom-centre)
 *  - a sheet is 4 columns × 8 rows (64×128 px), one animation per row, in ANIMS order
 *  - unused cells are transparent; colours come from the 32-colour palette
 */
export const ANIMS = ['idle', 'walk', 'run', 'climb', 'descend', 'cheer', 'rest', 'sleep'] as const;
export type Anim = (typeof ANIMS)[number];

export const ANIM_INFO: Record<Anim, { frames: number; fps: number; use: string }> = {
  idle: { frames: 2, fps: 2, use: 'Intro, standing still (2nd frame = blink)' },
  walk: { frames: 4, fps: 6, use: 'Hiking on flat / gentle ground' },
  run: { frames: 4, fps: 10, use: 'Trail running' },
  climb: { frames: 4, fps: 5, use: 'Steep uphill (grade > 15%), leaning forward' },
  descend: { frames: 4, fps: 6, use: 'Steep downhill (grade < -15%), leaning back' },
  cheer: { frames: 2, fps: 5, use: 'Summit, peak, finish (frame 1 = jump)' },
  rest: { frames: 2, fps: 1.5, use: 'Rest stops and aid stations, sitting (2nd frame = drinking)' },
  sleep: { frames: 2, fps: 1, use: 'Camp at night (2nd frame = breathing)' },
};

export const FRAME = 16;
export const SHEET_W = FRAME * 4;
export const SHEET_H = FRAME * ANIMS.length;

export type CharacterId = 'hiker' | 'runner' | 'me' | 'dog' | 'cat';
export const CHARACTER_LABEL: Record<CharacterId, string> = { hiker: 'Hiker', runner: 'Runner', me: 'Me', dog: 'Dog', cat: 'Cat' };
export const isHuman = (id: CharacterId) => id === 'hiker' || id === 'runner' || id === 'me';

/** "Me": a person dressed from the user's own kit (colours are palette names). */
export interface Look {
  headwear: 'lamp' | 'band' | 'cap' | 'bucket' | 'none';
  hair: ColorName;
  skin: ColorName;
  top: ColorName;
  sleeves: 'short' | 'long';
  bottoms: ColorName;
  legs: 'shorts' | 'pants';
  pack: 'vest' | 'backpack' | 'none';
  packColor: ColorName;
  shoes: ColorName;
  hatColor: ColorName;
  bib: boolean;
  poles: boolean;
  wristband: boolean;
}

/** Race kit from the user's KORGA UTR finish photos. */
export const KORGA_LOOK: Look = {
  headwear: 'lamp', hair: 'ink2', skin: 'skin', top: 'sky', sleeves: 'short', bottoms: 'ink2', legs: 'shorts',
  pack: 'vest', packColor: 'ink', shoes: 'sage', hatColor: 'rockDark', bib: true, poles: false, wristband: true,
};

/** Darker partner for shading a colour (sleeve side, back leg, brim). */
const SHADE: Partial<Record<ColorName, ColorName>> = {
  white: 'greyLight', greyLight: 'rock', rock: 'rockDark', rockDark: 'night', skyPale: 'skyLight', skyLight: 'sky',
  sky: 'dusk', dusk: 'night', night: 'ink2', ink2: 'ink', ink: 'ink', yellow: 'orange', cream: 'tan', orange: 'coral',
  coral: 'red', red: 'wine', wine: 'plum', pink: 'purple', purple: 'plum', plum: 'ink2', lime: 'greenLight',
  greenLight: 'green', green: 'forest', forest: 'forestDeep', forestDeep: 'tealDeep', sage: 'moss', moss: 'tealDeep',
  tealDeep: 'ink2', tan: 'brown', brown: 'brownDark', brownDark: 'ink2', skin: 'tan',
};
const shade = (c: ColorName): ColorName => SHADE[c] ?? c;
/** People: female = fringe + ponytail. Pets: female = a pink bow. Outfits are shared. */
export type Gender = 'male' | 'female';

export interface SpriteSet {
  frames: Record<Anim, HTMLCanvasElement[]>;
  flipped: Record<Anim, HTMLCanvasElement[]>;
  /** Pixel inside the frame where the head-lamp sits (for the night glow), or null. */
  lamp: [number, number] | null;
}

// ------------------------------------------------------------------ tiny raster helpers

type Grid = string[][];
const grid = (): Grid => Array.from({ length: FRAME }, () => Array<string>(FRAME).fill('.'));
const P = (g: Grid, x: number, y: number, c: string) => {
  x = Math.round(x); y = Math.round(y);
  if (x >= 0 && x < FRAME && y >= 0 && y < FRAME) g[y][x] = c;
};
const R = (g: Grid, x0: number, y0: number, x1: number, y1: number, c: string) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) P(g, x, y, c);
};
const L = (g: Grid, x0: number, y0: number, x1: number, y1: number, c: string) => {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    P(g, x0, y0, c);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
};
/** 1px dark outline around everything except `skip` colours (thin props like poles). */
function outline(g: Grid, skip = 'w'): string[] {
  const out = g.map((r) => [...r]);
  for (let y = 0; y < FRAME; y++) {
    for (let x = 0; x < FRAME; x++) {
      if (g[y][x] !== '.') continue;
      const nb = [g[y - 1]?.[x], g[y + 1]?.[x], g[y][x - 1], g[y][x + 1]];
      if (nb.some((c) => c && c !== '.' && c !== 'k' && !skip.includes(c))) out[y][x] = 'k';
    }
  }
  return out.map((r) => r.join(''));
}

// ------------------------------------------------------------------ people

interface HumanPose {
  bob?: number; // upper-body dy (negative = up)
  lean?: number; // upper-body dx (positive = forward)
  front?: [number, number]; // front foot [x, lift]
  back?: [number, number];
  hand?: [number, number]; // near hand (absolute, standing frame)
  hand2?: [number, number]; // far hand when both arms show (cheer)
  pole?: number; // pole tip x offset from the hand, undefined = no pole
  blink?: boolean;
  pose?: 'stand' | 'sit' | 'lie';
  drink?: boolean;
  breathe?: boolean;
}

interface Outfit {
  hat: 'bucket' | 'band' | 'lamp' | 'cap' | 'none';
  pack: 'backpack' | 'vest' | 'none';
  pole: boolean;
  bib: boolean;
  bareLegs: boolean;
  shortSleeves?: boolean;
  wristband?: boolean;
  female?: boolean;
}

const OUTFITS: Record<'hiker' | 'runner', Outfit> = {
  hiker: { hat: 'bucket', pack: 'backpack', pole: true, bib: false, bareLegs: false },
  runner: { hat: 'band', pack: 'none', pole: false, bib: true, bareLegs: true },
};

function lookOutfit(l: Look): Outfit {
  return {
    hat: l.headwear, pack: l.pack, pole: l.poles, bib: l.bib, bareLegs: l.legs === 'shorts',
    shortSleeves: l.sleeves === 'short', wristband: l.wristband,
  };
}

function lookKeys(l: Look): Record<string, string> {
  const hatShade = l.headwear === 'lamp' || l.headwear === 'band' ? C.cream : C[shade(l.hatColor)];
  return {
    k: C.ink, h: C[l.hatColor], H: hatShade, l: C.cream, r: C[l.hair], s: C[l.skin], c: C.pink,
    t: C[l.top], T: C[shade(l.top)], b: C[shade(l.packColor)], B: C[l.packColor], p: C[l.bottoms], P: C[shade(l.bottoms)],
    o: C[l.shoes], w: C.rockDark, W: C.white, S: C.skyPale, g: C.purple, G: C.plum, x: C.red, y: C.red,
  };
}

const HUMAN_KEYS: Record<'hiker' | 'runner', Record<string, string>> = {
  hiker: {
    k: C.ink, h: C.coral, H: C.wine, l: C.cream, r: C.brownDark, s: C.skin, c: C.pink,
    t: C.yellow, T: C.orange, b: C.tealDeep, B: C.moss, p: C.dusk, P: C.night, o: C.brownDark,
    w: C.brown, W: C.white, S: C.skyLight, g: C.coral, G: C.wine,
  },
  runner: {
    k: C.ink, h: C.red, H: C.wine, l: C.cream, r: C.brownDark, s: C.skin, c: C.pink,
    t: C.skyLight, T: C.sky, b: C.tealDeep, B: C.moss, p: C.ink2, P: C.ink2, o: C.coral,
    w: C.brown, W: C.white, S: C.skyPale, g: C.purple, G: C.plum,
  },
};

function drawHead(g: Grid, bx: number, by: number, o: Outfit, blink?: boolean, sway = 0) {
  R(g, 5 + bx, 5 + by, 10 + bx, 8 + by, 's');
  P(g, 5 + bx, 5 + by, 'r'); P(g, 5 + bx, 6 + by, 'r');
  if (o.female) {
    P(g, 5 + bx, 7 + by, 'r'); // longer hair at the back
    P(g, 6 + bx, 5 + by, 'r'); P(g, 7 + bx, 5 + by, 'r'); // fringe
    if (!blink) P(g, 10 + bx, 5 + by, 'k'); // eyelash
  }
  if (blink) { P(g, 8 + bx, 6 + by, 'k'); P(g, 9 + bx, 6 + by, 'k'); }
  else { P(g, 9 + bx, 5 + by, 'k'); P(g, 9 + bx, 6 + by, 'k'); }
  P(g, 10 + bx, 7 + by, 'c');
  if (o.hat === 'lamp' || o.hat === 'none' || o.hat === 'cap') {
    R(g, 5 + bx, 2 + by, 9 + bx, 4 + by, 'r'); // hair
    if (o.hat !== 'cap') { P(g, 6 + bx, 1 + by, 'r'); P(g, 8 + bx, 1 + by, 'r'); } // a bit of spike
    if (o.hat === 'lamp') {
      R(g, 5 + bx, 4 + by, 9 + bx, 4 + by, 'h'); // strap
      P(g, 10 + bx, 4 + by, 'l'); // the lamp itself, on the forehead
    } else if (o.hat === 'cap') {
      R(g, 5 + bx, 2 + by, 9 + bx, 3 + by, 'h');
      R(g, 9 + bx, 4 + by, 11 + bx, 4 + by, 'H'); // peak
    }
    if (o.female) {
      P(g, 6 + bx, 5 + by, 'r'); P(g, 7 + bx, 5 + by, 'r'); // fringe
      P(g, 4 + bx, 4 + by, 'c');
      P(g, 3 + bx, 4 + by, 'r'); P(g, 2 + bx, 5 + by, 'r'); P(g, 2 + bx, 6 + by, 'r');
      P(g, (sway > 0 ? 2 : 3) + bx, 7 + by, 'r');
    }
  } else if (o.hat === 'bucket') {
    R(g, 5 + bx, 2 + by, 9 + bx, 3 + by, 'h');
    R(g, 4 + bx, 4 + by, 11 + bx, 4 + by, 'H');
    P(g, 8 + bx, 3 + by, 'l'); // head-lamp
    if (o.female) {
      // ponytail out from under the hat; the tip lags behind when the body bobs
      // sticks out above the backpack so it reads at 16 px
      P(g, 4 + bx, 5 + by, 'c');
      P(g, 3 + bx, 5 + by, 'r'); P(g, 2 + bx, 5 + by, 'r'); P(g, 2 + bx, 6 + by, 'r');
      P(g, (sway > 0 ? 1 : 2) + bx, 7 + by, 'r');
    }
  } else {
    R(g, 5 + bx, 2 + by, 9 + bx, 4 + by, 'r'); // hair
    R(g, 5 + bx, 4 + by, 10 + bx, 4 + by, 'h'); // headband
    if (o.female) {
      P(g, 4 + bx, 4 + by, 'c'); // hair tie
      P(g, 3 + bx, 4 + by, 'r'); P(g, 2 + bx, 5 + by, 'r'); P(g, 2 + bx, 6 + by, 'r');
      P(g, (sway > 0 ? 2 : 3) + bx, 7 + by, 'r');
    } else {
      P(g, 4 + bx, 4 + by, 'h'); P(g, 3 + bx, 5 + by, 'h'); // flying band tails
    }
    P(g, 9 + bx, 4 + by, 'l');
  }
}

function drawLeg(g: Grid, hipX: number, hipY: number, foot: [number, number], legC: string) {
  const fy = 14 - foot[1];
  L(g, hipX, hipY, foot[0], Math.max(hipY, fy - 1), legC);
  P(g, foot[0], fy, 'o');
  P(g, foot[0] + 1, fy, 'o');
}

function drawHuman(p: HumanPose, o: Outfit): string[] {
  const g = grid();
  const legFront = o.bareLegs ? 's' : 'p';
  const legBack = o.bareLegs ? 's' : 'P';

  if (p.pose === 'lie') {
    // sleeping bag with the head poking out on the right
    const top = p.breathe ? 10 : 11;
    R(g, 2, top, 10, 14, 'g');
    R(g, 3, top + 1, 9, top + 1, 'G');
    P(g, 2, top, '.'); P(g, 2, 14, '.');
    R(g, 11, 11, 13, 14, 's');
    R(g, 11, 10, 13, 10, o.hat === 'bucket' || o.hat === 'cap' ? 'h' : 'r');
    if (o.female) { P(g, 14, 11, 'r'); P(g, 14, 12, 'r'); } // hair on the pillow
    P(g, 12, 12, 'k'); P(g, 13, 12, 'k'); // closed eyes
    P(g, 13, 13, 'c');
    return outline(g);
  }

  const sit = p.pose === 'sit';
  const by = (p.bob ?? 0) + (sit ? 3 : 0);
  const bx = p.lean ?? 0;

  // back leg (behind everything)
  if (!sit) drawLeg(g, 6, 12, p.back ?? [5, 0], legBack);
  // backpack
  if (o.pack === 'backpack') { R(g, 3 + bx, 8 + by, 4 + bx, 11 + by, 'B'); P(g, 4 + bx, 7 + by, 'B'); }
  // torso
  R(g, 5 + bx, 9 + by, 8 + bx, 11 + by, 't');
  R(g, 5 + bx, 9 + by, 5 + bx, 11 + by, 'T');
  if (o.pack === 'backpack') { P(g, 7 + bx, 9 + by, 'b'); P(g, 7 + bx, 10 + by, 'b'); }
  if (o.pack === 'vest') {
    // race vest: snug back panel + front pocket with a soft flask (white cap)
    P(g, 4 + bx, 9 + by, 'B'); // back panel
    P(g, 8 + bx, 9 + by, 'W'); // flask cap
    P(g, 8 + bx, 10 + by, 'B'); // chest pocket
  }
  if (o.bib) {
    if (o.pack === 'vest') { P(g, 6 + bx, 11 + by, 'y'); P(g, 7 + bx, 11 + by, 'W'); }
    else R(g, 6 + bx, 10 + by, 7 + bx, 11 + by, 'W');
  }
  // hips + legs
  if (sit) {
    R(g, 5, 13, 8, 13, 'p');
    R(g, 8, 14, 10, 14, legFront);
    P(g, 11, 13, 'o'); P(g, 11, 14, 'o');
  } else {
    R(g, 5, 12, 8, 12, 'p');
    drawLeg(g, 7, 12, p.front ?? [8, 0], legFront);
  }
  drawHead(g, bx, by, o, p.blink, -(p.bob ?? 0));

  // arms
  const sh: [number, number] = [7 + bx, 9 + by];
  const arm = o.shortSleeves ? 's' : 'T';
  if (p.hand2) {
    L(g, 6 + bx, 9 + by, p.hand2[0] + bx, p.hand2[1] + by, arm);
    P(g, 6 + bx, 9 + by, 'T');
    P(g, p.hand2[0] + bx, p.hand2[1] + by, 's');
  }
  const hand: [number, number] = sit
    ? p.drink ? [10, 9 + by - 3] : [10, 13]
    : [(p.hand ?? [7, 11])[0] + bx, (p.hand ?? [7, 11])[1] + by];
  L(g, sh[0], sh[1], hand[0], hand[1], arm);
  P(g, sh[0], sh[1], 'T'); // sleeve
  P(g, hand[0], hand[1], 's');
  if (o.wristband) {
    const dx = sh[0] - hand[0], dy = sh[1] - hand[1], len = Math.hypot(dx, dy) || 1;
    if (len >= 2) P(g, hand[0] + dx / len, hand[1] + dy / len, 'x');
  }
  if (sit && p.drink) { P(g, hand[0] + 1, hand[1] - 1, 'S'); P(g, hand[0] + 1, hand[1], 'S'); }
  if (o.pole && p.pole != null && !sit) L(g, hand[0] + 1, hand[1], hand[0] + 1 + p.pole, 14, 'w');
  return outline(g);
}

function humanFrames(o: Outfit): Record<Anim, string[][]> {
  return {
    idle: [
      drawHuman({ front: [8, 0], back: [5, 0], hand: [7, 11], pole: 1 }, o),
      drawHuman({ front: [8, 0], back: [5, 0], hand: [7, 11], pole: 1, blink: true }, o),
    ],
    walk: [
      drawHuman({ front: [9, 0], back: [4, 0], hand: [5, 11], pole: 0 }, o),
      drawHuman({ bob: -1, front: [7, 0], back: [6, 1], hand: [7, 11], pole: 1 }, o),
      drawHuman({ front: [4, 0], back: [9, 0], hand: [9, 11], pole: 2 }, o),
      drawHuman({ bob: -1, front: [6, 1], back: [7, 0], hand: [7, 11], pole: 1 }, o),
    ],
    run: [
      drawHuman({ lean: 1, front: [10, 0], back: [3, 2], hand: [5, 10], hand2: [9, 9] }, o),
      drawHuman({ lean: 1, bob: -1, front: [8, 2], back: [5, 2], hand: [7, 10] }, o),
      drawHuman({ lean: 1, front: [3, 2], back: [10, 0], hand: [9, 9], hand2: [5, 10] }, o),
      drawHuman({ lean: 1, bob: -1, front: [5, 2], back: [8, 2], hand: [7, 10] }, o),
    ],
    climb: [
      drawHuman({ lean: 1, front: [9, 1], back: [5, 0], hand: [9, 10], pole: 2 }, o),
      drawHuman({ lean: 1, front: [8, 0], back: [6, 1], hand: [8, 10], pole: 2 }, o),
      drawHuman({ lean: 1, front: [5, 0], back: [9, 1], hand: [9, 10], pole: 2 }, o),
      drawHuman({ lean: 1, front: [6, 1], back: [8, 0], hand: [8, 10], pole: 2 }, o),
    ],
    descend: [
      drawHuman({ lean: -1, front: [9, 0], back: [5, 0], hand: [9, 11], pole: 3 }, o),
      drawHuman({ lean: -1, bob: 1, front: [8, 0], back: [6, 1], hand: [9, 11], pole: 3 }, o),
      drawHuman({ lean: -1, front: [6, 0], back: [8, 0], hand: [9, 11], pole: 3 }, o),
      drawHuman({ lean: -1, bob: 1, front: [7, 1], back: [6, 0], hand: [9, 11], pole: 3 }, o),
    ],
    cheer: [
      drawHuman({ bob: -2, front: [8, 2], back: [5, 2], hand: [11, 4], hand2: [3, 4] }, o),
      drawHuman({ front: [8, 0], back: [5, 0], hand: [11, 5], hand2: [3, 5] }, o),
    ],
    rest: [drawHuman({ pose: 'sit' }, o), drawHuman({ pose: 'sit', drink: true }, o)],
    sleep: [drawHuman({ pose: 'lie' }, o), drawHuman({ pose: 'lie', breathe: true }, o)],
  };
}

// ------------------------------------------------------------------ pets

interface PetPose {
  bob?: number;
  head?: number; // head dy (climb: -1, descend: +1)
  a?: [number, number]; // near-front + far-back legs [dx, lift]
  b?: [number, number]; // far-front + near-back legs
  fronts?: [number, number]; // gallop: both fronts
  backs?: [number, number]; // gallop: both backs
  tail?: 0 | 1 | 2;
  blink?: boolean;
  pose?: 'stand' | 'lie' | 'curl';
  breathe?: boolean;
}

type Species = 'dog' | 'cat';

const PET_KEYS: Record<Species, Record<string, string>> = {
  dog: { k: C.ink, a: C.tan, A: C.brown, e: C.brownDark, n: C.ink, R: C.red, c: C.pink, w: C.pink },
  cat: { k: C.ink, a: C.orange, A: C.coral, e: C.orange, n: C.pink, R: C.skyLight, c: C.pink, w: C.pink },
};

function drawPet(p: PetPose, sp: Species, female = false): string[] {
  const g = grid();
  const cat = sp === 'cat';
  if (p.pose === 'curl') {
    const top = p.breathe ? 9 : 10;
    R(g, 3, top + 1, 11, 14, 'a');
    R(g, 4, top, 10, top, 'a');
    R(g, 3, 14, 11, 14, 'A'); // tail wrapped round
    R(g, 9, top + 1, 12, top + 3, 'a'); // head tucked in
    if (cat) { P(g, 9, top, 'a'); P(g, 11, top, 'a'); } else R(g, 9, top + 1, 10, top + 2, 'e');
    P(g, 11, top + 2, 'k'); P(g, 12, top + 2, 'k');
    if (cat) { P(g, 5, top + 1, 'A'); P(g, 7, top + 1, 'A'); }
    if (female) { P(g, 10, top, 'w'); P(g, 11, top, 'w'); }
    return outline(g, '');
  }
  if (p.pose === 'lie') {
    R(g, 3, 11, 10, 13, 'a');
    R(g, 10, 13, 13, 14, 'a'); // paws forward
    drawPetHead(g, 0, 3, sp, p.blink, female);
    drawTail(g, sp, p.tail ?? 0, 3);
    return outline(g, '');
  }
  const by = p.bob ?? 0, hy = (p.head ?? 0) + by;
  const legY = cat ? 12 : 12;
  const leg = (x: number, d: [number, number], c: string) => {
    const fy = 14 - d[1];
    L(g, x, legY + by, x + d[0], Math.max(legY + by, fy), c);
  };
  const A = p.fronts ? p.fronts : p.a ?? [0, 0];
  const B = p.backs ? p.backs : p.b ?? [0, 0];
  const nearFront = A, farBack = p.backs ? B : A;
  const farFront = p.fronts ? A : B, nearBack = B;
  // far legs (darker) first
  leg(10, farFront, 'A');
  leg(4, farBack, 'A');
  drawTail(g, sp, p.tail ?? 0, by);
  // body
  if (cat) R(g, 4, 9 + by, 10, 11 + by, 'a');
  else R(g, 4, 8 + by, 10, 11 + by, 'a');
  if (cat) { P(g, 6, 9 + by, 'A'); P(g, 8, 9 + by, 'A'); P(g, 5, 10 + by, 'A'); }
  else R(g, 5, 11 + by, 9, 11 + by, 'A');
  // near legs
  leg(9, nearFront, 'a');
  leg(5, nearBack, 'a');
  drawPetHead(g, 0, hy, sp, p.blink, female);
  return outline(g, '');
}

function drawPetHead(g: Grid, dx: number, dy: number, sp: Species, blink?: boolean, female = false) {
  if (sp === 'dog') {
    R(g, 10 + dx, 5 + dy, 13 + dx, 8 + dy, 'a');
    R(g, 14 + dx, 7 + dy, 14 + dx, 8 + dy, 'a'); // snout
    P(g, 14 + dx, 7 + dy, 'n'); // nose
    R(g, 10 + dx, 5 + dy, 10 + dx, 8 + dy, 'e'); // floppy ear
    P(g, 11 + dx, 5 + dy, 'e');
    if (blink) P(g, 12 + dx, 7 + dy, 'k'); else { P(g, 12 + dx, 6 + dy, 'k'); }
    if (female) { P(g, 12 + dx, 4 + dy, 'w'); P(g, 13 + dx, 4 + dy, 'w'); } // bow
    else { P(g, 10 + dx, 9 + dy, 'R'); P(g, 11 + dx, 9 + dy, 'R'); } // bandana
  } else {
    R(g, 10 + dx, 7 + dy, 13 + dx, 9 + dy, 'a');
    P(g, 11 + dx, 6 + dy, 'a'); P(g, 13 + dx, 6 + dy, 'a'); // pointy ears
    P(g, 11 + dx, 7 + dy, 'A');
    if (blink) { P(g, 12 + dx, 8 + dy, 'k'); P(g, 11 + dx, 8 + dy, 'k'); } else P(g, 12 + dx, 8 + dy, 'k');
    P(g, 13 + dx, 9 + dy, 'n');
    if (female) { P(g, 10 + dx, 10 + dy, 'w'); P(g, 11 + dx, 10 + dy, 'w'); } // neck bow
    else P(g, 10 + dx, 10 + dy, 'R'); // collar bell
  }
}

function drawTail(g: Grid, sp: Species, wag: number, by: number) {
  if (sp === 'dog') {
    const pts = [[[3, 8], [2, 7], [2, 6]], [[3, 8], [2, 7], [1, 7]], [[3, 8], [3, 7], [3, 6]]][wag];
    pts.forEach(([x, y]) => P(g, x, y + by, 'a'));
  } else {
    const pts = [
      [[3, 10], [2, 9], [2, 8], [3, 7]],
      [[3, 10], [2, 9], [1, 8], [1, 7]],
      [[3, 10], [3, 9], [3, 8], [4, 7]],
    ][wag];
    pts.forEach(([x, y]) => P(g, x, y + by, 'a'));
  }
}

function petFrames(sp: Species, female: boolean): Record<Anim, string[][]> {
  const D = (p: PetPose) => drawPet(p, sp, female);
  return {
    idle: [D({ tail: 0 }), D({ tail: 1, blink: true })],
    walk: [
      D({ a: [1, 0], b: [-1, 0], tail: 0 }),
      D({ a: [0, 0], b: [0, 1], tail: 1 }),
      D({ a: [-1, 0], b: [1, 0], tail: 0 }),
      D({ a: [0, 1], b: [0, 0], tail: 2 }),
    ],
    run: [
      D({ fronts: [2, 0], backs: [-2, 0], tail: 1 }),
      D({ bob: -1, fronts: [0, 1], backs: [0, 1], tail: 0 }),
      D({ fronts: [1, 0], backs: [-1, 0], tail: 1 }),
      D({ bob: -1, fronts: [-1, 1], backs: [1, 1], tail: 2 }),
    ],
    climb: [
      D({ head: -1, a: [1, 1], b: [-1, 0], tail: 0 }),
      D({ head: -1, a: [0, 0], b: [0, 1], tail: 1 }),
      D({ head: -1, a: [-1, 0], b: [1, 0], tail: 0 }),
      D({ head: -1, a: [0, 1], b: [0, 0], tail: 2 }),
    ],
    descend: [
      D({ head: 1, a: [1, 0], b: [-1, 0], tail: 2 }),
      D({ head: 1, a: [0, 0], b: [0, 1], tail: 2 }),
      D({ head: 1, a: [-1, 0], b: [1, 0], tail: 2 }),
      D({ head: 1, a: [0, 1], b: [0, 0], tail: 2 }),
    ],
    cheer: [D({ bob: -2, a: [0, 1], b: [0, 1], tail: 2 }), D({ tail: 1 })],
    rest: [D({ pose: 'lie', tail: 0 }), D({ pose: 'lie', tail: 1, blink: true })],
    sleep: [D({ pose: 'curl' }), D({ pose: 'curl', breathe: true })],
  };
}

// ------------------------------------------------------------------ sets

function rasterise(rows: string[], keys: Record<string, string>, flip: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = FRAME;
  c.height = FRAME;
  const ctx = c.getContext('2d')!;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = keys[row[x]];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(flip ? FRAME - 1 - x : x, y, 1, 1);
    }
  });
  return c;
}

const builtIn = new Map<string, SpriteSet>();

export function builtInSet(id: CharacterId, gender: Gender = 'male', look: Look = KORGA_LOOK): SpriteSet {
  const key = `${id}-${gender}${id === 'me' ? JSON.stringify(look) : ''}`;
  const hit = builtIn.get(key);
  if (hit) return hit;
  const female = gender === 'female';
  const outfit = id === 'me' ? lookOutfit(look) : id === 'hiker' || id === 'runner' ? OUTFITS[id] : null;
  const maps = outfit ? humanFrames({ ...outfit, female }) : petFrames(id as Species, female);
  const keys = id === 'me' ? lookKeys(look) : id === 'hiker' || id === 'runner' ? HUMAN_KEYS[id] : PET_KEYS[id as Species];
  const frames = {} as Record<Anim, HTMLCanvasElement[]>;
  const flipped = {} as Record<Anim, HTMLCanvasElement[]>;
  for (const a of ANIMS) {
    frames[a] = maps[a].map((m) => rasterise(m, keys, false));
    flipped[a] = maps[a].map((m) => rasterise(m, keys, true));
  }
  const set: SpriteSet = {
    frames,
    flipped,
    lamp: id === 'hiker' ? [8, 3] : id === 'runner' ? [9, 4] : outfit?.hat === 'lamp' ? [10, 4] : outfit?.hat === 'bucket' ? [8, 3] : null,
  };
  builtIn.set(key, set);
  return set;
}

/** Load a user sheet (PNG following the standard). Empty cells fall back to the built-in frames. */
export async function loadSheet(file: Blob, fallback: CharacterId, gender: Gender = 'male'): Promise<SpriteSet> {
  const img = await createImageBitmap(file);
  if (img.width % SHEET_W !== 0 || img.height % SHEET_H !== 0 || img.width / SHEET_W !== img.height / SHEET_H) {
    throw new Error(`Sprite sheet must be ${SHEET_W}×${SHEET_H} px (or an exact multiple, e.g. ${SHEET_W * 8}×${SHEET_H * 8}).`);
  }
  const scale = img.width / SHEET_W;
  const base = builtInSet(fallback, gender);
  const frames = {} as Record<Anim, HTMLCanvasElement[]>;
  const flipped = {} as Record<Anim, HTMLCanvasElement[]>;
  ANIMS.forEach((a, row) => {
    frames[a] = [];
    flipped[a] = [];
    for (let col = 0; col < ANIM_INFO[a].frames; col++) {
      const c = document.createElement('canvas');
      c.width = FRAME;
      c.height = FRAME;
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, col * FRAME * scale, row * FRAME * scale, FRAME * scale, FRAME * scale, 0, 0, FRAME, FRAME);
      const data = ctx.getImageData(0, 0, FRAME, FRAME).data;
      let any = false;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 127) { any = true; break; }
      if (!any) {
        frames[a].push(base.frames[a][col]);
        flipped[a].push(base.flipped[a][col]);
        continue;
      }
      // hard alpha (pixel art)
      const id = ctx.getImageData(0, 0, FRAME, FRAME);
      for (let i = 3; i < id.data.length; i += 4) id.data[i] = id.data[i] > 127 ? 255 : 0;
      ctx.putImageData(id, 0, 0);
      const f = document.createElement('canvas');
      f.width = FRAME;
      f.height = FRAME;
      const fctx = f.getContext('2d')!;
      fctx.translate(FRAME, 0);
      fctx.scale(-1, 1);
      fctx.drawImage(c, 0, 0);
      frames[a].push(c);
      flipped[a].push(f);
    }
  });
  return { frames, flipped, lamp: base.lamp };
}

/** The standard sheet for a set (use as a template for Grok Imagine / unfake.js). */
export function renderSheet(set: SpriteSet, scale = 1, guides = false): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = SHEET_W * scale;
  c.height = SHEET_H * scale;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ANIMS.forEach((a, row) => {
    for (let col = 0; col < 4; col++) {
      if (guides) {
        ctx.fillStyle = (row + col) % 2 ? '#2b2d4a' : '#3b3f6b';
        if (col >= ANIM_INFO[a].frames) ctx.fillStyle = '#1a1c2c';
        ctx.fillRect(col * FRAME * scale, row * FRAME * scale, FRAME * scale, FRAME * scale);
      }
      const f = set.frames[a][col];
      if (f) ctx.drawImage(f, col * FRAME * scale, row * FRAME * scale, FRAME * scale, FRAME * scale);
    }
  });
  return c;
}

/** Which animation to play for a given situation. */
export function frameOf(set: SpriteSet, anim: Anim, t: number, flip: boolean): HTMLCanvasElement {
  const list = (flip ? set.flipped : set.frames)[anim];
  const i = Math.floor(t * ANIM_INFO[anim].fps) % list.length;
  return list[i];
}
