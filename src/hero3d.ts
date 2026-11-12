import * as THREE from 'three';
import { FRAME } from './characters';
import { C, rgb01 } from './palette';
import { shared, type Terrain } from './terrain';

/**
 * The walker (and companion) standing in the 3D scene instead of painted over it: each is a quad
 * facing the camera, placed so its 16×16 frame covers exactly the same screen pixels the 2D overlay
 * would (crisp pixels, no resampling), but at the walker's depth — so ridges and trees in front can
 * hide it. It's lit by the scene (warm at dawn, blue under the moon) and casts its silhouette as a
 * shadow on the ground along the real sun / moon direction.
 */

const v3 = (hex: string) => new THREE.Vector3(...rgb01(hex));

interface Figure {
  quad: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  shadow: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
}

export class SceneFigures {
  readonly group = new THREE.Group();
  private figures: Figure[] = [];
  private textures = new Map<HTMLCanvasElement, THREE.CanvasTexture>();
  private tmp = new THREE.Vector3();

  constructor() {
    for (let i = 0; i < 2; i++) this.figures.push(this.makeFigure());
  }

  private makeFigure(): Figure {
    const qg = new THREE.BufferGeometry();
    qg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    qg.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2));
    qg.setIndex([0, 2, 1, 1, 2, 3]);
    const quad = new THREE.Mesh(qg, figureMaterial());
    quad.frustumCulled = false;
    quad.renderOrder = 20;
    // shadow: a strip of 2 × (N + 1) vertices lying on the ground, feet → tip
    const N = 6;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((N + 1) * 2 * 3), 3));
    const uv: number[] = [], idx: number[] = [];
    for (let k = 0; k <= N; k++) {
      uv.push(0, k / N, 1, k / N);
      if (k < N) idx.push(k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 1, k * 2 + 3, k * 2 + 2);
    }
    sg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    sg.setIndex(idx);
    const shadow = new THREE.Mesh(sg, shadowMaterial());
    shadow.frustumCulled = false;
    shadow.renderOrder = 19;
    this.group.add(quad, shadow);
    return { quad, shadow };
  }

  private texture(c: HTMLCanvasElement) {
    let t = this.textures.get(c);
    if (!t) {
      t = new THREE.CanvasTexture(c);
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.colorSpace = THREE.NoColorSpace;
      this.textures.set(c, t);
    }
    return t;
  }

  /**
   * Place figure `i` (0 = walker, 1 = companion): `frame` drawn with its bottom-centre at screen pixel
   * (sx, sy) — same convention as the overlay — standing at world point `feet`. `light` = the
   * direction towards the light casting shadows (unit), `shadowK` 0..1 how strong / long that shadow is.
   */
  place(
    i: number,
    frame: HTMLCanvasElement | null,
    feet: THREE.Vector3,
    sx: number,
    sy: number,
    cam: THREE.PerspectiveCamera,
    W: number,
    H: number,
    terrain: Terrain,
    camDist: number,
    light: THREE.Vector3,
    shadowK: number,
  ) {
    const f = this.figures[i];
    f.quad.visible = f.shadow.visible = !!frame;
    if (!frame) return;
    const tex = this.texture(frame);
    f.quad.material.uniforms.uMap.value = tex;
    f.shadow.material.uniforms.uMap.value = tex;

    // depth: a little in front of the feet, so the ground right behind doesn't cut into the figure
    const toCam = this.tmp.copy(cam.position).sub(feet).normalize();
    const zNdc = feet.clone().addScaledVector(toCam, camDist * 0.02).project(cam).z;
    const corner = (px: number, py: number) => new THREE.Vector3((px / W) * 2 - 1, 1 - (py / H) * 2, zNdc).unproject(cam);
    const x0 = sx - FRAME / 2, y0 = sy - FRAME;
    const pts = [corner(x0, y0), corner(x0 + FRAME, y0), corner(x0, y0 + FRAME), corner(x0 + FRAME, y0 + FRAME)];
    const qp = f.quad.geometry.getAttribute('position') as THREE.BufferAttribute;
    pts.forEach((p, k) => qp.setXYZ(k, p.x, p.y, p.z));
    qp.needsUpdate = true;

    // the silhouette laid on the ground, pointing away from the light; long when the light is low
    const worldH = pts[0].distanceTo(pts[2]); // the figure's height in world units at its depth
    const worldW = pts[0].distanceTo(pts[1]);
    let dx = -light.x, dz = -light.z;
    const dl = Math.hypot(dx, dz);
    const elev = Math.atan2(light.y, dl);
    if (dl < 1e-3) { dx = 1; dz = 0; } else { dx /= dl; dz /= dl; }
    const len = shadowK > 0 ? worldH * Math.min(3.2, 1 / Math.tan(Math.max(elev, 0.3))) * (0.4 + 0.6 * shadowK) : worldH * 0.22;
    const px = -dz, pz = dx; // across the shadow
    const sp = f.shadow.geometry.getAttribute('position') as THREE.BufferAttribute;
    const N = sp.count / 2 - 1;
    const lift = camDist * 0.004;
    for (let k = 0; k <= N; k++) {
      const u = k / N;
      // the shadow narrows slightly towards its tip, like the silhouette it is
      const half = (worldW / 2) * (1 - 0.15 * u);
      for (const [j, s] of [[0, -1], [1, 1]] as const) {
        const x = feet.x + dx * len * u + px * half * s;
        const z = feet.z + dz * len * u + pz * half * s;
        sp.setXYZ(k * 2 + j, x, terrain.worldY(x, z) + lift, z);
      }
    }
    sp.needsUpdate = true;
    f.shadow.material.uniforms.uStrength.value = shadowK > 0 ? 0.35 + 0.4 * shadowK : 0.5;
  }

  /** Wash figure `i` with `color` at strength `k` (the heart-rate flash), or clear it. */
  setTint(i: number, color: string | null, k: number) {
    const u = this.figures[i].quad.material.uniforms;
    if (color) u.uTint.value.set(...rgb01(color));
    u.uTintK.value = color ? k : 0;
  }

  hide() {
    for (const f of this.figures) f.quad.visible = f.shadow.visible = false;
  }

  dispose() {
    for (const f of this.figures) {
      f.quad.geometry.dispose();
      f.quad.material.dispose();
      f.shadow.geometry.dispose();
      f.shadow.material.dispose();
    }
    this.textures.forEach((t) => t.dispose());
  }
}

