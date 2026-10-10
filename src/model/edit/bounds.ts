/**
 * World-space bounds of posed entities (pure: no store, no three.js, no Rapier).
 *
 * Bodies are measured exactly through the *support function* of their collider shape: the largest extent of a convex
 * shape along a direction. Hull shapes (box, wedge, prism, icosahedron …) use their convex points, the round ones
 * (sphere, cylinder, capsule, cone) their analytic support, so a tilted cylinder gets its true axis-aligned box and
 * not the box of its bounding sphere. A compound body is the union of its parts, a group the union of everything
 * below it, soft bodies are measured by their size box (a balloon by its sphere), a path by its control points and a
 * light is a point.
 *
 * Other editing tools (align, drop, mirror, array …) share these helpers; keep the exports stable.
 */
import { qrot, qrotInv, type Quat, type Vec3 } from '../../core/math';
import { childIndex, descendantIds, topLevel } from '../groups';
import { shapeConvexPoints } from '../shapeRegistry';
import type { ColliderPart, Entity, PosedEntity, ShapeSpec, SoftEntity } from '../types';
import { isBody, isGroup, isPath, isPosed, isSoft } from '../types';

/** Axis-aligned box, world space. */
export interface AABB {
  min: Vec3;
  max: Vec3;
}

export const aabbCentre = (b: AABB): Vec3 => [
  (b.min[0] + b.max[0]) / 2,
  (b.min[1] + b.max[1]) / 2,
  (b.min[2] + b.max[2]) / 2,
];
export const aabbSize = (b: AABB): Vec3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];

export function aabbUnion(a: AABB | null, b: AABB | null): AABB | null {
  if (!a) return b;
  if (!b) return a;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export const aabbTranslate = (b: AABB, d: Vec3): AABB => ({
  min: [b.min[0] + d[0], b.min[1] + d[1], b.min[2] + d[2]],
  max: [b.max[0] + d[0], b.max[1] + d[1], b.max[2] + d[2]],
});

/** Do the boxes overlap in the XZ plane by more than `eps` (touching edges do not count)? */
export function aabbOverlapXZ(a: AABB, b: AABB, eps = 1e-6): boolean {
  return (
    a.min[0] < b.max[0] - eps && b.min[0] < a.max[0] - eps && a.min[2] < b.max[2] - eps && b.min[2] < a.max[2] - eps
  );
}

/** Bounds of a set of points. */
export function pointsBounds(points: readonly Vec3[]): AABB | null {
  if (!points.length) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i];
      if (p[i] > max[i]) max[i] = p[i];
    }
  return { min, max };
}

// ── support functions (local frame) ────────────────────────────────────────────────────────────────

/** Largest `u · p` over the convex shape `spec` (local space, `u` need not be normalised). */
export function shapeSupport(spec: ShapeSpec, u: Vec3): number {
  const pts = shapeConvexPoints(spec);
  if (pts) {
    let best = -Infinity;
    for (const p of pts) best = Math.max(best, p[0] * u[0] + p[1] * u[1] + p[2] * u[2]);
    return best;
  }
  const [sx, sy, sz] = spec.size;
  const rXZ = Math.hypot(u[0], u[2]);
  switch (spec.type) {
    case 'sphere':
      // Ellipsoid with semi-axes size/2 (a sphere in practice).
      return Math.hypot((u[0] * sx) / 2, (u[1] * sy) / 2, (u[2] * sz) / 2);
    case 'cylinder':
      return (sy / 2) * Math.abs(u[1]) + (Math.max(sx, sz) / 2) * rXZ;
    case 'capsule': {
      const r = Math.max(sx, sz) / 2;
      return Math.max(0, sy / 2 - r) * Math.abs(u[1]) + r * Math.hypot(u[0], u[1], u[2]);
    }
    case 'cone': {
      // Apex at +y/2, base circle of radius r at -y/2.
      const h = sy / 2;
      return Math.max(h * u[1], -h * u[1] + (Math.max(sx, sz) / 2) * rXZ);
    }
    default:
      // Unknown convex shape without points: its size box (conservative).
      return (Math.abs(u[0]) * sx + Math.abs(u[1]) * sy + Math.abs(u[2]) * sz) / 2;
  }
}

function boxSupport(half: Vec3, u: Vec3): number {
  return Math.abs(u[0]) * half[0] + Math.abs(u[1]) * half[1] + Math.abs(u[2]) * half[2];
}

type Support = (u: Vec3) => number;

