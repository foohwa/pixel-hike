import './style.css';
import { loadDem } from './dem';
import { exportMp4 } from './export';
import { parseGpx } from './gpx';
import { C } from './palette';
import { PixelRenderer, type Aspect, type ViewMode } from './renderer';
import { buildTerrain, terrainExtent, type Terrain } from './terrain';
import { Timeline } from './timeline';
import { buildTrack, clamp, toLatLon, type Checkpoint, type Track } from './track';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  drop: $('drop'),
  file: $<HTMLInputElement>('file'),
  title: $<HTMLInputElement>('title'),
  mode: $('mode'),
  aspect: $('aspect'),
  duration: $<HTMLInputElement>('duration'),
  durLabel: $('durLabel'),
  minimap: $<HTMLInputElement>('minimap'),
  tz: $<HTMLSelectElement>('tz'),
  cps: $('cps'),
  quality: $<HTMLSelectElement>('quality'),
  export: $<HTMLButtonElement>('export'),
  progress: $<HTMLProgressElement>('progress'),
  download: $<HTMLAnchorElement>('download'),
  screen: $('screen'),
  canvas: $<HTMLCanvasElement>('view'),
  status: $('status'),
  play: $<HTMLButtonElement>('play'),
  scrub: $<HTMLInputElement>('scrub'),
  clock: $('clock'),
  stats: $('stats'),
};

const renderer = new PixelRenderer(ui.canvas);

const state = {
  track: null as Track | null,
  terrain: null as Terrain | null,
  checkpoints: [] as Checkpoint[],
  timeline: null as Timeline | null,
  t: 0,
  playing: true,
  exporting: false,
  scrubbing: false,
};

// ------------------------------------------------------------------ loading

async function loadGpxText(text: string) {
  try {
    setStatus('Reading track…');
    const parsed = parseGpx(text);
    const track = buildTrack(parsed.points);

    setStatus('Loading terrain…');
    const ext = terrainExtent(track);
    const pad = 300;
    const a = toLatLon(track, ext.x0 - pad, ext.z0 - pad);
    const b = toLatLon(track, ext.x0 + ext.W + pad, ext.z0 + ext.D + pad);
    const dem = await loadDem(
      { minLat: Math.min(a.lat, b.lat), maxLat: Math.max(a.lat, b.lat), minLon: Math.min(a.lon, b.lon), maxLon: Math.max(a.lon, b.lon) },
      (done, total) => setStatus(`Loading terrain… ${done}/${total}`),
    ).catch((e) => {
      console.warn('Elevation tiles unavailable, using a stylised ridge instead.', e);
      return null;
    });

    setStatus('Building diorama…');
    await new Promise((r) => setTimeout(r, 0));
    const terrain = buildTerrain(track, dem);

    state.track = track;
    state.terrain = terrain;
    state.checkpoints = track.checkpoints.map((c) => ({ ...c }));
    ui.title.value = parsed.name;
    ui.duration.value = String(clamp(Math.round(20 + (track.stats.distance / 1000) * 0.4), 25, 60));
    ui.durLabel.textContent = `${ui.duration.value}s`;
    fillTimezones(track.stats.startTime);
    renderCheckpointList();
    renderStats();
    rebuild();
    state.t = 0;
    state.playing = true;
    [ui.play, ui.scrub, ui.export].forEach((el) => (el.disabled = false));
    ui.play.innerHTML = '&#9208;';
    setStatus(dem ? '' : 'Terrain tiles unavailable — using a stylised ridge.');
    if (!dem) setTimeout(() => setStatus(''), 3000);
  } catch (e) {
    console.error(e);
    setStatus((e as Error).message || 'Could not read that file.', true);
  }
}

function rebuild() {
  if (!state.track || !state.terrain) return;
  state.timeline = new Timeline(state.track, state.checkpoints, Number(ui.duration.value));
  renderer.setData({
    track: state.track,
    terrain: state.terrain,
    checkpoints: state.checkpoints,
    timeline: state.timeline,
    title: ui.title.value || 'My Hike',
    tzOffsetMin: Number(ui.tz.value || 0),
  });
  state.t = Math.min(state.t, state.timeline.duration);
}

