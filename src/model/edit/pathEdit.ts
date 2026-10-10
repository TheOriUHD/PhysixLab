/**
 * Pure path-editing maths (ED-23): picking a point on a spline with a ray, inserting / removing / reversing /
 * respacing / subdividing / simplifying control points, flattening and grid-snapping them, and building a path
 * through a list of positions. Everything here works on plain `Vec3` arrays and `PathCurve` (no DOM, three.js or
 * Rapier), so the editor commands, the path tool and the unit tests share one implementation.
 *
 * Points are expressed in the path's own frame unless a function says "world" (it then takes the path's pose).
 */
import { qrot, qrotInv, type Quat, type Vec3 } from '../../core/math';
import { LIMITS } from '../limits';
import { PathCurve, type PathSpec } from '../path';

/** Fewest control points a path may keep (a loop needs three corners to enclose anything). */
export const minPoints = (closed: boolean): number => (closed ? 3 : 2);

export const canClose = (pointCount: number): boolean => pointCount >= 3;

export const canRemovePoint = (pointCount: number, closed: boolean): boolean => pointCount > minPoints(closed);

export const canAddPoint = (pointCount: number): boolean => pointCount < LIMITS.maxPathPoints;

const copy = (p: Vec3): Vec3 => [p[0], p[1], p[2]];

// ---- picking ---------------------------------------------------------------------------------

export interface RayPolylineHit {
  /** Index of the polyline segment (from vertex `index` to `index + 1`). */
  index: number;
  /** Position along that segment, 0 … 1. */
  u: number;
  /** The closest point on the polyline. */
  point: Vec3;
  /** Distance along the ray to its closest approach. */
  rayT: number;
  /** Distance between the ray and the polyline at the closest approach. */
  distance: number;
}

/** Closest approach between the ray `origin + t·dir` (t ≥ 0, `dir` a unit vector) and the segment a → b. */
function rayToSegment(origin: Vec3, dir: Vec3, a: Vec3, b: Vec3): { t: number; u: number; distance: number } {
  const d2: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const r: Vec3 = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
  const E = d2[0] * d2[0] + d2[1] * d2[1] + d2[2] * d2[2];
  const B = dir[0] * d2[0] + dir[1] * d2[1] + dir[2] * d2[2];
  const C = dir[0] * r[0] + dir[1] * r[1] + dir[2] * r[2];
  const F = d2[0] * r[0] + d2[1] * r[1] + d2[2] * r[2];
  let t: number;
  let u: number;
  if (E < 1e-18) {
    u = 0;
    t = Math.max(0, -C);
  } else {
    const denom = E - B * B;
    t = denom > 1e-12 ? Math.max(0, (B * F - C * E) / denom) : 0;
    u = (B * t + F) / E;
    if (u < 0) {
      u = 0;
      t = Math.max(0, -C);
    } else if (u > 1) {
      u = 1;
      t = Math.max(0, B - C);
    }
  }
  const px = origin[0] + dir[0] * t - (a[0] + d2[0] * u);
  const py = origin[1] + dir[1] * t - (a[1] + d2[1] * u);
  const pz = origin[2] + dir[2] * t - (a[2] + d2[2] * u);
  return { t, u, distance: Math.hypot(px, py, pz) };
}

/**
 * The point of a polyline closest to a ray. `dir` need not be normalised. With `maxAngle` (radians) only hits inside
 * the cone `distance ≤ tan(maxAngle) · rayT` count — a click tolerance that stays constant on screen — and the best
 * hit is the one with the smallest angular offset; without it the best hit is simply the closest one.
 */
export function closestOnPolylineToRay(
  poly: readonly Vec3[],
  origin: Vec3,
  dir: Vec3,
  maxAngle?: number,
): RayPolylineHit | null {
  const l = Math.hypot(dir[0], dir[1], dir[2]);
  if (poly.length < 2 || l < 1e-12) return null;
  const d: Vec3 = [dir[0] / l, dir[1] / l, dir[2] / l];
  const slope = maxAngle === undefined ? Infinity : Math.tan(maxAngle);
  let best: RayPolylineHit | null = null;
  let bestScore = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const h = rayToSegment(origin, d, poly[i], poly[i + 1]);
    if (maxAngle !== undefined && h.distance > slope * Math.max(h.t, 1e-9)) continue;
    const score = maxAngle === undefined ? h.distance : h.distance / Math.max(h.t, 1e-9);
    if (score < bestScore) {
      bestScore = score;
      const a = poly[i];
      const b = poly[i + 1];
      best = {
        index: i,
        u: h.u,
        point: [a[0] + (b[0] - a[0]) * h.u, a[1] + (b[1] - a[1]) * h.u, a[2] + (b[2] - a[2]) * h.u],
        rayT: h.t,
        distance: h.distance,
      };
    }
  }
  return best;
}

