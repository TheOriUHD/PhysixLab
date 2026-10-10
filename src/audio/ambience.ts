/**
 * Ambient layers: wind and the quiet air bed.
 *
 * **Wind** is the sound of the air rushing past the camera: it follows the speed of the camera relative to the air,
 * which in this app is the speed of the body the camera is following (a free camera moves through the air no faster
 * than the scene does, and orbiting or panning is not flight, so it makes no wind). Level and brightness rise with
 * speed, and the gusts get quicker and shallower.
 *
 * The **air bed** is a very quiet low noise that makes a running simulation feel like a place rather than a vacuum.
 * Both are silent in zero gravity (a scene with no gravity is read as space) and fade out when the simulation is not
 * running.
 */
import { clamp01, smoothstep } from './mapping';

export interface WindParams {
  gain: number;
  cutoff: number;
  q: number;
  /** Slow modulation of the level: rate Hz and depth 0 … 1. */
  gustRate: number;
  gustDepth: number;
}

export const newWindParams = (): WindParams => ({ gain: 0, cutoff: 300, q: 0.6, gustRate: 0.3, gustDepth: 0.5 });

/** Air speed (m/s) at which wind is at full strength. */
export const WIND_FULL_SPEED = 50;

/** Gravity below this magnitude (m/s²) counts as space: no air, no wind. */
export const MIN_AIR_GRAVITY = 0.2;

/** 1 in a scene with gravity, 0 in zero gravity. */
export const airDensityForGravity = (g: number): number => smoothstep(0.05, MIN_AIR_GRAVITY, Math.abs(g));

export function windParams(airSpeed: number, density: number, out: WindParams): WindParams {
  const v = Math.max(0, Number.isFinite(airSpeed) ? airSpeed : 0);
  const x = clamp01(v / WIND_FULL_SPEED);
  out.gain = clamp01(density) * Math.pow(smoothstep(2.5, 45, v), 1.2) * 0.9;
  out.cutoff = 250 + 3600 * Math.pow(x, 0.9);
  out.q = 0.6 + x;
  out.gustRate = 0.25 + 0.5 * x;
  out.gustDepth = 0.55 * (1 - 0.5 * x);
  return out;
}

export interface BedParams {
  gain: number;
  cutoff: number;
}

/** The air bed: a constant whisper, scaled by the air density. */
export function bedParams(density: number, out: BedParams): BedParams {
  out.gain = 0.09 * clamp01(density);
  out.cutoff = 700;
  return out;
}
