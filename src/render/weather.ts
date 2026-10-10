/**
 * VZ-23: weather. Rain, snow, falling leaves and floating dust drawn as ONE instanced draw call per kind:
 * an `InstancedBufferGeometry` of a unit quad with a per-instance random seed. Every position is computed in the
 * vertex shader from a time uniform and that seed (fall, wind drift, sway, wrap-around inside a box that follows the
 * camera's focus) — there is no per-frame CPU loop over particles. The number of instances drawn is
 * `geometry.instanceCount`, capped by the quality tier (see `weatherLogic.ts`) and scaled by the intensity.
 *
 * Lightning is a seeded scheduler (`LightningScheduler`); a flash brightens the particles (uniform) and raises the
 * opacity of a white-blue DOM overlay on the viewport (capped, gentler with "reduce motion"). It deliberately does
 * not touch the post stack or add scene lights (a new light would recompile every material).
 *
 * The wet look is non-destructive: `Weather` lowers the roughness (and darkens the colour a little) of the ground
 * slab and of the body materials, remembers the original values, notices when someone else re-assigned a material
 * (a document edit) and restores everything when the weather stops. It never edits the document.
 */
import {
  BufferAttribute,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import type { Camera, Material, Object3D } from 'three';
import type { Vec3 } from '../core/math';
import type { WeatherKind, WeatherSettings } from '../model/types';
import { effectiveWet, weatherWind } from '../model/weather';
import type { QualityTier } from './graphics';
import {
  FALL_SPEED,
  FLASH_CAP,
  LightningScheduler,
  mulberry32,
  particleCap,
  particleCount,
  windDrift,
} from './weatherLogic';

type Particle = Exclude<WeatherKind, 'none'>;

const BOX: Record<Particle, Vec3> = {
  rain: [44, 26, 44],
  snow: [40, 22, 40],
  leaves: [36, 16, 36],
  dust: [26, 12, 26],
};

const VERT = /* glsl */ `
  attribute vec4 aSeed;
  uniform float uTime;
  uniform vec3 uCenter;
  uniform vec3 uSize;
  uniform vec2 uDrift;
  uniform float uFall;
  varying vec2 vUv;
  varying float vFade;
  varying vec3 vTint;
  varying float vShade;

  void main() {
    vec4 s = aSeed;
    float spd = uFall * (0.85 + 0.3 * s.w);
    vec3 vel = vec3(uDrift.x, -spd, uDrift.y);
    float ph = s.w * 6.2831 + s.x * 40.0;
    vec3 sway = vec3(0.0);
    #if defined(SNOW)
      sway = vec3(sin(uTime * 0.9 + ph) * 0.35, 0.0, cos(uTime * 0.7 + ph * 1.3) * 0.35);
    #elif defined(LEAF)
      sway = vec3(sin(uTime * 0.6 + ph) * 1.1, sin(uTime * 1.3 + ph) * 0.25, cos(uTime * 0.5 + ph * 1.3) * 1.1);
    #elif defined(DUST)
      sway = vec3(sin(uTime * 0.21 + ph) * 1.2, sin(uTime * 0.17 + ph * 1.7) * 0.7, cos(uTime * 0.19 + ph * 1.3) * 1.2);
    #endif
    vec3 raw = s.xyz * uSize + vel * uTime + sway;
    vec3 rel = mod(raw - uCenter + 0.5 * uSize, uSize) - 0.5 * uSize;
    vec3 wp = uCenter + rel;
    vec3 edge = abs(rel) / (0.5 * uSize);
    float f = 1.0 - smoothstep(0.72, 1.0, max(edge.x, max(edge.y, edge.z)));
    vUv = uv;
    vShade = 1.0;
    vTint = vec3(1.0);

    if (wp.y < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

    vec4 mv = viewMatrix * vec4(wp, 1.0);
    float depth = -mv.z;
    f *= smoothstep(0.5, 2.0, depth);
    vFade = f;

    #if defined(RAIN)
      float len = (0.5 + 0.3 * s.w) * (spd / 11.0);
      vec3 tail = (viewMatrix * vec4(wp - normalize(vel) * len, 1.0)).xyz;
      vec2 d = tail.xy - mv.xy;
      float dl = length(d);
      vec2 dir = dl > 1e-5 ? d / dl : vec2(0.0, -1.0);
      vec2 perp = vec2(-dir.y, dir.x);
      float w = max(0.012, depth * 0.0016);
      vec3 pv = mix(mv.xyz, tail, uv.y);
      pv.xy += perp * (uv.x - 0.5) * w;
      mv = vec4(pv, 1.0);
    #elif defined(SNOW) || defined(DUST)
      float sz = (0.05 + 0.06 * s.w);
      #if defined(DUST)
        sz = 0.025 + 0.03 * s.w;
      #endif
      sz = max(sz, depth * 0.0022) * f;
      mv.xy += position.xy * 2.0 * sz;
    #elif defined(LEAF)
      float sz = (0.14 + 0.1 * s.z) * smoothstep(0.0, 0.4, f);
      float a1 = uTime * (1.5 + 2.0 * s.x) + ph;
      float a2 = uTime * (1.0 + 2.0 * s.y) + ph * 2.0;
      vec3 c = vec3(position.x, position.y, 0.0) * sz;
      float c2 = cos(a2), s2 = sin(a2), c1 = cos(a1), s1 = sin(a1);
      vec3 r = vec3(c.x, c.y * c2, c.y * s2);
      r = vec3(r.x * c1 + r.z * s1, r.y, -r.x * s1 + r.z * c1);
      vec3 nn = vec3(c2 * s1, -s2, c2 * c1);
      vShade = 0.55 + 0.45 * abs(dot(normalize(nn), normalize(vec3(0.4, 0.8, 0.3))));
      float pick = floor(fract(s.w * 7.31) * 4.0);
      vTint = pick < 1.0 ? vec3(0.62, 0.22, 0.07) : pick < 2.0 ? vec3(0.85, 0.5, 0.1) : pick < 3.0 ? vec3(0.8, 0.7, 0.14) : vec3(0.3, 0.5, 0.12);
      mv = viewMatrix * vec4(wp + r, 1.0);
    #endif
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform float uAlpha;
  uniform float uFlash;
  uniform vec3 uColor;
  varying vec2 vUv;
  varying float vFade;
  varying vec3 vTint;
  varying float vShade;

  void main() {
    float a = uAlpha * vFade;
    vec3 col = uColor * vTint * vShade;
    #if defined(RAIN)
      float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
      a *= across * (0.25 + 0.75 * vUv.y);
    #elif defined(SNOW) || defined(DUST)
      float r = length(vUv - 0.5) * 2.0;
      if (r > 1.0) discard;
      a *= 1.0 - smoothstep(0.25, 1.0, r);
    #elif defined(LEAF)
      vec2 q = (vUv - 0.5) * 2.0;
      if (dot(q * vec2(1.0, 0.62), q * vec2(1.0, 0.62)) > 0.9) discard;
      a = 1.0;
    #endif
    col *= 1.0 + uFlash * 3.0;
    gl_FragColor = vec4(col, a);
  }
`;

interface KindLook {
  alpha: number;
  color: [number, number, number];
  transparent: boolean;
}
const LOOK: Record<Particle, KindLook> = {
  rain: { alpha: 0.42, color: [0.72, 0.8, 0.95], transparent: true },
  snow: { alpha: 0.9, color: [0.95, 0.97, 1.0], transparent: true },
  leaves: { alpha: 1, color: [1, 1, 1], transparent: false },
  dust: { alpha: 0.4, color: [0.9, 0.82, 0.68], transparent: true },
};
const DEFINE: Record<Particle, string> = { rain: 'RAIN', snow: 'SNOW', leaves: 'LEAF', dust: 'DUST' };

/** Roughness removed at full wetness, and how much the colour darkens (ground, other surfaces). */
const WET_ROUGH = 0.78;
const WET_DARK_GROUND = 0.42;
const WET_DARK_BODY = 0.12;
const SWEEP_EVERY = 0.75;

interface WetRecord {
  roughness: number;
  setRoughness: number;
  color: Color;
  setColor: Color;
}

interface MaterialWithLook extends Material {
  roughness: number;
  color: Color;
  isMeshStandardMaterial?: boolean;
}

export interface WeatherStats {
  kind: WeatherKind;
  /** Instances drawn / buffer size (the tier cap of the kind). */
  count: number;
  cap: number;
  tier: QualityTier;
  wet: number;
  /** Current flash 0–1 and strikes started so far. */
  flash: number;
  strikes: number;
  drawCalls: number;
}

export class Weather {
  readonly group = new Group();
  private mesh: Mesh<InstancedBufferGeometry, ShaderMaterial> | null = null;
  private builtKey = '';
  private settings: WeatherSettings | undefined;
  private time = 0;
  private tier: QualityTier = 'medium';
  private readonly wind: Vec3 = [0, 0, 0];
  private readonly drift: [number, number] = [0, 0];
  private readonly center = new Vector3();
  private readonly fwd = new Vector3();
  private lightning = new LightningScheduler(1);
  private flashScale = 1;
  private readonly overlay: HTMLDivElement;
  private wet = 0;
  private sweepIn = 0;
  private wetRecords = new Map<Material, WetRecord & { ground: boolean }>();
  private readonly scratch = new Color();

  /**
   * @param parent    the scene (or a group) the particles are added to
   * @param container the viewport element: the lightning overlay is added inside it
   * @param wetRoot   object tree whose materials get the wet look (the bodies group)
   * @param ground    the ground slab's material
   */
  constructor(
    parent: Object3D,
    container: HTMLElement,
    private readonly wetRoot: Object3D,
    private readonly ground: Material,
  ) {
    this.group.name = 'weather';
    this.group.visible = false;
    parent.add(this.group);
    const o = document.createElement('div');
    o.setAttribute('aria-hidden', 'true');
    o.dataset.role = 'weather-flash';
    o.style.cssText =
      'position:absolute;inset:0;pointer-events:none;opacity:0;display:none;background:#dbe6ff;mix-blend-mode:screen;';
    container.appendChild(o);
    this.overlay = o;
  }

  /** Apply the scene's weather block (undefined = clear). `seed` is the scene seed: it drives the lightning. */
  setSettings(w: WeatherSettings | undefined, seed = 1): void {
    const prev = this.settings;
    this.settings = w;
    weatherWind(w, this.wind);
    if (!prev || prev.lightning !== w?.lightning || prev.kind !== w?.kind) this.lightning.reseed(seed);
    this.lightning.setIntensity(w?.intensity ?? 0);
    this.sweepIn = 0; // re-apply the wet look at once
    this.syncMesh();
  }

  /** Reduced-motion users: 0 silences the flash overlay, 1 is full strength. */
  setFlashScale(k: number): void {
    this.flashScale = k;
  }

  /** Start a lightning strike now (preview button, tests). */
  triggerLightning(): void {
    this.lightning.trigger();
  }

  get stats(): WeatherStats {
    const kind = this.settings?.kind ?? 'none';
    const geo = this.mesh?.geometry;
    return {
      kind,
      count: this.group.visible && geo ? geo.instanceCount : 0,
      cap: kind === 'none' ? 0 : particleCap(kind, this.tier),
      tier: this.tier,
      wet: this.wet,
      flash: this.lightning.level,
      strikes: this.lightning.strikes,
      drawCalls: this.group.visible ? 1 : 0,
    };
  }

  /** True while something moves, so the viewport keeps rendering. */
  get active(): boolean {
    return this.group.visible;
  }

  /**
   * Per frame. `focus` is what the camera orbits (the particle box is centred between camera and focus).
   * Cheap when the weather is clear: one comparison.
   */
  update(dt: number, camera: Camera, focus: Vector3 | null, tier: QualityTier): void {
    if (tier !== this.tier) {
      this.tier = tier;
      this.syncMesh();
    }
    const w = this.settings;
    const kind = w?.kind ?? 'none';
    // wet look: re-sweep now and then (documents re-assign materials), and once when it ends
    this.sweepIn -= dt;
    if (this.sweepIn <= 0) {
      this.sweepIn = SWEEP_EVERY;
      this.applyWet(effectiveWet(w));
    }
    // lightning
    let flash = 0;
    if (w && w.lightning && kind !== 'none') flash = this.lightning.update(dt);
    else if (this.lightning.level > 0) this.lightning.reseed(1);
    this.setOverlay(flash);

    const mesh = this.mesh;
    if (!mesh || kind === 'none') return;
    this.time += dt;
    const u = mesh.material.uniforms;
    u.uTime.value = this.time;
    camera.getWorldDirection(this.fwd);
    const d = focus ? Math.min(30, Math.max(3, camera.position.distanceTo(focus))) : 12;
    this.center.copy(camera.position).addScaledVector(this.fwd, d * 0.7);
    (u.uCenter.value as Vector3).copy(this.center);
    windDrift(kind, this.wind, this.drift);
    (u.uDrift.value as Vector2).set(this.drift[0], this.drift[1]);
    u.uFlash.value = flash * (kind === 'rain' ? 1 : 0.5) * Math.max(this.flashScale, 0.3);
  }

  private setOverlay(level: number): void {
    const o = this.overlay;
    if (level <= 0.002 || this.flashScale <= 0) {
      if (o.style.display !== 'none') {
        o.style.display = 'none';
        o.style.opacity = '0';
      }
      return;
    }
    // Reduced motion: a single soft, dim flash (no strobing flicker amplitude).
    o.style.display = 'block';
    o.style.opacity = String(Math.min(FLASH_CAP, level * FLASH_CAP) * this.flashScale);
  }

  /** (Re)build the instanced mesh when the kind or the tier changes; resize the drawn count otherwise. */
  private syncMesh(): void {
    const w = this.settings;
    const kind = w?.kind ?? 'none';
    const count = w ? particleCount(kind, this.tier, w.intensity) : 0;
    if (kind === 'none' || count === 0) {
      this.group.visible = false;
      return;
    }
    const cap = particleCap(kind, this.tier);
    const key = `${kind}:${cap}`;
    if (key !== this.builtKey || !this.mesh) {
      this.disposeMesh();
      this.mesh = this.buildMesh(kind, cap);
      this.group.add(this.mesh);
      this.builtKey = key;
    }
    this.mesh.geometry.instanceCount = count;
    this.group.visible = true;
  }

  private buildMesh(kind: Particle, cap: number): Mesh<InstancedBufferGeometry, ShaderMaterial> {
    const geo = new InstancedBufferGeometry();
    geo.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
    );
    geo.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(cap * 4);
    const rnd = mulberry32(0x5eed + cap);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rnd();
    geo.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = cap;
    const look = LOOK[kind];
    const mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: { [DEFINE[kind]]: '' },
      uniforms: {
        uTime: { value: 0 },
        uCenter: { value: new Vector3() },
        uSize: { value: new Vector3(...BOX[kind]) },
        uDrift: { value: new Vector2() },
        uFall: { value: FALL_SPEED[kind] },
        uAlpha: { value: look.alpha },
        uFlash: { value: 0 },
        uColor: { value: new Color(look.color[0], look.color[1], look.color[2]) },
      },
      transparent: look.transparent,
      depthWrite: !look.transparent,
      side: DoubleSide,
      fog: false,
    });
    const mesh = new Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    mesh.name = `weather-${kind}`;
    return mesh;
  }

  private disposeMesh(): void {
    if (!this.mesh) return;
    this.group.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh = null;
    this.builtKey = '';
  }

  // ---- wet look ---------------------------------------------------------------------------------------------

  private applyWet(wet: number): void {
    this.wet = wet;
    if (wet <= 0 && this.wetRecords.size === 0) return;
    const seen = new Set<Material>();
    if (wet > 0) {
      this.wetOne(this.ground, wet, true, seen);
      this.wetRoot.traverse((o) => {
        const m = (o as Mesh).material as Material | Material[] | undefined;
        if (!m) return;
        if (Array.isArray(m)) for (const x of m) this.wetOne(x, wet, false, seen);
        else this.wetOne(m, wet, false, seen);
      });
    }
    // anything we modified earlier that is no longer wet (weather stopped, material gone): restore it
    for (const [m, rec] of this.wetRecords) {
      if (seen.has(m)) continue;
      this.restore(m as MaterialWithLook, rec);
      this.wetRecords.delete(m);
    }
  }

  private wetOne(m: Material, wet: number, ground: boolean, seen: Set<Material>): void {
    const mm = m as MaterialWithLook;
    if (!mm.isMeshStandardMaterial || seen.has(m)) return;
    seen.add(m);
    let rec = this.wetRecords.get(m);
    if (!rec) {
      rec = {
        roughness: mm.roughness,
        setRoughness: mm.roughness,
        color: mm.color.clone(),
        setColor: mm.color.clone(),
        ground,
      };
      this.wetRecords.set(m, rec);
    } else {
      // someone re-assigned the material since our last write (a document edit): that is the new original
      if (mm.roughness !== rec.setRoughness) rec.roughness = mm.roughness;
      if (!mm.color.equals(rec.setColor)) rec.color.copy(mm.color);
    }
    rec.setRoughness = Math.max(0.04, rec.roughness * (1 - WET_ROUGH * wet));
    mm.roughness = rec.setRoughness;
    const dark = 1 - (ground ? WET_DARK_GROUND : WET_DARK_BODY) * wet;
    this.scratch.copy(rec.color).multiplyScalar(dark);
    rec.setColor.copy(this.scratch);
    mm.color.copy(this.scratch);
  }

  private restore(m: MaterialWithLook, rec: WetRecord): void {
    if (m.roughness === rec.setRoughness) m.roughness = rec.roughness;
    if (m.color.equals(rec.setColor)) m.color.copy(rec.color);
  }

  /** Remove everything this object added to the scene and the page. */
  dispose(): void {
    this.applyWet(0);
    this.disposeMesh();
    this.group.parent?.remove(this.group);
    this.overlay.remove();
  }
}
