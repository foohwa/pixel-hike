import './style.css';
import { DEFAULT_TRACK, decodeFile, loadTrack, PreviewPlayer, renderSoundtrack, TRACKS, audioContext } from './audio';
import { builtInSet, frameOf, KORGA_LOOK, loadSheet, renderSheet, type CharacterId, type Gender, type Look, type SpriteSet } from './characters';
import { C, type ColorName } from './palette';
import { loadDem } from './dem';
import type { GateColor, GateOptions } from './gate';
import { exportMp4 } from './export';
import { parseFit } from './fit';
import { parseGpx, type ParsedTrack } from './gpx';
import { LogoSet, prepareLogo, type LogoColors, type LogoSource } from './logo';
import { clockText, KIND_COLOR } from './overlay';
import { PixelRenderer, type Aspect, type ViewMode } from './renderer';
import { forget, loadSaved, makeBackup, mergeCheckpoints, parseBackup, pin, save, trackKey } from './store';
import { buildTerrain, resolveScenery, terrainExtent, type SceneryChoice, type Terrain } from './terrain';
import type { BBox, Dem } from './dem';
import { loadWater, mapAreaKey, routeSurface, type SurfaceInfo, type WaterData } from './water';
import { findViews, namePeaks, openness, viewCheckpoints } from './landmarks';
import { defaultDuration, Timeline } from './timeline';
import {
  ACTIVITY_LABEL, buildTrack, detectCheckpoints, guessActivity, KIND_LABEL, sampleAt, toLatLon,
  type Activity, type Checkpoint, type CheckpointKind, type Track,
} from './track';
import { buildZones, defaultZones, ZONE_LABEL, ZONE_STYLES, zoneSummary, type TrailZones, type ZoneSettings, type ZoneStyle } from './zones';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  drop: $('drop'),
  file: $<HTMLInputElement>('file'),
  title: $<HTMLInputElement>('title'),
  logoFile: $<HTMLInputElement>('logoFile'),
  logoPreview: $<HTMLCanvasElement>('logoPreview'),
  logoRemove: $<HTMLButtonElement>('logoRemove'),
  logoOpts: $('logoOpts'),
  logoIntro: $<HTMLInputElement>('logoIntro'),
  logoBadge: $<HTMLInputElement>('logoBadge'),
  logoOutro: $<HTMLInputElement>('logoOutro'),
  logoColors: $<HTMLSelectElement>('logoColors'),
  gateMode: $<HTMLSelectElement>('gateMode'),
  gateColor: $<HTMLSelectElement>('gateColor'),
  gateText: $<HTMLInputElement>('gateText'),
  gateTagline: $<HTMLInputElement>('gateTagline'),
  scenery: $<HTMLSelectElement>('scenery'),
  envClouds: $<HTMLInputElement>('envClouds'),
  envLife: $<HTMLInputElement>('envLife'),
  envSigns: $<HTMLInputElement>('envSigns'),
  envSplits: $<HTMLInputElement>('envSplits'),
  envLight: $<HTMLInputElement>('envLight'),
  envWater: $<HTMLInputElement>('envWater'),
  envLandmarks: $<HTMLInputElement>('envLandmarks'),
  zonesOn: $<HTMLInputElement>('zonesOn'),
  zoneRows: $('zoneRows'),
  zoneStyle: [0, 1, 2].map((i) => $<HTMLSelectElement>(`zoneStyle${i}`)),
  zoneAt1: $<HTMLInputElement>('zoneAt1'),
  zoneAt2: $<HTMLInputElement>('zoneAt2'),
  zoneTech: $<HTMLInputElement>('zoneTech'),
  zoneLabels: $<HTMLInputElement>('zoneLabels'),
  zoneSummary: $('zoneSummary'),
  zoneState: $('zoneState'),
  zoneReset: $<HTMLButtonElement>('zoneReset'),
  activity: $('activity'),
  character: $('character'),
  gender: $('gender'),
  companion: $<HTMLSelectElement>('companion'),
  charPreview: $<HTMLCanvasElement>('charPreview'),
  lookEditor: $('lookEditor'),
  sheet: $<HTMLInputElement>('sheet'),
  template: $<HTMLButtonElement>('template'),
  resetSheet: $<HTMLButtonElement>('resetSheet'),
  mode: $('mode'),
  aspect: $('aspect'),
  duration: $<HTMLInputElement>('duration'),
  durLabel: $('durLabel'),
  speedLabel: $('speedLabel'),
  music: $<HTMLSelectElement>('music'),
  volume: $<HTMLInputElement>('volume'),
  musicFile: $<HTMLInputElement>('musicFile'),
  musicCredit: $('musicCredit'),
  minimap: $<HTMLInputElement>('minimap'),
  tz: $<HTMLSelectElement>('tz'),
  cps: $('cps'),
  saved: $('saved'),
  addCp: $<HTMLButtonElement>('addCp'),
  resetCps: $<HTMLButtonElement>('resetCps'),
  backupCps: $<HTMLButtonElement>('backupCps'),
  restoreCps: $<HTMLInputElement>('restoreCps'),
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
const player = new PreviewPlayer();

