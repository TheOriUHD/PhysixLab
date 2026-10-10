/**
 * Environment controller (VZ-10..VZ-13): applies `SceneSettings.environment` + the ground settings to the viewport —
 * sky (preset gradients, physically based Preetham sky, user HDRI), image-based lighting, sun light and its shadow
 * direction, tone mapping + exposure, fog (linear / exponential / height), ground types and horizon blending, and
 * the animated day-night cycle. The document stays the source of truth; this class only mirrors it.
 */
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  Color,
  DataTexture,
  EquirectangularReflectionMapping,
  Fog,
  FogExp2,
  LinearFilter,
  LinearToneMapping,
  MathUtils,
  MeshPhysicalMaterial,
  NeutralToneMapping,
  PMREMGenerator,
  RepeatWrapping,
  Scene,
  Texture,
  Vector3,
  type Mesh,
  type PixelFormat,
  type ShaderMaterial,
  type TextureDataType,
  type ToneMapping,
  type WebGLRenderTarget,
} from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { decodeBlob } from '../model/assets';
import { defaultEnvironment } from '../model/factory';
import type { BlobAsset, EnvironmentSettings, GroundSettings, ToneMappingName } from '../model/types';
import {
  buildEnvScene,
  disposeEnvScene,
  ENV_PRESET_BY_ID,
  ENV_PRESETS,
  sunDirection,
  sunFromTime,
  type EnvPresetDef,
} from './envPresets';
import { heightFogParams, installHeightFog } from './fogChunks';
import { canvasTextureFromRgba } from './materialBuild';
import { heightToNormal, renderPattern } from './proceduralTextures';
import type { Viewport } from './viewport';

installHeightFog();

const TONE: Record<ToneMappingName, ToneMapping> = {
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
  neutral: NeutralToneMapping,
  linear: LinearToneMapping,
};

const NIGHT = ENV_PRESET_BY_ID.get('night') as EnvPresetDef;
const STUDIO = ENV_PRESET_BY_ID.get('studio') as EnvPresetDef;

/** Seconds between lighting rebuilds while the day cycle (or a slider drag) keeps changing the sky. */
const REBAKE_MIN_INTERVAL = 0.5;