function partSupport(parts: readonly ColliderPart[]): Support {
  return (u) => {
    let best = -Infinity;
    for (const p of parts) {
      const local = qrotInv(p.rotation, u);
      best = Math.max(
        best,
        p.position[0] * u[0] + p.position[1] * u[1] + p.position[2] * u[2] + shapeSupport(p.shape, local),
      );
    }
    return best;
  };
}

function softSupport(e: SoftEntity): Support {
  const [sx, sy, sz] = e.size;
  if (e.type === 'balloon') return (u) => (sx / 2) * Math.hypot(u[0], u[1], u[2]);
  return (u) => boxSupport([sx / 2, sy / 2, sz / 2], u);
}

const AXES: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function boundsFromSupport(position: Vec3, rotation: Quat, support: Support): AABB {
  const min: Vec3 = [0, 0, 0];
  const max: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const u = qrotInv(rotation, AXES[i]);
    max[i] = position[i] + support(u);
    min[i] = position[i] - support([-u[0], -u[1], -u[2]]);
  }
  return { min, max };
}

/** Bounds of one non-group posed entity (a group has no geometry of its own: use `BoundsContext.bounds`). */
export function leafBounds(e: PosedEntity): AABB {
  if (isBody(e)) {
    const support: Support = e.parts?.length ? partSupport(e.parts) : (u) => shapeSupport(e.shape, u);
    return boundsFromSupport(e.position, e.rotation, support);
  }
  if (isSoft(e)) return boundsFromSupport(e.position, e.rotation, softSupport(e));
  if (isPath(e)) {
    const pts = e.points.map((p) => {
      const w = qrot(e.rotation, p);
      return [w[0] + e.position[0], w[1] + e.position[1], w[2] + e.position[2]] as Vec3;
    });
    return pointsBounds(pts) ?? { min: [...e.position], max: [...e.position] };
  }
  return { min: [...e.position], max: [...e.position] }; // light, empty group
}

/** Lookup tables for repeated bounds queries over one list of entities. */
export class BoundsContext {
  readonly byId = new Map<string, Entity>();
  readonly children: Map<string, string[]>;

  constructor(readonly entities: readonly Entity[]) {
    for (const e of entities) this.byId.set(e.id, e);
    this.children = childIndex(entities);
  }

  get(id: string): Entity | undefined {
    return this.byId.get(id);
  }

  /** Bounds of an entity; a group is the union of everything below it (its own pivot if empty). Null for joints / unknown ids. */
  bounds(id: string): AABB | null {
    const e = this.byId.get(id);
    if (!e || !isPosed(e)) return null;
    if (!isGroup(e)) return leafBounds(e);
    let box: AABB | null = null;
    for (const d of descendantIds(this.children, id)) {
      const c = this.byId.get(d);
      if (c && isPosed(c) && !isGroup(c)) box = aabbUnion(box, leafBounds(c));
    }
    return box ?? { min: [...e.position], max: [...e.position] };
  }

  /** The top-level posed ids of `ids` (members of a selected group are not listed separately). */
  roots(ids: readonly string[]): string[] {
    return topLevel((id) => this.byId.get(id), ids).filter((id) => {
      const e = this.byId.get(id);
      return !!e && isPosed(e);
    });
  }
}

/** Bounds of one entity in a list of entities. */
export function entityBounds(entities: readonly Entity[], id: string): AABB | null {
  return new BoundsContext(entities).bounds(id);
}

/** Union of the bounds of the top-level entities of `ids` (null when there are none). */
export function selectionBounds(entities: readonly Entity[], ids: readonly string[]): AABB | null {
  const ctx = new BoundsContext(entities);
  let box: AABB | null = null;
  for (const id of ctx.roots(ids)) box = aabbUnion(box, ctx.bounds(id));
  return box;
}

/**
 * Centre of a selection: `median` is the mean of the top-level entities' origins (what the gizmo uses and what
 * rotating "about the selection centre" means), `bounds` the centre of their joint bounding box.
 */
export function selectionCentre(
  entities: readonly Entity[],
  ids: readonly string[],
  kind: 'median' | 'bounds' = 'median',
): Vec3 | null {
  const ctx = new BoundsContext(entities);
  const roots = ctx.roots(ids);
  if (!roots.length) return null;
  if (kind === 'bounds') {
    let box: AABB | null = null;
    for (const id of roots) box = aabbUnion(box, ctx.bounds(id));
    return box ? aabbCentre(box) : null;
  }
  const sum: Vec3 = [0, 0, 0];
  for (const id of roots) {
    const e = ctx.get(id) as PosedEntity;
    sum[0] += e.position[0];
    sum[1] += e.position[1];
    sum[2] += e.position[2];
  }
  return [sum[0] / roots.length, sum[1] / roots.length, sum[2] / roots.length];
}
