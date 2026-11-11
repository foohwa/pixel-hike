import './style.css';
import { builtInSet, frameOf, loadSheet, renderSheet, type CharacterId, type Gender, type SpriteSet } from './characters';
import { loadDem } from './dem';
import { exportMp4 } from './export';
import { parseFit } from './fit';
import { parseGpx, type ParsedTrack } from './gpx';
import { KIND_COLOR } from './overlay';
import { PixelRenderer, type Aspect, type ViewMode } from './renderer';
import { buildTerrain, terrainExtent, type Terrain } from './terrain';
import { defaultDuration, Timeline } from './timeline';
import {
  ACTIVITY_LABEL, buildTrack, detectCheckpoints, guessActivity, KIND_LABEL, sampleAt, toLatLon,
  type Activity, type Checkpoint, type CheckpointKind, type Track,
} from './track';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  drop: $('drop'),
  file: $<HTMLInputElement>('file'),
  title: $<HTMLInputElement>('title'),
  activity: $('activity'),
  character: $('character'),
  gender: $('gender'),
  companion: $<HTMLSelectElement>('companion'),
  charPreview: $<HTMLCanvasElement>('charPreview'),
  sheet: $<HTMLInputElement>('sheet'),
  template: $<HTMLButtonElement>('template'),
  resetSheet: $<HTMLButtonElement>('resetSheet'),
  mode: $('mode'),
  aspect: $('aspect'),
  duration: $<HTMLInputElement>('duration'),
  durLabel: $('durLabel'),
  speedLabel: $('speedLabel'),
  minimap: $<HTMLInputElement>('minimap'),
  tz: $<HTMLSelectElement>('tz'),
  cps: $('cps'),
  addCp: $<HTMLButtonElement>('addCp'),
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
  activity: 'hike' as Activity,
  character: 'hiker' as CharacterId,
  gender: 'male' as Gender,
  companion: null as CharacterId | null,
  customSheet: null as SpriteSet | null,
  customCount: 0,
  t: 0,
  playing: true,
  exporting: false,
  scrubbing: false,
};

// ------------------------------------------------------------------ loading

async function loadFile(f: File) {
  try {
    setStatus('Reading track…');
    const parsed: ParsedTrack = /\.fit$/i.test(f.name) ? parseFit(await f.arrayBuffer()) : parseGpx(await f.text());
    await loadParsed(parsed);
  } catch (e) {
    console.error(e);
    setStatus((e as Error).message || 'Could not read that file.', true);
  }
}

async function loadParsed(parsed: ParsedTrack) {
  const track = buildTrack(parsed);

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
  state.customCount = 0;
  state.checkpoints = [];
  setActivity(guessActivity(track), false);
  ui.title.value = parsed.name;
  ui.duration.value = String(defaultDuration(track));
  fillTimezones(track.stats.startTime);
  renderStats();
  rebuild();
  state.t = 0;
  state.playing = true;
  [ui.play, ui.scrub, ui.export, ui.addCp].forEach((el) => (el.disabled = false));
  ui.play.innerHTML = '&#9208;';
  setStatus(dem ? '' : 'Terrain tiles unavailable — using a stylised ridge.');
  if (!dem) setTimeout(() => setStatus(''), 3000);
}

function heroSet(): SpriteSet {
  return state.customSheet ?? builtInSet(state.character, state.gender);
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
    activity: state.activity,
    hero: heroSet(),
    pet: state.companion ? builtInSet(state.companion) : null,
  });
  state.t = Math.min(state.t, state.timeline.duration);
  ui.durLabel.textContent = `${ui.duration.value}s`;
  const x = state.timeline.speedup();
  ui.speedLabel.textContent = x ? `· walking ≈ ${x >= 100 ? Math.round(x / 10) * 10 : Math.round(x)}× real speed` : '';
}

function setActivity(a: Activity, rebuildNow = true) {
  state.activity = a;
  ui.activity.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === a));
  if (state.track) {
    // re-detect, but keep checkpoints the user added
    const custom = state.checkpoints.filter((c) => c.id.startsWith('custom'));
    state.checkpoints = [...detectCheckpoints(state.track, a), ...custom].sort((x, y) => x.d - y.d);
    renderCheckpointList();
  }
  if (a === 'trailrun' && state.character === 'hiker') setCharacter('runner', false);
  if (a !== 'trailrun' && state.character === 'runner') setCharacter('hiker', false);
  if (rebuildNow) rebuild();
}

