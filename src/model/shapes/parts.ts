/**
 * Collider parts for compound shapes: each helper returns one `ShapeCollider` ready to be listed in a shape's
 * `colliders()`. A hollow or concave shape is built from several of these — convex hulls and cuboids that tile
 * the solid without overlapping, so the engine's summed mass equals the analytic volume times the density.
 */
import type { Vec3 } from '../../core/math';
import type { RapierModule, ShapeCollider } from '../shapeRegistry';
import { NO_ROT, ORIGIN } from './helpers';

/** A cuboid of half extents `half` centred at `centre`. */
export function boxPart(R: RapierModule, centre: Vec3, half: Vec3): ShapeCollider {
  return {
    desc: R.ColliderDesc.cuboid(Math.max(half[0], 1e-4), Math.max(half[1], 1e-4), Math.max(half[2], 1e-4)),
    localPos: [...centre],
    localRot: [...NO_ROT],
  };
}

/**
 * The convex hull of `pts` (body-frame points) as one collider. A degenerate cloud that the engine cannot hull
 * falls back to the cuboid around its bounds, so a shape never fails to build.
 */
export function hullPart(R: RapierModule, pts: Vec3[]): ShapeCollider {
  const desc = R.ColliderDesc.convexHull(new Float32Array(pts.flat()));
  if (desc) return { desc, localPos: [...ORIGIN], localRot: [...NO_ROT] };
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], p[a]);
      hi[a] = Math.max(hi[a], p[a]);
    }
  return boxPart(
    R,
    [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
    [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2],
  );
}

/** A vertical prism: the 2-D polygon `poly` in the XZ plane, extruded from `y0` to `y1`, as hull points. */
export function prismPoints(poly: readonly (readonly [number, number])[], y0: number, y1: number): Vec3[] {
  return [...poly.map(([x, z]): Vec3 => [x, y0, z]), ...poly.map(([x, z]): Vec3 => [x, y1, z])];
}
