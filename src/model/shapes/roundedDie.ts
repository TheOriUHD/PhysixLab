/**
 * The rounded cube of the d6. A game die must come to rest on one of its six faces — never on an edge or a corner —
 * and a faceted rounding can break that: any flat facet whose plane passes under the centre of mass is a place the
 * die can sit. The general rounded box (`roundedBox.ts`) uses an evenly spaced direction lattice that does not care;
 * this one is built for the purpose:
 *
 *  - every rounded edge is an even number of facets, so the middle of the edge (45° between the two faces, where
 *    the centre of mass is exactly above) is a vertex and not a facet;
 *  - every corner has a vertex on the diagonal, so no flat facet is centred under the centre of mass there either;
 *  - the rounding radius is limited (a quarter of the edge) so that the facets next to those vertices are tilted
 *    far enough that the centre of mass falls outside them. `tests/dice.test.ts` checks this on a grid of
 *    radii: only the six faces can carry the die.
 *
 * As with all the rounded hulls the engine's own limits apply (`hull3.ts`): a fillet too fine for the engine gets
 * fewer facets, and a tiny one none (a sharp cube).
 */
import type { Vec3 } from '../../core/math';
import { firstSafeHull, hullFaces, hullVolume, type Hull, type HullFace } from './hull3';
import { memo } from './memo';

/** Largest radius, as a fraction of the die's edge. */
export const DIE_MAX_ROUNDNESS = 0.25;

/** Directions of one octant: the three axes, `segments - 1` points on each of the three arcs, and the diagonal. */
export function dieOctant(segments: number): Vec3[] {
  return memo(`die|octant|${segments}`, () => {
    const out: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const axes: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    for (let a = 0; a < 3; a++) {
      const p = axes[a],
        q = axes[(a + 1) % 3];
      for (let k = 1; k < segments; k++) {
        const t = ((k / segments) * Math.PI) / 2;
        out.push([
          p[0] * Math.cos(t) + q[0] * Math.sin(t),
          p[1] * Math.cos(t) + q[1] * Math.sin(t),
          p[2] * Math.cos(t) + q[2] * Math.sin(t),
        ]);
      }
    }
    const s = 1 / Math.sqrt(3);
    out.push([s, s, s]);
    return out;
  });
}

/** The corner points of a cube of edge 1 rounded by `radius`, the edges in `segments` facets. */
export function roundedDiePoints(radius: number, segments: number): Vec3[] {
  const core = 0.5 - radius;
  const out: Vec3[] = [];
  if (!(radius > 1e-9)) {
    for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) out.push([x, y, z]);
    return out;
  }
  const dirs = dieOctant(segments);
  for (const sx of [1, -1])
    for (const sy of [1, -1])
      for (const sz of [1, -1])
        for (const d of dirs)
          out.push([sx * (core + radius * d[0]), sy * (core + radius * d[1]), sz * (core + radius * d[2])]);
  return out;
}

export interface RoundedDie {
  hull: Hull;
  volume: number;
  /** The radius actually built (0 when the rounding is too fine for the engine). */
  radius: number;
  /** Facets across each rounded edge actually built. */
  segments: number;
  /** Distance from the centre to the farthest point. */
  reach: number;
}

/** The unit rounded cube for a roundness (the radius as a fraction of the edge), engine-safe. */
export function roundedDie(roundness: number): RoundedDie {
  const radius = Math.max(0, Math.min(DIE_MAX_ROUNDNESS, roundness));
  return memo(`die|rounded|${radius}`, () => {
    const plans: { radius: number; segments: number }[] =
      radius > 1e-9
        ? [
            { radius, segments: 4 },
            { radius, segments: 2 },
            { radius: 0, segments: 0 },
          ]
        : [{ radius: 0, segments: 0 }];
    const found = firstSafeHull(plans.map((p) => () => roundedDiePoints(p.radius, p.segments)));
    // a cube's eight corners always form a hull
    const { hull, index } = found as { hull: Hull; index: number };
    const plan = plans[index];
    return {
      hull,
      volume: hullVolume(hull),
      radius: plan.radius,
      segments: plan.segments,
      reach: Math.max(...hull.points.map((p) => Math.hypot(p[0], p[1], p[2]))),
    };
  });
}

/**
 * The faces of a hull the body can rest on: those whose polygon contains the projection of the centre of mass onto
 * their plane. A fair die has exactly as many as it has faces.
 */
export function restingFaces(hull: Hull, centre: Vec3 = [0, 0, 0]): HullFace[] {
  return hullFaces(hull).filter((f) => {
    const n = f.normal;
    const t = n[0] * centre[0] + n[1] * centre[1] + n[2] * centre[2] - f.d;
    const p: Vec3 = [centre[0] - t * n[0], centre[1] - t * n[1], centre[2] - t * n[2]];
    const vs = f.verts.map((i) => hull.points[i]);
    return vs.every((a, i) => {
      const b = vs[(i + 1) % vs.length];
      const e: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const q: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
      const cx = e[1] * q[2] - e[2] * q[1],
        cy = e[2] * q[0] - e[0] * q[2],
        cz = e[0] * q[1] - e[1] * q[0];
      return cx * n[0] + cy * n[1] + cz * n[2] > 1e-9;
    });
  });
}