export interface RayCurveHit extends RayPolylineHit {
  /**
   * Control segment the hit lies on: the new point goes *after* control point `segment`, i.e. at index
   * `segment + 1` (a closed path's last segment appends).
   */
  segment: number;
  /** Curve parameter `t` ∈ [0, 1] of the hit. */
  t: number;
}

/** Turn a polyline hit on `curve.polyline(perSegment)` into a hit on the curve (control segment + parameter). */
export function curveHitFrom(curve: PathCurve, perSegment: number, hit: RayPolylineHit | null): RayCurveHit | null {
  if (!hit || curve.segments === 0) return null;
  const segment = Math.min(curve.segments - 1, Math.floor(hit.index / perSegment));
  const local = (hit.index - segment * perSegment + hit.u) / perSegment;
  return { ...hit, segment, t: (segment + local) / curve.segments };
}

/** Closest point of the spline itself (sampled `perSegment` chords per control segment) to a ray. */
export function closestOnCurveToRay(
  spec: PathSpec,
  origin: Vec3,
  dir: Vec3,
  maxAngle?: number,
  perSegment = 24,
): RayCurveHit | null {
  const curve = new PathCurve(spec);
  if (curve.segments === 0) return null;
  return curveHitFrom(curve, perSegment, closestOnPolylineToRay(curve.polyline(perSegment), origin, dir, maxAngle));
}

/** Control points with `point` inserted after control point `segment`; also the new index. */
export function insertPoint(points: readonly Vec3[], segment: number, point: Vec3): { points: Vec3[]; index: number } {
  const at = Math.max(0, Math.min(points.length - 1, segment)) + 1;
  const next = points.map(copy);
  next.splice(at, 0, copy(point));
  return { points: next, index: at };
}

/** Control points without index `i`, or null if the path would drop below its minimum. */
export function removePoint(points: readonly Vec3[], closed: boolean, i: number): Vec3[] | null {
  if (!points[i] || !canRemovePoint(points.length, closed)) return null;
  return points.filter((_, j) => j !== i).map(copy);
}

// ---- whole-path operations ---------------------------------------------------------------------

/**
 * The control points in the opposite direction of travel. The curve is the same shape traversed backwards:
 * `evaluate(t)` of the result equals `evaluate(1 − t)` of the original. A closed path keeps its first point as the
 * start (`[p0, pn-1 … p1]`) so the loop does not shift.
 */
export function reversePoints(points: readonly Vec3[], closed: boolean): Vec3[] {
  if (!closed || points.length < 2) return points.map(copy).reverse();
  return [copy(points[0]), ...points.slice(1).map(copy).reverse()];
}

/**
 * `count` points spaced at equal arc length along the curve (open: the ends stay on the first and last point; closed:
 * the first point stays). The new spline passes through points on the old curve and so follows it closely, but it is
 * not identical to it.
 */
export function resample(spec: PathSpec, count: number): Vec3[] {
  const closed = spec.closed && spec.points.length >= 3;
  const n = Math.max(minPoints(closed), Math.min(LIMITS.maxPathPoints, Math.floor(count)));
  const curve = new PathCurve(spec);
  if (curve.length <= 1e-9) return spec.points.map(copy);
  const out: Vec3[] = [];
  for (let k = 0; k < n; k++) {
    const s = closed ? (k * curve.length) / n : (k * curve.length) / (n - 1);
    out.push(curve.positionAtDistance(s));
  }
  if (!closed) out[n - 1] = copy(spec.points[spec.points.length - 1]);
  out[0] = copy(spec.points[0]);
  return out;
}

/** Insert a point on the curve in the middle (in `t`) of every control segment; null if that exceeds the limit. */
export function subdivide(spec: PathSpec): Vec3[] | null {
  const curve = new PathCurve(spec);
  const n = spec.points.length;
  if (curve.segments === 0 || n + curve.segments > LIMITS.maxPathPoints) return null;
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    out.push(copy(spec.points[i]));
    if (i < curve.segments) out.push(curve.positionAt((i + 0.5) / curve.segments));
  }
  return out;
}

