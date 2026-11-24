/**
 * Tiny pixel icons for the page chrome (buttons, transport), drawn in the button's own text colour so
 * they follow hover / disabled states. '#' is a lit pixel. Kept as bitmaps so they match the game art.
 */
const ICONS: Record<string, string[]> = {
  play: ['.#.....', '.##....', '.###...', '.####..', '.###...', '.##....', '.#.....'],
  pause: ['.##.##.', '.##.##.', '.##.##.', '.##.##.', '.##.##.', '.##.##.', '.##.##.'],
  film: ['#######', '#.#.#.#', '#######', '#.....#', '#######', '#.#.#.#', '#######'],
  gif: ['.##.#.###', '#...#.#..', '#.#.#.##.', '#.#.#.#..', '.##.#.#..'],
  poster: ['#######', '#.....#', '#...#.#', '#..###.', '#.#####', '#######'],
  collapse: ['...#...', '..###..', '.##.##.', '##...##'],
  expand: ['##...##', '.##.##.', '..###..', '...#...'],
  share: ['...#...', '..###..', '.#.#.#.', '...#...', '#..#..#', '#.....#', '#######'],
  save: ['...#...', '...#...', '.#.#.#.', '..###..', '...#...', '#.....#', '#######'],
};

/** An inline SVG for a named icon; `scale` is CSS px per icon pixel. */
export function pixelIcon(name: string, scale = 2): string {
  const rows = ICONS[name];
  if (!rows) return '';
  const w = Math.max(...rows.map((r) => r.length)), h = rows.length;
  let d = '';
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') d += `M${x} ${y}h1v1h-1z`; }));
  return `<svg class="pxi" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><path fill="currentColor" d="${d}"/></svg>`;
}

/** Fills every `<i data-icon="name">` in the page. */
export function mountIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    el.innerHTML = pixelIcon(el.dataset.icon!, Number(el.dataset.scale ?? 2));
  });
}
