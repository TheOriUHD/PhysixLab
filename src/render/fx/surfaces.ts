/**
 * Surfaces and impacts: how a material looks when it is hit, and which effects an impact produces.
 *
 * A contact event (protocol v2) names the two material presets and carries the contact's normal impulse and approach
 * speed. `impactBursts` turns that into a list of particle bursts, entirely from physical quantities:
 *
 *   - **energy** `E = ½·J·v` (J = normal impulse, v = approach speed) is, for a central impact, the kinetic energy that
 *     went into the contact (`J = m_eff (1 + e) v`, so `½ J v = ½ m_eff (1 + e) v²` — within a factor (1 + e)/1 of
 *     the exact ½ m v²). The **level** is its logarithm mapped to 0 … 1 (0.3 J → 0, 30 kJ → 1), so a ping-pong ball and a
 *     wrecking ball both get an effect in proportion. Bodies in this world have real masses (a steel ball 0.4 m across
 *     weighs 260 kg), so the **intensity** also weighs in how fast the hit was: `level^0.7 · (0.35 + 0.65·v/14)`.
 *   - **speed** gates the effect: a body resting or sliding gently makes no sparks, whatever its mass.
 *   - the **pair** decides the look: metal on a hard surface throws sparks, anything on concrete or the ground puffs
 *     dust, wood sheds chips when something harder hits it, glass shatters into shards and glints, rubber scuffs,
 *     brittle materials hit hard throw larger debris chunks.
 *
 * Surface profiles live in a registry keyed by material preset id (`registerFxSurface`), with a fallback derived from
 * the preset's physical numbers for presets nobody described — a package that adds a material adds one profile.
 * Everything here is pure and deterministic; `tests/fxSurfaces.test.ts` covers it.
 */
import type { Vec3 } from '../../core/math';
import { PRESET_BY_ID } from '../../model/materials';
import { hexToLinear } from './particleTypes';

export type FxSurfaceClass = 'metal' | 'stone' | 'wood' | 'glass' | 'rubber' | 'plastic' | 'foam' | 'ice' | 'earth';

export interface FxSurface {
  cls: FxSurfaceClass;
  /** 0 (foam) … 1 (steel): how hard it is — decides who chips whom and who sparks against whom. */
  hardness: number;
  /** 0 … 1: tendency to shed fragments when hit hard. */
  brittle: number;
  /** 0 … 1: tendency to raise dust. */
  dust: number;
  /** 0 … 1: tendency to throw sparks against a hard partner. */
  spark: number;
  /** Particle type of its chips, or null. */
  chip: string | null;
  /** Colour of this body (linear RGB) — the preset's, or the body's own paint. */
  color: Vec3;
  /** The preset's own colour (linear RGB), the reference the chip colours were authored for. */
  base: Vec3;
  /** Skid mark this surface leaves when it slides: tone 0 (black) … 1 (pale), opacity; null = leaves none. */
  skid: { tone: number; alpha: number } | null;
}

type Profile = Omit<FxSurface, 'color' | 'base'>;

const PROFILES = new Map<string, Profile>();

/** Describe how a material preset behaves in impacts. Returns the function that removes the profile again. */
export function registerFxSurface(presetId: string, profile: Profile): () => void {
  PROFILES.set(presetId, profile);
  return () => {
    if (PROFILES.get(presetId) === profile) PROFILES.delete(presetId);
  };
}

const metal = (hardness: number, spark: number, skid: Profile['skid']): Profile => ({
  cls: 'metal',
  hardness,
  brittle: 0,
  dust: 0,
  spark,
  chip: null,
  skid,
});

const BUILTIN: Record<string, Profile> = {
  steel: metal(1, 0.95, { tone: 0.55, alpha: 0.2 }),
  aluminum: metal(0.8, 0.55, { tone: 0.6, alpha: 0.16 }),
  gold: metal(0.5, 0.15, { tone: 0.55, alpha: 0.12 }),
  lead: metal(0.3, 0, { tone: 0.3, alpha: 0.16 }),
  wood: {
    cls: 'wood',
    hardness: 0.45,
    brittle: 0.55,
    dust: 0.25,
    spark: 0,
    chip: 'chip.wood',
    skid: { tone: 0.25, alpha: 0.22 },
  },
  rubber: {
    cls: 'rubber',
    hardness: 0.1,
    brittle: 0,
    dust: 0.15,
    spark: 0,
    chip: null,
    skid: { tone: 0, alpha: 0.85 },
  },
  plastic: {
    cls: 'plastic',
    hardness: 0.35,
    brittle: 0.18,
    dust: 0,
    spark: 0,
    chip: null,
    skid: { tone: 0.12, alpha: 0.28 },
  },
  concrete: {
    cls: 'stone',
    hardness: 0.85,
    brittle: 0.65,
    dust: 1,
    spark: 0.25,
    chip: 'chip.stone',
    skid: { tone: 0.65, alpha: 0.1 },
  },
  ceramic: { cls: 'stone', hardness: 0.8, brittle: 0.9, dust: 0.25, spark: 0, chip: 'chip.stone', skid: null },
  glass: { cls: 'glass', hardness: 0.8, brittle: 1, dust: 0, spark: 0, chip: 'shard.glass', skid: null },
  ice: { cls: 'ice', hardness: 0.55, brittle: 0.85, dust: 0, spark: 0, chip: 'shard.ice', skid: null },
  foam: { cls: 'foam', hardness: 0, brittle: 0.3, dust: 0.1, spark: 0, chip: 'crumb.foam', skid: null },
};