const state = {
  track: null as Track | null,
  terrain: null as Terrain | null,
  dem: null as Dem | null,
  bbox: null as BBox | null,
  water: null as WaterData | null,
  surface: null as SurfaceInfo | null,
  waterLoad: null as Promise<void> | null,
  checkpoints: [] as Checkpoint[],
  tombstones: [] as number[],
  timeline: null as Timeline | null,
  activity: 'hike' as Activity,
  character: 'hiker' as CharacterId,
  gender: 'male' as Gender,
  look: { ...KORGA_LOOK } as Look,
  companion: null as CharacterId | null,
  customSheet: null as SpriteSet | null,
  customMusic: null as { name: string; buffer: AudioBuffer } | null,
  logoSource: null as LogoSource | null,
  logoSet: null as LogoSet | null,
  zones: null as TrailZones | null,
  soundtrack: null as AudioBuffer | null,
  soundtrackKey: '',
  t: 0,
  playing: true,
  exporting: false,
  scrubbing: false,
  restoring: false,
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
  state.bbox = { minLat: Math.min(a.lat, b.lat), maxLat: Math.max(a.lat, b.lat), minLon: Math.min(a.lon, b.lon), maxLon: Math.max(a.lon, b.lon) };
  state.water = null;
  state.surface = null;
  state.waterLoad = null;
  const dem = await loadDem(
    { minLat: Math.min(a.lat, b.lat), maxLat: Math.max(a.lat, b.lat), minLon: Math.min(a.lon, b.lon), maxLon: Math.max(a.lon, b.lon) },
    (done, total) => setStatus(`Loading terrain… ${done}/${total}`),
  ).catch((e) => {
    console.warn('Elevation tiles unavailable, using a stylised ridge instead.', e);
    return null;
  });

  setStatus('Building diorama…');
  await new Promise((r) => setTimeout(r, 0));
  const terrain = buildTerrain(track, dem, resolveScenery(ui.scenery.value as SceneryChoice, track));

  state.track = track;
  state.terrain = terrain;
  state.dem = dem;
  state.checkpoints = [];
  state.tombstones = [];
  fillTimezones(track.stats.startTime);

  // defaults for this track…
  ui.title.value = parsed.name;
  ui.duration.value = String(defaultDuration(track));
  let activity = guessActivity(track);
  let pins: Checkpoint[] = [];

  setZoneUi(defaultZones(track));

  // …then whatever was saved for it last time
  // browser storage first; if it was cleared, fall back to the copy on disk (dev server)
  const saved = loadSaved(track) ?? (await loadFromDisk(track));
  state.restoring = !!saved; // don't auto-switch hiker/runner or save half-restored state
  if (saved) {
    applySettings(saved.settings);
    if (typeof saved.settings.activity === 'string') activity = saved.settings.activity as Activity;
    pins = saved.pins.map((p) => ({ ...p, pinned: true }));
    state.tombstones = saved.tombstones ?? [];
  }
  state.checkpoints = pins; // so setActivity merges them in
  setActivity(activity, false);
  state.restoring = false;
  renderStats();
  rebuild();
  state.t = 0;
  state.playing = true;
  [ui.play, ui.scrub, ui.export, ui.addCp, ui.resetCps, ui.backupCps].forEach((el) => (el.disabled = false));
  ui.play.innerHTML = '&#9208;';
  justRestored = !!saved;
  restoredAt = saved ? performance.now() : -Infinity;
  setStatus(dem ? '' : 'Terrain tiles unavailable — using a stylised ridge.');
  if (!dem) setTimeout(() => setStatus(''), 3000);
  void updateSoundtrack().then(syncAudio);
  void ensureWater();
}

function heroSet(): SpriteSet {
  return state.customSheet ?? builtInSet(state.character, state.gender, state.look);
}

function gateOptions(): GateOptions | null {
  const on = ui.gateMode.value === 'on' || (ui.gateMode.value === 'auto' && state.activity === 'trailrun');
  if (!on) return null;
  return {
    text: ui.gateText.value.trim() || ui.title.value || 'START',
    tagline: ui.gateTagline.value.trim(),
    color: ui.gateColor.value as GateColor,
  };
}

// ------------------------------------------------------------------ trail zones

for (const sel of ui.zoneStyle) {
  for (const st of ZONE_STYLES) sel.add(new Option(ZONE_LABEL[st], st));
}

function zoneSettings(): ZoneSettings {
  const num = (el: HTMLInputElement, fallback: number) => (Number.isFinite(el.valueAsNumber) ? el.valueAsNumber : fallback);
  const at1 = num(ui.zoneAt1, 1000);
  const at2 = Math.max(at1, num(ui.zoneAt2, 1500));
  return {
    on: ui.zonesOn.checked,
    technical: ui.zoneTech.checked,
    labels: ui.zoneLabels.checked,
    bands: [
      { at: -Infinity, style: ui.zoneStyle[0].value as ZoneStyle },
      { at: at1, style: ui.zoneStyle[1].value as ZoneStyle },
      { at: at2, style: ui.zoneStyle[2].value as ZoneStyle },
    ],
  };
}

function setZoneUi(z: ZoneSettings) {
  ui.zonesOn.checked = z.on;
  ui.zoneTech.checked = z.technical;
  ui.zoneLabels.checked = z.labels;
  z.bands.forEach((b, i) => (ui.zoneStyle[i].value = b.style));
  ui.zoneAt1.value = String(z.bands[1].at);
  ui.zoneAt2.value = String(z.bands[2].at);
  ui.zoneRows.classList.toggle('off', !z.on);
}

const SHORT: Record<ZoneStyle, string> = { jungle: 'jungle', forest: 'montane', mossy: 'mossy', rocky: 'rocky', meadow: 'meadow', plain: 'plain' };

function renderZoneSummary() {
  const z = state.zones, t = state.track;
  if (!z || !t) { ui.zoneSummary.textContent = ''; return; }
  const { km, techKm } = zoneSummary(z);
  const parts = ZONE_STYLES.filter((s) => (km[s] ?? 0) >= 0.05).map((s) => `${SHORT[s]} ${km[s]!.toFixed(1)} km`);
  if (z.settings.technical) parts.push(`steep ${techKm.toFixed(1)} km`);
  ui.zoneSummary.textContent = `${Math.round(t.stats.minEle)}–${Math.round(t.stats.maxEle)} m · ${parts.join(' · ')}`;
}

function rebuild() {
  if (!state.track || !state.terrain) return;
  const gate = gateOptions();
  // scenery decides the trees + land colours, so a change means a new diorama
  const scenery = resolveScenery(ui.scenery.value as SceneryChoice, state.track);
  if (state.terrain.scenery !== scenery) state.terrain = buildTerrain(state.track, state.dem, scenery);
  state.zones = buildZones(state.track, zoneSettings());
  ui.zoneRows.classList.toggle('off', !ui.zonesOn.checked);
  ui.zoneState.textContent = ui.zonesOn.checked ? 'on' : 'off';
  renderZoneSummary();
  state.timeline = new Timeline(state.track, state.checkpoints, Number(ui.duration.value), { gates: !!gate });
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
    logo: state.logoSet
      ? { set: state.logoSet, intro: ui.logoIntro.checked, badge: ui.logoBadge.checked, outro: ui.logoOutro.checked }
      : null,
    gate,
    zones: state.zones,
    water: state.water,
    env: {
      scenery,
      clouds: ui.envClouds.checked,
      life: ui.envLife.checked,
      signs: ui.envSigns.checked,
      splits: ui.envSplits.checked,
      light: ui.envLight.checked,
      water: ui.envWater.checked,
      landmarks: ui.envLandmarks.checked,
    },
  });
  state.t = Math.min(state.t, state.timeline.duration);
  ui.durLabel.textContent = `${ui.duration.value}s`;
  const x = state.timeline.speedup();
  ui.speedLabel.textContent = x ? `· walking ≈ ${x >= 100 ? Math.round(x / 10) * 10 : Math.round(x)}× real speed` : '';
  lastHereIdx = -2;
  persist();
}

