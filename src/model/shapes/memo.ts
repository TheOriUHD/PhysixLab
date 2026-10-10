/**
 * A tiny bounded memo for the derived data of shape definitions (hulls, section polygons, volumes): the registry
 * asks for a shape's volume, bounding radius, points and colliders many times for the same spec, and building a
 * hull or a gear section each time would be wasteful. Cached values are shared — callers must not mutate them.
 * The cache is cleared wholesale when it grows past `MAX` entries (the working set of a scene is far smaller).
 */
import type { ShapeParams } from '../types';

const MAX = 400;
const cache = new Map<string, unknown>();

export function memo<T>(key: string, make: () => T): T {
  if (cache.has(key)) return cache.get(key) as T;
  const v = make();
  if (cache.size >= MAX) cache.clear();
  cache.set(key, v);
  return v;
}

/** Stable text for a parameter object (declaration order is not assumed). */
export function paramsKey(params: ShapeParams | undefined): string {
  if (!params) return '';
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join(',');
}

/** For tests: drop everything. */
export function clearMemo(): void {
  cache.clear();
}
