/**
 * Coercion helpers for untrusted JSON (files, autosave, share links). Every value is read as `unknown`
 * and turned into a well-typed value with a default, so the sanitisers built on top never throw on garbage.
 */
import { clamp, type Quat, type Vec3 } from '../../core/math';
import { LIMITS } from '../limits';

export const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
export const bool = (x: unknown, d: boolean): boolean => (typeof x === 'boolean' ? x : d);

/** A string truncated to `max` characters (default: the generic string limit). */
export const str = (x: unknown, d: string, max: number = LIMITS.maxStringLength): string =>
  typeof x === 'string' ? (x.length > max ? x.slice(0, max) : x) : d;

/** Display name: any string, truncated to the name limit. */
export const nameStr = (x: unknown, d: string): string => str(x, d, LIMITS.maxNameLength);

/** Entity / asset id: a non-empty string of at most `maxIdLength` characters. */
export function idStr(x: unknown, d: string): string {
  if (typeof x !== 'string' || x.length === 0) return d;
  return x.length > LIMITS.maxIdLength ? x.slice(0, LIMITS.maxIdLength) : x;
}

/** An integer in [lo, hi]. */
export const int = (x: unknown, d: number, lo: number, hi: number): number => clamp(Math.round(num(x, d)), lo, hi);

/** One of the allowed values, or the default. */
export function oneOf<T extends string>(x: unknown, allowed: readonly T[], d: T): T {
  return typeof x === 'string' && (allowed as readonly string[]).includes(x) ? (x as T) : d;
}

/** A hex colour (#rgb, #rrggbb, #rrggbbaa) or the default. */
export const hexColor = (x: unknown, d: string): string =>
  typeof x === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(x) ? x : d;

export function isFiniteVec(x: unknown, n: number): x is number[] {
  return Array.isArray(x) && x.length === n && x.every((v) => typeof v === 'number' && Number.isFinite(v));
}

export function vec3(x: unknown, d: Vec3): Vec3 {
  if (isFiniteVec(x, 3)) return [x[0], x[1], x[2]];
  return [...d] as Vec3;
}

/** A position: finite and within ±maxCoordinate. */
export function position3(x: unknown, d: Vec3): Vec3 {
  const v = vec3(x, d);
  const m = LIMITS.maxCoordinate;
  return [clamp(v[0], -m, m), clamp(v[1], -m, m), clamp(v[2], -m, m)];
}

export function bool3(x: unknown): [boolean, boolean, boolean] {
  if (Array.isArray(x) && x.length === 3) return [!!x[0], !!x[1], !!x[2]];
  return [false, false, false];
}

export function quat(x: unknown): Quat {
  if (isFiniteVec(x, 4)) {
    const l = Math.hypot(x[0], x[1], x[2], x[3]);
    if (l > 1e-9) return [x[0] / l, x[1] / l, x[2] / l, x[3] / l];
  }
  return [0, 0, 0, 1];
}

/** A plain object (not null, not an array) or an empty one. */
export function obj(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}