/** Distance from `p` to the segment a → b. */
function segmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz;
  let u = l2 > 1e-18 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2 : 0;
  u = Math.max(0, Math.min(1, u));
  return Math.hypot(a[0] + abx * u - p[0], a[1] + aby * u - p[1], a[2] + abz * u - p[2]);
}

/** Ramer–Douglas–Peucker over `pts[lo..hi]`: marks the interior indices to keep. */
function rdp(pts: readonly Vec3[], lo: number, hi: number, tol: number, keep: boolean[]): void {
  const stack: [number, number][] = [[lo, hi]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1;
    let farD = tol;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(pts[i], pts[a], pts[b]);
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = true;
      stack.push([a, far], [far, b]);
    }
  }
}

/**
 * Drop control points that lie within `tolerance` metres of the line through their neighbours (Ramer–Douglas–Peucker
 * over the control polygon). Ends stay; a closed path keeps at least three points.
 */
export function simplify(points: readonly Vec3[], closed: boolean, tolerance: number): Vec3[] {
  const n = points.length;
  if (n <= minPoints(closed)) return points.map(copy);
  const keep = new Array<boolean>(n).fill(false);
  if (!closed) {
    keep[0] = keep[n - 1] = true;
    rdp(points, 0, n - 1, tolerance, keep);
  } else {
    // Split the loop at the point farthest from the first one and simplify both halves.
    let far = 1;
    let farD = -1;
    for (let i = 1; i < n; i++) {
      const d = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1], points[i][2] - points[0][2]);
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    keep[0] = keep[far] = true;
    rdp(points, 0, far, tolerance, keep);
    const second = [...points.slice(far), points[0]];
    const keep2 = new Array<boolean>(second.length).fill(false);
    rdp(second, 0, second.length - 1, tolerance, keep2);
    for (let i = 1; i < second.length - 1; i++) if (keep2[i]) keep[far + i] = true;
  }
  const out = points.filter((_, i) => keep[i]).map(copy);
  return out.length >= minPoints(closed) ? out : points.map(copy);
}

// ---- world-space edits ---------------------------------------------------------------------

export interface Pose {
  position: Vec3;
  rotation: Quat;
}

/** Apply `fn` to every point in world space and return the results in the path's own frame. */
export function mapInWorld(points: readonly Vec3[], pose: Pose, fn: (world: Vec3) => Vec3): Vec3[] {
  return points.map((p) => {
    const r = qrot(pose.rotation, p);
    const w = fn([pose.position[0] + r[0], pose.position[1] + r[1], pose.position[2] + r[2]]);
    return qrotInv(pose.rotation, [w[0] - pose.position[0], w[1] - pose.position[1], w[2] - pose.position[2]]);
  });
}

/** Height (world y) a flattened path sits at: just above the ground plane so the line does not z-fight with it. */
export const GROUND_LIFT = 0.05;

/** Put every point at world height `y`. */
export const flatten = (points: readonly Vec3[], pose: Pose, y = GROUND_LIFT): Vec3[] =>
  mapInWorld(points, pose, (w) => [w[0], y, w[2]]);

/** Snap a world position to a grid of `grid` metres on the chosen axes (default x and z). */
export function snapToGrid(p: Vec3, grid: number, axes: { x?: boolean; y?: boolean; z?: boolean } = {}): Vec3 {
  if (!(grid > 0)) return copy(p);
  const { x = true, y = false, z = true } = axes;
  const s = (v: number) => Math.round(v / grid) * grid + 0; // + 0 turns -0 into 0
  return [x ? s(p[0]) : p[0], y ? s(p[1]) : p[1], z ? s(p[2]) : p[2]];
}

/** Snap every point (in world space) to the grid on all three axes. */
export const snapPointsToGrid = (points: readonly Vec3[], pose: Pose, grid: number): Vec3[] =>
  mapInWorld(points, pose, (w) => snapToGrid(w, grid, { x: true, y: true, z: true }));

/** Control points through a list of positions, in order; consecutive duplicates collapse. Null for fewer than two. */
export function pointsThrough(positions: readonly Vec3[]): Vec3[] | null {
  const out: Vec3[] = [];
  for (const p of positions) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) < 1e-6) continue;
    out.push(copy(p));
  }
  return out.length >= 2 ? out.slice(0, LIMITS.maxPathPoints) : null;
}

/** Total arc length of the spline through `points`. */
export const pathLength = (points: readonly Vec3[], closed: boolean, tension: number): number =>
  new PathCurve({ points, closed, tension }).length;
