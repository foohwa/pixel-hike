import * as THREE from 'three';
import { C, rgb01 } from './palette';
import { LIGHT_GLSL, shared, type Terrain } from './terrain';
import { followDistance, sampleAt, type Checkpoint, type Track } from './track';

/**
 * Checkpoint set pieces built into the 3D terrain (instead of stickers drawn over it), so they get the
 * scene's light, shadows and fog, and ridges and trees hide them naturally. Sizes are stylised: picked
 * so they read at the follow camera's distance, like the walker sprite.
 *
 * Aid station: a worn dirt clearing where the trail passes, a striped pop-up canopy on four posts, a
 * table with water jugs, and a race feather flag. At night the canopy is lit from inside.
 */

export interface Sites {
  group: THREE.Group;
  /** Per frame: night 0..1 (lamps on under the canopy). */
  update(night: number): void;
  dispose(): void;
}

/** Which checkpoints get a set piece (and so no sprite in the 3D view). */
export const hasSite = (cp: Checkpoint) => cp.enabled && cp.kind === 'cp';

const v3 = (hex: string) => new THREE.Vector3(...rgb01(hex));
const WARM = v3('#ffd27a');

export function buildSites(cps: Checkpoint[], track: Track, terrain: Terrain): Sites {
  const group = new THREE.Group();
  const S = followDistance(track);
  const parts = partMaterial();
  const ground = groundMaterial();
  const geos: THREE.BufferGeometry[] = [];
  const glows: { at: THREE.Vector2; r: number }[] = [];
  const cleared: { mesh: THREE.InstancedMesh; i: number; m: THREE.Matrix4 }[] = [];

  for (const cp of cps) {
    if (!hasSite(cp)) continue;
    const d = cp.d;
    const ax = sampleAt(track, track.x, d), az = sampleAt(track, track.z, d);
    let hx = sampleAt(track, track.hdx, d), hz = sampleAt(track, track.hdz, d);
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl; hz /= hl;
    // beside the trail, on whichever side is flatter
    const off = S * 0.085;
    const h0 = terrain.worldY(ax, az);
    const slope = (sd: number) => {
      let m = 0;
      for (const f of [0.6, 1, 1.4]) m += Math.abs(terrain.worldY(ax - hz * sd * off * f, az + hx * sd * off * f) - h0);
      return m;
    };
    const side = slope(1) <= slope(-1) ? 1 : -1;
    const nx = -hz * side, nz = hx * side; // from the trail towards the tent
    const tx = ax + nx * off, tz = az + nz * off;

    // dirt clearing spanning the trail and the tent
    const px = ax + nx * off * 0.55, pz = az + nz * off * 0.55;
    const R = S * 0.085;
    geos.push(addPatch(group, ground, terrain, px, pz, R, S));
    clearTrees(terrain, px, pz, R * 1.05, cleared);
    glows.push({ at: new THREE.Vector2(tx, tz), r: S * 0.09 });

    // the canopy, its flat side to the trail
    const U = S * 1.6; // set-piece scale
    const yaw = Math.atan2(-nx, -nz); // local +z faces the trail
    const a = U * 0.026; // half width
    const postH = U * 0.022, roofH = U * 0.012, valH = U * 0.005;
    // stand it level: on the highest ground under its corners, legs reaching down to the lowest
    let top0 = -Infinity, low = Infinity;
    for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = tx + (Math.cos(yaw) * u + Math.sin(yaw) * v) * a, cz = tz + (-Math.sin(yaw) * u + Math.cos(yaw) * v) * a;
      const y = terrain.worldY(cx, cz);
      top0 = Math.max(top0, y);
      low = Math.min(low, y);
    }
    const base = top0;
    const add = (g: THREE.BufferGeometry, colors: (face: number) => string) => {
      g = g.index ? g.toNonIndexed() : g;
      const n = g.getAttribute('position').count;
      const col = new Float32Array(n * 3);
      for (let v = 0; v < n; v++) col.set(rgb01(colors(Math.floor(v / 3))), v * 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.rotateY(yaw);
      g.translate(tx, 0, tz);
      geos.push(g);
      const m = new THREE.Mesh(g, parts);
      group.add(m);
      return m;
    };
    // posts
    for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const g = new THREE.BoxGeometry(U * 0.004, base + postH - low + U * 0.004, U * 0.004);
      g.translate(u * a * 0.95, (base + postH + low) / 2 - U * 0.002, v * a * 0.95);
      add(g, () => C.greyLight);
    }
    // striped pyramid roof (8 panels, alternating red / white) and a striped valance round its edge
    const R8 = a * Math.SQRT2;
    const roof = new THREE.ConeGeometry(R8, roofH, 8, 1, true);
    roof.rotateY(Math.PI / 8);
    roof.translate(0, base + postH + valH + roofH / 2, 0);
    add(roof, (f) => (f % 2 ? C.white : C.red));
    const val = new THREE.CylinderGeometry(R8 * 0.99, R8 * 0.99, valH, 8, 1, true);
    val.rotateY(Math.PI / 8);
    val.translate(0, base + postH + valH / 2, 0);
    add(val, (f) => (Math.floor(f / 2) % 2 ? C.red : C.white));
    // table with water jugs and cups (towards the trail)
    const tableY = base + U * 0.008;
    const table = new THREE.BoxGeometry(a * 1.3, U * 0.0025, a * 0.45);
    table.translate(0, tableY, a * 0.35);
    add(table, () => C.cream);
    for (const k of [-0.45, -0.2, 0.2]) {
      const jug = new THREE.CylinderGeometry(U * 0.0035, U * 0.0035, U * 0.006, 6);
      jug.translate(a * k, tableY + U * 0.0042, a * 0.35);
      add(jug, () => C.sky);
    }
    const cups = new THREE.BoxGeometry(a * 0.25, U * 0.003, a * 0.15);
    cups.translate(a * 0.45, tableY + U * 0.0027, a * 0.35);
    add(cups, () => C.white);
    // crates of supplies at the back
    const crate = new THREE.BoxGeometry(a * 0.4, U * 0.007, a * 0.35);
    crate.translate(-a * 0.5, base + U * 0.0035, -a * 0.55);
    add(crate, () => C.brown);
    const crate2 = new THREE.BoxGeometry(a * 0.3, U * 0.005, a * 0.3);
    crate2.translate(a * 0.45, base + U * 0.0025, -a * 0.5);
    add(crate2, () => C.sky);
    // feather flag by the trail
    const poleH = U * 0.05;
    const pole = new THREE.BoxGeometry(U * 0.0035, poleH, U * 0.0035);
    pole.translate(a * 1.35, base + poleH / 2, a * 0.9);
    add(pole, () => C.ink2);
    const flag = new THREE.BoxGeometry(U * 0.012, poleH * 0.62, U * 0.001);
    flag.translate(a * 1.35 + U * 0.0065, base + poleH * 0.64, a * 0.9);
    add(flag, (f) => (f % 4 < 2 ? C.coral : C.yellow));
  }

  // trees hidden for the clearings come back when the set pieces are rebuilt
  for (const m of new Set(cleared.map((c) => c.mesh))) m.instanceMatrix.needsUpdate = true;

  return {
    group,
    update(night) {
      for (const mat of [parts, ground]) {
        mat.uniforms.uNight.value = night;
        const at = mat.uniforms.uGlowAt.value as THREE.Vector2[];
        const rr = mat.uniforms.uGlowR.value as number[];
        glows.slice(0, MAX_GLOWS).forEach((g, i) => { at[i].copy(g.at); rr[i] = g.r; });
        mat.uniforms.uGlows.value = Math.min(glows.length, MAX_GLOWS);
      }
    },
    dispose() {
      const touched = new Set<THREE.InstancedMesh>();
      for (const c of cleared) { c.mesh.setMatrixAt(c.i, c.m); touched.add(c.mesh); }
      touched.forEach((m) => (m.instanceMatrix.needsUpdate = true));
      geos.forEach((g) => g.dispose());
      parts.dispose();
      ground.dispose();
    },
  };
}

