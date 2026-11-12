import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { SpriteSet } from './characters';
import type { GateOptions } from './gate';
import { openness } from './landmarks';
import { clockText, drawOverlay, type DecorFrame, type DecorItem, type DialState, type EventLogo, type MapFrame, type ScreenPoint } from './overlay';
import { C, PALETTE, rgb01 } from './palette';
import { moonPhase, moonPosition, skyAt, sunEvents, sunPosition, type SunEvent } from './sky';
import { shared, type Scenery, type Terrain } from './terrain';
import type { Timeline, TimelineState } from './timeline';
import { clamp, gaussian, sampleAt, type Activity, type Checkpoint, type Track } from './track';
import { buildWater, type WaterData, type WaterScene } from './water';
import { decorDensity, decorSprite, rng, techSprite, ZONE_LABEL, type TrailZones } from './zones';

THREE.ColorManagement.enabled = false; // palette hex values pass straight through

export type ViewMode = '3d' | '2d';
export type Aspect = 'landscape' | 'portrait';
export const LOW_RES: Record<Aspect, [number, number]> = { landscape: [320, 180], portrait: [180, 320] };

const FOV_3D = 45;
const FOV_2D = 28;

export interface SceneData {
  track: Track;
  terrain: Terrain;
  checkpoints: Checkpoint[];
  timeline: Timeline;
  title: string;
  tzOffsetMin: number;
  activity: Activity;
  hero: SpriteSet;
  pet: SpriteSet | null;
  logo: EventLogo | null;
  gate: GateOptions | null;
  /** Elevation zones + technical stretches used to dress the trail, or null. */
  zones: TrailZones | null;
  env: EnvOptions;
  /** Rivers / lakes from OpenStreetMap, once loaded (null = none / not yet). */
  water: WaterData | null;
}

/** Optional scenery extras (each can be switched off in the sidebar). */
export interface EnvOptions {
  scenery: Scenery;
  /** Valley mist, drifting cloud shadows, clouds in the sky. */
  clouds: boolean;
  /** Fireflies, birds at dawn/dusk, a head-lamp beam pointing ahead. */
  life: boolean;
  /** Summit signboards + aid-station tents. */
  signs: boolean;
  /** Leg splits on checkpoint banners + "next checkpoint" line. */
  splits: boolean;
  /** Ridges cast shadows from the real sun; nights lit by the real moon (position + phase). */
  light: boolean;
  /** Draw rivers + lakes and announce named river crossings. */
  water: boolean;
  /** Viewpoint camera moves, camp / spring / waterfall markers (OSM landmarks). */
  landmarks: boolean;
}

interface Rig {
  K: number;
  stride: number; // track samples per rig sample
  tx: Float64Array; ty: Float64Array; tz: Float64Array;
  px: Float64Array; py: Float64Array; pz: Float64Array;
  camDist: number;
}