/** Auto-detected checkpoints for the current activity, with the user's pinned edits and deletions on top. */
function refreshCheckpoints() {
  if (!state.track) return;
  const pins = state.checkpoints.filter((c) => c.pinned);
  const detected = detectCheckpoints(state.track, state.activity);
  if (ui.envLandmarks.checked) {
    // viewpoints: OSM ones beside the trail + the most open terrain, clear of the other checkpoints
    const views = findViews(state.track, state.dem ? state.terrain : null, state.water, detected.map((c) => c.d));
    detected.push(...viewCheckpoints(state.track, views));
  }
  state.checkpoints = mergeCheckpoints(detected, pins, state.tombstones);
  namePeaks(state.track, state.checkpoints, state.water);
  renderCheckpointList();
}

function setActivity(a: Activity, rebuildNow = true) {
  state.activity = a;
  setSeg(ui.activity, a);
  refreshCheckpoints();
  if (!state.restoring) {
    if (a === 'trailrun' && state.character === 'hiker') setCharacter('runner', false);
    if (a !== 'trailrun' && state.character === 'runner') setCharacter('hiker', false);
  }
  updateMusicCredit();
  if (rebuildNow) {
    rebuild();
    void updateSoundtrack().then(syncAudio);
  }
}

function setCharacter(c: CharacterId, rebuildNow = true) {
  state.character = c;
  setSeg(ui.character, c);
  ui.lookEditor.hidden = c !== 'me';
  if (rebuildNow) rebuild();
}

// ------------------------------------------------------------------ "Me": outfit editor

const COLOURS: [ColorName, string][] = [
  ['ink', 'Black'], ['ink2', 'Charcoal'], ['night', 'Navy'], ['dusk', 'Blue-grey'], ['sky', 'Blue'], ['skyLight', 'Light blue'],
  ['tealDeep', 'Dark teal'], ['moss', 'Teal'], ['sage', 'Sage'], ['forest', 'Dark green'], ['green', 'Green'], ['greenLight', 'Lime green'],
  ['lime', 'Neon'], ['yellow', 'Yellow'], ['orange', 'Orange'], ['coral', 'Coral'], ['red', 'Red'], ['wine', 'Maroon'], ['pink', 'Pink'],
  ['purple', 'Purple'], ['plum', 'Plum'], ['white', 'White'], ['greyLight', 'Light grey'], ['rock', 'Grey'], ['rockDark', 'Dark grey'],
  ['cream', 'Cream'], ['tan', 'Tan'], ['brown', 'Brown'], ['brownDark', 'Dark brown'],
];
const SKINS: [ColorName, string][] = [['skin', 'Light'], ['tan', 'Tan'], ['brown', 'Brown'], ['brownDark', 'Dark']];
const HAIRS: [ColorName, string][] = [['ink2', 'Black'], ['brownDark', 'Dark brown'], ['brown', 'Brown'], ['tan', 'Light brown'], ['yellow', 'Blonde'], ['coral', 'Ginger'], ['rock', 'Grey'], ['white', 'White'], ['pink', 'Pink'], ['sky', 'Blue']];

type LookField = { key: keyof Look; label: string; options?: [string, string][]; colour?: [ColorName, string][] };
const LOOK_ROWS: LookField[][] = [
  [{ key: 'headwear', label: 'Head', options: [['lamp', 'Headlamp'], ['band', 'Headband'], ['cap', 'Cap'], ['bucket', 'Bucket hat'], ['none', 'Nothing']] }, { key: 'hatColor', label: 'colour', colour: COLOURS }],
  [{ key: 'hair', label: 'Hair', colour: HAIRS }, { key: 'skin', label: 'Skin', colour: SKINS }],
  [{ key: 'top', label: 'Top', colour: COLOURS }, { key: 'sleeves', label: 'sleeves', options: [['short', 'Short sleeves'], ['long', 'Long sleeves']] }],
  [{ key: 'bottoms', label: 'Bottoms', colour: COLOURS }, { key: 'legs', label: 'legs', options: [['shorts', 'Shorts'], ['pants', 'Long pants']] }],
  [{ key: 'pack', label: 'Pack', options: [['vest', 'Race vest'], ['backpack', 'Backpack'], ['none', 'None']] }, { key: 'packColor', label: 'colour', colour: COLOURS }],
  [{ key: 'shoes', label: 'Shoes', colour: COLOURS }],
];

function buildLookEditor() {
  const el = ui.lookEditor;
  el.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'row small';
  head.innerHTML = '<span class="hint">Your kit (from the KORGA finish photo)</span>';
  const preset = document.createElement('button');
  preset.className = 'mini';
  preset.textContent = 'KORGA kit';
  preset.title = 'Headlamp, blue-grey tee, black race vest, bib, black shorts, red wristband, grey-green shoes';
  preset.onclick = () => { state.look = { ...KORGA_LOOK }; syncLookEditor(); rebuild(); };
  head.append(preset);
  el.append(head);
  for (const row of LOOK_ROWS) {
    const r = document.createElement('div');
    r.className = 'lrow';
    for (const f of row) {
      const sel = document.createElement('select');
      sel.dataset.key = f.key;
      sel.title = f.label;
      for (const [v, label] of f.options ?? f.colour ?? []) sel.add(new Option(f.key === 'skin' ? `${label} skin` : label, v));
      if (f.colour) sel.classList.add('swatch');
      sel.onchange = () => {
        (state.look as unknown as Record<string, string>)[f.key] = sel.value;
        paintSwatch(sel);
        rebuild();
      };
      if (row.length === 1 || f === row[0]) {
        const lab = document.createElement('em');
        lab.textContent = f.label;
        r.append(lab);
      }
      r.append(sel);
    }
    el.append(r);
  }
  const checks = document.createElement('div');
  checks.className = 'row small';
  for (const [key, label] of [['bib', 'Race bib'], ['poles', 'Poles'], ['wristband', 'Wristband']] as const) {
    const lab = document.createElement('label');
    lab.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.key = key;
    cb.onchange = () => { state.look[key] = cb.checked; rebuild(); };
    lab.append(cb, ` ${label}`);
    checks.append(lab);
  }
  el.append(checks);
  syncLookEditor();
}

function paintSwatch(sel: HTMLSelectElement) {
  if (!sel.classList.contains('swatch')) return;
  sel.style.borderLeft = `14px solid ${C[sel.value as ColorName] ?? 'transparent'}`;
}

