import * as THREE from 'three';
import type { Dem } from './dem';
import { C, rgb01 } from './palette';
import { clamp, toLatLon, type Track } from './track';

export const EXAG = 1.5; // vertical exaggeration — mountains look cuter a bit taller

/** Look of the land: rainforest canopy + mossy summits, pines up to a real treeline + rock/snow, or the original. */
export type Scenery = 'tropical' | 'alpine' | 'classic';
export type SceneryChoice = 'auto' | Scenery;

export function resolveScenery(choice: SceneryChoice, track: Track): Scenery {
  if (choice !== 'auto') return choice;
  return Math.abs(track.lat0) < 23.5 ? 'tropical' : 'alpine';
}

/** Rough natural treeline (m) by latitude: ~3,600 m near the tropics, ~1,800 m in the Alps, sea level in the Arctic. */
export function treeline(lat: number) {
  return clamp(3600 - (Math.abs(lat) - 25) * 90, 0, 3800);
}

/** Tropical upper-montane (mossy cloud forest) starts around here. */
export const MOSSY_FROM_M = 1500;

/** Uniforms shared by every lit material (updated once per frame). */
export const shared = {
  uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
  uSunCol: { value: new THREE.Color(1, 1, 1) },
  uAmb: { value: new THREE.Color(0.5, 0.5, 0.5) },
  uFogCol: { value: new THREE.Color(0.8, 0.9, 1) },
  uFogNear: { value: 1e9 },
  uFogFar: { value: 2e9 },
  uLampPos: { value: new THREE.Vector3() },
  uLamp: { value: 0 },
  uLampR: { value: 300 },
  /** Head-lamp beam direction on the ground (unit xz); uBeam 0 = round pool, 1 = beam pointing ahead. */
  uLampDir: { value: new THREE.Vector2(1, 0) },
  uBeam: { value: 0 },
  /** Video time (s) for drifting clouds/mist. */
  uTime: { value: 0 },
  /** Cloud-shadow strength 0..1 (day only) and their size in metres. */
  uCloud: { value: 0 },
  uCloudScale: { value: 1500 },
  uWind: { value: new THREE.Vector2(40, 12) },
  /** Height map (world Y) for cast shadows: ridges block the sun / moon. */
  uHMap: { value: null as THREE.Texture | null },
  uHOrigin: { value: new THREE.Vector2() },
  uHSize: { value: new THREE.Vector2(1, 1) },
  uHMax: { value: 0 },
  uHStep: { value: 10 },
  /** Real direction of the light that casts shadows (sun, or moon at night); uShadow 0 = off. */
  uShadowDir: { value: new THREE.Vector3(0, 1, 0) },
  uShadow: { value: 0 },
};