/** Hide trees standing within r of (x, z), remembering them so dispose() can put them back. */
function clearTrees(terrain: Terrain, x: number, z: number, r: number, out: { mesh: THREE.InstancedMesh; i: number; m: THREE.Matrix4 }[]) {
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (const mesh of terrain.trees) {
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      m.decompose(p, q, s);
      if (s.x === 0 || Math.hypot(p.x - x, p.z - z) > r) continue;
      out.push({ mesh, i, m: m.clone() });
      mesh.setMatrixAt(i, zero);
    }
  }
}

/** Ground patch draped over the terrain (a grid clipped to a ragged circle in the shader). */
function addPatch(group: THREE.Group, mat: THREE.ShaderMaterial, terrain: Terrain, x: number, z: number, R: number, S: number) {
  const N = 14;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const u = (i / N) * 2 - 1, v = (j / N) * 2 - 1;
      const px = x + u * R, pz = z + v * R;
      pos.push(px, terrain.worldY(px, pz) + S * 0.0015, pz);
      uv.push(u, v);
      if (i < N && j < N) {
        const k = j * (N + 1) + i;
        idx.push(k, k + N + 1, k + 1, k + 1, k + N + 1, k + N + 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = 1;
  group.add(m);
  return g;
}

const MAX_GLOWS = 16;
const GLOW_GLSL = /* glsl */ `
uniform float uNight; uniform int uGlows; uniform vec2 uGlowAt[${MAX_GLOWS}]; uniform float uGlowR[${MAX_GLOWS}];
uniform vec3 uWarm;
/** Warm lamplight under the canopies at night (stepped, like the head-lamp pool). */
vec3 glow(vec3 col, vec3 base, vec3 w) {
  if (uNight <= 0.0) return col;
  float g = 0.0;
  for (int i = 0; i < ${MAX_GLOWS}; i++) {
    if (i >= uGlows) break;
    g = max(g, 1.0 - smoothstep(uGlowR[i] * 0.25, uGlowR[i], distance(w.xz, uGlowAt[i])));
  }
  g = floor(g * 2.0 + 0.5) / 2.0 * uNight;
  return mix(col, base * 0.9 + uWarm * 0.25, g * 0.75);
}
`;

const glowUniforms = () => ({
  uNight: { value: 0 },
  uGlows: { value: 0 },
  uGlowAt: { value: Array.from({ length: MAX_GLOWS }, () => new THREE.Vector2()) },
  uGlowR: { value: new Array(MAX_GLOWS).fill(1) },
  uWarm: { value: WARM },
});

function partMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexColors: true,
    uniforms: { ...shared, ...glowUniforms() },
    vertexShader: /* glsl */ `
      varying vec3 vW; varying vec3 vC;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vC = color; gl_Position = projectionMatrix * viewMatrix * w; }
    `,
    fragmentShader: /* glsl */ `
      ${LIGHT_GLSL}
      ${GLOW_GLSL}
      varying vec3 vW; varying vec3 vC;
      void main() {
        vec3 n = flatNormal(vW);
        if (!gl_FrontFacing) n = -n;
        gl_FragColor = vec4(glow(shade(vC, n, vW), vC, vW), 1.0);
      }
    `,
  });
}

