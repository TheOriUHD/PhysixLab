/**
 * The pure maths behind ghost placement (a library tile dragged or armed, then dropped into the scene): stepping the
 * rotation and the height offset, the world box of a posed thing, the world-bounds check, a conservative overlap test
 * against solid bodies, and the numbers shown in the ghost's label. No three.js and no app state, so it is unit
 * tested directly (`tests/placementGhost.test.ts`); `src/app/placementGhost.ts` is the controller that uses it.
 */
import { DEG, qfromAxisAngle, qrot, type Quat, type Vec3 } from '../../core/math';
import { supportLocal, type SupportShape } from './snap';

/** Degrees per coarse rotation key press (Q / E / R). */
export const ROTATE_STEP = 15;
/** Degrees per fine rotation key press (Shift held). */
export const ROTATE_FINE = 1;
/** Lowest and highest height offset above (or below) the surface, metres. */
export const LIFT_MIN = -5;
export const LIFT_MAX = 50;

/** Wrap an angle in degrees to (−180, 180]. */
export function wrapDeg(a: number): number {
  const x = ((((a + 180) % 360) + 360) % 360) - 180;
  return x === -180 ? 180 : x;
}

/**
 * One rotation key press. A coarse press moves to the next multiple of 15° in that direction (so a ghost turned to
 * 7° goes to 15° or 0°, never to 22°), a fine press moves by exactly 1°. The result is wrapped to (−180, 180].
 */
export function stepAngle(currentDeg: number, dir: 1 | -1, fine = false): number {
  if (fine) return wrapDeg(Math.round(currentDeg) + dir * ROTATE_FINE);
  const k = dir > 0 ? Math.floor(currentDeg / ROTATE_STEP + 1e-9) + 1 : Math.ceil(currentDeg / ROTATE_STEP - 1e-9) - 1;
  return wrapDeg(k * ROTATE_STEP);
}

/** Rotation about the world up axis by `deg` degrees. */
export function yawQuat(deg: number): Quat {
  return qfromAxisAngle([0, 1, 0], deg * DEG);
}

/** Size of one raise / lower press: the grid step when grid snapping is on (else 10 cm); a tenth of it when fine. */
export function liftStep(gridStep: number, snapOn: boolean, fine = false): number {
  const base = snapOn && gridStep > 0 ? gridStep : 0.1;
  return fine ? base / 10 : base;
}

/** One raise (`dir` 1) or lower (−1) press: the next multiple of `step`, clamped to [`LIFT_MIN`, `LIFT_MAX`]. */
export function stepLift(current: number, dir: 1 | -1, step: number): number {
  const s = Math.max(1e-4, step);
  const k = dir > 0 ? Math.floor(current / s + 1e-9) + 1 : Math.ceil(current / s - 1e-9) - 1;
  const v = Math.round(k * s * 1e6) / 1e6;
  return Math.min(LIFT_MAX, Math.max(LIFT_MIN, v));
}

/** `position` moved by `amount` metres along the unit `dir` (the surface normal when aligned, else world up). */
export function liftAlong(position: Vec3, dir: Vec3, amount: number): Vec3 {
  return [position[0] + dir[0] * amount, position[1] + dir[1] * amount, position[2] + dir[2] * amount];
}

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/** What a thing occupies, as `surfaceDropPose` takes it: an exact solid, or a box, or just a half height. */
export interface BoundsLike {
  support?: SupportShape;
  min?: Vec3;
  max?: Vec3;
  halfHeight?: number;
}

/** The local axis-aligned box of a `BoundsLike`. */
export function boxOfBounds(b: BoundsLike): Aabb {
  if (b.min && b.max) return { min: b.min, max: b.max };
  if (b.support) {
    const s = b.support;
    return {
      min: [-supportLocal(s, [-1, 0, 0]), -supportLocal(s, [0, -1, 0]), -supportLocal(s, [0, 0, -1])],
      max: [supportLocal(s, [1, 0, 0]), supportLocal(s, [0, 1, 0]), supportLocal(s, [0, 0, 1])],
    };
  }
  const h = Math.max(0.001, b.halfHeight ?? 0.5);
  return { min: [-h, -h, -h], max: [h, h, h] };
}

/** World axis-aligned box of the local box [`min`, `max`] turned by `rotation` and moved to `position`. */
export function worldAabb(min: Vec3, max: Vec3, position: Vec3, rotation: Quat): Aabb {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [min[0], max[0]])
    for (const y of [min[1], max[1]])
      for (const z of [min[2], max[2]]) {
        const p = qrot(rotation, [x, y, z]);
        for (let i = 0; i < 3; i++) {
          const v = p[i] + position[i];
          if (v < lo[i]) lo[i] = v;
          if (v > hi[i]) hi[i] = v;
        }
      }
  return { min: lo, max: hi };
}