export const LIGHT_GLSL = /* glsl */ `
uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uAmb;
uniform vec3 uFogCol; uniform float uFogNear; uniform float uFogFar;
uniform vec3 uLampPos; uniform float uLamp; uniform float uLampR;
uniform vec2 uLampDir; uniform float uBeam;
uniform float uTime; uniform float uCloud; uniform float uCloudScale; uniform vec2 uWind;
uniform sampler2D uHMap; uniform vec2 uHOrigin; uniform vec2 uHSize; uniform float uHMax; uniform float uHStep;
uniform vec3 uShadowDir; uniform float uShadow;
/** 0 when terrain between this point and the light blocks it. */
float lightVisible(vec3 w) {
  if (uShadow <= 0.0) return 1.0;
  vec3 p = w + vec3(0.0, uHStep * 0.25, 0.0);
  for (int i = 1; i <= 30; i++) {
    float fi = float(i);
    vec3 q = p + uShadowDir * (fi + fi * fi * 0.3) * uHStep;
    if (q.y > uHMax) return 1.0;
    vec2 uv = (q.xz - uHOrigin) / uHSize;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
    if (texture2D(uHMap, uv).r > q.y) return 0.0;
  }
  return 1.0;
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
  float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
  float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) { return vnoise(p) * 0.6 + vnoise(p * 2.03 + 7.1) * 0.3 + vnoise(p * 4.1 + 3.3) * 0.1; }
vec3 shade(vec3 base, vec3 n, vec3 w) {
  float d = max(dot(n, uSunDir), 0.0);
  d = floor(d * 4.0 + 0.5) / 4.0;                 // toon steps
  // cast shadows from ridges (long and dramatic when the sun is low)
  if (d > 0.0 && uShadow > 0.0) d *= 1.0 - uShadow * (1.0 - lightVisible(w));
  // drifting cloud shadows (hard-edged so they stay pixel-crisp)
  if (uCloud > 0.0) {
    float cs = fbm((w.xz - uWind * uTime) / uCloudScale);
    if (cs > 0.6) d *= 1.0 - 0.6 * uCloud;
  }
  vec3 col = base * min(uAmb + uSunCol * d, vec3(1.08));
  // headlamp: a warm pool of light at night — round, or stretched ahead of the hiker like a beam
  vec2 lv = w.xz - uLampPos.xz;
  float al = dot(lv, uLampDir), ac = dot(lv, vec2(-uLampDir.y, uLampDir.x));
  float beamR = length(vec2(al > 0.0 ? al * 0.5 : al * 1.8, ac * 1.25));
  float g = uLamp * (1.0 - smoothstep(uLampR * 0.35, uLampR, mix(length(lv), beamR, uBeam)));
  g = floor(g * 2.0 + 0.5) / 2.0;
  col = mix(col, base * 0.85 + vec3(0.22, 0.17, 0.05), g * 0.55);
  float f = smoothstep(uFogNear, uFogFar, distance(w, cameraPosition));
  return mix(col, uFogCol, f);
}
vec3 flatNormal(vec3 w) { return normalize(cross(dFdx(w), dFdy(w))); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;

const v3 = (hex: string) => new THREE.Vector3(...rgb01(hex));

export interface Terrain {
  group: THREE.Group;
  scenery: Scenery;
  /** Mist layer controls: uMist strength 0..1, uMistClear = radius kept clear around the hiker. */
  mist: { uMist: { value: number }; uMistClear: { value: number } };
  /** Instanced tree meshes (so rivers can clear their banks). */
  trees: THREE.InstancedMesh[];
  /** Local x/z extent of the diorama. */
  bounds: { x0: number; z0: number; x1: number; z1: number };
  shadowMap: { tex: THREE.Texture; origin: THREE.Vector2; size: THREE.Vector2; maxY: number; step: number };
  /** Surface height in metres (not exaggerated) at local x/z. */
  heightAt(x: number, z: number): number;
  /** World Y (exaggerated) at local x/z. */
  worldY(x: number, z: number): number;
  center: THREE.Vector3;
  size: number; // longest horizontal side, metres
  spacing: number;
  minH: number;
  maxH: number;
  dispose(): void;
}

/** Area covered by the diorama, in local metres. */
export function terrainExtent(track: Track) {
  const b = track.bounds;
  const w0 = b.maxX - b.minX, d0 = b.maxZ - b.minZ;
  const margin = Math.max(1200, Math.max(w0, d0) * 0.22);
  // make it a bit squarer so the diorama looks good from any angle
  const side = Math.max(w0, d0) + margin * 2;
  const W = Math.max(w0 + margin * 2, side * 0.7);
  const D = Math.max(d0 + margin * 2, side * 0.7);
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  return { cx, cz, W, D, x0: cx - W / 2, z0: cz - D / 2 };
}

export function buildTerrain(track: Track, dem: Dem | null, scenery: Scenery = 'classic'): Terrain {
  const { cx, cz, W, D, x0, z0 } = terrainExtent(track);
  const spacing = Math.max(W, D) / 200;
  const nx = Math.ceil(W / spacing) + 1, nz = Math.ceil(D / spacing) + 1;

  // --- height grid ---
  const H = new Float32Array(nx * nz);
  const fallback = makeFallbackHeight(track);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * spacing, z = z0 + j * spacing;
      let h = NaN;
      if (dem) {
        const { lat, lon } = toLatLon(track, x, z);
        h = dem.sample(lat, lon);
      }
      H[j * nx + i] = Number.isFinite(h) ? h : fallback(x, z);
    }
  }
  let minH = Infinity, maxH = -Infinity;
  for (const h of H) { minH = Math.min(minH, h); maxH = Math.max(maxH, h); }
  if (maxH - minH < 50) maxH = minH + 50;

  const heightAt = (x: number, z: number) => {
    const fx = clamp((x - x0) / spacing, 0, nx - 1.0001);
    const fz = clamp((z - z0) / spacing, 0, nz - 1.0001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const h00 = H[j * nx + i], h10 = H[j * nx + i + 1], h01 = H[(j + 1) * nx + i], h11 = H[(j + 1) * nx + i + 1];
    // must match the mesh triangulation below (diagonal from (1,0) to (0,1))
    return u + v <= 1 ? h00 + u * (h10 - h00) + v * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
  };
  const worldY = (x: number, z: number) => heightAt(x, z) * EXAG;

  const group = new THREE.Group();

  // --- height map for cast shadows (half-float so it filters smoothly) ---
  const hData = new Uint16Array(nx * nz);
  for (let k = 0; k < hData.length; k++) hData[k] = THREE.DataUtils.toHalfFloat(H[k] * EXAG);
  const hmap = new THREE.DataTexture(hData, nx, nz, THREE.RedFormat, THREE.HalfFloatType);
  hmap.minFilter = hmap.magFilter = THREE.LinearFilter;
  hmap.wrapS = hmap.wrapT = THREE.ClampToEdgeWrapping;
  hmap.needsUpdate = true;
  const shadowMap = {
    tex: hmap as THREE.Texture,
    // texel centres: uv 0..1 spans x0 - s/2 .. x0 + (nx - 1) s + s/2
    origin: new THREE.Vector2(x0 - spacing / 2, z0 - spacing / 2),
    size: new THREE.Vector2(nx * spacing, nz * spacing),
    maxY: maxH * EXAG,
    step: spacing * 0.6,
  };

  // --- terrain mesh ---
  const pos = new Float32Array(nx * nz * 3);
  const aH = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      pos[k * 3] = x0 + i * spacing;
      pos[k * 3 + 1] = H[k] * EXAG;
      pos[k * 3 + 2] = z0 + j * spacing;
      aH[k] = H[k];
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b2 = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, b2, c, d, b2);
    }
  }
  // how far each point sits below its surroundings (valleys < 0): where morning mist pools
  const blur = boxBlur(H, nx, nz, 6);
  const aV = new Float32Array(nx * nz);
  for (let k = 0; k < aV.length; k++) aV[k] = H[k] - blur[k];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aH', new THREE.BufferAttribute(aH, 1));
  geo.setAttribute('aV', new THREE.BufferAttribute(aV, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const range = maxH - minH;
  const mist = {
    uMist: { value: 0 },
    uMistClear: { value: 1000 },
    uMistCol: { value: new THREE.Vector3(0.93, 0.95, 0.98) },
    uMistScale: { value: spacing * 7 },
    uMistDepth: { value: clamp(range * 0.05, 25, 120) },
  };
  const contour = niceStep(range / 10);
  const terrainMat = new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uMinH: { value: minH },
      uMaxH: { value: maxH },
      uContour: { value: contour },
      uJitter: { value: spacing * 0.8 },
      // rainforest floor is darker so the canopy stands out
      cLow: { value: v3(scenery === 'tropical' ? C.green : C.lime) },
      c1: { value: v3(scenery === 'tropical' ? C.forest : C.greenLight) },
      c2: { value: v3(scenery === 'tropical' ? C.forest : C.green) },
      c3: { value: v3(scenery === 'tropical' ? C.forestDeep : C.forest) },
      c4: { value: v3(C.forestDeep) },
      c5: { value: v3(C.moss) },
      cRock: { value: v3(C.rock) },
      cDirt: { value: v3(C.tan) },
      ...zoneUniforms(scenery, track),
      ...mist,
    },
    vertexShader: /* glsl */ `
      attribute float aH; attribute float aV; varying float vH; varying float vV; varying vec3 vW; varying vec3 vN;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vH = aH; vV = aV; vN = normal; gl_Position = projectionMatrix * viewMatrix * w; }
    `,
    fragmentShader: /* glsl */ `
      ${LIGHT_GLSL}
      uniform float uMinH, uMaxH, uContour, uJitter;
      uniform vec3 cLow, c1, c2, c3, c4, c5, cRock, cDirt;
      uniform float uZ1, uZ2, uZ3; uniform vec3 cZ1, cZ2, cZ3;
      uniform float uMist, uMistClear, uMistScale, uMistDepth; uniform vec3 uMistCol;
      varying float vH; varying float vV; varying vec3 vW; varying vec3 vN;
      float bayer2(vec2 a){ a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
      float bayer4(vec2 a){ return bayer2(0.5 * a) * 0.25 + bayer2(a); }
      void main() {
        vec3 n = normalize(vN);
        float h = (vH - uMinH) / (uMaxH - uMinH);
        h += (hash(floor(vW.xz / uJitter)) - 0.5) * 0.05;
        vec3 base = h < 0.04 ? cLow : h < 0.16 ? c1 : h < 0.38 ? c2 : h < 0.62 ? c3 : h < 0.86 ? c4 : c5;
        // real-height zones (mossy forest, alpine meadow, bare rock, snow) with a ragged edge
        float ha = vH + (hash(floor(vW.xz / uJitter) + 3.7) - 0.5) * 60.0;
        if (ha >= uZ1) base = cZ1;
        if (ha >= uZ2) base = cZ2;
        if (ha >= uZ3) base = cZ3;
        bool snow = ha >= uZ3 && uZ3 < 1e8 && cZ3.r > 0.9;
        if (n.y < 0.5 && !snow) base = mix(base, cDirt, 0.35);
        if (n.y < 0.36 && !snow) base = cRock;
        // contour lines
        float c = vH / uContour;
        float fw = fwidth(c);
        float dist = abs(fract(c + 0.5) - 0.5) / max(fw, 1e-4);
        if (fw < 0.45 && dist < 0.75) base *= 0.78;
        vec3 col = shade(base, n, vW);
        // mist pooled in the valleys, drifting; trees poke through it; cleared around the hiker
        if (uMist > 0.0) {
          float v = smoothstep(-uMistDepth * 0.15, -uMistDepth, vV);
          float nz = fbm((vW.xz - uWind * uTime * 0.5) / uMistScale);
          // thinner mist = smaller patches (not sparser dots, which read as noise)
          float thr = mix(0.85, 0.28, uMist);
          float a = v * smoothstep(thr, thr + 0.12, nz);
          a *= smoothstep(uMistClear * 0.45, uMistClear, distance(vW.xz, uLampPos.xz));
          if (a > bayer4(gl_FragCoord.xy) * 0.999 + 0.0005) {
            vec3 m = mix(uMistCol, uFogCol, 0.15) * (0.6 + 0.4 * min(uAmb + uSunCol * 0.7, vec3(1.0)));
            float f = smoothstep(uFogNear, uFogFar, distance(vW, cameraPosition));
            col = mix(m, uFogCol, f);
          }
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  terrainMat.side = THREE.DoubleSide;
  const terrainMesh = new THREE.Mesh(geo, terrainMat);
  group.add(terrainMesh);

  // --- diorama skirt (soil layers around the edge) ---
  const baseY = (minH - range * 0.12 - 150) * EXAG;
  const skirt = buildSkirt(nx, nz, x0, z0, spacing, H, baseY);
  group.add(skirt);

  // --- trees ---
  const trees = scenery === 'tropical'
    ? buildRainforest(nx, nz, x0, z0, spacing, minH, maxH, heightAt)
    : buildTrees(nx, nz, x0, z0, spacing, minH, maxH, heightAt, scenery === 'alpine' ? treeline(track.lat0) : Infinity);
  for (const t of trees) group.add(t);



  const center = new THREE.Vector3(cx, ((minH + maxH) / 2) * EXAG, cz);
  return {
    group,
    scenery,
    mist,
    trees: trees as THREE.InstancedMesh[],
    bounds: { x0, z0, x1: x0 + (nx - 1) * spacing, z1: z0 + (nz - 1) * spacing },
    shadowMap,
    heightAt,
    worldY,
    center,
    size: Math.max(W, D),
    spacing,
    minH,
    maxH,
    dispose() {
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose?.();
      });
      hmap.dispose();
    },
  };
}