/** Worn earth: tan with darker speckles, a ragged edge that melts into the grass. */
function groundMaterial() {
  return new THREE.ShaderMaterial({
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    uniforms: { ...shared, ...glowUniforms(), uDirt: { value: v3(C.tan) }, uDirt2: { value: v3(C.brown) }, uGrass: { value: v3(C.green) } },
    vertexShader: /* glsl */ `
      varying vec3 vW; varying vec2 vP;
      void main() { vP = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
    `,
    fragmentShader: /* glsl */ `
      ${LIGHT_GLSL}
      ${GLOW_GLSL}
      uniform vec3 uDirt; uniform vec3 uDirt2; uniform vec3 uGrass;
      varying vec3 vW; varying vec2 vP;
      void main() {
        float r = length(vP) + (vnoise(vP * 4.0) - 0.5) * 0.35;
        if (r > 0.95) discard;
        // speckled dirt in the middle, tufts of grass breaking it up towards the edge
        float k = hash(floor(vW.xz / 5.0));
        vec3 base = k > 0.8 ? uDirt2 : uDirt;
        if (r > 0.65 && hash(floor(vW.xz / 7.0) + 3.1) < (r - 0.65) * 3.0) base = uGrass;
        vec3 col = shade(base, flatNormal(vW), vW);
        gl_FragColor = vec4(glow(col, base, vW), 1.0);
      }
    `,
  });
}