const smooth = (a: number, b: number, x: number) => {
  const t = MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export class EnvironmentController {
  private env: EnvironmentSettings = defaultEnvironment();
  private ground: GroundSettings | null = null;
  private readonly pmrem: PMREMGenerator;
  private envMap: WebGLRenderTarget | null = null;
  private envKey = '';
  private pendingBake = false;
  private sinceBake = 99;
  private sky: Sky | null = null;
  private skyBake: Sky | null = null;
  private hdri: { key: string; tex: Texture; rt: WebGLRenderTarget } | null = null;
  private hdriLoading = '';
  private hdriFailed = '';
  private lastTimeOfDay = -1;
  /** Reports problems (an unreadable HDRI) to the user. Wired by the application. */
  onError: ((message: string) => void) | null = null;
  private readonly dir = new Vector3(0, 1, 0);
  private cycleHours: number | null = null;
  private readonly tmpA = new Color();
  private readonly tmpB = new Color();
  private readonly groundUniforms = {
    uHorizon: { value: new Color('#27344a') },
    uNear: { value: 20 },
    uFar: { value: 70 },
    uBlend: { value: 0 },
  };
  private slabMat: MeshPhysicalMaterial;
  private groundKey = '';
  private waterNormal: Texture | null = null;
  private checkerTex: Texture | null = null;
  /** Looks up a blob asset (HDRI) by id. Wired by the application. */
  assetLookup: (id: string) => BlobAsset | undefined = () => undefined;
  /** Asks the application to redraw. */
  constructor(private vp: Viewport) {
    this.pmrem = new PMREMGenerator(vp.renderer);
    const old = vp.slab.material as MeshPhysicalMaterial;
    this.slabMat = new MeshPhysicalMaterial({ color: old.color.clone(), roughness: 0.92, metalness: 0 });
    this.slabMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.groundUniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform vec3 uHorizon; uniform float uNear; uniform float uFar; uniform float uBlend;',
        )
        .replace(
          '#include <dithering_fragment>',
          '#include <dithering_fragment>\n  gl_FragColor.rgb = mix( gl_FragColor.rgb, uHorizon, smoothstep( uNear, uFar, length( vViewPosition ) ) * uBlend );',
        );
    };
    this.slabMat.customProgramCacheKey = () => 'groundblend';
    vp.slab.material = this.slabMat;
    old.dispose();
  }

  /** Current sun direction (unit vector toward the sun). */
  get sunDir(): Vector3 {
    return this.dir;
  }

  /** Re-apply the document's environment + ground. Cheap enough to call on every settings change. */
  apply(env: EnvironmentSettings, ground: GroundSettings): void {
    this.env = env;
    this.ground = ground;
    if (!env.cycle.enabled) this.cycleHours = null;
    else if (this.cycleHours === null || env.timeOfDay !== this.lastTimeOfDay) this.cycleHours = env.timeOfDay;
    this.lastTimeOfDay = env.timeOfDay;
    this.update(true);
  }

  /** Per frame: advance the day-night cycle and animate water. */
  tick(dt: number): void {
    this.sinceBake += dt;
    if (this.env.cycle.enabled && this.cycleHours !== null) {
      this.cycleHours = (this.cycleHours + dt * this.env.cycle.hoursPerSecond) % 24;
      this.update(false);
    } else if (this.pendingBake && this.sinceBake >= REBAKE_MIN_INTERVAL) {
      this.update(false);
    }
    if (this.groundKey.startsWith('water') && this.waterNormal) {
      this.waterNormal.offset.x = (this.waterNormal.offset.x + dt * 0.012) % 1;
      this.waterNormal.offset.y = (this.waterNormal.offset.y + dt * 0.007) % 1;
      this.vp.needsRender = true;
    }
  }

  /** Solar time currently shown (the cycle's running clock, else the stored time of day). */
  get hours(): number {
    return this.cycleHours ?? this.env.timeOfDay;
  }

  // ---- sky, lighting, sun ---------------------------------------------------------------------

  private presetOf(env: EnvironmentSettings): EnvPresetDef {
    return ENV_PRESET_BY_ID.get(env.sky) ?? STUDIO;
  }

  private update(force: boolean): void {
    const { vp, env } = this;
    const physical = env.sky === 'physical';
    const hdri = env.sky === 'hdri';
    const preset = this.presetOf(env);
    const cycling = this.cycleHours !== null;

    // sun direction
    let az = env.sun.azimuth;
    let el = env.sun.elevation;
    if (cycling) ({ azimuth: az, elevation: el } = sunFromTime(this.cycleHours as number));
    sunDirection(az, el, this.dir);
    vp.sunDir.copy(this.dir);
    const sinE = this.dir.y;
    const day = smooth(-0.04, 0.2, sinE);
    const dynamic = physical || cycling;

    // tone mapping + exposure (the physical sky is HDR-bright: leave it room)
    vp.renderer.toneMapping = TONE[env.toneMapping];
    vp.renderer.toneMappingExposure = 1.05 * env.exposure * (physical ? 0.55 : 1);

    // sun light
    const sunBase = hdri ? 1.5 : physical ? 5.5 : preset.sunIntensity;
    vp.sun.intensity = sunBase * env.sun.intensity * (dynamic ? day : 1);
    this.tmpA.set(hdri || physical ? '#fff3e0' : preset.sunColor);
    if (dynamic) this.tmpA.lerp(this.tmpB.set('#ff7a2e'), (1 - smooth(0, 0.3, sinE)) * 0.8);
    vp.sun.color.copy(this.tmpA);
    vp.ambient.color.set(hdri ? '#ffffff' : preset.ambientColor);
    vp.ambient.intensity = (hdri ? 0.1 : preset.ambientIntensity) * (dynamic ? 0.25 + 0.75 * day : 1);

    // visible sky
    const bg = vp.skyMesh.material as ShaderMaterial;
    vp.skyMesh.visible = !physical && !(hdri && this.hdri && env.hdri.showBackground);
    const sp = hdri ? STUDIO : preset;
    const zenith = bg.uniforms.uZenith.value as Color;
    const horizon = bg.uniforms.uHorizon.value as Color;
    const ground = bg.uniforms.uGround.value as Color;
    zenith.set(sp.zenith);
    horizon.set(sp.horizon);
    ground.set(sp.ground);
    if (cycling && !physical) {
      const k = 1 - day;
      zenith.lerp(this.tmpB.set(NIGHT.zenith), k);
      horizon.lerp(this.tmpB.set(NIGHT.horizon), k);
      ground.lerp(this.tmpB.set(NIGHT.ground), k);
    }
    this.groundUniforms.uHorizon.value.copy(
      physical
        ? this.tmpB.set('#a9c3e0').lerp(this.tmpA.set('#04060b'), 1 - day)
        : hdri
          ? this.tmpB.set('#8c96a3')
          : horizon,
    );

    this.updatePhysicalSky(physical, force);

    // lighting bake (image-based lighting)
    const q = (v: number) => Math.round(v / 2) * 2;
    const dyn = physical || (cycling && preset.sunIntensity > 1);
    const key = hdri
      ? `hdri|${env.hdri.assetId}|${env.hdri.rotation}`
      : physical
        ? `phys|${q(az)}|${q(el)}|${env.sun.turbidity}|${env.sun.rayleigh}`
        : `preset|${env.sky}|${dyn ? `${q(az)}|${q(el)}` : `${Math.round(az)}|${Math.round(el)}`}`;
    if (key !== this.envKey) {
      if (this.sinceBake < REBAKE_MIN_INTERVAL && !force) this.pendingBake = true;
      else this.bake(key);
    }
    vp.scene.environmentIntensity =
      (hdri ? env.hdri.intensity : preset.envIntensity * (physical ? 0.9 : 1)) * (dynamic ? 0.12 + 0.88 * day : 1);

    if (hdri && this.hdri) this.applyHdri(this.hdri);
    this.updateFog();
    if (this.ground) this.updateGround(this.ground);
    vp.needsRender = true;
  }

  private updatePhysicalSky(on: boolean, force: boolean): void {
    const { vp } = this;
    if (!on) {
      if (this.sky) this.sky.visible = false;
      return;
    }
    if (!this.sky) {
      this.sky = new Sky();
      this.sky.scale.setScalar(90000);
      this.sky.frustumCulled = false;
      this.sky.renderOrder = -10;
      vp.scene.add(this.sky);
    }
    this.sky.visible = true;
    this.setSkyUniforms(this.sky, true);
    void force;
  }

  private setSkyUniforms(sky: Sky, sunDisc: boolean): void {
    const u = sky.material.uniforms as Record<string, { value: unknown }>;
    u.turbidity.value = this.env.sun.turbidity;
    u.rayleigh.value = this.env.sun.rayleigh;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.8;
    (u.sunPosition.value as Vector3).copy(this.dir);
    if (u.showSunDisc) u.showSunDisc.value = sunDisc;
  }

  /** Keep the sky dome around the camera. */
  followCamera(pos: Vector3): void {
    if (this.sky?.visible) this.sky.position.copy(pos);
  }

  private bake(key: string): void {
    const { vp, env } = this;
    this.pendingBake = false;
    this.sinceBake = 0;
    if (env.sky === 'hdri') {
      this.envKey = key;
      this.bakeHdri(key);
      return;
    }
    let scene: Scene;
    let owned = true;
    if (env.sky === 'physical') {
      scene = new Scene();
      this.skyBake = this.skyBake ?? new Sky();
      this.skyBake.scale.setScalar(90);
      this.setSkyUniforms(this.skyBake, false);
      scene.add(this.skyBake);
      owned = false;
    } else {
      scene = buildEnvScene(this.presetOf(env), this.dir);
    }
    const next = this.pmrem.fromScene(scene, env.sky === 'physical' ? 0 : 0.03, 0.1, 1000);
    if (owned) disposeEnvScene(scene);
    this.envMap?.dispose();
    this.envMap = next;
    this.envKey = key;
    vp.scene.environment = next.texture;
    vp.scene.background = null;
    vp.scene.environmentRotation.set(0, 0, 0);
    vp.scene.backgroundBlurriness = 0;
  }

  private bakeHdri(key: string): void {
    const { vp, env } = this;
    const id = env.hdri.assetId;
    const asset = id ? this.assetLookup(id) : undefined;
    const failed = asset && this.hdriFailed === `${asset.id}:${asset.hash}`;
    if (!asset || failed) {
      // nothing usable: studio lighting until the user supplies a (readable) file
      const scene = buildEnvScene(STUDIO, this.dir);
      const next = this.pmrem.fromScene(scene, 0.03);
      disposeEnvScene(scene);
      this.envMap?.dispose();
      this.envMap = next;
      vp.scene.environment = next.texture;
      vp.scene.background = null;
      return;
    }
    const cacheKey = `${asset.id}:${asset.hash}`;
    if (this.hdri?.key === cacheKey) {
      this.applyHdri(this.hdri);
      return;
    }
    if (this.hdriLoading === cacheKey) return;
    this.hdriLoading = cacheKey;
    void this.loadHdri(asset).then((tex) => {
      if (this.hdriLoading !== cacheKey) {
        tex?.dispose();
        return;
      }
      this.hdriLoading = '';
      if (!tex) {
        this.hdriFailed = cacheKey;
        this.onError?.(
          `“${asset.name}” could not be read as an HDRI (use a Radiance .hdr, an OpenEXR .exr or a .jpg / .png panorama).`,
        );
        this.envKey = '';
        this.update(true);
        return;
      }
      tex.mapping = EquirectangularReflectionMapping;
      const rt = this.pmrem.fromEquirectangular(tex);
      if (this.hdri) {
        this.hdri.tex.dispose();
        this.hdri.rt.dispose();
      }
      this.hdri = { key: cacheKey, tex, rt };
      this.envKey = key;
      if (this.env.sky === 'hdri') {
        this.applyHdri(this.hdri);
        this.update(false);
      }
    });
    void key;
  }

  private applyHdri(h: { tex: Texture; rt: WebGLRenderTarget }): void {
    const { vp, env } = this;
    vp.scene.environment = h.rt.texture;
    const rot = (env.hdri.rotation * Math.PI) / 180;
    vp.scene.environmentRotation.set(0, rot, 0);
    vp.scene.backgroundRotation.set(0, rot, 0);
    vp.scene.background = env.hdri.showBackground ? h.tex : null;
    vp.scene.backgroundBlurriness = env.hdri.backgroundBlur;
    vp.scene.backgroundIntensity = env.hdri.intensity;
    vp.skyMesh.visible = !env.hdri.showBackground;
  }

  private async loadHdri(asset: BlobAsset): Promise<Texture | null> {
    try {
      const bytes = decodeBlob(asset);
      const name = asset.name.toLowerCase();
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      if (name.endsWith('.hdr') || asset.mime.includes('radiance')) {
        const data = new RGBELoader().parse(buf);
        return dataTexture(data);
      }
      if (name.endsWith('.exr')) {
        const data = new EXRLoader().parse(buf);
        return dataTexture(data);
      }
      const bmp = await createImageBitmap(new Blob([buf], { type: asset.mime || 'image/jpeg' }), {
        imageOrientation: 'flipY',
      });
      const tex = new Texture(bmp as unknown as HTMLImageElement);
      tex.colorSpace = 'srgb';
      tex.needsUpdate = true;
      return tex;
    } catch {
      return null;
    }
  }

  /** The HDRI of the current scene is loaded and usable. */
  get hdriReady(): boolean {
    return !!this.hdri;
  }

  // ---- fog ------------------------------------------------------------------------------------

  private updateFog(): void {
    const { vp, env } = this;
    const f = env.fog;
    if (!f.enabled) {
      vp.scene.fog = null;
      return;
    }
    if (f.type === 'linear') {
      if (vp.scene.fog instanceof Fog && vp.scene.fog.far > 0) {
        vp.scene.fog.color.set(f.color);
        vp.scene.fog.near = f.near;
        vp.scene.fog.far = Math.max(f.far, f.near + 0.1);
      } else vp.scene.fog = new Fog(f.color, f.near, Math.max(f.far, f.near + 0.1));
    } else if (f.type === 'exp') {
      if (vp.scene.fog instanceof FogExp2) {
        vp.scene.fog.color.set(f.color);
        vp.scene.fog.density = f.density;
      } else vp.scene.fog = new FogExp2(f.color, f.density);
    } else {
      const p = heightFogParams(f.density, f.height, f.falloff);
      if (vp.scene.fog instanceof Fog && vp.scene.fog.far < 0) {
        vp.scene.fog.color.set(f.color);
        vp.scene.fog.near = p.near;
        vp.scene.fog.far = p.far;
      } else vp.scene.fog = new Fog(f.color, p.near, p.far);
    }
  }

  // ---- ground ---------------------------------------------------------------------------------

  /** The viewport sized / coloured the ground; this applies the ground *type* and horizon blend on top. */
  onGround(g: GroundSettings): void {
    this.ground = g;
    this.updateGround(g);
  }

  private updateGround(g: GroundSettings): void {
    const { vp } = this;
    const type = g.type ?? 'grid';
    const show = g.enabled && type !== 'none';
    vp.slab.visible = vp.shadowCatcher.visible = show;
    vp.grid.visible = show && type === 'grid';
    const half = g.halfSize;
    const key = `${type}|${g.color}|${half}`;
    const m = this.slabMat;
    if (key !== this.groundKey) {
      this.groundKey = key;
      m.map = null;
      m.normalMap = null;
      m.clearcoat = 0;
      m.roughness = 0.92;
      m.metalness = 0;
      m.color.set(g.color);
      if (type === 'checker') {
        const tex = this.checkerTexture(g.color);
        tex.repeat.set(half / 8, half / 8);
        m.map = tex;
        m.color.set('#ffffff');
        m.roughness = 0.85;
      } else if (type === 'water') {
        m.color.set('#1f6f9c');
        m.roughness = 0.05;
        m.clearcoat = 1;
        m.clearcoatRoughness = 0.04;
        const n = this.waterNormalTexture();
        n.repeat.set(half / 6, half / 6);
        m.normalMap = n;
        m.normalScale.set(0.5, 0.5);
      }
      m.needsUpdate = true;
    }
    const blend = g.horizonBlend ?? 0.5;
    this.groundUniforms.uBlend.value = Math.min(1, blend * 1.6);
    this.groundUniforms.uNear.value = half * 0.4;
    this.groundUniforms.uFar.value = half * 1.15;
  }

  private checkerTexture(color: string): Texture {
    this.checkerTex?.dispose();
    const c = new Color(color);
    const light = `#${c.clone().offsetHSL(0, 0, 0.12).getHexString()}`;
    const buf = renderPattern('checker', color, light, 128);
    this.checkerTex = canvasTextureFromRgba(buf.color, 128, 'srgb');
    return this.checkerTex;
  }

  private waterNormalTexture(): Texture {
    if (!this.waterNormal) {
      const buf = renderPattern('noise', '#000000', '#ffffff', 256);
      this.waterNormal = canvasTextureFromRgba(heightToNormal(buf.height, 256, 6), 256, 'srgb-linear');
      this.waterNormal.wrapS = this.waterNormal.wrapT = RepeatWrapping;
    }
    return this.waterNormal;
  }

  dispose(): void {
    this.envMap?.dispose();
    this.hdri?.tex.dispose();
    this.hdri?.rt.dispose();
    this.waterNormal?.dispose();
    this.checkerTex?.dispose();
    this.slabMat.dispose();
    this.pmrem.dispose();
    this.sky?.material.dispose();
    this.skyBake?.material.dispose();
  }
}

interface RawImage {
  data?: unknown;
  width?: number;
  height?: number;
  type?: TextureDataType;
  format?: PixelFormat;
  flipY?: boolean;
  colorSpace?: string;
}

function dataTexture(img: RawImage): Texture {
  // Loader output is a plain image description; DataTexture is created lazily to keep this file's imports small.
  const tex = new DataTexture(img.data as Float32Array, img.width ?? 1, img.height ?? 1, img.format, img.type);
  tex.colorSpace = img.colorSpace ?? 'srgb-linear';
  tex.flipY = img.flipY ?? false;
  tex.minFilter = tex.magFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export { ENV_PRESETS };
export type { Mesh };