function syncLookEditor() {
  ui.lookEditor.querySelectorAll<HTMLSelectElement>('select').forEach((s) => {
    s.value = String(state.look[s.dataset.key as keyof Look]);
    paintSwatch(s);
  });
  ui.lookEditor.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((c) => {
    c.checked = !!state.look[c.dataset.key as keyof Look];
  });
}

function parseLook(json: unknown): Look | null {
  if (typeof json !== 'string') return null;
  try {
    const l = JSON.parse(json) as Partial<Look>;
    return { ...KORGA_LOOK, ...l };
  } catch {
    return null;
  }
}

buildLookEditor();

// ------------------------------------------------------------------ saving

let persistTimer = 0;
let justRestored = false;
let restoredAt = -Infinity;
function persist() {
  if (!state.track || state.restoring) return;
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    if (!state.track) return;
    const ok = save(state.track, currentSaveState());
    mirrorToDisk(state.track);
    const edits = state.checkpoints.filter((c) => c.pinned).length + state.tombstones.length;
    // automatic re-saves right after opening (e.g. the map arriving) still count as "restored"
    const verb = justRestored || performance.now() - restoredAt < 4000 ? 'restored' : 'saved';
    justRestored = false;
    showSaved(ok ? (edits ? `✓ ${verb} · ${edits} edit${edits > 1 ? 's' : ''}` : `✓ ${verb}`) : 'not saved (storage full?)');
  }, 250);
}

/** Dev server only: also keep a copy in edits/<key>.json next to the project. */
const diskEnabled = () => import.meta.env.DEV && !new URLSearchParams(location.search).has('nodisk'); // tests pass ?nodisk

