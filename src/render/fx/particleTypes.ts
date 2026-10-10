/**
 * Particle types: the registry every effect is described in, and the tables the particle pool reads while it runs.
 *
 * A `ParticleTypeDef` is data — sprite, lifetime, size / opacity / colour over life, speed, gravity, drag, wind,
 * floor bounce — so a package adds an effect with one `registerParticleType()` call and emits it with
 * `fx.emit('my.type', position)`. The registry is a `Registry<T>`: ids are validated, duplicates throw, and
 * `registerParticleType` returns the function that unregisters again.
 *
 * The pool does not read definitions while it simulates. Each type is compiled once into a `CompiledType`: the
 * over-life curves are sampled into 32-entry look-up tables (`LUT_N`), the scalars are packed into a row of a
 * `Float32Array`, and the type gets a stable slot number that particles carry. A slot is never reused or reordered,
 * so a type unregistered while its particles are alive still finishes its animation.
 *
 * Colours are authored as sRGB hex strings and stored as linear radiance (a stop may exceed 1 for a glow), because
 * the renderer composes in linear light and tone-maps afterwards.
 */
import { Registry } from '../../core/registry';
import { SPRITE_NAMES, spriteFrame, type SpriteName } from './sprites';

/** `[t, value]` keyframes over normalised life, ascending in t, linear in between. */
export type Keyframes = readonly (readonly [t: number, value: number])[];
/** `[t, '#rrggbb', intensity?]` colour stops over normalised life. */
export type ColorStops = readonly (readonly [t: number, hex: string, intensity?: number])[];

export type ParticleBlend = 'additive' | 'normal';
/** `billboard` faces the camera, `velocity` is a streak along the screen-space velocity, `flat` lies on the ground. */
export type ParticleOrient = 'billboard' | 'velocity' | 'flat';

export interface ParticleTypeDef {
  id: string;
  label?: string;
  blend: ParticleBlend;
  /** Sprite chosen at random per particle. */
  sprites: readonly SpriteName[];
  /** Lifetime range, seconds. */
  life: readonly [number, number];
  /** Size range at spawn, metres (the width of the quad). */
  size: readonly [number, number];
  /** Multiplier of the size over life. */
  sizeOverLife: Keyframes;
  alphaOverLife: Keyframes;
  colorOverLife: ColorStops;
  /** Initial speed range along the emission direction, m/s. */
  speed: readonly [number, number];
  /** Half-angle of the emission cone, radians (π = every direction). */
  spread: number;
  /** Multiplier of the scene gravity: 1 falls, 0 floats, negative rises. */
  gravity: number;
  /** Exponential velocity decay, 1/s (relative to the wind for a type with `wind`). */
  drag: number;
  /** 0 … 1: how strongly the wind carries the particle. */
  wind: number;
  /** Fraction of the emitter's velocity a particle inherits. */
  inherit?: number;
  /** Spin range, rad/s (sign chosen at random). */
  spin: readonly [number, number];
  orient: ParticleOrient;
  /** `velocity` orientation: extra streak length per m/s of screen-space speed. */
  stretch?: number;
  /** Lateral wobble, m/s² (smoke curling). */
  swirl?: number;
  /** Floor restitution; 0 = the particle ignores the floor. */
  bounce: number;
  /** Fraction of the horizontal speed kept per bounce. */
  floorFriction?: number;
  /** After the last bounce the particle lies flat on the floor until it expires. */
  settle?: boolean;
  /** Fade out within a few centimetres of the floor, so large soft puffs do not show a hard cut where they meet it. */
  softFloor?: boolean;
  /** Default particle count of one `emit`. */
  count: number;
  /** Default spawn radius, metres. */
  radius: number;
}

export const LUT_N = 32;
/** Channels per type LUT, in order: size, alpha, r, g, b. */
export const LUT_CH = 5;

/** Scalars per type in `ParticleTypeTable.params`. */
export const P = {
  gravity: 0,
  drag: 1,
  wind: 2,
  bounce: 3,
  friction: 4,
  swirl: 5,
  stretch: 6,
  orient: 7, // 0 billboard, 1 velocity, 2 flat
  settle: 8,
  softFloor: 9,
  blend: 10, // 0 normal, 1 additive
  inherit: 11,
  STRIDE: 12,
} as const;

export interface CompiledType {
  slot: number;
  def: ParticleTypeDef;
  /** Sprite frame numbers for `def.sprites`. */
  frames: Uint8Array;
}