export class PixelRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV_3D, 16 / 9, 5, 1e6);
  private rt: THREE.WebGLRenderTarget;
  private post: { scene: THREE.Scene; cam: THREE.OrthographicCamera; mat: THREE.ShaderMaterial };
  private overlay: HTMLCanvasElement;
  private overlayCtx: CanvasRenderingContext2D;
  private overlayTex: THREE.CanvasTexture;

  private data: SceneData | null = null;
  private rig: Rig | null = null;
  private trail: { group: THREE.Group; done: Line2; step: number; mats: LineMaterial[] } | null = null;
  private water: { scene: WaterScene; data: WaterData; terrain: Terrain } | null = null;

  mode: ViewMode = '3d';
  aspect: Aspect = 'landscape';
  showMinimap = true;
  W = 320;
  H = 180;
  private facingLeft = false;
  private sunEvents: SunEvent[] = [];
  private toasts: { text: string; t: number }[] = [];
  /** Compass direction of the best outlook at each viewpoint checkpoint (cached per checkpoint). */
  private viewDir = new Map<string, number>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    this.gl.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.gl.setPixelRatio(1);
    this.gl.autoClear = false;

    this.rt = new THREE.WebGLRenderTarget(this.W, this.H, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });

    this.overlay = document.createElement('canvas');
    this.overlayCtx = this.overlay.getContext('2d')!;
    this.overlayTex = new THREE.CanvasTexture(this.overlay);
    this.overlayTex.minFilter = THREE.NearestFilter;
    this.overlayTex.magFilter = THREE.NearestFilter;
    this.overlayTex.generateMipmaps = false;

    const mat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tScene: { value: this.rt.texture },
        tOverlay: { value: this.overlayTex },
        uPal: { value: PALETTE.map((h) => new THREE.Vector3(...rgb01(h))) },
        uSkyTop: { value: new THREE.Vector3() },
        uSkyBot: { value: new THREE.Vector3() },
        uStars: { value: 0 },
        uTime: { value: 0 },
        uRes: { value: new THREE.Vector2(this.W, this.H) },
        uDither: { value: 0.09 },
        uSun: { value: new THREE.Vector3() },
        uMoon: { value: new THREE.Vector3() },
        uMoonPhase: { value: 0.5 },
        uSkyCloud: { value: 0 },
        uCloudCol: { value: new THREE.Vector3(1, 1, 1) },
        uYawPx: { value: 0 },
      },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene; uniform sampler2D tOverlay;
        uniform vec3 uPal[${PALETTE.length}];
        uniform vec3 uSkyTop; uniform vec3 uSkyBot; uniform float uStars; uniform float uTime;
        uniform vec2 uRes; uniform float uDither;
        uniform vec3 uSun; uniform vec3 uMoon; uniform float uMoonPhase;
        uniform float uSkyCloud; uniform vec3 uCloudCol; uniform float uYawPx;
        varying vec2 vUv;
        float bayer2(vec2 a){ a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
        float bayer4(vec2 a){ return bayer2(0.5 * a) * 0.25 + bayer2(a); }
        float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        float vn(vec2 p){
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        vec3 quant(vec3 c, vec2 px){
          c += (bayer4(px) - 0.5) * uDither;
          vec3 best = uPal[0]; float bd = 1e9;
          for (int i = 0; i < ${PALETTE.length}; i++) {
            vec3 d = c - uPal[i];
            float dist = dot(d * d, vec3(0.22, 0.45, 0.33)); // keeps hue, so greens stay green
            if (dist < bd) { bd = dist; best = uPal[i]; }
          }
          return best;
        }
        void main(){
          vec2 px = floor(vUv * uRes);
          vec4 s = texture2D(tScene, vUv);
          vec3 col;
          if (s.a < 0.5) {
            float g = clamp(vUv.y * 1.2 - 0.1, 0.0, 1.0);
            col = mix(uSkyBot, uSkyTop, g);
            float st = hash(px);
            if (uStars > 0.01 && st > 0.985 && vUv.y > 0.3) {
              float tw = step(0.5, fract(st * 91.0 + uTime * 1.3));
              col = mix(col, vec3(0.96), uStars * (0.6 + 0.4 * tw));
            }
            // sun and moon at their real positions (only where the sky shows)
            // pixel clouds in a band above the horizon; they follow the camera's heading so they don't stick to the screen
            if (uSkyCloud > 0.0) {
              vec2 cp = vec2((px.x + uYawPx) / 52.0 + uTime * 0.05, px.y / 9.0);
              float cn = vn(cp) * 0.65 + vn(cp * 2.1 + 4.3) * 0.35;
              float band = smoothstep(0.42, 0.6, vUv.y) * (1.0 - smoothstep(0.82, 0.97, vUv.y));
              float v = cn * band;
              if (v > 0.5) col = uCloudCol;
              else if (v > 0.44) col = mix(col, uCloudCol, 0.55);
            }
            if (uSun.z > 0.5) {
              float r = length(px - uSun.xy);
              if (r <= 5.6) col = r <= 3.6 ? vec3(1.0, 0.914, 0.639) : vec3(1.0, 0.804, 0.459);
            }
            if (uMoon.z > 0.5) {
              vec2 dd = px - uMoon.xy;
              if (dot(dd, dd) <= 18.5) {
                float hw = sqrt(max(1e-3, 18.5 - dd.y * dd.y));
                float xn = dd.x / hw;
                float k = cos(6.28318 * uMoonPhase);
                bool lit = uMoonPhase <= 0.5 ? xn >= k : xn <= -k;
                col = lit ? vec3(1.0, 0.914, 0.639) : mix(col, vec3(0.231, 0.247, 0.42), 0.7);
              }
            }
          } else col = s.rgb;
          col = quant(col, px);
          vec4 o = texture2D(tOverlay, vUv);
          col = mix(col, o.rgb, step(0.5, o.a));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const postScene = new THREE.Scene();
    postScene.add(quad);
    this.post = { scene: postScene, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), mat };

    this.setAspect('landscape');
  }

  setAspect(aspect: Aspect) {
    this.aspect = aspect;
    [this.W, this.H] = LOW_RES[aspect];
    this.gl.setSize(this.W, this.H, false);
    this.rt.setSize(this.W, this.H);
    this.overlay.width = this.W;
    this.overlay.height = this.H;
    this.overlayTex.dispose(); // re-upload at the new size
    this.post.mat.uniforms.uRes.value.set(this.W, this.H);
    this.camera.aspect = this.W / this.H;
    this.camera.updateProjectionMatrix();
    this.trail?.mats.forEach((m) => m.resolution.set(this.W, this.H));
    this.water?.scene.lineMats.forEach((l) => l.mat.resolution.set(this.W, this.H));
  }

  setMode(mode: ViewMode) {
    this.mode = mode;
  }

  setData(data: SceneData) {
    const old = this.data;
    if (old && old.terrain !== data.terrain) {
      this.scene.remove(old.terrain.group);
      old.terrain.dispose();
    }
    if (!old || old.terrain !== data.terrain || old.track !== data.track) {
      this.scene.add(data.terrain.group);
      this.data = data;
      this.buildTrail();
      this.buildRig();
      const day = 86400000;
      this.sunEvents = sunEvents(data.track.stats.startTime - 1.5 * day, data.track.stats.endTime + 1.5 * day, data.track.lat0, data.track.lon0);
    }
    this.data = data;
    this.syncWater(data);
    this.toasts = [];
    for (const ev of this.sunEvents) {
      const t = data.timeline.videoTimeAtClock(ev.ms);
      if (t == null || t < data.timeline.gateIn + data.timeline.intro) continue;
      this.toasts.push({ text: `${ev.kind === 'sunrise' ? 'SUNRISE' : 'SUNSET'} ${clockText(ev.ms, data.tzOffsetMin)}`, t });
    }
    const z = data.zones;
    if (z?.settings.on && z.settings.labels) {
      for (const run of z.runs) {
        if (run.style === 'plain') continue;
        const t = data.timeline.videoTimeAtDistance(run.d0);
        if (t == null) continue;
        this.toasts.push({ text: ZONE_LABEL[run.style].toUpperCase(), t: Math.max(t, data.timeline.gateIn + data.timeline.intro) });
      }
    }
    const t0 = data.timeline.gateIn + data.timeline.intro;
    const soft = new Set<{ text: string; t: number }>();
    if (data.env.water && this.water) {
      for (const c of this.water.scene.crossings) {
        const t = data.timeline.videoTimeAtDistance(c.d);
        if (t == null) continue;
        this.toasts.push({ text: c.name.toUpperCase().slice(0, 30), t: Math.max(t, t0) });
      }
    }
    if (data.env.landmarks && this.water) {
      const cps = data.checkpoints.filter((c) => c.enabled);
      for (const p of this.water.scene.sprites.pois) {
        // a waterfall a short detour away: mention it as we pass closest
        if (p.d == null && p.kind === 'waterfall' && p.near.off < 2500) {
          const t = data.timeline.videoTimeAtDistance(p.near.d);
          if (t == null) continue;
          const km = (p.near.off * data.track.distScale) / 1000;
          const toast = { text: `${(p.name || 'WATERFALL').toUpperCase().slice(0, 20)} ${km.toFixed(1)}KM AWAY`, t: Math.max(t, t0) };
          this.toasts.push(toast);
          soft.add(toast);
          continue;
        }
        if (p.d == null) continue;
        const named = p.kind === 'camp' && p.name;
        if (!named && p.kind !== 'waterfall') continue;
        if (cps.some((c) => Math.abs(c.d - p.d!) < 300)) continue; // a checkpoint banner already says where we are
        const t = data.timeline.videoTimeAtDistance(p.d);
        if (t == null) continue;
        const toast = { text: (p.name || 'WATERFALL').toUpperCase().slice(0, 30), t: Math.max(t, t0) };
        this.toasts.push(toast);
        if (p.kind === 'camp') soft.add(toast); // camps come in clusters: skip any that would show up late
      }
    }
    // one toast at a time: nudge later ones so they don't overlap
    this.toasts.sort((a, b) => a.t - b.t);
    const kept: typeof this.toasts = [];
    for (const toast of this.toasts) {
      const last = kept[kept.length - 1];
      const t = last ? Math.max(toast.t, last.t + 2.4) : toast.t;
      if (soft.has(toast) && t - toast.t > 1.2) continue;
      kept.push({ text: toast.text, t });
    }
    this.toasts = kept;
  }

  /** (Re)build the river / lake meshes when the data or the diorama changes. */
  private syncWater(data: SceneData) {
    const w = this.water;
    if (w && (w.data !== data.water || w.terrain !== data.terrain)) {
      this.scene.remove(w.scene.group);
      w.scene.dispose();
      this.water = null;
    }
    if (!this.water && data.water) {
      const scene = buildWater(data.water, data.track, data.terrain, this.W, this.H);
      this.scene.add(scene.group);
      this.water = { scene, data: data.water, terrain: data.terrain };
    }
    if (this.water) this.water.scene.group.visible = data.env.water;
  }

  private dialAt(ms: number): DialState {
    const ev = this.sunEvents;
    let prev: SunEvent | null = null, next: SunEvent | null = null;
    for (const e of ev) {
      if (e.ms <= ms) prev = e;
      else { next = e; break; }
    }
    const t = this.data!.track;
    const isDay = prev ? prev.kind === 'sunrise' : sunPosition(ms, t.lat0, t.lon0).elevation > 0;
    const a = prev?.ms ?? ms - 6 * 3600_000, b = next?.ms ?? ms + 6 * 3600_000;
    return { isDay, frac: (ms - a) / (b - a), moonPhase: moonPhase(ms) };
  }

  /** Screen pixel (post-shader coords, y up) of a sky direction, or z = 0 when not visible. */
  private skyPoint(az: number, el: number, out: THREE.Vector3) {
    if (el < -0.03) return out.set(0, 0, 0);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    // Real compass direction; if it's higher than the frame shows, pin it just inside the top edge
    // so the sun/moon still appear wherever sky is visible (the shader only draws on sky pixels).
    const v = this.camera.position.clone().addScaledVector(dir, this.camera.far * 0.5).applyMatrix4(this.camera.matrixWorldInverse);
    if (v.z > -1) {
      // behind the camera: only usable when the body is high overhead and we're looking up-ish — skip
      return out.set(0, 0, 0);
    }
    const p = v.applyMatrix4(this.camera.projectionMatrix);
    if (Math.abs(p.x) > 1.05 || p.y < -1) return out.set(0, 0, 0);
    const y = Math.min(p.y, 1 - 16 / this.H);
    return out.set(Math.round(((p.x + 1) / 2) * this.W), Math.round(((y + 1) / 2) * this.H), 1);
  }

  // ------------------------------------------------------------------ build

  private buildTrail() {
    const { track, terrain } = this.data!;
    if (this.trail) {
      this.scene.remove(this.trail.group);
      this.trail.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      this.trail.mats.forEach((m) => m.dispose());
    }
    const step = Math.max(track.step, terrain.spacing / 4);
    const n = Math.floor(track.stats.distance / step) + 1;
    const pos: number[] = [];
    for (let k = 0; k <= n; k++) {
      const d = Math.min(k * step, track.stats.distance);
      const x = sampleAt(track, track.x, d), z = sampleAt(track, track.z, d);
      pos.push(x, terrain.worldY(x, z) + terrain.spacing * 0.12, z);
    }
    const mk = (color: string, width: number, depthTest: boolean, dashed = false) => {
      const m = new LineMaterial({ color: new THREE.Color(color).getHex(), linewidth: width, worldUnits: false, depthTest, dashed });
      m.resolution.set(this.W, this.H);
      if (dashed) {
        m.dashSize = terrain.spacing * 0.25;
        m.gapSize = terrain.spacing * 0.35;
      }
      return m;
    };
    const geo = () => {
      const g = new LineGeometry();
      g.setPositions(pos);
      return g;
    };
    const ahead = new Line2(geo(), mk(C.greyLight, 1, true, true));
    ahead.computeLineDistances();
    const done = new Line2(geo(), mk(C.coral, 2, true));
    done.renderOrder = 11;
    const group = new THREE.Group();
    group.add(ahead, done);
    [ahead, done].forEach((l) => (l.frustumCulled = false));
    this.scene.add(group);
    this.trail = { group, done, step, mats: [ahead.material, done.material] };
  }

  private buildRig() {
    const { track, terrain } = this.data!;
    const K = Math.min(track.n, 2500);
    const stride = (track.n - 1) / (K - 1);
    const b = track.bounds;
    const extent = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    const camDist = clamp(extent * 0.1, 500, 2600);
    const pitch = (21 * Math.PI) / 180;
    const yawOff = 0.55;
    const hor = camDist * Math.cos(pitch), ver = camDist * Math.sin(pitch);
    const margin = camDist * 0.05;
    const metresPerK = track.step * stride;

    // 1) smoothed target (the hiker) and a camera offset that follows the smoothed heading
    const rx = new Float64Array(K), ry = new Float64Array(K), rz = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      const i = Math.round(k * stride);
      rx[k] = track.x[i]; rz[k] = track.z[i]; ry[k] = terrain.worldY(rx[k], rz[k]);
    }
    const tx = gaussian(rx, 25 / metresPerK), ty = gaussian(ry, 25 / metresPerK), tz = gaussian(rz, 25 / metresPerK);
    const ox = new Float64Array(K), oz = new Float64Array(K), lift = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      const i = Math.round(k * stride);
      const hx = -track.hdx[i], hz = -track.hdz[i];
      ox[k] = (hx * Math.cos(yawOff) - hz * Math.sin(yawOff)) * hor;
      oz[k] = (hx * Math.sin(yawOff) + hz * Math.cos(yawOff)) * hor;
      // 2) how much higher the camera must go so the hiker isn't hidden by terrain
      const x = tx[k], y = ty[k], z = tz[k];
      let need = y + ver;
      for (let s = 0.1; s <= 1.0001; s += 1 / 16) {
        const g = terrain.worldY(x + ox[k] * s, z + oz[k] * s) + margin;
        need = Math.max(need, y + (g - y) / s);
      }
      lift[k] = need - (y + ver);
    }
    // 3) smooth the lift (max-filter first so it never dips into a ridge)
    const sCam = 500 / metresPerK;
    const liftS = gaussian(maxFilter(lift, Math.ceil(sCam)), sCam);
    const px = new Float64Array(K), py = new Float64Array(K), pz = new Float64Array(K);
    const ahead = camDist * 0.22;
    for (let k = 0; k < K; k++) {
      px[k] = tx[k] + ox[k];
      pz[k] = tz[k] + oz[k];
      py[k] = ty[k] + ver + liftS[k];
    }
    // look a little ahead of the hiker so more of the trail in front is visible
    const lx = new Float64Array(K), lz = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      const i = Math.round(k * stride);
      lx[k] = tx[k] + track.hdx[i] * ahead;
      lz[k] = tz[k] + track.hdz[i] * ahead;
    }
    this.rig = { K, stride, camDist, tx: lx, ty, tz: lz, px, py, pz };
  }

  // ------------------------------------------------------------------ frame

  private rigAt(d: number) {
    const r = this.rig!, t = this.data!.track;
    const kf = clamp(d / t.step / r.stride, 0, r.K - 1);
    const k = Math.min(Math.floor(kf), r.K - 2), f = kf - k;
    const L = (a: Float64Array) => a[k] + (a[k + 1] - a[k]) * f;
    return {
      target: new THREE.Vector3(L(r.tx), L(r.ty), L(r.tz)),
      pos: new THREE.Vector3(L(r.px), L(r.py), L(r.pz)),
    };
  }

  private overviewPos(at: 'start' | 'end', orbit: number) {
    const { terrain, track } = this.data!;
    const c = terrain.center;
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const fit = Math.min(vfov, hfov);
    if (this.mode === '2d') {
      const h = ((terrain.size / 2) / Math.tan(fit / 2)) * 0.95;
      return { pos: new THREE.Vector3(c.x, c.y + h, c.z + 0.01), target: c.clone() };
    }
    const i = at === 'start' ? 0 : track.n - 1;
    let bx = -track.hdx[i], bz = -track.hdz[i];
    const a = 0.6 + orbit;
    [bx, bz] = [bx * Math.cos(a) - bz * Math.sin(a), bx * Math.sin(a) + bz * Math.cos(a)];
    const R = ((terrain.size / 2) / Math.tan(fit / 2)) * 1.05;
    const el = (48 * Math.PI) / 180;
    return {
      pos: new THREE.Vector3(c.x + bx * R * Math.cos(el), c.y + R * Math.sin(el), c.z + bz * R * Math.cos(el)),
      target: c.clone(),
    };
  }

  renderAt(tSec: number) {
    if (!this.data || !this.rig) return;
    const { track, terrain, timeline, checkpoints } = this.data;
    const st = timeline.sample(tSec);
    const r = this.rig;

    // ---- camera
    const is2d = this.mode === '2d';
    this.camera.fov = is2d ? FOV_2D : FOV_3D;
    this.camera.near = Math.max(2, r.camDist * 0.02);
    this.camera.far = terrain.size * 6;
    this.camera.updateProjectionMatrix();

    const follow = this.rigAt(st.d);
    if (is2d) {
      const h = (r.camDist * 1.5) / Math.tan((FOV_2D * Math.PI) / 360);
      follow.pos.set(follow.target.x, follow.target.y + h, follow.target.z + 0.01);
    }
    if (!is2d && st.phase === 'pause' && st.pauseCp?.kind === 'view' && this.data.env.landmarks) this.lookAround(follow, st);
    let u = 1;
    let over = this.overviewPos('start', 0);
    if (st.phase === 'gateStart') {
      u = 0;
    } else if (st.phase === 'intro') {
      u = ease(clamp((st.introT - 0.9) / (timeline.intro - 0.9), 0, 1));
    } else if (st.phase === 'outro') {
      over = this.overviewPos('end', st.outroU * 0.7);
      u = 1 - ease(clamp(st.outroU / 0.55, 0, 1));
    }
    const camPos = over.pos.clone().lerp(follow.pos, u);
    const camTgt = over.target.clone().lerp(follow.target, u);
    this.camera.up.set(0, 1, 0);
    if (is2d) this.camera.up.set(0, 0, -1);
    this.camera.position.copy(camPos);
    this.camera.lookAt(camTgt);
    this.camera.updateMatrixWorld();

    // ---- sky / light
    const ms = st.clockMs;
    const sky = skyAt(ms, track.lat0, track.lon0);
    const sp = sunPosition(ms, track.lat0, track.lon0);
    const mp = moonPosition(ms, track.lat0, track.lon0);
    this.applyLight(sky, sp, mp, ms);
    shared.uFogCol.value.setRGB(...sky.bottom);
    const fogNear = is2d ? 1e9 : r.camDist * 2.6;
    const fogFar = is2d ? 2e9 : r.camDist * 10;
    shared.uFogNear.value = u * fogNear + (1 - u) * terrain.size * 8;
    shared.uFogFar.value = u * fogFar + (1 - u) * terrain.size * 9;
    const hx = sampleAt(track, track.x, st.d), hz = sampleAt(track, track.z, st.d);
    const hy = terrain.worldY(hx, hz);
    shared.uLampPos.value.set(hx, hy, hz);
    shared.uLamp.value = sky.lamp;
    shared.uLampR.value = r.camDist * 0.16;
    const env = this.data.env;
    shared.uTime.value = st.t;
    shared.uCloud.value = env.clouds && !is2d ? clamp(1 - sky.lamp, 0, 1) : 0;
    shared.uCloudScale.value = terrain.size * 0.05;
    shared.uWind.value.set(terrain.size * 0.004, terrain.size * 0.0013);
    shared.uBeam.value = env.life ? 1 : 0;
    shared.uLampDir.value.set(sampleAt(track, track.hdx, st.d), sampleAt(track, track.hdz, st.d)).normalize();
    if (env.life) shared.uLampR.value = r.camDist * 0.22; // the beam reaches a bit further than the pool
    terrain.mist.uMist.value = env.clouds && st.phase !== 'gateStart' ? this.mistAt(ms) * (is2d ? 0.6 : 1) : 0;
    terrain.mist.uMistClear.value = r.camDist * 0.55;
    if (this.water) {
      const dark = sky.lamp > 0.5;
      for (const l of this.water.scene.lineMats) l.mat.color.set(dark ? l.night : l.day);
      const rv = this.water.scene.river;
      if (rv) {
        // sun sparkle by day; at night only a bright, risen moon glints on the water
        const illum = (1 - Math.cos(2 * Math.PI * moonPhase(ms))) / 2;
        rv.uGlint.value = !dark ? 1 : mp.elevation > 0.05 && illum > 0.3 ? 1 : 0;
        rv.uGlintCol.value.set(...rgb01(dark ? C.cream : C.skyPale));
        rv.uGlintThr.value = dark ? 0.95 : 0.88;
      }
    }

    // ---- trail progress
    const tr = this.trail!;
    const segs = Math.max(0, Math.floor(st.d / tr.step));
    (tr.done.geometry as LineGeometry).instanceCount = segs;

    // ---- 3D pass
    this.gl.setRenderTarget(this.rt);
    this.gl.setClearColor(0x000000, 0);
    this.gl.clear(true, true, true);
    this.gl.render(this.scene, this.camera);

    // ---- overlay pass
    const hiker = this.project(hx, hy, hz);
    const ahead = Math.min(track.stats.distance, st.d + 40);
    const ax = sampleAt(track, track.x, ahead), az = sampleAt(track, track.z, ahead);
    const pa = this.project(ax, terrain.worldY(ax, az), az);
    const dx = pa.x - hiker.x;
    if (dx < -0.4) this.facingLeft = true;
    else if (dx > 0.4) this.facingLeft = false;

    const cpScreen = new Map<string, ScreenPoint>();
    for (const cp of checkpoints) {
      const x = sampleAt(track, track.x, cp.d), z = sampleAt(track, track.z, cp.d);
      const y = terrain.worldY(x, z);
      const p = this.project(x, y, z);
      // flags/tents/signs behind a ridge stay hidden (the 2D map looks straight down: nothing hides)
      if (!is2d && p.visible && this.cpBehindRidge(cp.id, x, y, z)) p.visible = false;
      cpScreen.set(cp.id, p);
    }

    const decor = this.decorFrame(st, hiker);
    const map = this.mapFrame(st, hx, hz, sky.lamp > 0.5);

    const petAt = this.data.pet
      ? { x: hiker.x + (this.facingLeft ? 11 : -11), y: hiker.y + 1, visible: hiker.visible }
      : null;
    drawOverlay({
      ctx: this.overlayCtx,
      W: this.W,
      H: this.H,
      track,
      activity: this.data.activity,
      checkpoints,
      timeline,
      state: st,
      sky,
      dial: this.dialAt(ms),
      toasts: this.toasts,
      title: this.data.title,
      tzOffsetMin: this.data.tzOffsetMin,
      hero: this.data.hero,
      heroAt: hiker,
      facingLeft: this.facingLeft,
      pet: this.data.pet,
      petAt,
      petFacingLeft: this.facingLeft,
      cpScreen,
      showMinimap: this.showMinimap,
      logo: this.data.logo,
      gate: this.data.gate,
      zones: this.data.zones,
      decor,
      map,
      env: this.data.env,
    });
    this.overlayTex.needsUpdate = true;

    // ---- post (quantise + sky + overlay) to the canvas
    const pu = this.post.mat.uniforms;
    pu.uSkyTop.value.set(...sky.top);
    pu.uSkyBot.value.set(...sky.bottom);
    pu.uStars.value = sky.stars;
    pu.uTime.value = st.t;
    this.skyPoint(sp.azimuth, sp.elevation, pu.uSun.value);
    this.skyPoint(mp.azimuth, mp.elevation, pu.uMoon.value);
    if (pu.uSun.value.z > 0.5) pu.uMoon.value.z = 0; // keep it simple: one disc at a time
    pu.uMoonPhase.value = moonPhase(ms);
    pu.uSkyCloud.value = env.clouds ? 1 : 0;
    const night = clamp(sky.lamp, 0, 1);
    const cb = sky.bottom;
    pu.uCloudCol.value.set(
      (cb[0] + (1 - cb[0]) * 0.65) * (1 - night * 0.55),
      (cb[1] + (1 - cb[1]) * 0.65) * (1 - night * 0.55),
      (cb[2] + (1 - cb[2]) * 0.65) * (1 - night * 0.45),
    );
    const dir = this.camera.getWorldDirection(this.tmp2);
    const hfov = 2 * Math.atan(Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.aspect);
    pu.uYawPx.value = (Math.atan2(dir.x, -dir.z) / hfov) * this.W;
    this.gl.setRenderTarget(null);
    this.gl.clear();
    this.gl.render(this.post.scene, this.post.cam);
  }

  private project(x: number, y: number, z: number): ScreenPoint {
    const p = this.projectF(x, y, z);
    return { x: Math.round(p.x), y: Math.round(p.y), visible: p.visible };
  }

  private projectF(x: number, y: number, z: number): ScreenPoint {
    const v = this.tmp.set(x, y, z).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.W, y: ((1 - v.y) / 2) * this.H, visible: v.z < 1 && v.z > -1 };
  }

  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  /**
   * Light for this moment. By default: the sky ramp's colours from the sun's real direction (kept
   * ≥ 18° up so slopes read). With `env.light`: ridges cast shadows along the real, unclamped sun
   * direction (so at dawn the peaks light up first and evenings get long valley shadows), and at
   * night the light comes from the real moon, as bright as its phase — darker when it's down.
   */
  private applyLight(
    sky: ReturnType<typeof skyAt>,
    sp: { azimuth: number; elevation: number },
    mp: { azimuth: number; elevation: number },
    ms: number,
  ) {
    const { terrain, env } = this.data!;
    const dir = (az: number, el: number): [number, number, number] =>
      [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
    let ld = [...sky.lightDir] as [number, number, number];
    let col = [...sky.sunColor] as [number, number, number];
    let amb = [...sky.ambient] as [number, number, number];
    shared.uShadow.value = 0;
    if (env.light) {
      const sunDeg = (sp.elevation * 180) / Math.PI;
      const night = clamp((-sunDeg - 4) / 6, 0, 1); // 0 above -4°, 1 below -10°
      const moonUp = mp.elevation > 0.03;
      const phase = moonPhase(ms);
      const illum = (1 - Math.cos(2 * Math.PI * phase)) / 2; // 0 new … 1 full
      if (night > 0) {
        // moonlight strength: bright under a high full moon, starlight only when it's down / new
        const k = moonUp ? 0.35 + 0.85 * illum * clamp(mp.elevation / 0.35, 0.3, 1) : 0.3;
        const ka = moonUp ? 0.8 + 0.25 * illum : 0.75;
        col = col.map((v) => v * (1 + (k - 1) * night)) as typeof col;
        amb = amb.map((v) => v * (1 + (ka - 1) * night)) as typeof amb;
        if (moonUp) {
          const md = dir(mp.azimuth, Math.max(mp.elevation, (18 * Math.PI) / 180));
          ld = ld.map((v, i) => v + (md[i] - v) * night) as typeof ld;
          const l = Math.hypot(...ld);
          ld = ld.map((v) => v / l) as typeof ld;
        }
      }
      // shadows follow the body that's actually lighting the scene; ≥ 1° so dawn light grazes the peaks
      const useMoon = night > 0.5;
      const body = useMoon ? mp : sp;
      if (!useMoon || (moonUp && illum > 0.25)) {
        shared.uShadowDir.value.set(...dir(body.azimuth, Math.max(body.elevation, Math.PI / 180)));
        shared.uShadow.value = useMoon ? 0.7 : sunDeg > -6 ? 1 : 0;
      }
      const sm = terrain.shadowMap;
      shared.uHMap.value = sm.tex;
      shared.uHOrigin.value.copy(sm.origin);
      shared.uHSize.value.copy(sm.size);
      shared.uHMax.value = sm.maxY;
      shared.uHStep.value = sm.step;
    }
    shared.uSunDir.value.set(...ld);
    shared.uSunCol.value.setRGB(...col);
    shared.uAmb.value.setRGB(...amb);
  }

  /** Mist thickness by time of day: thick around sunrise, light by day, medium at night. */
  private mistAt(ms: number) {
    let rise: number | null = null;
    for (const e of this.sunEvents) if (e.kind === 'sunrise' && e.ms <= ms + 2 * 3600_000) rise = e.ms;
    const h = rise != null ? (ms - rise) / 3600_000 : 99; // hours since (or before) sunrise
    const night = this.data ? skyAt(ms, this.data.track.lat0, this.data.track.lon0).lamp : 0;
    // morning mist: thick from ~2 h before sunrise, burning off by ~4 h after; a little at night
    if (h >= -2 && h <= 2) return 0.95;
    if (h > 2 && h < 4) return 0.95 - (h - 2) * 0.45;
    return night > 0.5 ? 0.35 : 0;
  }

  /**
   * How far the terrain rises above the camera→point sight line (world units; > 0 = blocked).
   * Steps every ~1.5 grid cells so a thin ridge between a far checkpoint and the camera isn't skipped.
   */
  private ridgeAbove(x: number, y: number, z: number, lift: number, maxSteps = 160) {
    const c = this.camera.position, t = this.data!.terrain;
    const ty = y + lift;
    const n = Math.min(maxSteps, Math.max(12, Math.ceil(Math.hypot(x - c.x, z - c.z) / (t.spacing * 1.5))));
    let worst = -Infinity;
    for (let s = 1; s < n; s++) {
      const f = s / n;
      worst = Math.max(worst, t.worldY(c.x + (x - c.x) * f, c.z + (z - c.z) * f) - (c.y + (ty - c.y) * f));
    }
    return worst;
  }

  /** Per checkpoint, with a little hysteresis so a flag right on a skyline doesn't flicker. */
  private cpHidden = new Map<string, boolean>();
  private cpBehindRidge(id: string, x: number, y: number, z: number) {
    const s = this.data!.terrain.spacing;
    // sight line to just above the ground (the bottom of the flag pole)
    const h = this.ridgeAbove(x, y, z, s * 0.2);
    const was = this.cpHidden.get(id) ?? false;
    const now = h > s * 0.08 ? true : h < -s * 0.08 ? false : was;
    this.cpHidden.set(id, now);
    return now;
  }

  /** True when a ridge sits between the camera and the point (ray march over the height field). */
  private occluded(x: number, y: number, z: number) {
    return this.ridgeAbove(x, y, z, this.data!.terrain.spacing * 0.15, 64) > 0;
  }

  /**
   * At a viewpoint: the camera eases back, swings round towards the most open direction and lifts
   * its gaze over the hiker, then returns — a couple of seconds to take in the view.
   */
  private lookAround(follow: { pos: THREE.Vector3; target: THREE.Vector3 }, st: TimelineState) {
    const { track, terrain } = this.data!;
    const cp = st.pauseCp!;
    let dir = this.viewDir.get(cp.id + ':' + Math.round(cp.d));
    if (dir == null) {
      dir = openness(track, terrain, cp.d).dir;
      this.viewDir.set(cp.id + ':' + Math.round(cp.d), dir);
    }
    const b = (1 - Math.cos(2 * Math.PI * st.pauseU)) / 2; // 0 → 1 → 0, smooth at both ends
    const r = this.rig!;
    const off = follow.pos.clone().sub(follow.target);
    // current looking direction vs. the view's direction (both as compass angles)
    const look = Math.atan2(-off.x, off.z);
    let delta = dir - look;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    const turn = clamp(delta, -1.3, 1.3) * b;
    const c = Math.cos(turn), sn = Math.sin(turn);
    const ox = off.x * c - off.z * sn, oz = off.x * sn + off.z * c;
    const k = 1 + 0.55 * b;
    const ahead = r.camDist * 0.7 * b;
    const vx = Math.sin(dir), vz = -Math.cos(dir);
    follow.target.set(follow.target.x + vx * ahead, follow.target.y - r.camDist * 0.08 * b, follow.target.z + vz * ahead);
    follow.pos.set(follow.target.x - vx * ahead + ox * k, follow.target.y + off.y * (k - 0.25 * b), follow.target.z - vz * ahead + oz * k);
    const ground = terrain.worldY(follow.pos.x, follow.pos.z) + r.camDist * 0.12;
    if (follow.pos.y < ground) follow.pos.y = ground;
  }

  /** Bridges, traffic, street lights, white water and landmarks visible this frame (screen positions). */
  private mapFrame(st: TimelineState, hx: number, hz: number, night: boolean): MapFrame | null {
    const w = this.water;
    if (!w || st.phase === 'gateStart' || st.phase === 'gateFinish') return null;
    const { env, track } = this.data!;
    const sp = w.scene.sprites;
    const is2d = this.mode === '2d';
    const cam = this.camera.position;
    const R = this.rig!.camDist;
    const W = this.W, H = this.H;
    const vis = (x: number, y: number, z: number, maxQ: number) => {
      const q = is2d ? Math.hypot(x - hx, z - hz) / (R * 3) : Math.hypot(x - cam.x, y - cam.y, z - cam.z) / R;
      if (q > maxQ) return null;
      const p = this.projectF(x, y, z);
      if (!p.visible || p.x < -8 || p.x > W + 8 || p.y < -8 || p.y > H + 8) return null;
      if (!is2d && this.occluded(x, y, z)) return null;
      return { x: Math.round(p.x), y: Math.round(p.y), q: is2d ? 2.4 : q };
    };
    const out: MapFrame = { lamps: [], rapids: [], bridges: [], vehicles: [], falls: [], sideFalls: [], camps: [], springs: [] };

    if (env.water) {
      if (night) {
        const L = sp.lamps;
        for (let i = 0; i < L.length && out.lamps.length < 1500; i += 3) {
          const v = vis(L[i], L[i + 1], L[i + 2], 3);
          if (v) out.lamps.push(v);
        }
      }
      const Rp = sp.rapids;
      for (let i = 0; i < Rp.length; i += 3) {
        const v = vis(Rp[i], Rp[i + 1], Rp[i + 2], 1.3);
        if (v) out.rapids.push(v);
      }
      for (const b of sp.bridges) {
        const v = vis(b.x, b.y, b.z, 2.4);
        if (!v) continue;
        const a = this.projectF(sampleAt(track, track.x, b.d - 20), b.y, sampleAt(track, track.z, b.d - 20));
        const c = this.projectF(sampleAt(track, track.x, b.d + 20), b.y, sampleAt(track, track.z, b.d + 20));
        let tx = c.x - a.x, ty = c.y - a.y;
        const l = Math.hypot(tx, ty);
        if (l < 1e-3) { tx = 1; ty = 0; } else { tx /= l; ty /= l; }
        out.bridges.push({ ...v, tx, ty });
      }
      // a little traffic on the roads nearest the hiker
      const reach = R * (is2d ? 4 : 2.5);
      const near = sp.paths
        .map((p, i) => ({ p, i, gap: Math.hypot(p.cx - hx, p.cz - hz) - p.r }))
        .filter((e) => e.gap < reach)
        .sort((a, b) => a.gap - b.gap)
        .slice(0, 6);
      const COLORS = [C.red, C.sky, C.white, C.yellow, C.greenLight, C.orange];
      for (const { p, i } of near) {
        const n = p.main && p.len > 2000 ? 2 : 1;
        for (let v = 0; v < n; v++) {
          const rnd = rng(i * 7 + v + 1);
          const dirn = rnd() < 0.5 ? 1 : -1;
          const speed = R * (p.main ? 0.09 : 0.055) * (0.8 + rnd() * 0.4);
          const s0 = rnd() * p.len;
          const s = (((s0 + dirn * st.t * speed) % p.len) + p.len) % p.len;
          const at = pathPoint(p, s), ahead = pathPoint(p, clamp(s + dirn * 12, 0, p.len));
          const q = vis(at[0], at[1], at[2], 2.2);
          if (!q) continue;
          const f = this.projectF(ahead[0], ahead[1], ahead[2]);
          out.vehicles.push({ x: q.x, y: q.y, left: f.x < q.x - 0.01, moto: rnd() < 0.4, color: COLORS[Math.floor(rnd() * COLORS.length)] });
        }
      }
    }
    if (env.landmarks) {
      for (const p of sp.pois) {
        if (p.kind === 'waterfall') {
          const v = vis(p.x, p.y, p.z, 3.5);
          if (v) out.falls.push(v);
          if (p.d == null && p.near.off < 2500) {
            const s = this.sideFall(p, vis);
            if (s) out.sideFalls.push(s);
          }
        } else if (p.d != null && (p.kind === 'camp' || p.kind === 'spring')) {
          const v = vis(p.x, p.y, p.z, p.kind === 'camp' ? 2.2 : 1.8);
          if (v) (p.kind === 'camp' ? out.camps : out.springs).push(v);
        }
      }
    }
    return out;
  }

  /**
   * Where to show an off-route waterfall beside the trail: at the route point closest to it, pushed
   * sideways (on screen) to the side it really lies on, with an arrow sign at the trail edge.
   */
  private sideFall(
    p: { x: number; z: number; near: { d: number } },
    vis: (x: number, y: number, z: number, maxQ: number) => { x: number; y: number; q: number } | null,
  ): MapFrame['sideFalls'][number] | null {
    const { track, terrain } = this.data!;
    const d = p.near.d;
    const ax = sampleAt(track, track.x, d), az = sampleAt(track, track.z, d), ay = terrain.worldY(ax, az);
    const v = vis(ax, ay, az, 3);
    if (!v) return null;
    // which side of the trail (in the world) the waterfall is on…
    const hx = sampleAt(track, track.hdx, d), hz = sampleAt(track, track.hdz, d);
    const side = Math.sign(hx * (p.z - az) - hz * (p.x - ax)) || 1;
    // …and which way that is on screen
    const nx = -hz * side, nz = hx * side;
    const off = this.rig!.camDist * 0.05;
    const q = this.projectF(ax + nx * off, terrain.worldY(ax + nx * off, az + nz * off), az + nz * off);
    let sx = q.x - v.x, sy = q.y - v.y;
    const l = Math.hypot(sx, sy);
    if (l < 1e-3) { sx = 1; sy = 0; } else { sx /= l; sy /= l; }
    const px = clamp(22 / Math.max(0.75, v.q), 18, 26); // clear of the hiker sprite
    return {
      x: Math.round(v.x + sx * px), y: Math.round(v.y + sy * px * 0.6), q: v.q,
      sx: Math.round(v.x + sx * 6), sy: Math.round(v.y + sy * 4), left: sx < 0,
    };
  }

  /**
   * Props along the trail for this frame: ferns / moss / boulders by elevation zone, roots and rock
   * steps on steep ground, fixed ropes beside technical stretches and a warning sign where one starts.
   * Placed at fixed track distances (so they don't swim) and offset sideways in screen pixels so they
   * stay readable at any zoom.
   */
  private decorFrame(st: TimelineState, hero: ScreenPoint): DecorFrame | null {
    const zones = this.data!.zones;
    if (!zones || !zones.settings.on) return null;
    if (st.phase !== 'move' && st.phase !== 'pause') return null;
    const { track, terrain } = this.data!;
    const r = this.rig!;
    const is2d = this.mode === '2d';
    const L = track.stats.distance;
    const sp = r.camDist * 0.03;
    const back = is2d ? 3.2 : 1.1, fwd = is2d ? 3.2 : 2.8; // the top-down view shows more trail behind
    const d0 = Math.max(0, st.d - r.camDist * back), d1 = Math.min(L, st.d + r.camDist * fwd);
    const cam = this.camera.position;
    const W = this.W, H = this.H;

    const world = (d: number) => {
      const x = sampleAt(track, track.x, d), z = sampleAt(track, track.z, d);
      return { x, y: terrain.worldY(x, z), z };
    };
    /** Screen position, unit tangent (direction of travel) and distance factor at track distance d. */
    const frame = (d: number) => {
      const w = world(d);
      const p = this.projectF(w.x, w.y, w.z);
      if (!p.visible || p.x < -12 || p.x > W + 12 || p.y < -12 || p.y > H + 12) return null;
      if (!is2d && this.occluded(w.x, w.y, w.z)) return null;
      const w2 = world(Math.min(L, d + sp * 0.4));
      const p2 = this.projectF(w2.x, w2.y, w2.z);
      let tx = p2.x - p.x, ty = p2.y - p.y;
      const len = Math.hypot(tx, ty);
      if (len < 1e-3) { tx = 1; ty = 0; } else { tx /= len; ty /= len; }
      const q = is2d ? 1 : Math.hypot(w.x - cam.x, w.y - cam.y, w.z - cam.z) / r.camDist;
      return { x: p.x, y: p.y, tx, ty, q };
    };

    const items: DecorItem[] = [];
    for (let k = Math.ceil(d0 / sp); k * sp <= d1; k++) {
      const rnd = rng(k + 1);
      const dk = k * sp;
      const style = zones.styleAt(dk);
      const tech = zones.techAt(dk);
      const count = Math.floor(decorDensity(style) + rnd()) + (tech ? 1 : 0);
      for (let j = 0; j < count; j++) {
        const onTrail = tech && j === count - 1;
        const dd = clamp(dk + (rnd() - 0.5) * sp, 0, L);
        const side = rnd() < 0.5 ? -1 : 1, off = rnd(), pick = rnd();
        // keep the patch right around the walker clear so the sprite stays readable
        if (Math.abs(dd - st.d) < sp * 0.6) continue;
        const f = frame(dd);
        if (!f || f.q > 3.2) continue;
        const far = f.q > 1.8;
        const rows = onTrail ? techSprite(pick) : decorSprite(style, pick, far);
        if (!rows) continue;
        const o = onTrail ? (off - 0.5) * 2 : (5 + off * 12) / Math.max(0.75, f.q);
        items.push({
          x: Math.round(f.x - f.ty * side * o),
          y: Math.round(f.y + f.tx * side * o),
          rows,
          lit: Math.hypot(f.x - hero.x, f.y - hero.y) < 30,
        });
      }
    }

    // fixed ropes + warning signs
    const ropes: DecorFrame['ropes'] = [];
    const signs: DecorItem[] = [];
    for (const run of zones.tech) {
      if (run.d1 < d0 || run.d0 > d1) continue;
      let line: { x: number; y: number }[] = [];
      const a = Math.max(run.d0, d0), b = Math.min(run.d1, d1);
      for (let d = a; d <= b + 1e-6; d += sp * 0.5) {
        const f = frame(d);
        if (!f) { if (line.length > 1) ropes.push(line); line = []; continue; }
        const o = 6 / Math.max(0.75, f.q);
        line.push({ x: Math.round(f.x + f.ty * o), y: Math.round(f.y - f.tx * o) });
      }
      if (line.length > 1) ropes.push(line);
      if (run.d1 - run.d0 >= 150 && run.d0 >= d0) {
        const f = frame(run.d0);
        if (f && f.q < 2.4) {
          const o = 10 / Math.max(0.75, f.q);
          signs.push({ x: Math.round(f.x - f.ty * o), y: Math.round(f.y + f.tx * o), rows: [], lit: Math.hypot(f.x - hero.x, f.y - hero.y) < 30 });
        }
      }
    }
    items.sort((p, q) => p.y - q.y);
    return { items, ropes, signs };
  }
}

/** World x/y/z at arc length s along a road path. */
function pathPoint(p: { pts: Float32Array; cum: Float32Array }, s: number): [number, number, number] {
  const c = p.cum;
  let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (c[m] <= s) lo = m; else hi = m;
  }
  const f = c[hi] > c[lo] ? (s - c[lo]) / (c[hi] - c[lo]) : 0;
  const a = lo * 3, b = hi * 3, P = p.pts;
  return [P[a] + (P[b] - P[a]) * f, P[a + 1] + (P[b + 1] - P[a + 1]) * f, P[a + 2] + (P[b + 2] - P[a + 2]) * f];
}

function ease(x: number) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function maxFilter(a: Float64Array, r: number) {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let m = -Infinity;
    for (let j = Math.max(0, i - r); j <= Math.min(a.length - 1, i + r); j++) m = Math.max(m, a[j]);
    out[i] = m;
  }
  return out;
}