function mirrorToDisk(t: Track) {
  if (!diskEnabled()) return;
  fetch(`/__pixelhike/edits/${encodeURIComponent(trackKey(t))}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(makeBackup(t, currentSaveState()), null, 2),
  }).catch(() => { /* not running under the dev server */ });
}

async function loadFromDisk(t: Track) {
  if (!diskEnabled()) return null;
  try {
    const r = await fetch(`/__pixelhike/edits/${encodeURIComponent(trackKey(t))}`);
    return r.ok ? parseBackup(await r.text()) : null;
  } catch {
    return null;
  }
}

function showSaved(text: string) {
  ui.saved.textContent = text;
}

function collectSettings() {
  return {
    title: ui.title.value,
    activity: state.activity,
    character: state.character,
    gender: state.gender,
    look: JSON.stringify(state.look),
    companion: state.companion,
    duration: Number(ui.duration.value),
    mode: renderer.mode,
    aspect: renderer.aspect,
    minimap: ui.minimap.checked,
    tz: Number(ui.tz.value),
    music: ui.music.value === 'custom' ? 'auto' : ui.music.value, // uploaded files aren't stored
    volume: Number(ui.volume.value),
    logo: state.logoSource?.dataUrl ?? null, // small, background-free PNG
    logoIntro: ui.logoIntro.checked,
    logoBadge: ui.logoBadge.checked,
    logoOutro: ui.logoOutro.checked,
    logoColors: ui.logoColors.value,
    gateMode: ui.gateMode.value,
    gateColor: ui.gateColor.value,
    gateText: ui.gateText.value,
    gateTagline: ui.gateTagline.value,
    scenery: ui.scenery.value,
    envClouds: ui.envClouds.checked,
    envLife: ui.envLife.checked,
    envSigns: ui.envSigns.checked,
    envSplits: ui.envSplits.checked,
    envLight: ui.envLight.checked,
    envWater: ui.envWater.checked,
    envLandmarks: ui.envLandmarks.checked,
    zonesEnabled: ui.zonesOn.checked,
    zoneStyle0: ui.zoneStyle[0].value,
    zoneStyle1: ui.zoneStyle[1].value,
    zoneStyle2: ui.zoneStyle[2].value,
    zoneAt1: zoneSettings().bands[1].at,
    zoneAt2: zoneSettings().bands[2].at,
    zoneTech: ui.zoneTech.checked,
    zoneLabels: ui.zoneLabels.checked,
  };
}

function applySettings(s: Record<string, unknown>) {
  if (typeof s.title === 'string') ui.title.value = s.title;
  if (typeof s.character === 'string') setCharacter(s.character as CharacterId, false);
  const look = parseLook(s.look);
  if (look) { state.look = look; syncLookEditor(); }
  if (s.gender === 'male' || s.gender === 'female') { state.gender = s.gender; setSeg(ui.gender, s.gender); }
  if ('companion' in s) { state.companion = (s.companion as CharacterId | null) ?? null; ui.companion.value = state.companion ?? ''; }
  if (typeof s.duration === 'number') ui.duration.value = String(s.duration);
  if (s.mode === '2d' || s.mode === '3d') { renderer.setMode(s.mode); setSeg(ui.mode, s.mode); }
  if (s.aspect === 'landscape' || s.aspect === 'portrait') { renderer.setAspect(s.aspect); setSeg(ui.aspect, s.aspect); fitCanvas(); }
  if (typeof s.minimap === 'boolean') { ui.minimap.checked = s.minimap; renderer.showMinimap = s.minimap; }
  if (typeof s.tz === 'number') ui.tz.value = String(s.tz);
  if (typeof s.music === 'string') ui.music.value = s.music;
  if (typeof s.volume === 'number') ui.volume.value = String(s.volume);
  for (const [k, el] of [['logoIntro', ui.logoIntro], ['logoBadge', ui.logoBadge], ['logoOutro', ui.logoOutro]] as const) {
    if (typeof s[k] === 'boolean') el.checked = s[k] as boolean;
  }
  if (s.logoColors === 'logo' || s.logoColors === 'palette') ui.logoColors.value = s.logoColors;
  if (typeof s.gateMode === 'string') ui.gateMode.value = s.gateMode;
  if (typeof s.gateColor === 'string') ui.gateColor.value = s.gateColor;
  if (typeof s.gateText === 'string') ui.gateText.value = s.gateText;
  if (typeof s.gateTagline === 'string') ui.gateTagline.value = s.gateTagline;
  if (s.scenery === 'auto' || s.scenery === 'tropical' || s.scenery === 'alpine' || s.scenery === 'classic') ui.scenery.value = s.scenery;
  for (const [k, el] of [['envClouds', ui.envClouds], ['envLife', ui.envLife], ['envSigns', ui.envSigns], ['envSplits', ui.envSplits], ['envLight', ui.envLight], ['envWater', ui.envWater], ['envLandmarks', ui.envLandmarks]] as const) {
    if (typeof s[k] === 'boolean') el.checked = s[k] as boolean;
  }
  for (const [k, el] of [['zonesEnabled', ui.zonesOn], ['zoneTech', ui.zoneTech], ['zoneLabels', ui.zoneLabels]] as const) {
    if (typeof s[k] === 'boolean') el.checked = s[k] as boolean;
  }
  ui.zoneStyle.forEach((el, i) => {
    const v = s[`zoneStyle${i}`];
    if (typeof v === 'string' && (ZONE_STYLES as string[]).includes(v)) el.value = v;
  });
  if (typeof s.zoneAt1 === 'number') ui.zoneAt1.value = String(s.zoneAt1);
  if (typeof s.zoneAt2 === 'number') ui.zoneAt2.value = String(s.zoneAt2);
  if ('logo' in s) {
    const url = typeof s.logo === 'string' ? s.logo : null;
    if (url !== (state.logoSource?.dataUrl ?? null)) void setLogo(url ? { dataUrl: url } : null);
  }
}

// ------------------------------------------------------------------ event logo

async function setLogo(src: LogoSource | null) {
  state.logoSource = src;
  state.logoSet = src ? await LogoSet.load(src, ui.logoColors.value as LogoColors) : null;
  ui.logoOpts.hidden = ui.logoRemove.hidden = ui.logoPreview.hidden = !state.logoSet;
  if (state.logoSet) {
    const img = state.logoSet.get(32);
    ui.logoPreview.width = img.width;
    ui.logoPreview.height = img.height;
    const ctx = ui.logoPreview.getContext('2d')!;
    ctx.clearRect(0, 0, img.width, img.height);
    ctx.drawImage(img, 0, 0);
    ui.logoPreview.style.width = `${img.width * 2}px`;
  }
  rebuild();
}

// ------------------------------------------------------------------ music

function currentTrackId(): string | null {
  const v = ui.music.value;
  if (v === 'none') return null;
  if (v === 'custom') return 'custom';
  return v === 'auto' ? DEFAULT_TRACK[state.activity] : v;
}

function updateMusicCredit() {
  const id = currentTrackId();
  if (!id) ui.musicCredit.textContent = '';
  else if (id === 'custom') ui.musicCredit.textContent = `♪ ${state.customMusic?.name ?? ''}`;
  else {
    const t = TRACKS.find((x) => x.id === id)!;
    ui.musicCredit.textContent = `♪ "${t.title}" · ${t.artist} (${t.license})`;
  }
}

let soundtrackJob = 0;
/** (Re)renders the looped + faded soundtrack when the track, length or volume changes. */
async function updateSoundtrack() {
  updateMusicCredit();
  const id = currentTrackId();
  const duration = state.timeline?.duration ?? 0;
  const key = `${id}|${duration}|${ui.volume.value}|${state.customMusic?.name ?? ''}`;
  if (key === state.soundtrackKey) return;
  const job = ++soundtrackJob;
  if (!id || !duration) {
    state.soundtrack = null;
    state.soundtrackKey = key;
    syncAudio();
    return;
  }
  try {
    const src = id === 'custom' ? state.customMusic!.buffer : await loadTrack(id);
    const buf = await renderSoundtrack(src, duration, Number(ui.volume.value));
    if (job !== soundtrackJob) return; // a newer request won
    state.soundtrack = buf;
    state.soundtrackKey = key;
    syncAudio();
  } catch (e) {
    console.warn('Music unavailable', e);
    state.soundtrack = null;
  }
}

/** Starts/stops the preview audio so it matches the play state. */
function syncAudio() {
  if (state.playing && state.soundtrack && !state.exporting && !state.scrubbing && state.timeline && state.t < state.timeline.duration) {
    player.start(state.soundtrack, state.t);
  } else player.stop();
}

let musicTimer = 0;
function updateSoundtrackSoon() {
  clearTimeout(musicTimer);
  musicTimer = window.setTimeout(() => void updateSoundtrack(), 200);
}

// Browsers only allow sound after a click: resume on the first interaction.
window.addEventListener('pointerdown', () => {
  const c = audioContext();
  if (c.state === 'suspended') void c.resume().then(syncAudio);
}, { once: false });

// ------------------------------------------------------------------ UI

function setStatus(msg: string, error = false) {
  ui.status.textContent = msg;
  ui.status.classList.toggle('error', error);
}

function setSeg(el: HTMLElement, v: string) {
  el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
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

/** Any edit pins the checkpoint so it survives activity changes and reloads. */
function edited(cp: Checkpoint, row?: HTMLElement) {
  pin(cp);
  rebuild();
  if (row) markEdited(row);
}

/** Updates a row's "edited" markers in place (re-rendering would swallow clicks mid-edit). */
function markEdited(row: HTMLElement) {
  const chip = row.querySelector<HTMLElement>('.chip');
  if (chip) { chip.style.borderColor = 'var(--yellow)'; chip.title = 'Edited by you (kept for this track)'; }
  const meta = row.querySelector<HTMLElement>('.meta');
  if (meta && !meta.textContent?.endsWith('edited')) meta.textContent += ' · edited';
}

const hereEl = document.createElement('li');
hereEl.className = 'here';

function renderCheckpointList() {
  ui.cps.innerHTML = '';
  for (const cp of state.checkpoints) {
    const li = document.createElement('li');
    li.dataset.d = String(cp.d);
    const fixed = cp.kind === 'start' || cp.kind === 'finish';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = cp.enabled;
    cb.disabled = fixed;
    cb.title = 'Show this checkpoint';
    cb.onchange = () => { cp.enabled = cb.checked; edited(cp, li); };

    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = KIND_COLOR[cp.kind];
    chip.title = cp.pinned ? 'Edited by you (kept for this track)' : 'Auto-detected';
    if (cp.pinned) chip.style.borderColor = 'var(--yellow)';

    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 18;
    name.value = cp.name;
    name.oninput = () => { cp.name = name.value || defaultName(cp.kind); edited(cp, li); };

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
      edited(cp);
      renderCheckpointList();
    };

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Remove checkpoint';
    del.disabled = fixed;
    del.onclick = () => {
      state.tombstones.push(cp.d);
      state.checkpoints = state.checkpoints.filter((c) => c !== cp);
      renderCheckpointList();
      rebuild();
    };

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.title = 'Jump to this checkpoint';
    const m = cp.stayMin ?? 0;
    const stay = m ? ` · stayed ${m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m} min`}` : '';
    meta.textContent = `km ${((cp.d * (state.track?.distScale ?? 1)) / 1000).toFixed(1)} · ${Math.round(cp.ele).toLocaleString()} m${stay}${cp.pinned ? ' · edited' : ''}`;
    meta.onclick = () => {
      const t = state.timeline?.reachTimes.get(cp.id) ?? (cp.kind === 'start' ? 0 : null);
      if (t != null) seek(Math.max(0, t - 0.6));
    };

    li.append(cb, chip, name, kind, del, meta);
    ui.cps.append(li);
  }
  lastHereIdx = -2;
}

