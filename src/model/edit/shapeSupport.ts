/**
 * Bridges the shape registry and the pure snapper (ED-14 / ED-15): the support shape and snap features of a body's
 * `ShapeSpec`, the axis-aligned bounds of an entity list, and rigid placement of an entity list (a prefab) at a pose.
 */
import { qmul, qrot, vadd } from '../../core/math';
import type { Quat, Vec3 } from '../../core/math';
import { shapeConvexPoints } from '../shapeRegistry';
import type { Entity, ShapeSpec } from '../types';
import { isBody } from '../types';
import { shapeFeatures, worldHalfExtents, type ShapeFeatures, type SupportShape } from './snap';

/** Corner points of a box with the given half extents about `centre`. */
export function boxCorners(half: Vec3, centre: Vec3 = [0, 0, 0]): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [-1, 1])
    for (const y of [-1, 1])
      for (const z of [-1, 1]) out.push([centre[0] + x * half[0], centre[1] + y * half[1], centre[2] + z * half[2]]);
  return out;
}

/**
 * The convex solid a shape occupies, by support function. Built-in analytic shapes get their exact solid; convex hull
 * shapes use their hull points; anything else (a shape added later without hull points) falls back to its size box.
 * `hasParts` (compound bodies) also uses the size box, which bounds all the parts.
 */
export function supportOfShape(spec: ShapeSpec, hasParts = false): SupportShape {
  const [sx, sy, sz] = spec.size;
  if (!hasParts) {
    switch (spec.type) {
      case 'sphere':
        return { k: 'ellipsoid', r: [sx / 2, sy / 2, sz / 2] };
      case 'cylinder':
        return { k: 'cylinder', r: sx / 2, h: sy / 2 };
      case 'capsule':
        return { k: 'capsule', r: sx / 2, h: Math.max(0, sy / 2 - sx / 2) };
      case 'cone':
        return { k: 'cone', r: sx / 2, h: sy / 2 };
    }
    const pts = shapeConvexPoints(spec);
    if (pts && pts.length >= 4) return { k: 'points', pts };
  }
  return { k: 'points', pts: boxCorners([sx / 2, sy / 2, sz / 2]) };
}

const featureCache = new Map<string, ShapeFeatures>();

/** Snap features of a shape (cached by type, size and parameters: the hull faces are only computed once). */
export function featuresOfShape(spec: ShapeSpec, hasParts = false): ShapeFeatures {
  const key = `${spec.type}|${spec.size.join(',')}|${JSON.stringify(spec.params ?? {})}|${hasParts ? 'p' : ''}`;
  let f = featureCache.get(key);
  if (!f) {
    if (featureCache.size > 400) featureCache.clear();
    f = shapeFeatures(supportOfShape(spec, hasParts));
    featureCache.set(key, f);
  }
  return f;
}

/** Axis-aligned bounds of the bodies in a list (null when there are none). */
export function entitiesBounds(list: readonly Entity[]): { min: Vec3; max: Vec3 } | null {
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;
  for (const e of list) {
    if (!isBody(e)) continue;
    const h = worldHalfExtents(supportOfShape(e.shape, !!e.parts?.length), e.rotation);
    const lo: Vec3 = [e.position[0] - h[0], e.position[1] - h[1], e.position[2] - h[2]];
    const hi: Vec3 = [e.position[0] + h[0], e.position[1] + h[1], e.position[2] + h[2]];
    min = min ? [Math.min(min[0], lo[0]), Math.min(min[1], lo[1]), Math.min(min[2], lo[2])] : lo;
    max = max ? [Math.max(max[0], hi[0]), Math.max(max[1], hi[1]), Math.max(max[2], hi[2])] : hi;
  }
  return min && max ? { min, max } : null;
}

/**
 * Rigidly move a list of entities: rotate about the origin by `rotation`, then translate by `at`. World-anchored
 * joint ends (and axes) are carried along; body-local ones already follow their body.
 */
export function placeEntities(list: readonly Entity[], at: Vec3, rotation: Quat | null): Entity[] {
  const turn = (v: Vec3): Vec3 => (rotation ? qrot(rotation, v) : v);
  return list.map((e) => {
    if (e.kind === 'joint') {
      return {
        ...e,
        anchorA: e.bodyA ? e.anchorA : vadd(turn(e.anchorA), at),
        anchorB: e.bodyB ? e.anchorB : vadd(turn(e.anchorB), at),
        axis: e.bodyA ? e.axis : turn(e.axis),
      };
    }
    const next = { ...e, position: vadd(turn(e.position), at) };
    return rotation && 'rotation' in e ? { ...next, rotation: qmul(rotation, e.rotation) } : next;
  });
}
