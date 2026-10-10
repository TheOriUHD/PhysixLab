/**
 * VZ-23: the pure part of the weather renderer — particle budget per quality tier, how wind turns into drift,
 * and the seeded lightning scheduler. No three.js, no DOM: unit-tested in Node.
 */
import { clamp } from '../core/math';
import type { Vec3 } from '../core/math';
import type { WeatherKind } from '../model/types';
import type { QualityTier } from './graphics';

/** Particles at full intensity per quality tier (for kinds with factor 1). `?quality=low` stays cheap. */
export const TIER_PARTICLES: Record<QualityTier, number> = { low: 1500, medium: 6000, high: 12000, ultra: 20000 };

/** Share of the tier budget a kind may use (leaves are big quads, dust is tiny and faint). */
export const KIND_FACTOR: Record<Exclude<WeatherKind, 'none'>, number> = {
  rain: 1,
  snow: 0.8,
  leaves: 0.12,
  dust: 0.5,
};

/** Hard ceiling of the instance buffer for a kind at a tier. */
export function particleCap(kind: WeatherKind, tier: QualityTier): number {
  if (kind === 'none') return 0;
  return Math.max(16, Math.floor(TIER_PARTICLES[tier] * KIND_FACTOR[kind]));
}

/** Instances drawn: the cap scaled by intensity (0 when the weather is clear or the intensity is 0). */
export function particleCount(kind: WeatherKind, tier: QualityTier, intensity: number): number {
  if (kind === 'none') return 0;
  const k = clamp(Number.isFinite(intensity) ? intensity : 0, 0, 1);
  if (k <= 0) return 0;
  const cap = particleCap(kind, tier);
  return Math.min(cap, Math.max(1, Math.round(cap * k)));
}

/** How much of the wind a particle picks up (rain is heavy, the rest follow the air). */
export const WIND_FOLLOW: Record<Exclude<WeatherKind, 'none'>, number> = { rain: 0.7, snow: 1, leaves: 1, dust: 1 };
/** Nominal fall speed, m/s (dust floats: it has none). */
export const FALL_SPEED: Record<Exclude<WeatherKind, 'none'>, number> = {
  rain: 11,
  snow: 1.3,
  leaves: 1.1,
  dust: 0.03,
};

/** Horizontal drift velocity of a particle kind in the given wind (x, z), m/s. */
export function windDrift(kind: WeatherKind, wind: Vec3, out: [number, number] = [0, 0]): [number, number] {
  const k = kind === 'none' ? 0 : WIND_FOLLOW[kind];
  out[0] = wind[0] * k + 0; // + 0 turns -0 into 0
  out[1] = wind[2] * k + 0;
  return out;
}

/** Tilt of a falling streak from the vertical, radians: atan(horizontal speed / fall speed). */
export function streakTilt(kind: WeatherKind, wind: Vec3): number {
  if (kind === 'none') return 0;
  const d = windDrift(kind, wind);
  return Math.atan2(Math.hypot(d[0], d[1]), FALL_SPEED[kind]);
}

// ---- lightning ------------------------------------------------------------------------------------------------

/** mulberry32: small seeded generator (the scene seed drives the sky, so a replay flashes the same way). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mean seconds between strikes: 28 s in a drizzle down to 7 s in a storm. */
export const lightningGap = (intensity: number): number => 28 - 21 * clamp(intensity, 0, 1);
/** Peak flash brightness is capped (the overlay opacity never exceeds this before the reduced-motion scale). */
export const FLASH_CAP = 0.5;

export interface Strike {
  /** Seconds from now. */
  at: number;
  /** Pulse offsets within the strike, seconds, and their strengths (a main flash and 0–2 flickers). */
  pulses: { dt: number; k: number }[];
}

/** Draw the strike that follows the previous one: its delay, and its flicker pattern. Deterministic in `rnd`. */
export function nextStrike(rnd: () => number, intensity: number): Strike {
  const mean = lightningGap(intensity);
  const at = 0.4 * mean + 1.2 * mean * rnd();
  const main = 0.55 + 0.45 * rnd();
  const pulses = [{ dt: 0, k: main }];
  const extra = Math.floor(rnd() * 3);
  let t = 0;
  for (let i = 0; i < extra; i++) {
    t += 0.07 + 0.12 * rnd();
    pulses.push({ dt: t, k: main * (0.4 + 0.4 * rnd()) });
  }
  return { at, pulses };
}

const DECAY = 0.11;

/** Flash level 0–1 `t` seconds after a strike began (sum of decaying pulses, capped). */
export function strikeLevel(strike: Strike, t: number): number {
  let v = 0;
  for (const p of strike.pulses) if (t >= p.dt) v += p.k * Math.exp(-(t - p.dt) / DECAY);
  return Math.min(1, v);
}

/** Seconds after which a strike is over (all pulses below ~1 %). */
export const strikeDuration = (s: Strike): number => s.pulses[s.pulses.length - 1].dt + DECAY * 5;

/** Runs the strikes in time. `level` is the current flash 0–1; `strikes` counts how many have started. */
export class LightningScheduler {
  private rnd: () => number;
  private wait = 0;
  private current: Strike | null = null;
  private t = 0;
  strikes = 0;
  level = 0;

  constructor(
    seed: number,
    private intensity = 0.5,
  ) {
    this.rnd = mulberry32(seed);
    this.wait = nextStrike(this.rnd, intensity).at;
  }

  setIntensity(i: number): void {
    this.intensity = i;
  }

  /** Restart the random stream (a simulation reset replays the same sky). */
  reseed(seed: number): void {
    this.rnd = mulberry32(seed);
    this.wait = nextStrike(this.rnd, this.intensity).at;
    this.current = null;
    this.level = 0;
    this.strikes = 0;
  }

  /** Force a strike now (tests, the preview button). */
  trigger(): void {
    this.begin(nextStrike(this.rnd, this.intensity));
  }

  private begin(s: Strike): void {
    this.current = s;
    this.t = 0;
    this.strikes++;
  }

  update(dt: number): number {
    if (this.current) {
      this.t += dt;
      this.level = strikeLevel(this.current, this.t);
      if (this.t > strikeDuration(this.current)) {
        this.current = null;
        this.level = 0;
        this.wait = nextStrike(this.rnd, this.intensity).at;
      }
    } else {
      this.wait -= dt;
      if (this.wait <= 0) this.begin(nextStrike(this.rnd, this.intensity));
    }
    return this.level;
  }
}