/** Flat-shaded, sun/moon/fog-lit material in one palette colour (lakes etc.). */
export function litMaterial(hex: string) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uCol: { value: v3(hex) } },
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
    `,
    fragmentShader: /* glsl */ `
      ${LIGHT_GLSL}
      uniform vec3 uCol;
      varying vec3 vW;
      void main() { gl_FragColor = vec4(shade(uCol, vec3(0.0, 1.0, 0.0), vW), 1.0); }
    `,
  });
}

function objectMaterial(vertexColors: boolean) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared },
    vertexColors,
    vertexShader: /* glsl */ `
      varying vec3 vW; varying vec3 vC;
      void main() {
        vec4 p = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
        #endif
        vec4 w = modelMatrix * p;
        vW = w.xyz;
        #if defined(USE_INSTANCING_COLOR)
          vC = instanceColor;
        #elif defined(USE_COLOR)
          vC = color;
        #else
          vC = vec3(1.0);
        #endif
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      ${LIGHT_GLSL}
      varying vec3 vW; varying vec3 vC;
      void main() { gl_FragColor = vec4(shade(vC, flatNormal(vW), vW), 1.0); }
    `,
  });
}

function buildSkirt(nx: number, nz: number, x0: number, z0: number, s: number, H: Float32Array, baseY: number) {
  const ring: [number, number][] = [];
  for (let i = 0; i < nx; i++) ring.push([i, 0]);
  for (let j = 1; j < nz; j++) ring.push([nx - 1, j]);
  for (let i = nx - 2; i >= 0; i--) ring.push([i, nz - 1]);
  for (let j = nz - 2; j >= 0; j--) ring.push([0, j]);

  const pos: number[] = [], col: number[] = [];
  const soil = [rgb01(C.brown), rgb01(C.brownDark), rgb01(C.tan), rgb01(C.brownDark)];
  for (let k = 0; k < ring.length; k++) {
    const [i0, j0] = ring[k], [i1, j1] = ring[(k + 1) % ring.length];
    const ax = x0 + i0 * s, az = z0 + j0 * s, bx = x0 + i1 * s, bz = z0 + j1 * s;
    const ay = H[j0 * nx + i0] * EXAG, by = H[j1 * nx + i1] * EXAG;
    // stack of horizontal soil bands
    const bands = 4;
    for (let q = 0; q < bands; q++) {
      const f0 = q / bands, f1 = (q + 1) / bands;
      const a0 = ay + (baseY - ay) * f0, a1 = ay + (baseY - ay) * f1;
      const b0 = by + (baseY - by) * f0, b1 = by + (baseY - by) * f1;
      pos.push(ax, a0, az, bx, b0, bz, ax, a1, az, bx, b0, bz, bx, b1, bz, ax, a1, az);
      for (let v = 0; v < 6; v++) col.push(...soil[q]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const m = objectMaterial(true);
  m.side = THREE.DoubleSide;
  return new THREE.Mesh(g, m);
}

function buildTrees(
  nx: number, nz: number, x0: number, z0: number, s: number,
  minH: number, maxH: number, heightAt: (x: number, z: number) => number, line = Infinity,
): THREE.Object3D[] {
  const treeH = s * 0.55;
  const cone = new THREE.ConeGeometry(treeH * 0.36, treeH, 5, 1);
  cone.translate(0, treeH / 2, 0);
  const rand = mulberry32(1234);
  const W = (nx - 1) * s, D = (nz - 1) * s;
  const target = Math.min(14000, Math.round((nx * nz) / 3));
  const mesh = new THREE.InstancedMesh(cone, objectMaterial(false), target);
  const greens = [C.forestDeep, C.forest, C.green, C.moss, C.forestDeep].map((h) => new THREE.Color(...rgb01(h)));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();
  let count = 0;
  for (let tries = 0; tries < target * 4 && count < target; tries++) {
    const x = x0 + rand() * W, z = z0 + rand() * D;
    const h = heightAt(x, z);
    const hn = (h - minH) / (maxH - minH);
    const slope = Math.abs(heightAt(x + s, z) - heightAt(x - s, z)) + Math.abs(heightAt(x, z + s) - heightAt(x, z - s));
    if (slope / (2 * s) > 0.9) continue;
    let density = hn < 0.04 ? 0.15 : hn > 0.93 ? 0.1 : 0.75;
    let shrink = 1;
    if (Number.isFinite(line)) {
      // thin out and shrink towards the treeline, none above it
      const below = line - h;
      if (below <= 0) continue;
      density = below > 300 ? 0.75 : 0.75 * (below / 300) + 0.05;
      shrink = below > 300 ? 1 : 0.55 + 0.45 * (below / 300);
    }
    if (rand() > density) continue;
    const k = Math.floor(rand() * 1e9) % 7;
    const size = (0.7 + rand() * 0.6) * shrink;
    p.set(x, h * EXAG - treeH * 0.05, z);
    sc.set(size, size * (0.9 + rand() * 0.5), size);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI);
    m.compose(p, q, sc);
    mesh.setMatrixAt(count, m);
    mesh.setColorAt(count, greens[k % greens.length]);
    count++;
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  return [mesh];
}

/**
 * Tropical rainforest: a dense, lumpy canopy of round crowns, a few tall emergent trees on bare
 * trunks, and small moss-green, stunted trees above ~1,500 m (upper montane "mossy forest").
 */
function buildRainforest(
  nx: number, nz: number, x0: number, z0: number, s: number,
  minH: number, maxH: number, heightAt: (x: number, z: number) => number,
): THREE.Object3D[] {
  const treeH = s * 0.55;
  const crown = new THREE.IcosahedronGeometry(treeH * 0.58, 0);
  crown.scale(1, 0.7, 1);
  crown.translate(0, treeH * 0.42, 0);
  const trunk = new THREE.CylinderGeometry(treeH * 0.05, treeH * 0.07, treeH * 1.3, 4, 1);
  trunk.translate(0, treeH * 0.65, 0);
  const rand = mulberry32(4321);
  const W = (nx - 1) * s, D = (nz - 1) * s;
  const target = Math.min(42000, Math.round(nx * nz * 1.1));
  const crowns = new THREE.InstancedMesh(crown, objectMaterial(false), target);
  const trunks = new THREE.InstancedMesh(trunk, objectMaterial(false), Math.ceil(target * 0.08));
  const col = (hex: string) => new THREE.Color(...rgb01(hex));
  const jungle = [C.green, C.forest, C.green, C.greenLight, C.forest, C.green, C.forestDeep].map(col);
  const sunlit = [C.greenLight, C.green].map(col);
  const mossy = [C.sage, C.moss, C.greenLight, C.moss, C.lime].map(col);
  const bark = col(C.brownDark);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let count = 0, nTrunk = 0;
  for (let tries = 0; tries < target * 4 && count < target; tries++) {
    const x = x0 + rand() * W, z = z0 + rand() * D;
    const h = heightAt(x, z);
    const hn = (h - minH) / (maxH - minH);
    const slope = Math.abs(heightAt(x + s, z) - heightAt(x - s, z)) + Math.abs(heightAt(x, z + s) - heightAt(x, z - s));
    if (slope / (2 * s) > 1.1) continue;
    const moss = h >= MOSSY_FROM_M;
    const density = hn < 0.02 ? 0.3 : moss ? 0.98 : 0.92;
    if (rand() > density) continue;
    const r = rand();
    const emergent = !moss && r < 0.07 && nTrunk < trunks.count;
    const size = moss ? 0.5 + rand() * 0.3 : emergent ? 1.3 + rand() * 0.4 : 0.75 + rand() * 0.55;
    q.setFromAxisAngle(up, rand() * Math.PI);
    if (emergent) {
      // tall dipterocarp: bare trunk with a wide, flat crown above the canopy
      p.set(x, h * EXAG - treeH * 0.05, z);
      sc.set(1, 1, 1);
      m.compose(p, q, sc);
      trunks.setMatrixAt(nTrunk, m);
      trunks.setColorAt(nTrunk, bark);
      nTrunk++;
      p.set(x, h * EXAG + treeH * 0.95, z);
      sc.set(size * 1.25, size * 0.6, size * 1.25);
    } else {
      p.set(x, h * EXAG - treeH * 0.12 * size, z);
      sc.set(size, size * (0.8 + rand() * 0.4), size);
    }
    m.compose(p, q, sc);
    crowns.setMatrixAt(count, m);
    const pal = moss ? mossy : emergent || rand() < 0.12 ? sunlit : jungle;
    crowns.setColorAt(count, pal[Math.floor(rand() * pal.length)]);
    count++;
  }
  crowns.count = count;
  trunks.count = nTrunk;
  for (const mesh of [crowns, trunks]) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
  }
  return [crowns, trunks];
}

/** Colours for real-height zones, applied over the relative height bands. */
function zoneUniforms(scenery: Scenery, track: Track) {
  const off = 1e9;
  const u = (z1: number, c1: string, z2 = off, c2: string = C.white, z3 = off, c3: string = C.white) => ({
    uZ1: { value: z1 }, uZ2: { value: z2 }, uZ3: { value: z3 },
    cZ1: { value: v3(c1) }, cZ2: { value: v3(c2) }, cZ3: { value: v3(c3) },
  });
  if (scenery === 'tropical') return u(MOSSY_FROM_M, C.moss);
  if (scenery === 'alpine') {
    const tl = treeline(track.lat0);
    return u(tl, C.greenLight, tl + 350, C.rock, tl + 1100, C.white);
  }
  return u(off, C.white);
}

/** Separable box blur of a height grid (radius r cells). */
function boxBlur(H: Float32Array, nx: number, nz: number, r: number) {
  const tmp = new Float32Array(H.length), out = new Float32Array(H.length);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, i - r); k <= Math.min(nx - 1, i + r); k++) { s += H[j * nx + k]; c++; }
      tmp[j * nx + i] = s / c;
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, j - r); k <= Math.min(nz - 1, j + r); k++) { s += tmp[k * nx + i]; c++; }
      out[j * nx + i] = s / c;
    }
  }
  return out;
}

/** Without elevation tiles: ridge made of cones under the track so the hike still has a mountain. */
function makeFallbackHeight(track: Track) {
  const pts: [number, number, number][] = [];
  const stride = Math.max(1, Math.floor(track.n / 400));
  for (let i = 0; i < track.n; i += stride) pts.push([track.x[i], track.z[i], track.ele[i]]);
  const base = track.stats.minEle - 80;
  return (x: number, z: number) => {
    let h = base;
    for (const [px, pz, pe] of pts) {
      const v = pe - Math.hypot(x - px, z - pz) * 0.35;
      if (v > h) h = v;
    }
    return h;
  };
}

function niceStep(v: number) {
  const steps = [10, 20, 25, 50, 100, 200, 250, 500, 1000];
  return steps.find((s) => s >= v) ?? 1000;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
