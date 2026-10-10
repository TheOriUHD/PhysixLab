/**
 * How fine a fillet the engine can be given. A rounded edge of radius `rim` on a body of diameter `D` is `steps`
 * facets; the first facet leaves the flat face at distance `rim · (1 − cos(90° / steps))`, and the engine's hull
 * builder needs every such distance to be at least `ENGINE_CLEARANCE × D` (see `hull3.ts`). So a small radius gets
 * fewer facets, a smaller one a single chamfer, and a tiny one none. `bevelPlan` lists the (radius, facets) pairs to
 * try, most detailed first, for `firstSafeHull`.
 */
import { ENGINE_CLEARANCE, ENGINE_MIN_DIHEDRAL } from './hull3';

/** Margin over the engine's clearance used when estimating, so the first plan usually already qualifies. */
const MARGIN = 1.15;

/** Facets of a rim whose neighbours around the axis meet at less than this are not even tried. */
const MIN_AROUND_AXIS_DEGREES = ENGINE_MIN_DIHEDRAL - 0.5;

export interface BevelPlan {
  /** Radius to build (0 = a sharp edge). */
  rim: number;
  /** Facets across the rounded edge (1 = a flat chamfer). */
  steps: number;
  /** Sides around the axis, for a body of revolution (fewer than asked when the rim needs it). */
  sides?: number;
}

/** The largest number of facets the estimate allows for this rim and diameter (0 = too small for even a chamfer). */
export function maxBevelSteps(rim: number, diameter: number): number {
  const need = ENGINE_CLEARANCE * MARGIN * diameter;
  if (!(rim >= need)) return 0;
  const angle = Math.acos(Math.max(-1, Math.min(1, 1 - need / rim)));
  if (!(angle > 1e-6)) return 64;
  return Math.max(1, Math.floor(Math.PI / 2 / angle));
}

/**
 * Sides to try for a body of revolution, from the requested count down to 8 (about 15 % fewer each time): the
 * faces of a fillet band meet their neighbours around the axis at roughly `360° / sides × sin(tilt)`, and the engine
 * merges faces that meet at under about 1.35°, so a finer rim wants fewer sides.
 */
export function sidesLadder(sides: number): number[] {
  const out = [sides];
  for (let n = Math.round(sides * 0.85); n >= 8; n = Math.round(n * 0.85)) {
    if (n !== out[out.length - 1]) out.push(n);
  }
  if (out[out.length - 1] !== 8 && sides > 8) out.push(8);
  return out;
}

/** Angle (degrees) at which the faces of the first facet of a rim meet their neighbours around the axis. */
function aroundAxisDihedral(sides: number, steps: number): number {
  const tilt = Math.PI / 2 / steps / 2; // the first facet leaves the cap at half a step
  return (360 / sides) * Math.sin(tilt);
}

/**
 * Plans for `rim` with `steps` facets, then one facet fewer … a chamfer — and, for a body of revolution, the same
 * again with fewer sides — finally the sharp shape. `chamfer` asks for a single flat cut whatever `steps` says.
 * Combinations that are certain to crowd the engine's hull builder are left out, so the list is short.
 */
export function bevelPlan(rim: number, steps: number, diameter: number, chamfer: boolean, sides?: number): BevelPlan[] {
  const fit = maxBevelSteps(rim, diameter);
  const top = chamfer ? Math.min(1, fit) : Math.min(steps, fit);
  const out: BevelPlan[] = [];
  for (const n of sides === undefined ? [undefined] : sidesLadder(sides))
    for (let s = top; s >= 1; s--) {
      if (n !== undefined && aroundAxisDihedral(n, chamfer ? 1 : s) < MIN_AROUND_AXIS_DEGREES) continue;
      out.push(n === undefined ? { rim, steps: s } : { rim, steps: s, sides: n });
    }
  out.push(sides === undefined ? { rim: 0, steps: 1 } : { rim: 0, steps: 1, sides });
  return out;
}
