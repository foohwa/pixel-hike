// Pull 16×16 sprites from the CC0 Pixel Art Atlas (huggingface.co/datasets/Angais/pixel-art-atlas-1.4m:
// 1.4M AI-generated sprites with captions) and turn the ones you pick into palette-exact char maps.
//
// One-time setup (~260 MB download, ~800 MB unpacked, kept outside the repo):
//   mkdir -p ~/.cache/pixel-hike/atlas && cd ~/.cache/pixel-hike/atlas
//   curl -LO https://huggingface.co/datasets/Angais/pixel-art-atlas-1.4m/resolve/main/pixel-art-16x16-1.4m.zip
//   unzip pixel-art-16x16-1.4m.zip && rm pixel-art-16x16-1.4m.zip
// (or set ATLAS_DIR to wherever it lives)
//
// usage:
//   node scripts/atlas-sprites.mjs search <words…> [--n 48] [--subject] [--colors ink,brown,…] [--out sheet.png]
//       Contact sheet of matches: each cell shows the original (left) and the 32-colour version (right),
//       numbered; the console lists number → row + caption. --subject matches the subject name only;
//       --colors limits the 32-colour version to those palette names (try what picks.json will use).
//   node scripts/atlas-sprites.mjs build
//       Reads art/atlas/picks.json  { id: { row, colors?, remap?, height?, fill?, outline?, flip? } }
//       and writes src/atlasart.ts (same shape as src/wildart.ts) + docs/sprites/atlas-preview.png.
//       colors: palette names allowed (default all 32); remap: { from: to } after snapping;
//       height: shrink to this many px by dropping the rows/columns most like their neighbours (shrink: 'vote'
//       instead takes the most common colour per cell, `fill` share needed, default 0.45);
//       outline: add a 1 px ink outline outside the shape; flip: mirror so it faces right;
//       inkEdge (default true): dark pixels on the silhouette edge become ink, like the sprite standard;
//       decor: a trail-side prop → ATLAS_DECOR in zones.ts's letters (day/night colours), not ATLAS_ART.
//
// Licence: the atlas is CC0 (AI-generated with Krea 2 Turbo + a pixel-art LoRA; see the dataset card for
// Krea's terms). Nothing from the atlas is committed except the converted sprites in src/atlasart.ts.
import { closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const DIR = process.env.ATLAS_DIR ?? join(homedir(), '.cache/pixel-hike/atlas');
if (!existsSync(join(DIR, 'tokens.npy'))) {
  console.error(`No atlas in ${DIR} — see the setup lines at the top of this script.`);
  process.exit(1);
}
const GAME = JSON.parse(readFileSync('docs/palette.json', 'utf8')); // [{ name, hex, r, g, b }]

// ---------------------------------------------------------------- atlas access
function npyHeader(fd) {
  const b = Buffer.alloc(12);
  readSync(fd, b, 0, 12, 0);
  const major = b[6];
  const len = major === 1 ? b.readUInt16LE(8) : b.readUInt32LE(8);
  const start = major === 1 ? 10 : 12;
  const h = Buffer.alloc(len);
  readSync(fd, h, 0, len, start);
  return { offset: start + len, header: h.toString('latin1') };
}
const palFd = openSync(join(DIR, 'palette.npy'), 'r');
const palH = npyHeader(palFd);
const palBuf = readFileSync(join(DIR, 'palette.npy')).subarray(palH.offset);
closeSync(palFd);
const atlasRGB = (i) => [palBuf[i * 3], palBuf[i * 3 + 1], palBuf[i * 3 + 2]];

const tokFd = openSync(join(DIR, 'tokens.npy'), 'r');
const tokH = npyHeader(tokFd);
if (!/'<u2'/.test(tokH.header)) throw new Error(`unexpected tokens dtype: ${tokH.header}`);
/** Row → 256 RGBA pixels (null = transparent). */
function sprite(row) {
  const b = Buffer.alloc(512);
  readSync(tokFd, b, 0, 512, tokH.offset + row * 512);
  const px = [];
  for (let k = 0; k < 256; k++) {
    const t = b.readUInt16LE(k * 2);
    px.push(t === 0 ? null : atlasRGB(t));
  }
  return px;
}

// ---------------------------------------------------------------- colour → game palette (CIE Lab)
function lab([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = f(r), G = f(g), B = f(b);
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, y = R * 0.2126 + G * 0.7152 + B * 0.0722, z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const h = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * h(y) - 16, 500 * (h(x) - h(y)), 200 * (h(y) - h(z))];
}
const GAME_LAB = GAME.map((p) => ({ ...p, lab: lab([p.r, p.g, p.b]) }));
function nearest(rgb, allowed) {
  const l = lab(rgb);
  let best = null, bd = Infinity;
  for (const p of GAME_LAB) {
    if (allowed && !allowed.includes(p.name)) continue;
    const d = (l[0] - p.lab[0]) ** 2 + (l[1] - p.lab[1]) ** 2 + (l[2] - p.lab[2]) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
const byName = Object.fromEntries(GAME.map((p) => [p.name, p]));
/** zones.ts prop letters (keep in step with DECOR_KEYS there). */
const DECOR_LETTER = {
  forestDeep: 'f', forest: 'F', green: 'g', greenLight: 'G', lime: 'l', sage: 's', moss: 'm', brown: 'b', brownDark: 'B',
  tan: 't', rock: 'r', rockDark: 'R', greyLight: 'w', yellow: 'y', orange: 'o', red: 'x', wine: 'A', pink: 'p', purple: 'P',
  cream: 'c', ink: 'k',
};

/** Sprite → grid of palette names (null = empty), trimmed to its content. */
function convert(px, opt = {}) {
  let grid = [];
  for (let y = 0; y < 16; y++) {
    const r = [];
    for (let x = 0; x < 16; x++) {
      const c = px[y * 16 + x];
      let n = c ? nearest(c, opt.colors).name : null;
      if (n && opt.remap?.[n]) n = opt.remap[n];
      r.push(n);
    }
    grid.push(r);
  }
  // the sprite standard's outline is ink: dark pixels on the silhouette edge snap to it (inkEdge: false keeps them)
  if (opt.inkEdge !== false) {
    const dark = (y, x) => { const c = px[y * 16 + x]; return c && lab(c)[0] < 32; };
    const empty = (y, x) => y < 0 || x < 0 || y > 15 || x > 15 || !px[y * 16 + x];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++)
      if (dark(y, x) && (empty(y - 1, x) || empty(y + 1, x) || empty(y, x - 1) || empty(y, x + 1))) grid[y][x] = 'ink';
  }
  if (opt.flip) grid = grid.map((r) => r.reverse());
  grid = trim(grid);
  if (opt.height && opt.height < grid.length) {
    const h = opt.height - (opt.outline ? 2 : 0);
    grid = opt.shrink === 'vote' ? downscale(grid, h, opt.fill ?? 0.45) : carve(grid, h, Math.round((grid[0].length * h) / grid.length));
  }
  if (opt.outline) grid = outline(grid);
  return grid;
}
function trim(g) {
  let x0 = 99, x1 = -1, y0 = 99, y1 = -1;
  g.forEach((r, y) => r.forEach((c, x) => { if (c) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }));
  if (x1 < 0) return [[null]];
  return g.slice(y0, y1 + 1).map((r) => r.slice(x0, x1 + 1));
}
/**
 * Shrink by deleting whole rows / columns, each time the one most like its neighbour (fewest differing
 * pixels), so outlines, eyes and tusks stay crisp — no new pixels are invented.
 */
function carve(g, h, w) {
  g = g.map((r) => r.slice());
  const diff = (a, b) => a.reduce((n, c, i) => n + (c !== b[i] ? 1 : 0), 0);
  const cols = (gg) => gg[0].map((_, x) => gg.map((r) => r[x]));
  while (g.length > h || g[0].length > w) {
    const doRows = g.length - h >= g[0].length - w;
    const lines = doRows ? g : cols(g);
    let best = 1, bd = Infinity;
    for (let i = 1; i < lines.length; i++) {
      // a small penalty at the edges, so the silhouette's extremes survive
      const d = diff(lines[i], lines[i - 1]) + (i === 1 || i === lines.length - 1 ? 0.5 : 0);
      if (d < bd) { bd = d; best = i; }
    }
    if (doRows) g.splice(best, 1);
    else g = g.map((r) => r.filter((_, x) => x !== best));
  }
  return trim(g);
}
function downscale(g, h, fill) {
  const s = g.length / h, w = Math.max(1, Math.round(g[0].length / s));
  const out = [];
  for (let y = 0; y < h; y++) {
    const r = [];
    for (let x = 0; x < w; x++) {
      const count = {};
      let fg = 0, tot = 0;
      for (let yy = Math.floor(y * s); yy < Math.min(g.length, Math.ceil((y + 1) * s)); yy++)
        for (let xx = Math.floor(x * s); xx < Math.min(g[0].length, Math.ceil((x + 1) * s)); xx++) {
          tot++;
          const c = g[yy][xx];
          if (c) { fg++; count[c] = (count[c] ?? 0) + 1; }
        }
      // the outline would win most votes at this size: colours vote without ink (outline: true re-adds a clean one)
      const ranked = Object.entries(count).sort((a, b) => b[1] - a[1]);
      const colour = ranked.find(([c]) => c !== 'ink') ?? ranked[0];
      r.push(fg / tot >= fill ? colour[0] : null);
    }
    out.push(r);
  }
  return trim(out);
}
function outline(g) {
  const H = g.length + 2, W = g[0].length + 2;
  const at = (x, y) => (x >= 1 && y >= 1 && x <= W - 2 && y <= H - 2 ? g[y - 1][x - 1] : null);
  const out = [];
  for (let y = 0; y < H; y++) {
    const r = [];
    for (let x = 0; x < W; x++) {
      const c = at(x, y);
      r.push(c ?? ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => at(x + dx, y + dy)) ? 'ink' : null));
    }
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------- tiny PNG writer + 3×5 digits
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
class Canvas {
  constructor(w, h, bg) { this.w = w; this.h = h; this.d = Buffer.alloc(w * h * 4); this.rect(0, 0, w, h, bg); }
  rect(x0, y0, w, h, [r, g, b]) {
    for (let y = Math.max(0, y0); y < Math.min(this.h, y0 + h); y++)
      for (let x = Math.max(0, x0); x < Math.min(this.w, x0 + w); x++) { const i = (y * this.w + x) * 4; this.d[i] = r; this.d[i + 1] = g; this.d[i + 2] = b; this.d[i + 3] = 255; }
  }
  text(s, x, y, k, col) {
    for (const ch of String(s)) {
      const m = DIGITS[+ch];
      if (m) for (let j = 0; j < 15; j++) if (m[j] === '1') this.rect(x + (j % 3) * k, y + Math.floor(j / 3) * k, k, k, col);
      x += 4 * k;
    }
  }
  /** grid of [r,g,b] | null at scale k */
  grid(g, x0, y0, k) { g.forEach((r, y) => r.forEach((c, x) => c && this.rect(x0 + x * k, y0 + y * k, k, k, c))); }
  save(path) { writeFileSync(path, png(this.w, this.h, this.d)); }
}
const hexRGB = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const namesToRGB = (g) => g.map((r) => r.map((n) => (n ? hexRGB(byName[n].hex) : null)));
const BG = hexRGB('#3b3f6b'), GRASS = hexRGB('#4f9a55'), LABEL = hexRGB('#ffcd75');

// ---------------------------------------------------------------- commands
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, def) => { const i = rest.indexOf(name); if (i < 0) return def; const v = rest[i + 1]; rest.splice(i, 2); return v; };
const bool = (name) => { const i = rest.indexOf(name); if (i < 0) return false; rest.splice(i, 1); return true; };

if (cmd === 'search') {
  const n = Number(flag('--n', 48));
  const out = flag('--out', 'atlas-search.png');
  const subjectOnly = bool('--subject');
  const colors = flag('--colors', null)?.split(',');
  const words = rest.map((w) => w.toLowerCase());
  if (!words.length) { console.error('search: give some words'); process.exit(1); }
  const captions = JSON.parse(readFileSync(join(DIR, 'captions.json'), 'utf8'));
  const subjects = JSON.parse(readFileSync(join(DIR, 'objects.json'), 'utf8'));
  const has = (s) => words.every((w) => new RegExp(`\\b${w}`).test(s));
  const q = words.join(' ');
  const hits = [];
  const subjCount = {};
  for (let i = 0; i < captions.length; i++) {
    const s = subjects[i].toLowerCase(), c = captions[i].toLowerCase();
    const score = s === q ? 3 : has(s) ? 2 : !subjectOnly && has(c) ? 1 : 0;
    if (score) { hits.push([score, i]); subjCount[subjects[i]] = (subjCount[subjects[i]] ?? 0) + 1; }
  }
  // best first; within a score, spread across subjects so one subject doesn't fill the sheet
  hits.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const seen = {}, picked = [];
  for (const pass of [0, 1, 2, 3, 99]) for (const h of hits) {
    if (picked.length >= n) break;
    const s = subjects[h[1]];
    if (picked.includes(h)) continue;
    if ((seen[s] ?? 0) <= pass) { picked.push(h); seen[s] = (seen[s] ?? 0) + 1; }
  }
  console.log(`${hits.length} matches; subjects: ${Object.entries(subjCount).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([s, c]) => `${s} (${c})`).join(', ')}`);
  const K = 4, COLS = 8, CW = 16 * K * 2 + K * 3, CH = 16 * K + 7 * 2 + 4;
  const cv = new Canvas(COLS * CW + 8, Math.ceil(picked.length / COLS) * CH + 8, hexRGB('#1a1c2c'));
  picked.forEach(([, row], j) => {
    const x = 4 + (j % COLS) * CW, y = 4 + Math.floor(j / COLS) * CH;
    cv.text(j, x, y, 2, LABEL);
    const px = sprite(row);
    cv.rect(x, y + 12, 16 * K, 16 * K, BG);
    cv.grid(Array.from({ length: 16 }, (_, yy) => px.slice(yy * 16, yy * 16 + 16)), x, y + 12, K);
    cv.rect(x + 16 * K + K, y + 12, 16 * K, 16 * K, BG);
    cv.grid(namesToRGB(convert(px, { colors })), x + 16 * K + K, y + 12, K);
    console.log(`#${j}\trow ${row}\t${subjects[row]} — ${captions[row]}`);
  });
  cv.save(out);
  console.log(`wrote ${out}`);
} else if (cmd === 'build') {
  const picks = JSON.parse(readFileSync('art/atlas/picks.json', 'utf8'));
  const lines = [
    `// Generated by scripts/atlas-sprites.mjs from art/atlas/picks.json (Pixel Art Atlas, CC0). Do not edit by hand.`,
    `import { C } from './palette';`,
    ``,
    `export const ATLAS_ART: Record<string, { frames: string[][]; keys: Record<string, string> }> = {`,
  ];
  const decor = [];
  const all = [];
  for (const [id, opt] of Object.entries(picks)) {
    if (opt.decor) {
      // trail-side props use zones.ts's fixed letters (so they switch to the night colours): only those colours allowed
      const g = convert(sprite(opt.row), { ...opt, colors: opt.colors ?? Object.keys(DECOR_LETTER) });
      decor.push({ id, rows: g.map((r) => r.map((c) => (c ? DECOR_LETTER[c] : '.')).join('')) });
      all.push({ id, g });
      console.log(`${id} (decor): ${g[0].length}×${g.length} px`);
      continue;
    }
    const g = convert(sprite(opt.row), opt);
    const used = [...new Set(g.flat().filter(Boolean))];
    const letter = Object.fromEntries(used.map((nm, i) => [nm, 'abcdefghijklmnopqrstuvwxyz'[i]]));
    const rows = g.map((r) => r.map((c) => (c ? letter[c] : '.')).join(''));
    lines.push(`  ${/^[a-z_$][\w$]*$/i.test(id) ? id : JSON.stringify(id)}: {`);
    lines.push(`    keys: { ${used.map((nm) => `${letter[nm]}: C.${nm}`).join(', ')} },`);
    lines.push(`    frames: [[\n${rows.map((r) => `      '${r}',`).join('\n')}\n    ]],`);
    lines.push(`  },`);
    all.push({ id, g });
    console.log(`${id}: ${g[0].length}×${g.length} px, ${used.length} colours`);
  }
  lines.push(`};`, ``);
  lines.push(`/** Trail-side props in zones.ts's letters (DECOR_KEYS day / night). */`);
  lines.push(`export const ATLAS_DECOR: Record<string, string[]> = {`);
  for (const d of decor) lines.push(`  ${d.id}: [\n${d.rows.map((r) => `    '${r}',`).join('\n')}\n  ],`);
  lines.push(`};`, ``);
  writeFileSync('src/atlasart.ts', lines.join('\n'));
  console.log('wrote src/atlasart.ts');
  // preview: 8× on grass and on night
  const K = 8, CELL = 18 * K;
  const cv = new Canvas(all.length * CELL + 8, CELL * 2 + 8, hexRGB('#1a1c2c'));
  all.forEach(({ g }, j) => {
    for (const [r, bg] of [[0, GRASS], [1, BG]]) {
      const x = 4 + j * CELL, y = 4 + r * CELL;
      cv.rect(x, y, CELL - 4, CELL - 4, bg);
      cv.grid(namesToRGB(g), x + Math.floor((CELL - 4 - g[0].length * K) / 2), y + CELL - 4 - K - g.length * K, K);
    }
  });
  cv.save('docs/sprites/atlas-preview.png');
  console.log('wrote docs/sprites/atlas-preview.png');
} else {
  console.error('usage: node scripts/atlas-sprites.mjs search <words…> [--n 48] [--subject] [--out file.png] | build');
  process.exit(1);
}
closeSync(tokFd);