function setCharacter(c: CharacterId, rebuildNow = true) {
  state.character = c;
  ui.character.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === c));
  if (rebuildNow) rebuild();
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

const EDITABLE_KINDS: CheckpointKind[] = ['summit', 'peak', 'view', 'rest', 'camp', 'cp'];

function defaultName(k: CheckpointKind) {
  return ({ start: 'START', summit: 'SUMMIT', peak: 'PEAK', view: 'VIEWPOINT', rest: 'REST', camp: 'CAMP', cp: 'CP', finish: 'FINISH' })[k];
}

function renderCheckpointList() {
  ui.cps.innerHTML = '';
  for (const cp of state.checkpoints) {
    const li = document.createElement('li');
    const fixed = cp.kind === 'start' || cp.kind === 'finish';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = cp.enabled;
    cb.disabled = fixed;
    cb.onchange = () => { cp.enabled = cb.checked; rebuild(); };

    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = KIND_COLOR[cp.kind];

    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 18;
    name.value = cp.name;
    name.oninput = () => { cp.name = name.value || defaultName(cp.kind); };

    const kind = document.createElement('select');
    kind.disabled = fixed;
    for (const k of fixed ? [cp.kind] : EDITABLE_KINDS) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = KIND_LABEL[k];
      o.selected = k === cp.kind;
      kind.append(o);
    }
    kind.onchange = () => {
      const old = cp.kind;
      cp.kind = kind.value as CheckpointKind;
      if (cp.name.startsWith(defaultName(old))) cp.name = defaultName(cp.kind);
      renderCheckpointList();
      rebuild();
    };

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Remove checkpoint';
    del.disabled = fixed;
    del.onclick = () => {
      state.checkpoints = state.checkpoints.filter((c) => c !== cp);
      renderCheckpointList();
      rebuild();
    };

    const meta = document.createElement('div');
    meta.className = 'meta';
    const m = cp.stayMin ?? 0;
    const stay = m ? ` · stayed ${m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m} min`}` : '';
    meta.textContent = `km ${((cp.d * (state.track?.distScale ?? 1)) / 1000).toFixed(1)} · ${Math.round(cp.ele).toLocaleString()} m${stay}`;

    li.append(cb, chip, name, kind, del, meta);
    ui.cps.append(li);
  }
}

function renderStats() {
  const tr = state.track!;
  const s = tr.stats;
  const h = Math.floor(s.duration / 3600000), m = Math.round((s.duration % 3600000) / 60000);
  const items: [string, string][] = [
    ['Distance', `${((s.distance * tr.distScale) / 1000).toFixed(2)} km`],
    ['Duration', `${h}h ${String(m).padStart(2, '0')}m`],
    ['Ascent', `${Math.round(s.ascent).toLocaleString()} m`],
    ['Highest', `${Math.round(s.maxEle).toLocaleString()} m`],
  ];
  if (s.avgHr) items.push(['Avg HR', `${Math.round(s.avgHr)} bpm`]);
  if (s.calories) items.push(['Calories', `${Math.round(s.calories).toLocaleString()} kcal`]);
  if (s.avgTemp != null) items.push(['Avg temp', `${Math.round(s.avgTemp)} °C`]);
  items.push(['Looks like', ACTIVITY_LABEL[guessActivity(tr)]]);
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

function download(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

bindSeg(ui.mode, (v) => renderer.setMode(v as ViewMode));
bindSeg(ui.aspect, (v) => { renderer.setAspect(v as Aspect); fitCanvas(); });
bindSeg(ui.activity, (v) => setActivity(v as Activity));
bindSeg(ui.character, (v) => { state.customSheet = null; ui.resetSheet.hidden = true; setCharacter(v as CharacterId); });
bindSeg(ui.gender, (v) => { state.gender = v as Gender; rebuild(); });
ui.companion.onchange = () => { state.companion = (ui.companion.value || null) as CharacterId | null; rebuild(); };
ui.duration.oninput = () => rebuild();
ui.title.oninput = () => rebuild();
ui.tz.onchange = () => rebuild();
ui.minimap.onchange = () => (renderer.showMinimap = ui.minimap.checked);

ui.sheet.onchange = async () => {
  const f = ui.sheet.files?.[0];
  if (!f) return;
  try {
    state.customSheet = await loadSheet(f, state.character, state.gender);
    ui.resetSheet.hidden = false;
    rebuild();
  } catch (e) {
    setStatus((e as Error).message, true);
    setTimeout(() => setStatus(''), 4000);
  }
  ui.sheet.value = '';
};
ui.resetSheet.onclick = () => { state.customSheet = null; ui.resetSheet.hidden = true; rebuild(); };
ui.template.onclick = () => {
  download(renderSheet(heroSet(), 8).toDataURL('image/png'), `pixel-hike-${state.character}-${state.gender}-sheet-8x.png`);
};

ui.addCp.onclick = () => {
  if (!state.track || !state.timeline) return;
  const tr = state.track;
  const d = state.timeline.sample(state.t).d;
  if (d <= 0 || d >= tr.stats.distance) {
    setStatus('Scrub to a point along the trail first.');
    setTimeout(() => setStatus(''), 2000);
    return;
  }
  const kind: CheckpointKind = state.activity === 'trailrun' ? 'cp' : 'view';
  const time = sampleAt(tr, tr.time, d);
  state.checkpoints.push({
    id: `custom${state.customCount++}`, kind, name: defaultName(kind), enabled: true,
    d, ele: sampleAt(tr, tr.ele, d), time, leaveTime: time,
  });
  state.checkpoints.sort((a, b) => a.d - b.d);
  renderCheckpointList();
  rebuild();
};

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
  if (f) await loadFile(f);
};
for (const el of [ui.drop, ui.screen]) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); ui.drop.classList.add('hover'); });
  el.addEventListener('dragleave', () => ui.drop.classList.remove('hover'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    ui.drop.classList.remove('hover');
    const f = e.dataTransfer?.files?.[0];
    if (f) await loadFile(f);
  });
}

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

const previewCtx = ui.charPreview.getContext('2d')!;
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
  // walk-cycle preview of the chosen character (+ buddy)
  const secs = now / 1000;
  previewCtx.clearRect(0, 0, 64, 16);
  const walkAnim = state.activity === 'trailrun' ? 'run' : 'walk';
  if (state.companion) previewCtx.drawImage(frameOf(builtInSet(state.companion), walkAnim, secs + 0.13, false), 14, 0);
  previewCtx.drawImage(frameOf(heroSet(), walkAnim, secs, false), 30, 0);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.addEventListener('resize', fitCanvas);
fitCanvas();

// Dev/test hooks: ?sample loads public/samples/hike.gpx (?sample=fit → hike.fit). Both are git-ignored.
const params = new URLSearchParams(location.search);
const sampleKind = params.get('sample');
const ready =
  sampleKind != null
    ? fetch(sampleKind === 'fit' ? '/samples/hike.fit' : '/samples/hike.gpx')
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('No sample file'))))
        .then((b) => loadFile(new File([b], sampleKind === 'fit' ? 'hike.fit' : 'hike.gpx')))
    : Promise.resolve();

Object.assign(window, {
  __pixelHike: {
    ready,
    _renderer: renderer,
    seek(t: number) { state.playing = false; state.t = t; renderer.renderAt(t); },
    setMode(m: ViewMode) { renderer.setMode(m); },
    setAspect(a: Aspect) { renderer.setAspect(a); fitCanvas(); },
    setActivity(a: Activity) { setActivity(a); },
    setCharacter(c: CharacterId) { setCharacter(c); },
    setCompanion(c: CharacterId | null) { state.companion = c; rebuild(); },
    setGender(g: Gender) { state.gender = g; ui.gender.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === g)); rebuild(); },
    setDuration(s: number) { ui.duration.value = String(s); rebuild(); },
    sheetDataUrl(c: CharacterId, scale = 1, guides = false, g: Gender = 'male') { return renderSheet(builtInSet(c, g), scale, guides).toDataURL('image/png'); },
    get duration() { return state.timeline?.duration ?? 0; },
    get checkpoints() { return state.checkpoints; },
    get timeline() { return state.timeline; },
    get stats() { return state.track?.stats; },
    get speedup() { return state.timeline?.speedup(); },
    exportMp4: (scale = 4, duration?: number) =>
      exportMp4(renderer, { duration: duration ?? state.timeline!.duration, fps: 30, scale }),
  },
});