let lastHereIdx = -2;
let lastHereText = '';
/** Moves the "you are here" row to sit after the last checkpoint passed, and highlights the current stop. */
function updateHere() {
  if (!state.timeline || !state.track) return;
  const st = state.timeline.sample(state.t);
  const rows = [...ui.cps.querySelectorAll<HTMLLIElement>('li[data-d]')];
  let idx = -1;
  rows.forEach((r, i) => {
    const d = Number(r.dataset.d);
    const passed = d <= st.d + 0.5 && st.phase !== 'intro' && st.phase !== 'gateStart';
    if (passed) idx = i;
    r.classList.toggle('passed', passed && !(st.pauseCp && st.pauseCp.d === d));
    r.classList.toggle('now', !!st.pauseCp && Math.abs(st.pauseCp.d - d) < 0.5);
  });
  if (st.phase === 'intro' || st.phase === 'gateStart') idx = -1;
  const tr = state.track;
  const where = st.pauseCp ? `at ${st.pauseCp.name}` : st.phase === 'intro' || st.phase === 'gateStart' ? 'ready to start' : st.phase === 'outro' || st.phase === 'gateFinish' ? 'finished!' : 'on the trail';
  const text = `▶ YOU ARE HERE · ${where} · km ${((st.d * tr.distScale) / 1000).toFixed(1)} · ${Math.round(sampleAt(tr, tr.ele, st.d)).toLocaleString()} m · ${clockText(st.clockMs, Number(ui.tz.value || 0))}`;
  if (text !== lastHereText) { hereEl.textContent = text; lastHereText = text; }
  if (idx !== lastHereIdx || !hereEl.isConnected) {
    const after = rows[idx];
    if (after) after.after(hereEl);
    else ui.cps.prepend(hereEl);
    lastHereIdx = idx;
    // keep the marker visible inside the list's own scroll box (without moving the sidebar)
    const box = ui.cps;
    const top = hereEl.offsetTop, bottom = top + hereEl.offsetHeight;
    if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) box.scrollTop = top - box.clientHeight / 2;
  }
}

function renderStats() {
  const tr = state.track!;
  const s = tr.stats;
  const h = Math.floor(s.duration / 3600000), m = Math.round((s.duration % 3600000) / 60000);
  const items: [string, string][] = [
    ['Distance', `${((s.distance * tr.distScale) / 1000).toFixed(2)} km`],
    ['Duration', `${h}h ${String(m).padStart(2, '0')}m`],
    ['Elevation gain', `${Math.round(s.ascent).toLocaleString()} m`],
    ['Highest', `${Math.round(s.maxEle).toLocaleString()} m`],
  ];
  if (s.avgHr) items.push(['Avg HR', `${Math.round(s.avgHr)} bpm`]);
  if (s.calories) items.push(['Calories', `${Math.round(s.calories).toLocaleString()} kcal`]);
  if (s.avgTemp != null) items.push(['Avg temp', `${Math.round(s.avgTemp)} °C`]);
  if (state.surface && state.track === tr) {
    const k = state.surface.km;
    const parts = [['trail', k.trail], ['road', k.road], ['track', k.track]] as const;
    items.push(['Surface', parts.filter(([, v]) => v >= 0.1).map(([n, v]) => `${n} ${v.toFixed(1)}`).join(' · ') + ' km']);
  }
  items.push(['Looks like', ACTIVITY_LABEL[guessActivity(tr)]]);
  ui.stats.innerHTML = items.map(([k, v]) => `<div>${k} <b>${v}</b></div>`).join('');
}

function bindSeg(el: HTMLElement, onPick: (v: string) => void) {
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    setSeg(el, b.dataset.v!);
    onPick(b.dataset.v!);
  });
}

// keep the preview as big as its space allows whenever that space changes (window, sidebar, stats…)
new ResizeObserver(() => fitCanvas()).observe(ui.screen);

function fitCanvas() {
  const box = ui.screen.getBoundingClientRect();
  // whole *device* pixels per game pixel keeps it crisp; on a Retina screen (2 device px per CSS px)
  // that allows half steps (2.5×, 3.5×…), so the preview can use more of its space
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  const fit = Math.min((box.width - 8) / renderer.W, (box.height - 8) / renderer.H);
  const s = Math.max(1, Math.floor(fit * dpr) / dpr);
  ui.canvas.style.width = `${renderer.W * s}px`;
  ui.canvas.style.height = `${renderer.H * s}px`;
}