/** The scene's world-bounds box as the placement check needs it. */
export interface WorldBox {
  enabled: boolean;
  min: Vec3;
  max: Vec3;
}

/** Further than this from the origin nothing can be placed (the physics world is not meant to reach so far). */
export const FAR_LIMIT = 5000;

/**
 * Why a thing centred at `centre` cannot be placed, or null. The bounds box (when enabled) kills a body whose centre
 * leaves it, so a centre outside it is refused; independent of that nothing may land absurdly far away or be non-finite.
 */
export function placementViolation(centre: Vec3, world: WorldBox | null): string | null {
  if (centre.some((v) => !Number.isFinite(v)) || centre.some((v) => Math.abs(v) > FAR_LIMIT)) {
    return 'Too far from the origin';
  }
  if (world?.enabled) {
    for (let i = 0; i < 3; i++) {
      if (centre[i] < world.min[i] || centre[i] > world.max[i]) return 'Outside the world bounds';
    }
  }
  return null;
}

/** An oriented box: centre, rotation and half extents. */
export interface Obb {
  c: Vec3;
  q: Quat;
  h: Vec3;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * Penetration depth of two oriented boxes by the separating-axis test (15 axes): positive when they overlap (the
 * smallest overlap along any axis), zero or negative when they touch or are apart. Both boxes are shrunk about their
 * centres by `shrink` first, so a thing resting flush on a surface (or a curved shape inside its bounding box) is
 * not reported as overlapping.
 */
export function obbPenetration(a: Obb, b: Obb, shrink = 0.9): number {
  const ax: Vec3[] = [qrot(a.q, [1, 0, 0]), qrot(a.q, [0, 1, 0]), qrot(a.q, [0, 0, 1])];
  const bx: Vec3[] = [qrot(b.q, [1, 0, 0]), qrot(b.q, [0, 1, 0]), qrot(b.q, [0, 0, 1])];
  const ha: Vec3 = [a.h[0] * shrink, a.h[1] * shrink, a.h[2] * shrink];
  const hb: Vec3 = [b.h[0] * shrink, b.h[1] * shrink, b.h[2] * shrink];
  const t: Vec3 = [b.c[0] - a.c[0], b.c[1] - a.c[1], b.c[2] - a.c[2]];
  let least = Infinity;
  const test = (axis: Vec3): boolean => {
    const len = Math.hypot(axis[0], axis[1], axis[2]);
    if (len < 1e-6) return true; // parallel edges: no axis
    const n: Vec3 = [axis[0] / len, axis[1] / len, axis[2] / len];
    let ra = 0;
    let rb = 0;
    for (let i = 0; i < 3; i++) {
      ra += ha[i] * Math.abs(dot(n, ax[i]));
      rb += hb[i] * Math.abs(dot(n, bx[i]));
    }
    const depth = ra + rb - Math.abs(dot(n, t));
    if (depth < least) least = depth;
    return depth > 0;
  };
  for (let i = 0; i < 3; i++) if (!test(ax[i])) return least;
  for (let i = 0; i < 3; i++) if (!test(bx[i])) return least;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (!test(cross(ax[i], bx[j]))) return least;
  return least;
}

/** Overlap deeper than this (metres, after shrinking) counts as interpenetrating. */
export const OVERLAP_TOLERANCE = 0.02;

/** Footprint radius of the landing marker for a thing with these local bounds: the half diagonal on the ground. */
export function footprintRadius(min: Vec3, max: Vec3): number {
  const r = Math.hypot(max[0] - min[0], max[2] - min[2]) / 2;
  return Math.min(8, Math.max(0.18, r * 1.08));
}

const num = (v: number): string => {
  const s = (Math.round(v * 100) / 100).toFixed(2);
  return s.replace(/\.?0+$/, '') || '0';
};

/** "1 × 0.5 × 2 m" — the size line of the ghost's label (zero extents, as of a cloth, are left out). */
export function formatSize(min: Vec3, max: Vec3): string {
  const d = [max[0] - min[0], max[1] - min[1], max[2] - min[2]].filter((v) => v > 1e-3);
  return d.length ? `${d.map(num).join(' × ')} m` : '';
}

/** "x 2.5  y 0  z −1" — the position line of the ghost's label. */
export function formatPoint(p: Vec3): string {
  return `x ${num(p[0])}  y ${num(p[1])}  z ${num(p[2])}`.replace(/-/g, '−');
}
