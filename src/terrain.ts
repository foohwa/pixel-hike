import * as THREE from 'three';
import type { Dem } from './dem';
import { C, rgb01 } from './palette';
import { clamp, toLatLon, type Track } from './track';

export const EXAG = 1.5; // vertical exaggeration — mountains look cuter a bit taller

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
};

const LIGHT_GLSL = /* glsl */ `
uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uAmb;
uniform vec3 uFogCol; uniform float uFogNear; uniform float uFogFar;
uniform vec3 uLampPos; uniform float uLamp; uniform float uLampR;
vec3 shade(vec3 base, vec3 n, vec3 w) {
  float d = max(dot(n, uSunDir), 0.0);
  d = floor(d * 4.0 + 0.5) / 4.0;                 // toon steps
  vec3 col = base * min(uAmb + uSunCol * d, vec3(1.08));
  // headlamp: a small warm pool of light around the hiker at night
  float g = uLamp * (1.0 - smoothstep(uLampR * 0.35, uLampR, distance(w.xz, uLampPos.xz)));
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

export function buildTerrain(track: Track, dem: Dem | null): Terrain {
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
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aH', new THREE.BufferAttribute(aH, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const range = maxH - minH;
  const contour = niceStep(range / 10);
  const terrainMat = new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uMinH: { value: minH },
      uMaxH: { value: maxH },
      uContour: { value: contour },
      uJitter: { value: spacing * 0.8 },
      cLow: { value: v3(C.lime) },
      c1: { value: v3(C.greenLight) },
      c2: { value: v3(C.green) },
      c3: { value: v3(C.forest) },
      c4: { value: v3(C.forestDeep) },
      c5: { value: v3(C.moss) },
      cRock: { value: v3(C.rock) },
      cDirt: { value: v3(C.tan) },
    },
    vertexShader: /* glsl */ `
      attribute float aH; varying float vH; varying vec3 vW; varying vec3 vN;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vH = aH; vN = normal; gl_Position = projectionMatrix * viewMatrix * w; }
    `,
    fragmentShader: /* glsl */ `
      ${LIGHT_GLSL}
      uniform float uMinH, uMaxH, uContour, uJitter;
      uniform vec3 cLow, c1, c2, c3, c4, c5, cRock, cDirt;
      varying float vH; varying vec3 vW; varying vec3 vN;
      void main() {
        vec3 n = normalize(vN);
        float h = (vH - uMinH) / (uMaxH - uMinH);
        h += (hash(floor(vW.xz / uJitter)) - 0.5) * 0.05;
        vec3 base = h < 0.04 ? cLow : h < 0.16 ? c1 : h < 0.38 ? c2 : h < 0.62 ? c3 : h < 0.86 ? c4 : c5;
        if (n.y < 0.5) base = mix(base, cDirt, 0.35);
        if (n.y < 0.36) base = cRock;
        // contour lines
        float c = vH / uContour;
        float fw = fwidth(c);
        float dist = abs(fract(c + 0.5) - 0.5) / max(fw, 1e-4);
        if (fw < 0.45 && dist < 0.75) base *= 0.78;
        gl_FragColor = vec4(shade(base, n, vW), 1.0);
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
  const trees = buildTrees(nx, nz, x0, z0, spacing, minH, maxH, heightAt);
  group.add(trees);

  const center = new THREE.Vector3(cx, ((minH + maxH) / 2) * EXAG, cz);
  return {
    group,
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
    },
  };
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
  minH: number, maxH: number, heightAt: (x: number, z: number) => number,
) {
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
    const density = hn < 0.04 ? 0.15 : hn > 0.93 ? 0.1 : 0.75;
    if (rand() > density) continue;
    const k = Math.floor(rand() * 1e9) % 7;
    const size = 0.7 + rand() * 0.6;
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
  return mesh;
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
