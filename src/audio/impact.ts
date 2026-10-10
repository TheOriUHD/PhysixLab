/**
 * Impact sounds: from a contact event (the two materials, the normal impulse, the approach speed) and the sizes and
 * masses of the bodies to the voices that play, as plain data.
 *
 *   - **How loud.** The impact energy `E = ½·J·v` (the kinetic energy that went into the contact) on a logarithmic
 *     scale, so a ping-pong ball and a wrecking ball both register. Slow hits of heavy bodies are damped
 *     (`gainLevel = L·(0.55 + 0.45·v/10)`): a 4 t ball touching down gently is a thump, not a clang.
 *   - **How bright.** The timbre level also follows the speed: the upper modes and the click of the contact are
 *     stronger the harder and faster the hit.
 *   - **How high.** Bigger bodies ring lower: the fundamental follows `(0.5 m / size)^0.85`, and large objects ring a
 *     little longer.
 *   - **What rings.** Each body rings with its own material's modes; a light body hitting a heavy one rings loudly
 *     and the heavy one barely; a soft partner (foam, rubber) damps the ring. The ground adds a dull thump.
 *   - **Brittle materials** hit very hard break: the voice is flagged `shatter`, its ring is cut short (a broken glass no
 *     longer chimes as a whole) and the director adds the `break` event sound (the spray of fragments, `events.ts`).
 *
 * A voice names a *buffer* by a quantised key (material, pitch in sixths of an octave, timbre level, damping,
 * shatter), so the engine renders each distinct sound once and plays it with a gain and a fine pitch rate.
 * Everything here is pure: `tests/audioImpact.test.ts` covers the mappings and renders the buffers to measure them.
 */
import { hashString, clamp, clamp01, dbToGain, smoothstep } from './mapping';
import { Rng } from '../core/rng';
import type { ModeSpec, NoiseSpec, Recipe } from './dsp';
import { soundProfileFor, GROUND_SOUND, type SoundProfile } from './materials';

/** Size, metres, of the object whose fundamental is the profile's `pitch`. */
export const REF_SIZE = 0.5;

/** Quietest and loudest impact energies on the sound scale, joules. */
const E_LOW = Math.log10(0.02);
const E_HIGH = Math.log10(20000);

/** Impact energy `½·J·v`, joules. */
export function impactEnergy(speed: number, impulse: number): number {
  return 0.5 * Math.max(0, impulse) * Math.max(0, speed);
}

/** Impact energy on a 0 … 1 logarithmic scale (0.02 J → 0, 20 kJ → 1). */
export function soundLevel(energy: number): number {
  if (!(energy > 0)) return 0;
  return clamp01((Math.log10(energy) - E_LOW) / (E_HIGH - E_LOW));
}

/**
 * The loudness level (0 … 1) to a linear gain: −50 dB for the faintest tick up to 0 dB for the biggest crash, on a
 * compressive curve (`L^0.6`) so that everyday hits (a 10 kg ball dropped from a metre, level ≈ 0.55) sit around −12 dB
 * rather than disappearing next to the rare huge one.
 */
export function levelToGain(level: number): number {
  return dbToGain(-50 + 50 * Math.pow(clamp01(level), 0.6));
}

/** Frequency factor of an object of `size` metres relative to the 0.5 m reference: smaller is higher. */
export function sizePitchFactor(size: number): number {
  return clamp(Math.pow(REF_SIZE / Math.max(0.01, size), 0.85), 0.06, 5);
}

/** How much of the contact's energy shows as loudness and as brightness. */
export function impactLevels(
  speed: number,
  impulse: number,
): { energy: number; level: number; gainLevel: number; timbre: number } {
  const energy = impactEnergy(speed, impulse);
  const level = soundLevel(energy);
  const vigor = clamp01(speed / 10);
  return { energy, level, gainLevel: level * (0.55 + 0.45 * vigor), timbre: clamp01(level * (0.25 + 0.75 * vigor)) };
}

