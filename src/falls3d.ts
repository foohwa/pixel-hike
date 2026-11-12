import * as THREE from 'three';
import { C, rgb01 } from './palette';
import { LIGHT_GLSL, shared, type Terrain } from './terrain';

/**
 * A waterfall built into the 3D terrain: a rock cliff sunk into the hillside (moss on its ledges),
 * a curtain of water streaming down its face, and a splash pool with ripples at its foot.
 * Sizes are in world units and chosen by the caller so it reads at the follow camera's distance.
 */

export interface FallSite {
  /** Pool centre (local x/z). */
  x: number;
  z: number;
  /** Unit x/z direction the falls face (towards the trail). */
  fx: number;
  fz: number;
  /** Height of the drop (world units). */
  h: number;
}

const v3 = (hex: string) => new THREE.Vector3(...rgb01(hex));

export function buildFalls(sites: FallSite[], terrain: Terrain) {
  const group = new THREE.Group();
  const rock = rockMaterial();
  const sheet = sheetMaterial();
  const pool = poolMaterial();
  const geos: THREE.BufferGeometry[] = [];

  for (const s of sites) {
    const H = s.h;
    const fx = s.fx, fz = s.fz;
    const rx = -fz, rz = fx; // right-hand side, looking at the falls' face
    const yaw = Math.atan2(fx, fz); // rotates +z onto the facing direction
    const Rp = H * 0.42, D = H * 0.7, Wc = H * 1.1;
    const ground = (x: number, z: number) => terrain.worldY(x, z);

    // pool level: the highest ground round its rim, so the water never sinks under the hillside
    let yPool = -Infinity;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      yPool = Math.max(yPool, ground(s.x + Math.cos(a) * Rp * 0.8, s.z + Math.sin(a) * Rp * 0.8));
    }
    yPool += H * 0.02;
    const top = yPool + H;

    // cliff block behind the pool, its foot buried well below the lowest ground it stands on
    const cx = s.x - fx * (Rp * 0.75 + D / 2), cz = s.z - fz * (Rp * 0.75 + D / 2);
    let low = Infinity;
    for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) {
      low = Math.min(low, ground(cx + rx * (Wc / 2) * u + fx * (D / 2) * v, cz + rz * (Wc / 2) * u + fz * (D / 2) * v));
    }
    const foot = Math.min(low, yPool) - H * 0.4;
    const addRock = (g: THREE.BufferGeometry, x: number, y: number, z: number, rotY: number, color: string) => {
      g.rotateY(rotY);
      g.translate(x, y, z);
      const n = g.getAttribute('position').count;
      const c = rgb01(color);
      g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => c).flat(), 3));
      geos.push(g);
      group.add(new THREE.Mesh(g, rock));
    };
    const block = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d).toNonIndexed();
    addRock(block(Wc, top - foot, D), cx, (top + foot) / 2, cz, yaw, C.rock);
    // stepped shoulders either side, a little lower and pushed forward, so the top isn't one flat slab
    for (const side of [-1, 1]) {
      const sh = top - H * (side < 0 ? 0.22 : 0.32);
      const sx = cx + rx * side * Wc * 0.55 + fx * D * 0.15, sz = cz + rz * side * Wc * 0.55 + fz * D * 0.15;
      addRock(block(Wc * 0.5, sh - foot, D * 0.9), sx, (sh + foot) / 2, sz, yaw + side * 0.12, side < 0 ? C.rock : C.greyLight);
    }
    // boulders round the pool
    const boulder = (r: number, a: number, dist: number, color: string) => {
      const g = new THREE.IcosahedronGeometry(r, 0);
      const bx = s.x + (rx * Math.cos(a) + fx * Math.sin(a)) * dist, bz = s.z + (rz * Math.cos(a) + fz * Math.sin(a)) * dist;
      addRock(g, bx, Math.max(yPool, ground(bx, bz)) + r * 0.2, bz, a, color);
    };
    boulder(H * 0.16, 0.1, Rp * 1.05, C.greyLight);
    boulder(H * 0.12, Math.PI - 0.35, Rp * 1.0, C.rock);
    boulder(H * 0.09, 0.9, Rp * 1.1, C.rockDark);
    boulder(H * 0.1, Math.PI - 1.1, Rp * 1.15, C.rockDark);

    // the water curtain on the cliff face, from the lip down into the pool
    const Ws = H * 0.46;
    const g = new THREE.PlaneGeometry(Ws, top - yPool + H * 0.04, 1, 1);
    g.rotateY(yaw);
    const fxw = cx + fx * (D / 2 + H * 0.015), fzw = cz + fz * (D / 2 + H * 0.015);
    g.translate(fxw, (top + yPool) / 2 - H * 0.02, fzw);
    geos.push(g);
    const curtain = new THREE.Mesh(g, sheet);
    curtain.renderOrder = 7;
    group.add(curtain);
    // the stream running over the lip
    const lip = new THREE.PlaneGeometry(Ws * 0.8, D * 0.6, 1, 1);
    lip.rotateX(-Math.PI / 2);
    lip.rotateY(yaw);
    lip.translate(cx + fx * D * 0.2, top + H * 0.01, cz + fz * D * 0.2);
    geos.push(lip);
    group.add(new THREE.Mesh(lip, pool));

    // splash pool
    const pg = new THREE.CircleGeometry(Rp, 22);
    pg.rotateX(-Math.PI / 2);
    pg.translate(s.x, yPool, s.z);
    geos.push(pg);
    const pm = new THREE.Mesh(pg, pool);
    pm.renderOrder = 6;
    group.add(pm);
  }

  return {
    group,
    dispose() {
      geos.forEach((g) => g.dispose());
      rock.dispose();
      sheet.dispose();
      pool.dispose();
    },
  };
}

function rockMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uMoss: { value: v3(C.green) }, uMossLight: { value: v3(C.greenLight) } },
    vertexColors: true,
    vertexShader: /* glsl */ `
      varying vec3 vW; varying vec3 vC;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vC = color; gl_Position = projectionMatrix * viewMatrix * w; }
    `,
    fragmentShader: /* glsl */ `
      ${LIGHT_GLSL}
      uniform vec3 uMoss; uniform vec3 uMossLight;
      varying vec3 vW; varying vec3 vC;
      void main() {
        vec3 n = flatNormal(vW);
        vec3 base = vC;
        // moss on ledges and in streaks down the rock
        if (n.y > 0.55) base = hash(floor(vW.xz / 9.0)) > 0.5 ? uMoss : uMossLight;
        else if (hash(floor(vec2(vW.x + vW.z, vW.y * 0.3) / 7.0)) > 0.86) base = uMoss;
        gl_FragColor = vec4(shade(base, n, vW), 1.0);
      }
    `,
  });
}

/** Falling water: streaks scrolling down, foamy edges and a churning foot. */
function sheetMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { ...shared, uA: { value: v3(C.sky) }, uB: { value: v3(C.skyLight) }, uC: { value: v3(C.white) } },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vW;
      void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
    `,
    fragmentShader: /* glsl */ `
      ${LIGHT_GLSL}
      uniform vec3 uA; uniform vec3 uB; uniform vec3 uC;
      varying vec2 vUv; varying vec3 vW;
      void main() {
        float lane = floor(vUv.x * 7.0);
        float v = fract(vUv.y * 2.2 + uTime * 1.7 + hash(vec2(lane, 3.0)));
        vec3 c = v < 0.45 ? uA : v < 0.8 ? uB : uC;
        if (vUv.x < 0.12 || vUv.x > 0.88) c = v < 0.5 ? uB : uC;            // white edges
        float churn = 0.12 + 0.08 * hash(vec2(lane, floor(uTime * 6.0)));
        if (vUv.y < churn) c = uC;                                         // spray at the foot
        gl_FragColor = vec4(shade(c, vec3(0.0, 1.0, 0.0), vW), 1.0);
      }
    `,
  });
}

/** Pool / stream surface: rings spreading out, foam patches near the falls. */
function poolMaterial() {
  return new THREE.ShaderMaterial({
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: { ...shared, uA: { value: v3(C.sky) }, uB: { value: v3(C.skyLight) }, uC: { value: v3(C.white) } },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vW;
      void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
    `,
    fragmentShader: /* glsl */ `
      ${LIGHT_GLSL}
      uniform vec3 uA; uniform vec3 uB; uniform vec3 uC;
      varying vec2 vUv; varying vec3 vW;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        vec3 c = uA;
        if (fract(r * 3.5 - uTime * 0.9) < 0.14) c = uB;
        if (r > 0.86) c = uB;
        if (hash(floor(vW.xz / 6.0) + floor(uTime * 5.0)) > 0.9) c = uC;
        gl_FragColor = vec4(shade(c, vec3(0.0, 1.0, 0.0), vW), 1.0);
      }
    `,
  });
}