// -- colour helpers --------------------------------------------------------------------------------------------

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const HEX = /^#?([0-9a-fA-F]{6})$/;

/** `#rrggbb` → linear RGB in 0 … 1; null when the string is not a six-digit hex colour. */
export function hexToLinear(hex: string): [number, number, number] | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}

// -- validation ------------------------------------------------------------------------------------------------

function checkRange(id: string, what: string, r: readonly [number, number], min: number, max: number): void {
  if (!r || r.length !== 2 || !Number.isFinite(r[0]) || !Number.isFinite(r[1]) || r[0] > r[1])
    throw new Error(`Particle type "${id}": ${what} must be [min, max] with min <= max`);
  if (r[0] < min || r[1] > max) throw new Error(`Particle type "${id}": ${what} must lie within ${min} … ${max}`);
}

function checkKeys(id: string, what: string, k: Keyframes): void {
  if (!k || k.length === 0) throw new Error(`Particle type "${id}": ${what} needs at least one keyframe`);
  let last = -1;
  for (const [t, v] of k) {
    if (!Number.isFinite(t) || !Number.isFinite(v) || t < 0 || t > 1 || t < last)
      throw new Error(`Particle type "${id}": ${what} keyframes must be [t, value] with t ascending within 0 … 1`);
    last = t;
  }
}

export function validateParticleType(def: ParticleTypeDef): void {
  const id = def.id;
  if (def.blend !== 'additive' && def.blend !== 'normal')
    throw new Error(`Particle type "${id}": blend must be 'additive' or 'normal'`);
  if (!def.sprites?.length) throw new Error(`Particle type "${id}": needs at least one sprite`);
  for (const s of def.sprites)
    if (!SPRITE_NAMES.includes(s))
      throw new Error(`Particle type "${id}": unknown sprite "${String(s)}" (known: ${SPRITE_NAMES.join(', ')})`);
  checkRange(id, 'life', def.life, 0.02, 60);
  checkRange(id, 'size', def.size, 0.001, 200);
  checkRange(id, 'speed', def.speed, 0, 500);
  checkRange(id, 'spin', def.spin, 0, 200);
  checkKeys(id, 'sizeOverLife', def.sizeOverLife);
  checkKeys(id, 'alphaOverLife', def.alphaOverLife);
  if (!def.colorOverLife?.length) throw new Error(`Particle type "${id}": colorOverLife needs at least one stop`);
  for (const [t, hex] of def.colorOverLife)
    if (!(t >= 0 && t <= 1) || !hexToLinear(hex))
      throw new Error(`Particle type "${id}": colour stops must be [t, '#rrggbb', intensity?]`);
  for (const [k, v] of [
    ['spread', def.spread],
    ['gravity', def.gravity],
    ['drag', def.drag],
    ['wind', def.wind],
    ['bounce', def.bounce],
    ['count', def.count],
    ['radius', def.radius],
  ] as const)
    if (!Number.isFinite(v)) throw new Error(`Particle type "${id}": ${k} must be a number`);
  if (def.spread < 0 || def.spread > Math.PI) throw new Error(`Particle type "${id}": spread must lie within 0 … π`);
  if (def.count < 0) throw new Error(`Particle type "${id}": count must not be negative`);
  if (def.bounce < 0 || def.bounce > 1) throw new Error(`Particle type "${id}": bounce must lie within 0 … 1`);
}

/** The registry of particle types. Built-ins are registered by `builtinTypes.ts`. */
export const particleTypes = new Registry<ParticleTypeDef>({ kind: 'particle type', validate: validateParticleType });

export function registerParticleType(def: ParticleTypeDef): () => void {
  return particleTypes.register(def);
}

// -- compilation ------------------------------------------------------------------------------------------------

function sampleKeys(k: Keyframes, t: number): number {
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i][0]) {
      const [t0, v0] = k[i - 1];
      const [t1, v1] = k[i];
      return t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v1;
    }
  }
  return k[k.length - 1][1];
}