/** The sprite, lit by the scene but kept readable (half its own colours, half the scene's light). */
function figureMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { ...shared, uMap: { value: null as THREE.Texture | null }, uTint: { value: new THREE.Vector3(1, 0, 0) }, uTintK: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; uniform vec3 uSunCol; uniform vec3 uAmb; uniform float uLamp;
      uniform vec3 uTint; uniform float uTintK;
      varying vec2 vUv;
      void main() {
        vec4 c = texture2D(uMap, vUv);
        if (c.a < 0.5) discard;
        vec3 lit = c.rgb * min(uAmb + uSunCol * 0.75, vec3(1.1));
        // at night the head-lamp spills back onto the walker a little, so it never goes black
        vec3 col = mix(c.rgb, lit, 0.5 - 0.28 * uLamp);
        // heart-rate flash: washed towards the tint, keeping a little of the shading
        float l = dot(c.rgb, vec3(0.3, 0.55, 0.15));
        col = mix(col, uTint * (0.8 + 0.45 * l), uTintK);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

/** The silhouette on the ground: a dark, pixel-dithered shadow (no blending, crisp at 320×180). */
function shadowMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
    depthWrite: false,
    uniforms: { uMap: { value: null as THREE.Texture | null }, uStrength: { value: 0.6 }, uCol: { value: v3(C.ink) } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; uniform float uStrength; uniform vec3 uCol;
      varying vec2 vUv;
      float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
      float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
      void main() {
        // vUv.y runs feet → tip: sample the frame bottom-up
        if (texture2D(uMap, vec2(vUv.x, vUv.y)).a < 0.5) discard;
        if (bayer4(gl_FragCoord.xy) > uStrength) discard;
        gl_FragColor = vec4(uCol, 1.0);
      }
    `,
  });
}
