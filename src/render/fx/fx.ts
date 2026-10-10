/**
 * `Fx` — the visual-effects system and its small public API.
 *
 *     fx.emit('spark', [x, y, z], { count: 12, direction: [0, 1, 0] });     // any registered particle type
 *     fx.explosion([x, y, z], { radius: 7 });                              // fireball, ring, debris, smoke, light
 *     fx.impact({ position, normal, speed, impulse, a, b, … });            // material-dependent impact effects
 *
 * Particles are simulated on the CPU in two pooled structure-of-arrays pools (alpha-blended and additive) and drawn
 * as instanced quads (see `particleRenderer.ts`). The system is deterministic: every `emit` draws from a stream seeded
 * by the scene seed and the call's number (`reseed(seed)` restarts both), and the simulation advances by the `dt` the
 * caller passes — the app passes simulation time, so effects pause with the simulation and slow down with the time
 * scale. Quality tier, master switch and per-effect switches come from `FxSettings` (`configure`).
 *
 * Other packages add effects by registering a `ParticleTypeDef` (`registerParticleType`) and calling `fx.emit`; the
 * wind and gravity the particles feel come from `setEnvironment`.
 */
import { PointLight, type Object3D } from 'three';
import type { Vec3 } from '../../core/math';
import { ParticleEmitter, type EmitOptions } from './emitter';
import { registerBuiltinParticleTypes } from './builtinTypes';
import { explode, type ExplosionLight, type ExplosionOptions } from './explosion';
import { ParticlePool, S, type ParticleEnv } from './particlePool';
import { ParticleRenderer } from './particleRenderer';
import { ParticleTypeTable, particleTypes } from './particleTypes';
import {
  DEFAULT_FX_SETTINGS,
  FX_MAX_PARTICLES,
  FX_MAX_SKID_SEGMENTS,
  resolveTier,
  type FxSettings,
  type FxTier,
  type FxTierId,
} from './settings';
import { SkidBuffer } from './skidBuffer';
import { SkidMarkMesh } from './skidMesh';
import { impactBursts, type FxSurface, type ImpactBurst } from './surfaces';

export type Vec3Like = readonly [number, number, number] | { x: number; y: number; z: number };

/** The share of the particle budget the alpha-blended pool gets (smoke and dust dominate); additive gets the rest. */
const NORMAL_SHARE = 0.62;

export interface FxEnvironment {
  gravity: Vec3;
  /** Constant wind, m/s. */
  wind: Vec3;
  /** Optional wind field; see `ParticleEnv.windAt`. */
  windAt?: ParticleEnv['windAt'];
  /** Height of the ground, or −Infinity when the scene has none. */
  floorY: number;
  /** Ground colour, linear RGB (skid marks are drawn relative to it). */
  groundColor: Vec3;
}

export interface FxStats {
  live: number;
  additive: number;
  normal: number;
  /** The tier's particle budget. */
  budget: number;
  spawned: number;
  overwritten: number;
  /** Emits skipped because they were farther from the camera than the tier allows, or because effects are off. */
  culled: number;
  /** Impact calls that produced bursts. */
  bursts: number;
  explosions: number;
  skidSegments: number;
  skidStrips: number;
}

export interface FxImpact {
  position: Vec3Like;
  /** Unit contact normal (out of `b` towards `a`). */
  normal: Vec3Like;
  speed: number;
  impulse: number;
  a: FxSurface;
  b: FxSurface;
  bIsGround: boolean;
  /** Characteristic size of the smaller body, metres. */
  size?: number;
}

/** One point light, reused by every explosion; its intensity decays exponentially. */
class FlashLight {
  readonly light = new PointLight(0xffa860, 0, 0, 2);
  private peak = 0;
  private decay = 0.1;
  private t = 0;
  /** Scales the peak (reduced-motion users get a gentler flash). */
  scale = 1;

  constructor(parent: Object3D) {
    this.light.name = 'fx-flash';
    this.light.castShadow = false;
    parent.add(this.light);
  }

  trigger(x: number, y: number, z: number, p: ExplosionLight): void {
    const peak = p.intensity * this.scale;
    // A newer, weaker flash does not cut off a stronger one still going.
    if (this.peak * Math.exp(-this.t / this.decay) > peak) return;
    this.light.position.set(x, y, z);
    this.light.color.setRGB(p.color[0], p.color[1], p.color[2]);
    this.light.distance = p.range;
    this.peak = peak;
    this.decay = p.decay;
    this.t = 0;
    this.light.intensity = peak;
  }

  update(dt: number): void {
    if (this.peak <= 0) return;
    this.t += dt;
    const i = this.peak * Math.exp(-this.t / this.decay);
    if (i < this.peak * 0.002 || i < 0.05) {
      this.peak = 0;
      this.light.intensity = 0;
    } else this.light.intensity = i;
  }

  clear(): void {
    this.peak = 0;
    this.light.intensity = 0;
  }

  dispose(): void {
    this.light.removeFromParent();
    this.light.dispose();
  }
}

function xyz(p: Vec3Like): [number, number, number] {
  return 'x' in p ? [p.x, p.y, p.z] : [p[0], p[1], p[2]];
}