/** The ground slab: hard, dusty, sparks against metal. Its colour is the scene's ground colour. */
export const GROUND_PROFILE: Profile = {
  cls: 'earth',
  hardness: 0.7,
  brittle: 0,
  dust: 1,
  spark: 0.5,
  chip: null,
  skid: null,
};

const FALLBACK_COLOR: Vec3 = [0.4, 0.4, 0.4];

function linearOf(hex: string | undefined): Vec3 {
  return (hex && hexToLinear(hex)) || FALLBACK_COLOR;
}

/** A profile for a preset nobody described, from its physical numbers. */
function derive(id: string): Profile {
  const p = PRESET_BY_ID.get(id);
  if (!p) return { ...BUILTIN.plastic };
  if (p.metalness >= 0.5) return metal(0.7, 0.4, { tone: 0.5, alpha: 0.15 });
  if (p.opacity < 0.7) return { ...BUILTIN.glass };
  if (p.density < 200) return { ...BUILTIN.foam };
  if (p.restitution >= 0.7 || p.friction >= 0.9) return { ...BUILTIN.rubber };
  return { ...BUILTIN.plastic };
}

/**
 * The surface of a material preset. `colorHex` is the body's own colour when it differs from the preset's (a red
 * wooden crate): chips and dust follow it. The ground is `surfaceFor('ground', groundColor)`.
 */
export function surfaceFor(presetId: string, colorHex?: string): FxSurface {
  if (presetId === 'ground') {
    const c = linearOf(colorHex);
    return { ...GROUND_PROFILE, color: c, base: c };
  }
  const profile = PROFILES.get(presetId) ?? BUILTIN[presetId] ?? derive(presetId);
  const base = linearOf(PRESET_BY_ID.get(presetId)?.color);
  return { ...profile, color: colorHex ? linearOf(colorHex) : base, base };
}

// -- impact recipe ---------------------------------------------------------------------------------------------------

/** ½·J·v: the kinetic energy the contact absorbed, joules (see the module comment). */
export function impactEnergy(speed: number, impulse: number): number {
  return 0.5 * Math.max(0, impulse) * Math.max(0, speed);
}

const E_LOW = Math.log10(0.3);
const E_HIGH = Math.log10(30000);

/** Impact energy on a 0 … 1 logarithmic scale (0.3 J → 0, 30 kJ → 1). */
export function impactLevel(energy: number): number {
  if (!(energy > 0)) return 0;
  return Math.min(1, Math.max(0, (Math.log10(energy) - E_LOW) / (E_HIGH - E_LOW)));
}

/**
 * How strong the visual effect of an impact is, 0 … 1: the energy level, damped for slow hits of heavy bodies (a 4 t
 * ball touching down at 1 m/s should not throw as much as the same ball at 20 m/s).
 */
export function impactIntensity(speed: number, impulse: number): number {
  const level = impactLevel(impactEnergy(speed, impulse));
  const vigor = Math.min(1, Math.max(0, speed / 14));
  return Math.pow(level, 0.7) * (0.35 + 0.65 * vigor);
}

export interface ImpactInput {
  /** Approach speed along the normal, m/s. */
  speed: number;
  /** Normal impulse, N·s. */
  impulse: number;
  a: FxSurface;
  b: FxSurface;
  /** `b` is the ground slab: every burst then goes up (+normal). */
  bIsGround: boolean;
  /** Characteristic size of the smaller body, metres — scales puffs and chips. */
  size?: number;
}