function sampleColor(stops: ColorStops, t: number, out: [number, number, number]): void {
  const lin = (i: number): [number, number, number] => {
    const s = stops[i];
    const c = hexToLinear(s[1]) as [number, number, number];
    const k = s[2] ?? 1;
    return [c[0] * k, c[1] * k, c[2] * k];
  };
  if (t <= stops[0][0] || stops.length === 1) {
    const c = lin(0);
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    return;
  }
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0] || i === stops.length - 1) {
      const a = lin(i - 1);
      const b = lin(i);
      const f =
        stops[i][0] > stops[i - 1][0]
          ? Math.min(1, Math.max(0, (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0])))
          : 1;
      out[0] = a[0] + (b[0] - a[0]) * f;
      out[1] = a[1] + (b[1] - a[1]) * f;
      out[2] = a[2] + (b[2] - a[2]) * f;
      return;
    }
  }
}

/** Sample a definition into the look-up table layout (`LUT_CH` channels of `LUT_N` entries). */
export function compileLut(def: ParticleTypeDef): Float32Array {
  const lut = new Float32Array(LUT_CH * LUT_N);
  const rgb: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < LUT_N; k++) {
    const t = k / (LUT_N - 1);
    lut[k] = sampleKeys(def.sizeOverLife, t);
    lut[LUT_N + k] = sampleKeys(def.alphaOverLife, t);
    sampleColor(def.colorOverLife, t, rgb);
    lut[2 * LUT_N + k] = rgb[0];
    lut[3 * LUT_N + k] = rgb[1];
    lut[4 * LUT_N + k] = rgb[2];
  }
  return lut;
}

/**
 * The compiled form of the registry: slot numbers, look-up tables and packed scalars. `sync()` picks up types
 * registered since the last call (cheap when nothing changed). `lut` and `params` may be reallocated when the table
 * grows, so read them from the table on every use rather than caching them.
 */
export class ParticleTypeTable {
  /** `slots[slot]` — undefined for a slot whose id was never compiled. */
  readonly slots: CompiledType[] = [];
  private readonly byId = new Map<string, number>();
  private readonly defs = new Map<string, ParticleTypeDef>();
  lut = new Float32Array(0);
  params = new Float32Array(0);
  private seen = -1;

  constructor(private readonly registry: Registry<ParticleTypeDef> = particleTypes) {}

  /** Compile every type that is new or was re-registered with a different definition. */
  sync(): void {
    if (this.seen === this.registry.revision) return;
    this.seen = this.registry.revision;
    for (const def of this.registry.list()) {
      if (this.defs.get(def.id) === def) continue;
      this.defs.set(def.id, def);
      const slot = this.byId.get(def.id) ?? this.slots.length;
      this.byId.set(def.id, slot);
      this.ensure(slot + 1);
      this.slots[slot] = {
        slot,
        def,
        frames: Uint8Array.from(def.sprites.map(spriteFrame)),
      };
      this.lut.set(compileLut(def), slot * LUT_CH * LUT_N);
      const o = slot * P.STRIDE;
      const p = this.params;
      p[o + P.gravity] = def.gravity;
      p[o + P.drag] = def.drag;
      p[o + P.wind] = def.wind;
      p[o + P.bounce] = def.bounce;
      p[o + P.friction] = def.floorFriction ?? 0.6;
      p[o + P.swirl] = def.swirl ?? 0;
      p[o + P.stretch] = def.stretch ?? 0;
      p[o + P.orient] = def.orient === 'velocity' ? 1 : def.orient === 'flat' ? 2 : 0;
      p[o + P.settle] = def.settle ? 1 : 0;
      p[o + P.softFloor] = def.softFloor ? 1 : 0;
      p[o + P.blend] = def.blend === 'additive' ? 1 : 0;
      p[o + P.inherit] = def.inherit ?? 0;
    }
  }

  private ensure(slots: number): void {
    if (this.params.length >= slots * P.STRIDE) return;
    const n = Math.max(slots, Math.ceil(this.slots.length * 1.5), 16);
    const lut = new Float32Array(n * LUT_CH * LUT_N);
    lut.set(this.lut);
    const params = new Float32Array(n * P.STRIDE);
    params.set(this.params);
    this.lut = lut;
    this.params = params;
  }

  /** The slot of a registered type id, or -1. */
  slotOf(id: string): number {
    this.sync();
    return this.byId.get(id) ?? -1;
  }

  /** The compiled type of a *registered* id, or undefined (a type unregistered since keeps animating its live particles). */
  get(id: string): CompiledType | undefined {
    if (!this.registry.has(id)) return undefined;
    const s = this.slotOf(id);
    return s < 0 ? undefined : this.slots[s];
  }
}