function download(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

function seek(t: number) {
  state.t = t;
  syncAudio();
}

bindSeg(ui.mode, (v) => { renderer.setMode(v as ViewMode); persist(); });
bindSeg(ui.aspect, (v) => { renderer.setAspect(v as Aspect); fitCanvas(); persist(); });
bindSeg(ui.activity, (v) => setActivity(v as Activity));
bindSeg(ui.character, (v) => { state.customSheet = null; ui.resetSheet.hidden = true; setCharacter(v as CharacterId); });
bindSeg(ui.gender, (v) => { state.gender = v as Gender; rebuild(); });
ui.companion.onchange = () => { state.companion = (ui.companion.value || null) as CharacterId | null; rebuild(); };
ui.duration.oninput = () => { rebuild(); updateSoundtrackSoon(); };
ui.title.oninput = () => rebuild();
ui.tz.onchange = () => rebuild();
ui.minimap.onchange = () => { renderer.showMinimap = ui.minimap.checked; persist(); };
ui.music.onchange = () => { void updateSoundtrack(); persist(); };
ui.volume.oninput = () => { updateSoundtrackSoon(); persist(); };
ui.musicFile.onchange = async () => {
  const f = ui.musicFile.files?.[0];
  if (!f) return;
  try {
    state.customMusic = { name: f.name, buffer: await decodeFile(f) };
    const opt = ui.music.querySelector<HTMLOptionElement>('option[value="custom"]')!;
    opt.hidden = false;
    opt.textContent = `My track: ${f.name.slice(0, 24)}`;
    ui.music.value = 'custom';
    await updateSoundtrack();
  } catch {
    setStatus('Could not read that audio file.', true);
    setTimeout(() => setStatus(''), 3000);
  }
  ui.musicFile.value = '';
};

ui.logoFile.onchange = async () => {
  const f = ui.logoFile.files?.[0];
  ui.logoFile.value = '';
  if (!f) return;
  try {
    await setLogo(await prepareLogo(f));
  } catch (e) {
    setStatus((e as Error).message || 'Could not read that image.', true);
    setTimeout(() => setStatus(''), 3000);
  }
};
ui.logoRemove.onclick = () => void setLogo(null);
ui.logoColors.onchange = () => void setLogo(state.logoSource);
for (const el of [ui.logoIntro, ui.logoBadge, ui.logoOutro]) el.onchange = () => rebuild();
ui.gateMode.onchange = ui.gateColor.onchange = () => { rebuild(); void updateSoundtrack().then(syncAudio); };
ui.gateText.oninput = ui.gateTagline.oninput = () => rebuild();
for (const el of [ui.scenery, ui.envClouds, ui.envLife, ui.envSigns, ui.envSplits, ui.envLight]) el.onchange = () => rebuild();
ui.envWater.onchange = () => { rebuild(); if (ui.envWater.checked) void ensureWater(); };
ui.envLandmarks.onchange = () => {
  refreshCheckpoints();
  rebuild();
  if (ui.envLandmarks.checked) void ensureWater();
};

/** Download the map area's rivers + lakes once (cached per area in the browser). */
function ensureWater(): Promise<void> {
  if (!state.bbox || !(ui.envWater.checked || ui.envLandmarks.checked)) return Promise.resolve();
  if (state.water) return Promise.resolve();
  if (state.waterLoad) return state.waterLoad;
  const track = state.track;
  const t0 = performance.now();
  mapStatus('Loading map…');
  state.waterLoad = loadWater(state.bbox, {
    onProgress: (done, total) => { if (state.track === track) mapStatus(`Loading map… ${done}/${total}`); },
    // springs + waterfalls come from a separate small query and may land a bit later
    onExtras: (w) => {
      if (state.track !== track || state.water !== w) return;
      state.water = { ...w }; // a new object, so the renderer rebuilds the map with them
      refreshCheckpoints();
      rebuild();
    },
  })
    .then((w) => {
      if (state.track !== track) return; // another file was loaded meanwhile
      state.water = w;
      state.surface = routeSurface(w, track!);
      renderStats();
      refreshCheckpoints(); // OSM viewpoints + peak names
      rebuild();
      mapStatus(`Map ready (${((performance.now() - t0) / 1000).toFixed(1)} s)`, 1500);
    })
    .catch((e) => {
      console.warn('Map data unavailable (OpenStreetMap)', e);
      state.waterLoad = null;
      if (state.track === track) mapStatus('Map data unavailable right now — the video works without rivers and roads.', 5000);
    });
  return state.waterLoad;
}

/** Map messages only use the status line when nothing else is showing there. */
let mapMsgTimer = 0;
function mapStatus(msg: string, clearAfter = 0) {
  const cur = ui.status.textContent ?? '';
  if (cur && !cur.startsWith('Loading map') && !cur.startsWith('Map ')) return;
  setStatus(msg);
  clearTimeout(mapMsgTimer);
  if (clearAfter) mapMsgTimer = window.setTimeout(() => { if (ui.status.textContent === msg) setStatus(''); }, clearAfter);
}
for (const el of [ui.zonesOn, ui.zoneTech, ui.zoneLabels, ...ui.zoneStyle, ui.zoneAt1, ui.zoneAt2]) el.onchange = () => rebuild();
ui.zoneReset.onclick = () => {
  if (!state.track) return;
  setZoneUi({ ...defaultZones(state.track), on: ui.zonesOn.checked }); // reset heights/styles, keep on/off
  rebuild();
};

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
  const cp: Checkpoint = { id: '', kind, name: defaultName(kind), enabled: true, d, ele: sampleAt(tr, tr.ele, d), time, leaveTime: time };
  pin(cp);
  state.checkpoints.push(cp);
  state.checkpoints.sort((a, b) => a.d - b.d);
  renderCheckpointList();
  rebuild();
};
function currentSaveState() {
  return {
    settings: collectSettings(),
    pins: state.checkpoints.filter((c) => c.pinned),
    tombstones: state.tombstones,
  };
}