export interface ImpactBurst {
  /** Particle type id. */
  type: string;
  count: number;
  /** Size multiplier. */
  scale: number;
  /** Speed multiplier. */
  speed: number;
  /** +1: along the contact normal (out of `b`, towards `a`), −1: against it. */
  dir: 1 | -1;
  /** Linear RGB tint, if the burst takes the surface's colour. */
  color?: Vec3;
  /** Candidate for real rigid fragments when "physical debris" is on. */
  physical?: boolean;
  /** Which surface the burst comes from, for tests and tools. */
  from: 'a' | 'b';
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const MAX_BURST = 36;

/** Chip / debris colour: the body's own colour relative to the colour the chip type was drawn for. */
export function relativeTint(s: FxSurface): Vec3 {
  const r = (c: number, b: number) => Math.min(3, Math.max(0.25, c / Math.max(0.02, b)));
  return [r(s.color[0], s.base[0]), r(s.color[1], s.base[1]), r(s.color[2], s.base[2])];
}

/** Dust colour: the surface's colour lifted towards a pale warm grey, as dust is paler than what it came off. */
export function dustTint(s: FxSurface): Vec3 {
  const pale: Vec3 = [0.5, 0.47, 0.42];
  const k = 0.5;
  return [
    Math.min(1, s.color[0] * (1 - k) + pale[0] * k + 0.04),
    Math.min(1, s.color[1] * (1 - k) + pale[1] * k + 0.04),
    Math.min(1, s.color[2] * (1 - k) + pale[2] * k + 0.04),
  ];
}

/** The bursts one impact produces. Empty for gentle contacts. */
export function impactBursts(i: ImpactInput): ImpactBurst[] {
  const v = i.speed;
  const E = impactEnergy(v, i.impulse);
  if (v < 0.7 || E < 0.3) return [];
  const L = impactIntensity(v, i.impulse);
  const sizeK = Math.min(2.2, Math.max(0.55, 0.55 + (i.size ?? 0.4) * 1.1));
  const out: ImpactBurst[] = [];
  const cap = (n: number) => Math.min(MAX_BURST, n);
  const sides: { s: FxSurface; p: FxSurface; dir: 1 | -1; from: 'a' | 'b' }[] = [
    { s: i.a, p: i.b, dir: 1, from: 'a' },
    { s: i.b, p: i.a, dir: i.bIsGround ? 1 : -1, from: 'b' },
  ];

  // Sparks: a spark-prone surface struck against something hard.
  const sa = i.a.spark * clamp01((i.b.hardness - 0.4) / 0.5);
  const sb = i.b.spark * clamp01((i.a.hardness - 0.4) / 0.5);
  const strength = Math.max(sa, sb);
  if (v >= 1.6 && strength >= 0.2) {
    const count = cap((4 + 22 * L) * strength);
    const burst = { type: 'spark', scale: 0.8 + 0.5 * sizeK, speed: 0.8 + 0.9 * L };
    if (i.bIsGround) out.push({ ...burst, count, dir: 1, from: sa >= sb ? 'a' : 'b' });
    else {
      out.push({ ...burst, count: count * 0.55, dir: 1, from: 'a' });
      out.push({ ...burst, count: count * 0.45, dir: -1, from: 'b' });
    }
  }

  for (const { s, p, dir, from } of sides) {
    // Dust.
    if (s.dust > 0 && v >= 0.9) {
      out.push({
        type: 'dust',
        count: cap((2 + 12 * L) * s.dust),
        scale: (0.7 + 0.9 * L) * sizeK,
        speed: 0.8 + 0.6 * L,
        dir,
        color: dustTint(s),
        from,
      });
    }
    // Chips and shards: a brittle surface hit by something at least not much softer.
    if (s.chip && s.brittle > 0) {
      const vMin = 4.5 - 2.7 * s.brittle;
      if (v >= vMin && p.hardness >= s.hardness * 0.6) {
        out.push({
          type: s.chip,
          count: cap((1 + 9 * L) * s.brittle),
          scale: (0.8 + 0.7 * L) * Math.min(1.4, sizeK),
          speed: 0.8 + 0.7 * L,
          dir,
          color: relativeTint(s),
          from,
        });
        if (s.cls === 'glass') out.push({ type: 'glint', count: 1 + 3 * L, scale: 0.7 + 0.6 * L, speed: 1, dir, from });
      }
    }
    // Rubber scuffs against anything hard enough to rub it.
    if (s.cls === 'rubber' && v >= 1.5 && p.hardness > 0.3) {
      out.push({
        type: 'scuff.rubber',
        count: cap(1 + 5 * L),
        scale: 0.8 + 0.5 * L,
        speed: 0.8 + 0.5 * L,
        dir,
        color: [Math.min(1, s.color[0] * 0.5), Math.min(1, s.color[1] * 0.5), Math.min(1, s.color[2] * 0.5)],
        from,
      });
    }
    // Debris: a brittle material hit very hard throws chunks.
    if (s.brittle >= 0.5 && L >= 0.45 && v >= 4.5 && p.hardness >= 0.4) {
      out.push({
        type: 'debris',
        count: Math.min(14, Math.ceil((2 + (8 * (L - 0.45)) / 0.55) * s.brittle)),
        scale: (0.8 + 0.8 * L) * Math.min(1.5, sizeK),
        speed: 0.8 + L,
        dir,
        color: relativeTintFor(s),
        physical: true,
        from,
      });
    }
  }
  return out;
}

/** Debris is authored in a neutral earthy tone, so it takes the surface's absolute colour. */
function relativeTintFor(s: FxSurface): Vec3 {
  const lift = 1.25;
  return [
    Math.min(1.5, s.color[0] * lift + 0.05),
    Math.min(1.5, s.color[1] * lift + 0.05),
    Math.min(1.5, s.color[2] * lift + 0.05),
  ];
}
