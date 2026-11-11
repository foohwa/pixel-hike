import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { SpriteSet } from './characters';
import { clockText, drawOverlay, type DialState, type ScreenPoint } from './overlay';
import { C, PALETTE, rgb01 } from './palette';
import { moonPhase, moonPosition, skyAt, sunEvents, sunPosition, type SunEvent } from './sky';
import { shared, type Terrain } from './terrain';
import type { Timeline } from './timeline';
import { clamp, gaussian, sampleAt, type Activity, type Checkpoint, type Track } from './track';

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
  private trail: { group: THREE.Group; done: Line2; ghost: Line2; step: number; mats: LineMaterial[] } | null = null;

  mode: ViewMode = '3d';
  aspect: Aspect = 'landscape';
  showMinimap = true;
  W = 320;
  H = 180;
  private facingLeft = false;
  private sunEvents: SunEvent[] = [];
  private toasts: { text: string; t: number }[] = [];

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
      },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene; uniform sampler2D tOverlay;
        uniform vec3 uPal[${PALETTE.length}];
        uniform vec3 uSkyTop; uniform vec3 uSkyBot; uniform float uStars; uniform float uTime;
        uniform vec2 uRes; uniform float uDither;
        uniform vec3 uSun; uniform vec3 uMoon; uniform float uMoonPhase;
        varying vec2 vUv;
        float bayer2(vec2 a){ a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
        float bayer4(vec2 a){ return bayer2(0.5 * a) * 0.25 + bayer2(a); }
        float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
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
    this.toasts = [];
    for (const ev of this.sunEvents) {
      const t = data.timeline.videoTimeAtClock(ev.ms);
      if (t == null || t < data.timeline.intro) continue;
      this.toasts.push({ text: `${ev.kind === 'sunrise' ? 'SUNRISE' : 'SUNSET'} ${clockText(ev.ms, data.tzOffsetMin)}`, t });
    }
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
    const ghost = new Line2(geo(), mk(C.wine, 1, false));
    ghost.renderOrder = 10;
    const done = new Line2(geo(), mk(C.coral, 2, true));
    done.renderOrder = 11;
    const group = new THREE.Group();
    group.add(ahead, ghost, done);
    [ahead, ghost, done].forEach((l) => (l.frustumCulled = false));
    this.scene.add(group);
    this.trail = { group, done, ghost, step, mats: [ahead.material, ghost.material, done.material] };
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
    let u = 1;
    let over = this.overviewPos('start', 0);
    if (st.phase === 'intro') {
      u = ease(clamp((st.t - 0.9) / (timeline.intro - 0.9), 0, 1));
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
    shared.uSunDir.value.set(...sky.lightDir);
    shared.uSunCol.value.setRGB(...sky.sunColor);
    shared.uAmb.value.setRGB(...sky.ambient);
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

    // ---- trail progress
    const tr = this.trail!;
    const segs = Math.max(0, Math.floor(st.d / tr.step));
    (tr.done.geometry as LineGeometry).instanceCount = segs;
    (tr.ghost.geometry as LineGeometry).instanceCount = segs;
    tr.ghost.visible = !is2d;

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
      cpScreen.set(cp.id, this.project(x, terrain.worldY(x, z), z));
    }

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
    });
    this.overlayTex.needsUpdate = true;

    // ---- post (quantise + sky + overlay) to the canvas
    const pu = this.post.mat.uniforms;
    pu.uSkyTop.value.set(...sky.top);
    pu.uSkyBot.value.set(...sky.bottom);
    pu.uStars.value = sky.stars;
    pu.uTime.value = st.t;
    const sp = sunPosition(ms, track.lat0, track.lon0);
    const mp = moonPosition(ms, track.lat0, track.lon0);
    this.skyPoint(sp.azimuth, sp.elevation, pu.uSun.value);
    this.skyPoint(mp.azimuth, mp.elevation, pu.uMoon.value);
    if (pu.uSun.value.z > 0.5) pu.uMoon.value.z = 0; // keep it simple: one disc at a time
    pu.uMoonPhase.value = moonPhase(ms);
    this.gl.setRenderTarget(null);
    this.gl.clear();
    this.gl.render(this.post.scene, this.post.cam);
  }

  private project(x: number, y: number, z: number): ScreenPoint {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return {
      x: Math.round(((v.x + 1) / 2) * this.W),
      y: Math.round(((1 - v.y) / 2) * this.H),
      visible: v.z < 1 && v.z > -1,
    };
  }
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
