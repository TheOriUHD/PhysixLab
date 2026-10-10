/**
 * Trails: what a body in contact with the ground leaves behind, decided from its `GroundContact` (see `slip.ts`).
 *
 *   - **skid marks** where a wheel slips faster than `WHEEL_SLIP` or another body slides faster than `BODY_SLIP`,
 *     in the tone / opacity of its material (rubber leaves black marks, steel a faint scratch, ice and glass none);
 *   - **tyre smoke** from slipping wheels and rubber bodies, in proportion to the slip speed;
 *   - **sparks** where a metal body grinds over the ground;
 *   - **dust trails** behind anything fast on the ground.
 *
 * The plan is in "per second" rates; the caller multiplies by the frame time and the quality tier. Pure and
 * allocation-free (`planTrail` fills a reusable `TrailPlan`).
 */
import type { GroundContact } from './slip';
import type { FxSurface } from './surfaces';

/** Slip speed (m/s) above which a wheel marks the ground / a sliding body does. */
export const WHEEL_SLIP = 1.8;
export const BODY_SLIP = 3.0;
/** Slip speed above which tyres smoke. */
export const SMOKE_SLIP = 3.0;
/** Slip speed above which grinding metal throws sparks. */
export const SPARK_SLIP = 4.5;
/** Ground speed above which a body raises a dust trail. */
export const DUST_SPEED = 4.5;

export interface TrailInfo {
  /** Wheel-like: round, free to spin about a horizontal axle. */
  wheel: boolean;
  surface: FxSurface;
  /** Width of the contact patch, metres (a wheel's tread width). */
  width: number;
  /** Characteristic size, metres. */
  size: number;
}

export interface TrailPlan {
  /** Skid-mark opacity 0 … 1 (0 = no mark now) and tone 0 (black) … 1 (pale). */
  skid: number;
  tone: number;
  /** Particles per second. */
  smoke: number;
  sparks: number;
  dust: number;
}

export function newTrailPlan(): TrailPlan {
  return { skid: 0, tone: 0, smoke: 0, sparks: 0, dust: 0 };
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export function planTrail(c: GroundContact, info: TrailInfo, out: TrailPlan): TrailPlan {
  out.skid = out.tone = out.smoke = out.sparks = out.dust = 0;
  if (!c.touching) return out;
  const s = info.surface;
  const slip = c.slip;
  const slipLimit = info.wheel ? WHEEL_SLIP : BODY_SLIP;

  if (slip >= slipLimit && s.skid) {
    // Fade in over the first few m/s above the limit so a mark does not start with a hard edge.
    out.skid = s.skid.alpha * (0.35 + 0.65 * clamp01((slip - slipLimit) / 6));
    out.tone = s.skid.tone;
  }
  if (slip >= SMOKE_SLIP && (info.wheel || s.cls === 'rubber')) {
    out.smoke = (6 + 26 * clamp01((slip - SMOKE_SLIP) / 9)) * Math.min(1.6, 0.6 + info.size);
  }
  if (slip >= SPARK_SLIP && s.cls === 'metal' && s.spark > 0.3) {
    out.sparks = 40 * clamp01((slip - SPARK_SLIP) / 10) * s.spark;
  }
  if (c.speed >= DUST_SPEED) {
    out.dust = (6 + 14 * clamp01((c.speed - DUST_SPEED) / 14)) * Math.min(1.8, 0.5 + info.size);
    // A slipping tyre throws more.
    if (slip >= slipLimit) out.dust *= 1.5;
  }
  return out;
}