/** A body's share of the ring: a light body hitting a heavy one rings, the heavy one barely does. */
export function ringShare(mass: number, partnerMass: number): number {
  const m = mass > 0 && Number.isFinite(mass) ? mass : Infinity;
  const p = partnerMass > 0 && Number.isFinite(partnerMass) ? partnerMass : Infinity;
  if (m === Infinity && p === Infinity) return 0.8;
  if (p === Infinity) return 1.15;
  if (m === Infinity) return 0.45;
  return clamp(1.2 * Math.sqrt(p / (m + p)), 0.45, 1.15);
}

// -- quantisation -----------------------------------------------------------------------------------------------------

const PITCH_STEPS_PER_OCTAVE = 6;
const LEVEL_BUCKETS = 4;
const DAMP_BUCKETS = 3;

export const pitchBucket = (hz: number): number => Math.round(Math.log2(clamp(hz, 40, 9000)) * PITCH_STEPS_PER_OCTAVE);
export const bucketPitch = (bucket: number): number => Math.pow(2, bucket / PITCH_STEPS_PER_OCTAVE);
export const levelBucket = (timbre: number): number =>
  Math.min(LEVEL_BUCKETS - 1, Math.floor(clamp01(timbre) * LEVEL_BUCKETS));
const bucketLevel = (b: number): number => (b + 0.5) / LEVEL_BUCKETS;

/** What a rendered impact buffer is made of; the cache key is a pure function of it. */
export interface ImpactSpec {
  /** Material preset id (`'ground'` for the slab). */
  preset: string;
  /** Fundamental, in `pitchBucket` units. */
  pitch: number;
  /** Timbre level bucket 0 … 3. */
  level: number;
  /** Damping from a soft partner, bucket 0 … 3. */
  damp: number;
  /** The object breaks: its ring is cut short (the `break` event supplies the fragments). */
  shatter: boolean;
}

export const impactKey = (s: ImpactSpec): string =>
  `i|${s.preset}|p${s.pitch}|l${s.level}|d${s.damp}${s.shatter ? '|x' : ''}`;

export interface ImpactVoice {
  spec: ImpactSpec;
  key: string;
  /** Linear gain (before the category / master volumes and the spatialisation). */
  gain: number;
  /** Fine pitch: the requested fundamental divided by the buffer's. */
  rate: number;
  /** Which body of the contact rings. */
  role: 'a' | 'b' | 'ground';
  /** The loudness level 0 … 1 of the contact (before the gain curve): what the `break` event is scaled by. */
  level: number;
}

export interface ImpactInput {
  /** Approach speed along the normal, m/s. */
  speed: number;
  /** Normal impulse, N·s. */
  impulse: number;
  matA: string;
  /** `'ground'` when the other side is the ground slab. */
  matB: string;
  /** Characteristic size of each body, metres (the ground counts as huge). */
  sizeA: number;
  sizeB: number;
  /** Mass, kg; 0 / Infinity = immovable (static, kinematic, the ground). */
  massA: number;
  massB: number;
}

/** Contacts too gentle to make a sound at all. */
const MIN_ENERGY = 0.02;
const MIN_SPEED = 0.15;

/** Plan the voices of one contact: the ring of each body, and the ground's thump. Empty for a gentle touch. */
export function planImpact(i: ImpactInput): ImpactVoice[] {
  const { energy, gainLevel, timbre } = impactLevels(i.speed, i.impulse);
  if (energy < MIN_ENERGY || i.speed < MIN_SPEED) return [];
  const base = levelToGain(gainLevel);
  const out: ImpactVoice[] = [];
  const ground = i.matB === 'ground';
  const pA = soundProfileFor(i.matA);
  const pB = soundProfileFor(i.matB);
  const side = (
    profile: SoundProfile,
    preset: string,
    size: number,
    partner: SoundProfile,
    share: number,
    role: ImpactVoice['role'],
  ) => {
    const f0 = profile.pitch * sizePitchFactor(size);
    const pb = pitchBucket(f0);
    const softness = clamp01(1 - partner.hardness);
    const spec: ImpactSpec = {
      preset,
      pitch: pb,
      level: levelBucket(timbre),
      damp: Math.round(softness * DAMP_BUCKETS),
      shatter: profile.brittle * smoothstep(0.55, 0.85, gainLevel) > 0.35,
    };
    out.push({
      spec,
      key: impactKey(spec),
      gain: base * profile.gain * share,
      rate: f0 / bucketPitch(pb),
      role,
      level: gainLevel,
    });
  };
  side(pA, i.matA, i.sizeA, ground ? GROUND_SOUND : pB, ringShare(i.massA, ground ? Infinity : i.massB), 'a');
  if (ground) {
    // The slab: a low thump, deeper for bigger bodies, a little more present the harder the hit.
    const f0 = GROUND_SOUND.pitch * clamp(Math.pow(REF_SIZE / Math.max(0.05, i.sizeA), 0.3), 0.55, 1.5);
    const pb = pitchBucket(f0);
    const spec: ImpactSpec = { preset: 'ground', pitch: pb, level: levelBucket(timbre), damp: 0, shatter: false };
    out.push({
      spec,
      key: impactKey(spec),
      gain: base * 0.85,
      rate: f0 / bucketPitch(pb),
      role: 'ground',
      level: gainLevel,
    });
  } else {
    side(pB, i.matB, i.sizeB, pA, ringShare(i.massB, i.massA), 'b');
  }
  return out;
}