// ------------------------------------------------------------------ UI

function setStatus(msg: string, error = false) {
  ui.status.textContent = msg;
  ui.status.classList.toggle('error', error);
}

function fillTimezones(startMs: number) {
  const local = -new Date(startMs).getTimezoneOffset();
  ui.tz.innerHTML = '';
  for (let m = -720; m <= 840; m += 30) {
    const o = document.createElement('option');
    const sign = m < 0 ? '-' : '+';
    const a = Math.abs(m);
    o.value = String(m);
    o.textContent = `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
    if (m === local) o.selected = true;
    ui.tz.append(o);
  }
}

const KIND_COLOR: Record<Checkpoint['kind'], string> = {
  start: C.greenLight, summit: C.red, peak: C.yellow, rest: C.orange, finish: C.white,
};

function renderCheckpointList() {
  ui.cps.innerHTML = '';
  for (const cp of state.checkpoints) {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = cp.enabled;
    cb.disabled = cp.kind === 'start' || cp.kind === 'finish';
    cb.onchange = () => { cp.enabled = cb.checked; rebuild(); };
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = KIND_COLOR[cp.kind];
    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 18;
    name.value = cp.name;
    name.oninput = () => { cp.name = name.value || cp.kind.toUpperCase(); };
    const meta = document.createElement('div');
    meta.className = 'meta';
    const extra = cp.kind === 'rest' ? ` · ${cp.restMin} min` : '';
    meta.textContent = `${cp.kind} · km ${(cp.d / 1000).toFixed(1)} · ${Math.round(cp.ele).toLocaleString()} m${extra}`;
    li.append(cb, chip, name, document.createElement('span'), document.createElement('span'), meta);
    ui.cps.append(li);
  }
}

function renderStats() {
  const s = state.track!.stats;
  const h = Math.floor(s.duration / 3600000), m = Math.round((s.duration % 3600000) / 60000);
  const items: [string, string][] = [
    ['Distance', `${(s.distance / 1000).toFixed(2)} km`],
    ['Duration', `${h}h ${String(m).padStart(2, '0')}m`],
    ['Ascent', `${Math.round(s.ascent).toLocaleString()} m`],
    ['Highest', `${Math.round(s.maxEle).toLocaleString()} m`],
  ];
  if (s.avgHr) items.push(['Avg HR', `${Math.round(s.avgHr)} bpm`]);
  ui.stats.innerHTML = items.map(([k, v]) => `<div>${k} <b>${v}</b></div>`).join('');
}

function bindSeg(el: HTMLElement, onPick: (v: string) => void) {
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    onPick(b.dataset.v!);
  });
}

function fitCanvas() {
  const box = ui.screen.getBoundingClientRect();
  const s = Math.max(1, Math.floor(Math.min((box.width - 8) / renderer.W, (box.height - 8) / renderer.H)));
  ui.canvas.style.width = `${renderer.W * s}px`;
  ui.canvas.style.height = `${renderer.H * s}px`;
}

bindSeg(ui.mode, (v) => renderer.setMode(v as ViewMode));
bindSeg(ui.aspect, (v) => { renderer.setAspect(v as Aspect); fitCanvas(); });
ui.duration.oninput = () => { ui.durLabel.textContent = `${ui.duration.value}s`; rebuild(); };
ui.title.oninput = () => rebuild();
ui.tz.onchange = () => rebuild();
ui.minimap.onchange = () => (renderer.showMinimap = ui.minimap.checked);

ui.play.onclick = () => {
  state.playing = !state.playing;
  if (state.playing && state.timeline && state.t >= state.timeline.duration) state.t = 0;
  ui.play.innerHTML = state.playing ? '&#9208;' : '&#9654;';
};
ui.scrub.oninput = () => {
  if (!state.timeline) return;
  state.t = (Number(ui.scrub.value) / 1000) * state.timeline.duration;
};
ui.scrub.onpointerdown = () => (state.scrubbing = true);
ui.scrub.onpointerup = () => (state.scrubbing = false);

ui.file.onchange = async () => {
  const f = ui.file.files?.[0];
  if (f) await loadGpxText(await f.text());
};
ui.drop.addEventListener('dragover', (e) => { e.preventDefault(); ui.drop.classList.add('hover'); });
ui.drop.addEventListener('dragleave', () => ui.drop.classList.remove('hover'));
ui.drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  ui.drop.classList.remove('hover');
  const f = e.dataTransfer?.files?.[0];
  if (f) await loadGpxText(await f.text());
});
// allow dropping anywhere on the preview too
ui.screen.addEventListener('dragover', (e) => e.preventDefault());
ui.screen.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) await loadGpxText(await f.text());
});

let exportAbort: AbortController | null = null;
ui.export.onclick = async () => {
  if (!state.timeline) return;
  if (state.exporting) { exportAbort?.abort(); return; }
  state.exporting = true;
  exportAbort = new AbortController();
  ui.export.textContent = 'Cancel';
  ui.progress.hidden = false;
  ui.download.hidden = true;
  try {
    const blob = await exportMp4(renderer, {
      duration: state.timeline.duration,
      fps: 30,
      scale: Number(ui.quality.value),
      onProgress: (u) => (ui.progress.value = u),
      signal: exportAbort.signal,
    });
    const url = URL.createObjectURL(blob);
    const name = `${(ui.title.value || 'hike').replace(/[^\w-]+/g, '-').toLowerCase()}-pixel-${renderer.mode}.mp4`;
    ui.download.href = url;
    ui.download.download = name;
    ui.download.textContent = `Download ${name} (${(blob.size / 1e6).toFixed(1)} MB)`;
    ui.download.hidden = false;
    ui.download.click();
  } catch (e) {
    if ((e as Error).name !== 'AbortError') setStatus(`Export failed: ${(e as Error).message}`, true);
  } finally {
    state.exporting = false;
    ui.export.textContent = 'Export MP4';
    ui.progress.hidden = true;
  }
};

// ------------------------------------------------------------------ loop

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state.timeline && !state.exporting) {
    if (state.playing && !state.scrubbing) {
      state.t += dt;
      if (state.t > state.timeline.duration + 1.5) state.t = 0; // loop with a short hold
    }
    renderer.renderAt(state.t);
    ui.scrub.value = String(Math.round((Math.min(state.t, state.timeline.duration) / state.timeline.duration) * 1000));
    ui.clock.textContent = `${Math.min(state.t, state.timeline.duration).toFixed(1)}s / ${state.timeline.duration}s`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.addEventListener('resize', fitCanvas);
fitCanvas();

// Dev/test hooks: ?sample loads public/samples/hike.gpx (git-ignored).
const params = new URLSearchParams(location.search);
const ready = params.has('sample')
  ? fetch('/samples/hike.gpx').then((r) => (r.ok ? r.text() : Promise.reject(new Error('No sample file')))).then(loadGpxText)
  : Promise.resolve();

Object.assign(window, {
  __pixelHike: {
    ready,
    _renderer: renderer,
    seek(t: number) { state.playing = false; state.t = t; renderer.renderAt(t); },
    setMode(m: ViewMode) { renderer.setMode(m); },
    setAspect(a: Aspect) { renderer.setAspect(a); fitCanvas(); },
    get duration() { return state.timeline?.duration ?? 0; },
    get checkpoints() { return state.checkpoints; },
    get timeline() { return state.timeline; },
    get stats() { return state.track?.stats; },
    exportMp4: (scale = 4, duration?: number) =>
      exportMp4(renderer, { duration: duration ?? state.timeline!.duration, fps: 30, scale }),
  },
});