ui.backupCps.onclick = () => {
  if (!state.track) return;
  const b = makeBackup(state.track, currentSaveState());
  const date = new Date(state.track.stats.startTime).toISOString().slice(0, 10);
  const name = `${(ui.title.value || 'hike').replace(/[^\w-]+/g, '-').toLowerCase()}-${date}-edits.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' }));
  download(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showSaved(`✓ backed up · ${b.pins.length + b.tombstones.length} edits`);
};

ui.restoreCps.onchange = async () => {
  const f = ui.restoreCps.files?.[0];
  ui.restoreCps.value = '';
  if (!f || !state.track) return;
  try {
    const b = parseBackup(await f.text());
    if (b.key !== trackKey(state.track) &&
        !confirm(`This backup was made for a different track (${new Date(b.track.startTime).toLocaleString()}). Apply it anyway?`)) return;
    state.restoring = true;
    applySettings(b.settings);
    state.tombstones = b.tombstones ?? [];
    state.checkpoints = b.pins.map((p) => ({ ...p, pinned: true }));
    setActivity((b.settings.activity as Activity) ?? state.activity, false);
    state.restoring = false;
    justRestored = true;
    rebuild();
    void updateSoundtrack().then(syncAudio);
  } catch (e) {
    state.restoring = false;
    setStatus((e as Error).message || 'Could not read that backup.', true);
    setTimeout(() => setStatus(''), 3000);
  }
};

ui.resetCps.onclick = () => {
  if (!state.track || !confirm('Forget all checkpoint edits for this track?')) return;
  state.tombstones = [];
  state.checkpoints = [];
  refreshCheckpoints();
  rebuild();
};

ui.play.onclick = () => {
  state.playing = !state.playing;
  if (state.playing && state.timeline && state.t >= state.timeline.duration) state.t = 0;
  ui.play.innerHTML = state.playing ? '&#9208;' : '&#9654;';
  syncAudio();
};
ui.scrub.oninput = () => {
  if (!state.timeline) return;
  state.t = (Number(ui.scrub.value) / 1000) * state.timeline.duration;
};
ui.scrub.onpointerdown = () => { state.scrubbing = true; syncAudio(); };
ui.scrub.onpointerup = () => { state.scrubbing = false; syncAudio(); };

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
  await updateSoundtrack();
  // rivers are still downloading? give them a moment so the video includes them
  if ((ui.envWater.checked || ui.envLandmarks.checked) && !state.water && state.waterLoad) {
    setStatus('Fetching map data…');
    await Promise.race([state.waterLoad, new Promise((r) => setTimeout(r, 20_000))]);
    setStatus('');
  }
  state.exporting = true;
  syncAudio();
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
      audio: state.soundtrack,
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
    syncAudio();
  }
};

// ------------------------------------------------------------------ loop

const previewCtx = ui.charPreview.getContext('2d')!;
let last = performance.now();
let lastHere = 0;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state.timeline && !state.exporting) {
    if (state.playing && !state.scrubbing) {
      const audioT = player.time();
      state.t = audioT ?? state.t + dt; // the music is the master clock while it plays
      if (state.t > state.timeline.duration + 1.5) {
        state.t = 0; // loop with a short hold
        syncAudio();
      }
    }
    renderer.renderAt(state.t);
    ui.scrub.value = String(Math.round((Math.min(state.t, state.timeline.duration) / state.timeline.duration) * 1000));
    ui.clock.textContent = `${Math.min(state.t, state.timeline.duration).toFixed(1)}s / ${state.timeline.duration}s`;
    if (now - lastHere > 100) { updateHere(); lastHere = now; }
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
    _state: state,
    seek(t: number) { state.playing = false; state.t = t; syncAudio(); renderer.renderAt(t); updateHere(); },
    setMode(m: ViewMode) { renderer.setMode(m); setSeg(ui.mode, m); },
    setAspect(a: Aspect) { renderer.setAspect(a); setSeg(ui.aspect, a); fitCanvas(); },
    setActivity(a: Activity) { setActivity(a); },
    setCharacter(c: CharacterId) { setCharacter(c); },
    setLook(l: Partial<Look>) { state.look = { ...state.look, ...l }; syncLookEditor(); rebuild(); },
    setGender(g: Gender) { state.gender = g; setSeg(ui.gender, g); rebuild(); },
    setCompanion(c: CharacterId | null) { state.companion = c; ui.companion.value = c ?? ''; rebuild(); },
    setGate(mode: string, text = '', tagline = '', color = 'red') {
      ui.gateMode.value = mode; ui.gateText.value = text; ui.gateTagline.value = tagline; ui.gateColor.value = color; rebuild();
    },
    waterReady() { return ensureWater().then(() => state.water && { lines: state.water.lines.length, areas: state.water.areas.length, pois: state.water.pois.length, extras: !!state.water.extras, surface: state.surface }); },
    /** For scripts/bake-map.mjs: the loaded map data and the area key it's cached under. */
    mapData() { return ensureWater().then(() => state.bbox && state.water && { area: mapAreaKey(state.bbox), data: state.water }); },
    async setLogoFromUrl(url: string, colors: LogoColors = 'logo') {
      ui.logoColors.value = colors;
      await setLogo(await prepareLogo(await (await fetch(url)).blob()));
    },
    setDuration(s: number) { ui.duration.value = String(s); rebuild(); },
    setEnv(e: { scenery?: string; clouds?: boolean; life?: boolean; signs?: boolean; splits?: boolean; light?: boolean }) {
      if (e.light != null) ui.envLight.checked = e.light;
      if ((e as { water?: boolean }).water != null) ui.envWater.checked = !!(e as { water?: boolean }).water;
      if ((e as { landmarks?: boolean }).landmarks != null) { ui.envLandmarks.checked = !!(e as { landmarks?: boolean }).landmarks; refreshCheckpoints(); }
      if (e.scenery) ui.scenery.value = e.scenery;
      if (e.clouds != null) ui.envClouds.checked = e.clouds;
      if (e.life != null) ui.envLife.checked = e.life;
      if (e.signs != null) ui.envSigns.checked = e.signs;
      if (e.splits != null) ui.envSplits.checked = e.splits;
      rebuild();
    },
    setZones(z: Partial<ZoneSettings>) { setZoneUi({ ...zoneSettings(), ...z }); rebuild(); },
    /** Openness score every 500 m: [km, score, elevation]. */
    viewScan() {
      const t = state.track!, tr = state.terrain!;
      const out: number[][] = [];
      for (let d = 400; d < t.stats.distance; d += 500) out.push([+(d / 1000).toFixed(1), +openness(t, tr, d).score.toFixed(3), Math.round(sampleAt(t, t.ele, d))]);
      return out;
    },
    zones() { return state.zones && { runs: state.zones.runs, tech: state.zones.tech, summary: ui.zoneSummary.textContent }; },
    forgetSaved() { if (state.track) forget(state.track); },
    /** A character's views (rows: side, 3/4 back, back, front; columns: animations' frames). */
    viewsDataUrl(c: CharacterId, scale = 6, g: Gender = 'male') {
      const set = c === 'me' ? builtInSet('me', g, state.look) : builtInSet(c, g);
      const anims = ['idle', 'walk', 'run', 'cheer'] as const;
      const cv = document.createElement('canvas');
      cv.width = 16 * 12 * scale; cv.height = 16 * 4 * scale;
      const ctx = cv.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#3b3f6b'; ctx.fillRect(0, 0, cv.width, cv.height);
      (['side', 'back3', 'back', 'front'] as const).forEach((v, row) => {
        let col = 0;
        for (const a of anims) {
          const list = v === 'side' ? set.frames[a] : set.views?.[v][a] ?? [];
          for (const f of list) ctx.drawImage(f, col++ * 16 * scale, row * 16 * scale, 16 * scale, 16 * scale);
        }
      });
      return cv.toDataURL('image/png');
    },
    sheetDataUrl(c: CharacterId, scale = 1, guides = false, g: Gender = 'male') { return renderSheet(builtInSet(c, g), scale, guides).toDataURL('image/png'); },
    get duration() { return state.timeline?.duration ?? 0; },
    get checkpoints() { return state.checkpoints; },
    get timeline() { return state.timeline; },
    get stats() { return state.track?.stats; },
    get speedup() { return state.timeline?.speedup(); },
    soundtrackReady: () => updateSoundtrack().then(() => state.soundtrack?.duration ?? 0),
    exportMp4: async (scale = 4, duration?: number) => {
      await updateSoundtrack();
      state.exporting = true; // pause the live preview, like the Export button does
      try {
        return await exportMp4(renderer, { duration: duration ?? state.timeline!.duration, fps: 30, scale, audio: state.soundtrack });
      } finally {
        state.exporting = false;
      }
    },
  },
});