/** The spec of a typical hit on a material (a 0.5 m object, medium timbre, a hard floor): what the engine warms its cache with. */
export function typicalImpact(preset: string): { spec: ImpactSpec; key: string } {
  const spec: ImpactSpec = {
    preset,
    pitch: pitchBucket(soundProfileFor(preset).pitch),
    level: 2,
    damp: preset === 'ground' ? 0 : 1,
    shatter: false,
  };
  return { spec, key: impactKey(spec) };
}

// -- the recipe of a buffer -----------------------------------------------------------------------------------------------

const MAX_FREQ = 17000;

/** Build the recipe of an impact buffer (a pure function of its spec, so the cache key identifies the sound). */
export function impactRecipe(spec: ImpactSpec): Recipe {
  const p = soundProfileFor(spec.preset);
  const f0 = bucketPitch(spec.pitch);
  const lvl = bucketLevel(spec.level);
  const sb = spec.damp / DAMP_BUCKETS; // 0 hard partner … 1 very soft partner
  const rng = new Rng(hashString(impactKey(spec)));

  // A shattered object no longer rings as a whole: the chime is cut short and the fragments take over.
  const whole = spec.shatter ? 0.45 : 1;
  const ring = Math.max(
    0.012,
    p.ring * clamp(Math.pow(p.pitch / f0, 0.35), 0.5, 2.2) * (0.75 + 0.25 * lvl) * (1 - 0.7 * sb) * whole,
  );
  const upper = (0.3 + 0.7 * lvl) * (1 - 0.5 * sb);

  const modes: ModeSpec[] = [];
  p.modes.forEach(([ratio, g], i) => {
    const freq = f0 * ratio * (i === 0 ? 1 : 1 + p.detune * (rng.next() * 2 - 1));
    if (freq > MAX_FREQ) return;
    const mode: ModeSpec = { freq, gain: g * (i === 0 ? 1 : upper), t60: ring / (1 + p.damp * i) };
    if (p.glide && i < 2) mode.glide = p.glide;
    modes.push(mode);
  });

  const noise: NoiseSpec[] = [];
  const clickAmp = p.click * (0.3 + 0.7 * lvl) * (1 - 0.5 * sb);
  if (clickAmp > 0.01) {
    noise.push({
      color: 'white',
      gain: clickAmp * 0.9,
      t60: 0.007 + 0.01 * (1 - sb),
      attack: 0.0002,
      filter: { type: 'bandpass', freq: p.clickFreq * (0.7 + 0.6 * lvl), q: 1.1 },
    });
  }
  if (p.body > 0.01) {
    const bodyFreq = clamp(p.bodyFreq * Math.pow(f0 / p.pitch, 0.6), 60, 4000);
    noise.push({
      color: 'pink',
      gain: p.body * (0.5 + 0.5 * lvl) * 1.2,
      t60: 0.035 + 0.05 * p.body,
      attack: 0.0004,
      filter: { type: 'bandpass', freq: bodyFreq, q: 0.9 },
    });
  }

  const t60max = modes.reduce((m, x) => Math.max(m, x.t60), 0.04);
  const duration = clamp(Math.max(t60max * 1.15, 0.07), 0.07, 1.9);
  return { duration, modes, noise };
}