export class Fx {
  readonly types = new ParticleTypeTable(particleTypes);
  readonly additive: ParticlePool;
  readonly normal: ParticlePool;
  readonly emitter: ParticleEmitter;
  readonly skidBuffer: SkidBuffer;
  readonly renderer: ParticleRenderer;
  readonly skidMesh: SkidMarkMesh;
  private readonly flash: FlashLight;

  settings: FxSettings = { ...DEFAULT_FX_SETTINGS };
  tier: FxTier;
  /** The effects clock: the sum of the `dt`s passed to `update`. Skid marks age on it. */
  time = 0;
  readonly env: FxEnvironment = {
    gravity: [0, -9.81, 0],
    wind: [0, 0, 0],
    floorY: 0,
    groundColor: [0.024, 0.027, 0.039],
  };

  private cam: [number, number, number] | null = null;
  private culled = 0;
  private bursts = 0;
  private explosions = 0;
  private stamp = 0;

  /**
   * @param parent    scene group the particle meshes, the skid marks and the flash light are added to
   * @param graphics  graphics quality `auto` resolves to (the viewport's)
   */
  constructor(parent: Object3D, graphics: FxTierId = 'medium') {
    registerBuiltinParticleTypes();
    const normalCapacity = Math.ceil(FX_MAX_PARTICLES * NORMAL_SHARE);
    this.normal = new ParticlePool(normalCapacity, this.types);
    this.additive = new ParticlePool(FX_MAX_PARTICLES - normalCapacity, this.types);
    this.emitter = new ParticleEmitter(this.types, this.additive, this.normal);
    this.skidBuffer = new SkidBuffer(FX_MAX_SKID_SEGMENTS);
    this.renderer = new ParticleRenderer(parent, this.additive, this.normal);
    this.skidMesh = new SkidMarkMesh(parent, this.skidBuffer);
    this.flash = new FlashLight(parent);
    this.tier = resolveTier(this.settings.quality, graphics);
    this.configure(this.settings, graphics);
  }

  // -- configuration ---------------------------------------------------------------------------------------------

  /** Apply the settings and the graphics quality `auto` follows. */
  configure(settings: FxSettings, graphics: FxTierId): void {
    const wasOn = this.settings.enabled;
    this.settings = { ...settings };
    this.tier = resolveTier(settings.quality, graphics);
    const budget = this.tier.maxParticles;
    this.normal.limit = Math.min(this.normal.capacity, Math.floor(budget * NORMAL_SHARE));
    this.additive.limit = Math.min(this.additive.capacity, budget - Math.floor(budget * NORMAL_SHARE));
    this.emitter.emission = this.tier.emission * settings.intensity;
    this.emitter.sizeScale = Math.pow(settings.intensity, 0.35);
    this.skidBuffer.setLimit(this.tier.skidSegments);
    if (!settings.enabled && wasOn) this.clear();
  }

  /** Gravity, wind, floor height and ground colour; unspecified fields keep their value. */
  setEnvironment(patch: Partial<FxEnvironment>): void {
    Object.assign(this.env, patch);
    this.renderer.setFloor(this.env.floorY === -Infinity ? -1e6 : this.env.floorY);
    const g = this.env.groundColor;
    this.skidMesh.setGroundColor(g[0], g[1], g[2]);
  }

  /** Restart the random streams from the scene seed (call when a simulation is built or reset). */
  reseed(seed: number): void {
    this.emitter.reseed(seed);
  }

  /** Dim the explosion light (reduced-motion users). */
  setFlashScale(k: number): void {
    this.flash.scale = k;
  }

  // -- emitting --------------------------------------------------------------------------------------------------

  /** Whether an effect at this position is worth spawning (effects on, and within the tier's range of the camera). */
  private wanted(x: number, y: number, z: number): boolean {
    if (!this.settings.enabled) return false;
    const c = this.cam;
    if (!c) return true;
    const d = this.tier.maxDistance;
    const dx = x - c[0];
    const dy = y - c[1];
    const dz = z - c[2];
    return dx * dx + dy * dy + dz * dz <= d * d;
  }

  /** Emit particles of a registered type. Returns how many were created. */
  emit(type: string, position: Vec3Like, options?: EmitOptions): number {
    const [x, y, z] = xyz(position);
    if (!this.wanted(x, y, z)) {
      this.emitter.skip();
      this.culled++;
      return 0;
    }
    return this.emitter.emit(type, x, y, z, options);
  }

  /** Particles emitted per type since the last `clear()`, explosion parts and impact bursts included. */
  emittedByType(): Record<string, number> {
    return Object.fromEntries(this.emitter.counts);
  }

  /** A blast: fireball, shock ring, embers, debris, smoke, and a light flash. Returns false when explosions are off. */
  explosion(position: Vec3Like, options: ExplosionOptions): boolean {
    const [x, y, z] = xyz(position);
    if (!this.settings.explosions || !this.wanted(x, y, z)) {
      this.emitter.skip();
      this.culled++;
      return false;
    }
    this.explosions++;
    const light = explode(this.emitter, x, y, z, { floorY: this.env.floorY, ...options });
    if (this.tier.lightFlash) this.flash.trigger(x, y, z, light);
    return true;
  }

