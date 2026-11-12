import * as THREE from 'three';
import { drawText, textWidth } from './font';
import { GATE_THEMES, type GateOptions } from './gate';
import { openness } from './landmarks';
import { C, rgb01 } from './palette';
import { LIGHT_GLSL, shared, type Terrain } from './terrain';
import { FOLLOW_YAW, followDistance, sampleAt, type Checkpoint, type Track } from './track';

/**
 * Checkpoint set pieces built into the 3D terrain (instead of stickers drawn over it), so they get the
 * scene's light, shadows and fog, and ridges and trees hide them naturally. Sizes are stylised: picked
 * so they read at the follow camera's distance, like the walker sprite. The 2D map keeps the sprites.
 *
 * - aid station: dirt clearing, two red pop-up gazebos, a table with jugs and cups, water drums, a flag
 * - camp: clearing, two A-frame tents, a stone fire ring with a flickering fire, log seats
 * - rest: small clearing, a log bench and a signpost
 * - summit / peak: a stone cairn on bare rock with the flag on top, and a signboard (summit signs on)
 * - viewpoint: a wooden deck with railings facing the open view, and a flag
 * - start / finish: an arch over the trail in the gate colours with its banner, or a flag
 *
 * Flags are real poles with waving cloth: grey until you get there, then the checkpoint's colour runs up.
 */

export interface FlagState { reached: boolean; raise: number }
export interface Sites {
  group: THREE.Group;
  /** Per frame: night 0..1 (lamps / fires glow), whether signboards show, each flag's state. */
  update(night: number, signs: boolean, flag: (id: string) => FlagState): void;
  dispose(): void;
}

/** Checkpoints that get a set piece in 3D (and so no sprite there). */
export const hasSite = (cp: Checkpoint) => cp.enabled;

/** Flag colours by kind (match the 2D flags in overlay.ts). */
const FLAG_COLOR: Record<Checkpoint['kind'], string> = {
  start: C.greenLight, summit: C.red, peak: C.yellow, view: C.pink, rest: C.orange, camp: C.coral, cp: C.skyLight, finish: C.white,
};

