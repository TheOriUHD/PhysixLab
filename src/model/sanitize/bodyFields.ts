/** Sanitisers for the per-body fields added in format v2 (collision filter, drag, mass overrides, tags, layer). */
import { clamp, type Vec3 } from '../../core/math';
import { ALL_GROUPS, DEFAULT_LAYER } from '../factory';
import { LIMITS } from '../limits';
import type { BodyEntity, CollisionSpec, DragSpec } from '../types';
import { int, isFiniteVec, num, obj, str } from './primitives';

export const MAX_DRAG = 1e6;

export function sanitizeCollision(raw: unknown): CollisionSpec {
  const r = obj(raw);
  return { group: int(r.group, 0, 0, 15), mask: int(r.mask, ALL_GROUPS, 0, ALL_GROUPS) };
}

export function sanitizeDrag(raw: unknown): DragSpec {
  const r = obj(raw);
  return { linear2: clamp(num(r.linear2, 0), 0, MAX_DRAG), angular2: clamp(num(r.angular2, 0), 0, MAX_DRAG) };
}

/** Trimmed, non-empty, de-duplicated, length- and count-limited. */
export function sanitizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw as unknown[]) {
    if (typeof t !== 'string') continue;
    const tag = t.trim().slice(0, LIMITS.maxTagLength);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= LIMITS.maxTags) break;
  }
  return out;
}

/** The v2 per-body fields of a raw body. `parent` is validated later, once every entity id is known. */
export function sanitizeBodyFields(
  raw: Record<string, unknown>,
): Pick<
  BodyEntity,
  | 'collision'
  | 'drag'
  | 'massOverride'
  | 'comOverride'
  | 'inertiaScale'
  | 'sleepThreshold'
  | 'tags'
  | 'layer'
  | 'parent'
> {
  const out: ReturnType<typeof sanitizeBodyFields> = {
    collision: sanitizeCollision(raw.collision),
    drag: sanitizeDrag(raw.drag),
    inertiaScale: clamp(num(raw.inertiaScale, 1), 1e-3, 1e3),
    tags: sanitizeTags(raw.tags),
    layer: str(raw.layer, DEFAULT_LAYER).trim() || DEFAULT_LAYER,
  };
  const mass = num(raw.massOverride, 0);
  if (mass > 0) out.massOverride = clamp(mass, 1e-4, 1e9);
  if (isFiniteVec(raw.comOverride, 3)) {
    const c = raw.comOverride;
    out.comOverride = [clamp(c[0], -1e4, 1e4), clamp(c[1], -1e4, 1e4), clamp(c[2], -1e4, 1e4)] as Vec3;
  }
  const sleep = num(raw.sleepThreshold, -1);
  if (sleep >= 0) out.sleepThreshold = Math.min(sleep, 100);
  if (typeof raw.parent === 'string' && raw.parent) out.parent = raw.parent.slice(0, LIMITS.maxIdLength);
  return out;
}

/**
 * Drop `parent` links that point at nothing, at the entity itself, or that close a cycle.
 * Returns how many links were removed.
 */
export function repairParents(entities: { id: string; parent?: string }[]): number {
  const byId = new Map(entities.map((e) => [e.id, e]));
  let removed = 0;
  for (const e of entities) {
    if (e.parent === undefined) continue;
    if (e.parent === e.id || !byId.has(e.parent)) {
      delete e.parent;
      removed++;
    }
  }
  for (const e of entities) {
    const seen = new Set<string>([e.id]);
    for (
      let cur = e.parent ? byId.get(e.parent) : undefined;
      cur;
      cur = cur.parent ? byId.get(cur.parent) : undefined
    ) {
      if (seen.has(cur.id)) {
        delete e.parent;
        removed++;
        break;
      }
      seen.add(cur.id);
    }
  }
  return removed;
}