  /**
   * The effects of one impact, from the material pair, the approach speed and the impulse (`impactBursts`). Returns
   * the bursts that were emitted, so the caller can spawn physical debris from the `physical` ones.
   */
  impact(ev: FxImpact): ImpactBurst[] {
    const s = this.settings;
    if (!s.enabled || (!s.impacts && !s.debris)) return [];
    const [x, y, z] = xyz(ev.position);
    if (!this.wanted(x, y, z)) {
      this.culled++;
      return [];
    }
    const [nx, ny, nz] = xyz(ev.normal);
    const bursts = impactBursts({
      speed: ev.speed,
      impulse: ev.impulse,
      a: ev.a,
      b: ev.b,
      bIsGround: ev.bIsGround,
      size: ev.size,
    });
    const done: ImpactBurst[] = [];
    for (const b of bursts) {
      const isDebris = b.type === 'debris';
      if (isDebris ? !s.debris : !s.impacts) continue;
      this.emit(b.type, [x + nx * 0.02 * b.dir, y + ny * 0.02 * b.dir, z + nz * 0.02 * b.dir], {
        count: b.count,
        scale: b.scale,
        speed: b.speed,
        direction: [nx * b.dir, ny * b.dir, nz * b.dir],
        color: b.color,
      });
      done.push(b);
    }
    if (done.length) this.bursts++;
    return done;
  }

  // -- skid marks ------------------------------------------------------------------------------------------------

  /** Start of a scan over the sources of skid marks this frame. */
  beginScan(): void {
    this.stamp++;
  }

  /** A source touches the ground at (x, z) and leaves a mark of the given width, opacity and tone. */
  skid(key: number, x: number, z: number, width: number, alpha: number, tone: number): void {
    if (!this.settings.enabled || !this.settings.skidMarks || !Number.isFinite(this.env.floorY)) return;
    this.skidBuffer.extend(key, x, this.env.floorY + 0.012, z, width, alpha, tone, this.time, this.stamp);
  }

  /** End of the scan: sources that did not report this frame end their strips. */
  endScan(): void {
    this.skidBuffer.endStale(this.stamp);
  }

  clearSkidMarks(): void {
    this.skidBuffer.clear();
  }

  // -- frame -----------------------------------------------------------------------------------------------------

  /** Advance by `dt` seconds of effects time and update what is drawn for this camera. */
  update(dt: number, camera: { position: { x: number; y: number; z: number } }): void {
    const c = camera.position;
    if (!this.cam) this.cam = [c.x, c.y, c.z];
    else {
      this.cam[0] = c.x;
      this.cam[1] = c.y;
      this.cam[2] = c.z;
    }
    if (dt > 0) {
      this.time += dt;
      this.additive.update(dt, this.env);
      this.normal.update(dt, this.env);
      this.flash.update(dt);
    }
    this.renderer.sync(c.x, c.y, c.z);
    this.skidMesh.sync(this.time);
  }

  /** Remove every particle, skid mark and flash (a reset, a new scene, effects switched off). */
  clear(): void {
    this.additive.clear();
    this.normal.clear();
    this.skidBuffer.clear();
    this.flash.clear();
    this.emitter.resetCounts();
    this.renderer.sync(0, 0, 0);
    this.skidMesh.sync(this.time);
  }

  get stats(): FxStats {
    return {
      live: this.additive.count + this.normal.count,
      additive: this.additive.count,
      normal: this.normal.count,
      budget: this.tier.maxParticles,
      spawned: this.additive.stats.spawned + this.normal.stats.spawned,
      overwritten: this.additive.stats.overwritten + this.normal.stats.overwritten,
      culled: this.culled,
      bursts: this.bursts,
      explosions: this.explosions,
      skidSegments: this.skidBuffer.count,
      skidStrips: this.skidBuffer.activeStrips,
    };
  }

  /** How many live particles are of a registered type (tests and tools). */
  liveOfType(id: string): number {
    const slot = this.types.slotOf(id);
    if (slot < 0) return 0;
    let n = 0;
    for (const pool of [this.additive, this.normal])
      for (let i = 0; i < pool.count; i++) if (pool.state[i * S.STRIDE + S.type] === slot) n++;
    return n;
  }

  /** Current intensity of the explosion light, candela (0 when idle). */
  get flashIntensity(): number {
    return this.flash.light.intensity;
  }

  /** A 32-bit digest of the live particle state (FNV-1a over the float bits): equal digests mean equal particles. */
  digest(): number {
    let h = 0x811c9dc5;
    for (const pool of [this.additive, this.normal]) {
      const bits = new Uint32Array(pool.state.buffer, pool.state.byteOffset, pool.count * S.STRIDE);
      for (let i = 0; i < bits.length; i++) h = Math.imul(h ^ bits[i], 0x01000193) >>> 0;
      h = Math.imul(h ^ pool.count, 0x01000193) >>> 0;
    }
    return h;
  }

  dispose(): void {
    this.renderer.dispose();
    this.skidMesh.dispose();
    this.flash.dispose();
  }
}