const v3 = (hex: string) => new THREE.Vector3(...rgb01(hex));
const WARM = v3('#ffd27a');
const CORNERS = [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const;

export function buildSites(cps: Checkpoint[], track: Track, terrain: Terrain, gate: GateOptions | null): Sites {
  const group = new THREE.Group();
  const boards = new THREE.Group(); // summit signboards (shown with "summit signs" on)
  group.add(boards);
  const S = followDistance(track);
  const U = S * 1.6; // prop scale
  const parts = partMaterial();
  const dirt = groundMaterial(C.tan, C.brown, C.green);
  const rocky = groundMaterial(C.rock, C.rockDark, C.green);
  const fire = fireMaterial();
  const mats: THREE.Material[] = [parts, dirt, rocky, fire];
  const geos: THREE.BufferGeometry[] = [];
  const textures: THREE.Texture[] = [];
  const glows: { at: THREE.Vector2; r: number }[] = [];
  const cleared: { mesh: THREE.InstancedMesh; i: number; m: THREE.Matrix4 }[] = [];
  const flags: { id: string; kind: Checkpoint['kind']; u: Record<string, THREE.IUniform> }[] = [];

  for (const cp of cps) {
    if (!hasSite(cp)) continue;
    const d = cp.kind === 'start' ? Math.min(track.stats.distance, 20) : cp.d;
    const ax = sampleAt(track, track.x, d), az = sampleAt(track, track.z, d);
    let hx = sampleAt(track, track.hdx, d), hz = sampleAt(track, track.hdz, d);
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl; hz /= hl;
    /**
     * Which side of the trail a piece goes: the side facing compass direction `dir` if given, else the
     * one that shows to the right of the walker on screen (as the 2D props do), so the walker sprite
     * doesn't cover it. The follow camera sits behind the walker, swung FOLLOW_YAW (see buildRig).
     */
    const pickSide = (_off: number, dir?: number) => {
      if (dir != null) return Math.sign(-hz * Math.sin(dir) + hx * -Math.cos(dir)) || 1;
      const bx = -hx, bz = -hz, yo = FOLLOW_YAW;
      const ox = bx * Math.cos(yo) - bz * Math.sin(yo), oz = bx * Math.sin(yo) + bz * Math.cos(yo);
      const rx = oz, rz = -ox; // screen right, on the ground
      return Math.sign(-hz * rx + hx * rz) || 1;
    };

    /** A local frame at (ox, oz) whose +z points along (fx, fz); `add` bakes geometry into the scene. */
    const frame = (ox: number, oz: number, fx: number, fz: number) => {
      const yaw = Math.atan2(fx, fz);
      const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
      const world = (lx: number, lz: number) => [ox + cosY * lx + sinY * lz, oz - sinY * lx + cosY * lz] as const;
      const ground = (lx: number, lz: number) => terrain.worldY(...world(lx, lz));
      const add = (g: THREE.BufferGeometry, colors: (face: number) => string, mat: THREE.Material = parts, into: THREE.Group = group) => {
        g = g.index ? g.toNonIndexed() : g;
        const n = g.getAttribute('position').count;
        const col = new Float32Array(n * 3);
        for (let v = 0; v < n; v++) col.set(rgb01(colors(Math.floor(v / 3))), v * 3);
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        g.rotateY(yaw);
        g.translate(ox, 0, oz);
        geos.push(g);
        const m = new THREE.Mesh(g, mat);
        into.add(m);
        return m;
      };
      const box = (w: number, h: number, dd: number, x: number, y: number, z: number, col: string, into?: THREE.Group) => {
        const g = new THREE.BoxGeometry(w, h, dd);
        g.translate(x, y, z);
        return add(g, () => col, parts, into);
      };
      /** Lowest / highest ground under a w × d footprint centred at local (lx, lz). */
      const footing = (lx: number, lz: number, w: number, dd: number) => {
        let lo = Infinity, hi = -Infinity;
        for (const [u, v] of [...CORNERS, [0, 0]] as const) {
          const y = ground(lx + (u * w) / 2, lz + (v * dd) / 2);
          lo = Math.min(lo, y); hi = Math.max(hi, y);
        }
        return { lo, hi };
      };
      return { yaw, world, ground, add, box, footing, fx, fz };
    };

    /** Flag pole with a waving cloth at local (lx, lz) of frame f, standing on y0. */
    const flag = (f: ReturnType<typeof frame>, lx: number, lz: number, y0: number, poleH: number) => {
      f.box(U * 0.003, poleH, U * 0.003, lx, y0 + poleH / 2, lz, C.ink2);
      f.box(U * 0.005, U * 0.004, U * 0.005, lx, y0 + poleH, lz, C.yellow); // finial
      const w = U * 0.016, h = U * 0.011;
      const g = new THREE.PlaneGeometry(w, h, 6, 1);
      g.translate(lx + w / 2, y0 + poleH - h / 2 - U * 0.002, lz);
      const u = clothUniforms(f.fx, f.fz, h, poleH * 0.65, w);
      const m = f.add(g, () => C.white, clothMaterial(u));
      mats.push(m.material as THREE.Material);
      flags.push({ id: cp.id, kind: cp.kind, u });
    };
    const clearing = (x: number, z: number, R: number, mat = dirt) => {
      geos.push(addPatch(group, mat, terrain, x, z, R, S));
      clearTrees(terrain, x, z, R * 1.05, cleared);
    };

    // ------------------------------------------------------------ per kind
    if (cp.kind === 'cp') {
      const off = S * 0.085, side = pickSide(off);
      const nx = -hz * side, nz = hx * side; // trail → tent
      const tx = ax + nx * off, tz = az + nz * off;
      clearing(ax + nx * off * 0.55, az + nz * off * 0.55, S * 0.085);
      glows.push({ at: new THREE.Vector2(tx, tz), r: S * 0.09 });
      const f = frame(tx, tz, -nx, -nz); // +z faces the trail
      const a = U * 0.02, postH = U * 0.02, roofH = U * 0.0065, valH = U * 0.0045;
      const gazebo = (ox: number, roof: string, trim: string) => {
        const { lo, hi } = f.footing(ox, 0, a * 2, a * 2);
        for (const [u, v] of CORNERS) f.box(U * 0.0035, hi + postH - lo + U * 0.004, U * 0.0035, ox + u * a * 0.97, (hi + postH + lo) / 2 - U * 0.002, v * a * 0.97, C.greyLight);
        const r = a * Math.SQRT2 * 1.04;
        const top = new THREE.ConeGeometry(r, roofH, 4, 1, true);
        top.rotateY(Math.PI / 4);
        top.translate(ox, hi + postH + valH + roofH / 2, 0);
        f.add(top, () => roof);
        const val = new THREE.CylinderGeometry(r, r, valH, 4, 1, true);
        val.rotateY(Math.PI / 4);
        val.translate(ox, hi + postH + valH / 2, 0);
        f.add(val, () => trim);
        f.box(a * 2, postH, U * 0.0015, ox, hi + postH / 2, -a * 0.97, roof); // back wall
        return hi;
      };
      const b1 = gazebo(-a * 1.08, C.red, C.wine);
      const b2 = gazebo(a * 1.08, C.red, C.wine);
      const tableY = Math.max(b1, b2) + U * 0.008;
      f.box(a * 3.2, U * 0.0035, a * 0.5, 0, tableY, a * 0.45, C.white);
      for (const k of [-1.2, -0.9, -0.6]) {
        const jug = new THREE.CylinderGeometry(U * 0.003, U * 0.003, U * 0.0055, 6);
        jug.translate(a * k, tableY + U * 0.0045, a * 0.45);
        f.add(jug, () => C.sky);
      }
      for (const k of [0.3, 0.6, 0.9, 1.2]) f.box(U * 0.003, U * 0.003, U * 0.003, a * k, tableY + U * 0.003, a * 0.45, k > 0.8 ? C.orange : C.yellow);
      for (const k of [-1.4, -0.4]) {
        const drum = new THREE.CylinderGeometry(U * 0.005, U * 0.005, U * 0.009, 8);
        drum.translate(a * k, b1 + U * 0.0045, -a * 0.55);
        f.add(drum, () => C.sky);
      }
      f.box(a * 0.5, U * 0.006, a * 0.4, a * 1.1, b2 + U * 0.003, -a * 0.5, C.brown);
      flag(f, a * 2.6, a * 0.9, f.ground(a * 2.6, a * 0.9), U * 0.045);
    } else if (cp.kind === 'camp') {
      const off = S * 0.085, side = pickSide(off);
      const nx = -hz * side, nz = hx * side;
      const cx = ax + nx * off, cz = az + nz * off;
      clearing(ax + nx * off * 0.5, az + nz * off * 0.5, S * 0.08);
      glows.push({ at: new THREE.Vector2(cx, cz), r: S * 0.07 });
      const f = frame(cx, cz, -nx, -nz);
      const tent = (lx: number, lz: number, len: number, col: string, rot: number) => {
        // A-frame: a triangular prism lying along local x
        const r = U * 0.009;
        const g = new THREE.CylinderGeometry(r, r, len, 3, 1, false);
        g.rotateZ(Math.PI / 2);
        g.rotateX(Math.PI / 2 + Math.PI); // ridge up
        g.rotateY(rot);
        const y = f.footing(lx, lz, len, r * 2).hi + r * 0.5;
        g.translate(lx, y, lz);
        f.add(g, (k) => (k >= 6 && k < 9 ? C.ink2 : col)); // dark door at one end
      };
      tent(-U * 0.02, -U * 0.012, U * 0.024, C.orange, 0.3);
      tent(U * 0.018, -U * 0.018, U * 0.02, C.greenLight, -0.25);
      // fire ring with a fire, log seats either side
      const gy = f.ground(0, U * 0.012);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const st = new THREE.IcosahedronGeometry(U * 0.0022, 0);
        st.translate(Math.cos(a) * U * 0.006, gy + U * 0.001, U * 0.012 + Math.sin(a) * U * 0.006);
        f.add(st, () => C.rock);
      }
      const flame = new THREE.ConeGeometry(U * 0.0035, U * 0.009, 5);
      flame.translate(0, gy + U * 0.0045, U * 0.012);
      f.add(flame, () => C.orange, fire);
      for (const sx of [-1, 1]) {
        const log = new THREE.CylinderGeometry(U * 0.0025, U * 0.0025, U * 0.014, 6);
        log.rotateX(Math.PI / 2);
        log.translate(sx * U * 0.014, f.ground(sx * U * 0.014, U * 0.012) + U * 0.0025, U * 0.012);
        f.add(log, () => C.brown);
      }
      flag(f, U * 0.03, U * 0.01, f.ground(U * 0.03, U * 0.01), U * 0.04);
    } else if (cp.kind === 'rest') {
      const off = S * 0.075, side = pickSide(off);
      const nx = -hz * side, nz = hx * side;
      const cx = ax + nx * off, cz = az + nz * off;
      clearing(ax + nx * off * 0.5, az + nz * off * 0.5, S * 0.06);
      const f = frame(cx, cz, -nx, -nz);
      const log = new THREE.CylinderGeometry(U * 0.004, U * 0.004, U * 0.026, 7);
      log.rotateZ(Math.PI / 2);
      log.translate(0, f.footing(0, 0, U * 0.026, U * 0.008).hi + U * 0.004, 0);
      f.add(log, () => C.brown);
      const y = f.ground(U * 0.022, U * 0.006);
      f.box(U * 0.003, U * 0.02, U * 0.003, U * 0.022, y + U * 0.01, U * 0.006, C.brownDark);
      f.box(U * 0.016, U * 0.009, U * 0.0025, U * 0.022, y + U * 0.019, U * 0.006, C.cream);
      f.box(U * 0.017, U * 0.0015, U * 0.003, U * 0.022, y + U * 0.0238, U * 0.006, C.orange);
    } else if (cp.kind === 'summit' || cp.kind === 'peak') {
      // cairn on bare rock right beside the trail, flag on top; the signboard stands next to it
      const off = S * 0.075, side = pickSide(off);
      const nx = -hz * side, nz = hx * side;
      const cx = ax + nx * off, cz = az + nz * off;
      clearing(ax + nx * off * 0.6, az + nz * off * 0.6, S * 0.07, rocky);
      const f = frame(cx, cz, -nx, -nz);
      const big = cp.kind === 'summit' ? 1.25 : 1;
      let y = f.footing(0, 0, U * 0.02, U * 0.02).lo;
      const rocks = [0.012, 0.0095, 0.0072, 0.005].map((r) => r * U * big);
      rocks.forEach((r, k) => {
        const g = new THREE.IcosahedronGeometry(r, 0);
        g.scale(1, 0.62, 1);
        g.rotateY(k * 1.3);
        g.translate((k % 2 ? 1 : -1) * r * 0.12, y + r * 0.5, 0);
        f.add(g, () => (k % 2 ? C.rock : C.greyLight));
        y += r * 1.0;
      });
      flag(f, 0, 0, y - rocks[3] * 0.4, U * 0.04 * big);
      const sx = U * 0.032, sy = f.ground(sx, U * 0.008);
      for (const px of [-1, 1]) f.box(U * 0.003, U * 0.026, U * 0.003, sx + px * U * 0.009, sy + U * 0.013, U * 0.008, C.brownDark, boards);
      f.box(U * 0.026, U * 0.012, U * 0.003, sx, sy + U * 0.022, U * 0.008, C.cream, boards);
      f.box(U * 0.027, U * 0.002, U * 0.0035, sx, sy + U * 0.0283, U * 0.008, C.red, boards);
    } else if (cp.kind === 'view') {
      // a wooden deck on the side the view opens to, railing round its outer edges
      const look = openness(track, terrain, cp.d).dir;
      const off = S * 0.095, side = pickSide(off, look);
      const nx = -hz * side, nz = hx * side;
      const cx = ax + nx * off, cz = az + nz * off;
      clearing(ax + nx * off * 0.6, az + nz * off * 0.6, S * 0.055);
      const f = frame(cx, cz, nx, nz); // +z looks out over the view
      const w = U * 0.03, dd = U * 0.022;
      const { lo, hi } = f.footing(0, 0, w, dd);
      const top = hi + U * 0.004;
      for (const [u, v] of CORNERS) f.box(U * 0.003, top - lo + U * 0.004, U * 0.003, (u * w) / 2, (top + lo) / 2 - U * 0.002, (v * dd) / 2, C.brownDark);
      f.box(w, U * 0.003, dd, 0, top, 0, C.tan);
      for (let k = -2; k <= 2; k++) f.box(U * 0.0008, U * 0.0031, dd, (k * w) / 5.5, top + U * 0.0001, 0, C.brown); // plank lines
      const railH = U * 0.009;
      for (const [x0, z0, x1, z1] of [[-w / 2, dd / 2, w / 2, dd / 2], [-w / 2, -dd / 2, -w / 2, dd / 2], [w / 2, -dd / 2, w / 2, dd / 2]]) {
        const len = Math.hypot(x1 - x0, z1 - z0);
        const rail = new THREE.BoxGeometry(x1 === x0 ? U * 0.002 : len, U * 0.002, z1 === z0 ? U * 0.002 : len);
        rail.translate((x0 + x1) / 2, top + railH, (z0 + z1) / 2);
        f.add(rail, () => C.brown);
        for (let k = 0; k <= 3; k++) {
          const t = k / 3;
          f.box(U * 0.002, railH, U * 0.002, x0 + (x1 - x0) * t, top + railH / 2, z0 + (z1 - z0) * t, C.brownDark);
        }
      }
      flag(f, -w / 2, -dd / 2, top, U * 0.035);
    } else if (cp.kind === 'start' || cp.kind === 'finish') {
      if (gate) {
        // the arch straddles the trail; its banner faces the way you come in
        const f = frame(ax, az, hx, hz);
        const span = U * 0.034, H = U * 0.042, pw = U * 0.007;
        const th = GATE_THEMES[gate.color];
        clearing(ax, az, S * 0.06);
        glows.push({ at: new THREE.Vector2(ax, az), r: S * 0.06 });
        let topY = -Infinity;
        for (const sx of [-1, 1]) topY = Math.max(topY, f.ground(sx * span, 0) + H);
        for (const sx of [-1, 1]) {
          const g0 = f.ground(sx * span, 0) - U * 0.004;
          f.box(pw, topY - g0, pw, sx * span, (topY + g0) / 2, 0, th.main);
          f.box(pw * 1.3, U * 0.004, pw * 1.3, sx * span, g0 + U * 0.006, 0, th.dark); // foot
        }
        const bh = U * 0.012;
        f.box(span * 2 + pw, bh, pw * 0.8, 0, topY - bh / 2, 0, th.main);
        const text = cp.kind === 'finish' ? 'FINISH' : (gate.text || 'START').toUpperCase().slice(0, 18);
        const tex = bannerTexture(text, th.main, th.text);
        textures.push(tex);
        for (const facing of [-1, 1]) {
          const g = new THREE.PlaneGeometry(span * 2 - pw, bh * 0.82);
          if (facing > 0) g.rotateY(Math.PI);
          g.translate(0, topY - bh / 2, facing * -(pw * 0.42));
          const m = f.add(g, () => C.white, bannerMaterial(tex));
          mats.push(m.material as THREE.Material);
        }
      } else {
        const off = S * 0.03, side = pickSide(off);
        const nx = -hz * side, nz = hx * side;
        const f = frame(ax + nx * off, az + nz * off, -nx, -nz);
        flag(f, 0, 0, f.ground(0, 0), U * 0.045);
      }
    }
  }

  // trees hidden for the clearings come back when the set pieces are rebuilt
  for (const m of new Set(cleared.map((c) => c.mesh))) m.instanceMatrix.needsUpdate = true;

  const glowMats = [parts, dirt, rocky];
  return {
    group,
    update(night, signs, state) {
      boards.visible = signs;
      for (const mat of glowMats) {
        mat.uniforms.uNight.value = night;
        const at = mat.uniforms.uGlowAt.value as THREE.Vector2[];
        const rr = mat.uniforms.uGlowR.value as number[];
        glows.slice(0, MAX_GLOWS).forEach((g, i) => { at[i].copy(g.at); rr[i] = g.r; });
        mat.uniforms.uGlows.value = Math.min(glows.length, MAX_GLOWS);
      }
      for (const fl of flags) {
        const s = state(fl.id);
        (fl.u.uCol.value as THREE.Vector3).copy(v3(s.reached ? FLAG_COLOR[fl.kind] : C.rock));
        fl.u.uChecker.value = fl.kind === 'finish' && s.reached ? 1 : 0;
        fl.u.uRaise.value = s.raise;
      }
    },
    dispose() {
      const touched = new Set<THREE.InstancedMesh>();
      for (const c of cleared) { c.mesh.setMatrixAt(c.i, c.m); touched.add(c.mesh); }
      touched.forEach((m) => (m.instanceMatrix.needsUpdate = true));
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
    },
  };
}

