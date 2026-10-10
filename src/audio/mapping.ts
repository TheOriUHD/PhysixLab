/**
 * Small pure helpers shared by the sound modules: ranges, decibels, the slider-to-gain law, and how the time scale
 * bends pitch. No DOM and no WebAudio, so everything is unit-tested in Node (`tests/audioCore.test.ts`).
 */
import { clamp } from '../core/math';

export { clamp };

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Hermite smooth step from 0 at `e0` to 1 at `e1` (e0 < e1). */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => (g > 1e-9 ? 20 * Math.log10(g) : -180);

/**
 * Volume slider (0 … 1) to a linear gain. Perceived loudness is roughly logarithmic, so the slider is squared:
 * half-way is −12 dB, a quarter is −24 dB, zero is silence.
 */
export function volumeToGain(v: number): number {
  const x = clamp01(Number.isFinite(v) ? v : 0);
  return x * x;
}

/** Semitones to a frequency ratio. */
export const semitones = (n: number): number => Math.pow(2, n / 12);

/**
 * How the simulation's time scale bends the pitch of every sound. Slow motion lowers pitch the way a slowed
 * recording does, but gently (a tenth of real time is not three octaves down, which would be a rumble); fast-forward
 * raises it only a little, so 4× does not turn collisions into squeaks.
 *
 *     1×  → 1          0.5× → 0.73          0.25× → 0.54          0.1× → 0.35 (about the floor)          4× → 1.22
 */
export function pitchForTimeScale(timeScale: number): number {
  const ts = Number.isFinite(timeScale) && timeScale > 0 ? timeScale : 1;
  if (ts >= 1) return Math.min(1.25, 1 + 0.11 * Math.log2(ts));
  return Math.max(0.35, Math.pow(ts, 0.45));
}

/** A stable 32-bit hash of a string (FNV-1a): seeds the noise of a cached sound from its key. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
