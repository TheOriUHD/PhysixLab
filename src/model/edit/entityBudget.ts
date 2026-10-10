/**
 * The scene's object budget (`LIMITS.maxEntities`) as one shared check for every edit that adds many objects at once
 * (arrays, mirror copies, paste, symmetry partners, prefab insert). Pure: it only needs a way to count the scene.
 */
import { LIMITS } from '../limits';

/** How many more objects a scene holding `count` can take. */
export const roomFor = (count: number): number => Math.max(0, LIMITS.maxEntities - count);

/** How many more objects the scene can take. */
export function entityRoom(store: { all(): readonly unknown[] }): number {
  return roomFor(store.all().length);
}

/** A refusal when adding `extra` objects to a scene of `count` would exceed the scene limit, else null. */
export function budgetMessage(count: number, extra: number, what = 'This'): string | null {
  const room = roomFor(count);
  if (extra <= room) return null;
  const f = (n: number) => n.toLocaleString('en-US');
  return `${what} would add ${f(extra)} objects but the scene can take ${f(room)} more (limit ${f(LIMITS.maxEntities)}).`;
}

/** The same check against a store: a user-facing refusal or null. */
export const fitsEntityBudget = (store: { all(): readonly unknown[] }, extra: number, what = 'This'): string | null =>
  budgetMessage(store.all().length, extra, what);