/** The gate's banner text in the pixel font, on the theme colour (crisp: nearest filtering). */
function bannerTexture(text: string, bg: string, fg: string) {
  const c = document.createElement('canvas');
  c.width = textWidth(text) + 8;
  c.height = 11;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  drawText(ctx, text, c.width / 2, 2, fg, { align: 'center' });
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

function bannerMaterial(tex: THREE.Texture) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uMap: { value: tex } },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vW;
      void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
    `,
    fragmentShader: /* glsl */ `
      ${LIGHT_GLSL}
      uniform sampler2D uMap;
      varying vec2 vUv; varying vec3 vW;
      void main() { vec3 c = texture2D(uMap, vUv).rgb; gl_FragColor = vec4(shade(c, vec3(0.0, 1.0, 0.0), vW), 1.0); }
    `,
  });
}

function clothUniforms(fx: number, fz: number, h: number, travel: number, w: number): Record<string, THREE.IUniform> {
  return {
    ...shared,
    uCol: { value: v3(C.rock) },
    uChecker: { value: 0 },
    uRaise: { value: 0 },
    uTravel: { value: travel },
    uWave: { value: new THREE.Vector3(fx, 0, fz).multiplyScalar(w * 0.18) },
    uW: { value: w },
    uH: { value: h },
  };
}

/** Flag cloth: rides up the pole as uRaise goes 0 → 1, ripples away from the pole, checkered at the finish. */
function clothMaterial(u: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: u,
    vertexShader: /* glsl */ `
      uniform float uRaise; uniform float uTravel; uniform vec3 uWave; uniform float uTime;
      varying vec2 vUv; varying vec3 vW;
      void main() {
        vUv = uv;
        vec3 p = position;
        p.y -= (1.0 - uRaise) * uTravel;
        p += uWave * sin(uv.x * 4.0 - uTime * 7.0) * uv.x;
        vec4 w = modelMatrix * vec4(p, 1.0); vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      ${LIGHT_GLSL}
      uniform vec3 uCol; uniform float uChecker;
      varying vec2 vUv; varying vec3 vW;
      void main() {
        vec3 c = uCol;
        if (uChecker > 0.5 && mod(floor(vUv.x * 4.0) + floor(vUv.y * 3.0), 2.0) > 0.5) c = vec3(0.102, 0.11, 0.173);
        gl_FragColor = vec4(shade(c, vec3(0.0, 1.0, 0.0), vW), 1.0);
      }
    `,
  });
}

/** Campfire: unlit, flickering between orange and yellow. */
function fireMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uA: { value: v3(C.orange) }, uB: { value: v3(C.yellow) }, uC: { value: v3(C.coral) } },
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uA; uniform vec3 uB; uniform vec3 uC;
      varying vec3 vW;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        float k = h(vec2(floor(uTime * 8.0), floor(vW.y * 0.2)));
        gl_FragColor = vec4(k > 0.6 ? uB : k > 0.25 ? uA : uC, 1.0);
      }
    `,
  });
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

/** Worn ground (dirt, or bare rock at summits): speckled, with a ragged edge that melts into the grass. */
function groundMaterial(a: string, b: string, grass: string) {
  return new THREE.ShaderMaterial({
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    uniforms: { ...shared, ...glowUniforms(), uDirt: { value: v3(a) }, uDirt2: { value: v3(b) }, uGrass: { value: v3(grass) } },
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
