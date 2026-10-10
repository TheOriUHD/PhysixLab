/**
 * Splines for `PathEntity`: pure, allocation-light evaluation shared by the renderer, the editor and the physics
 * worker (movers that follow a track, cameras on rails, spawners along a route …).
 *
 * The curve is a *centripetal Catmull-Rom spline* (the knot spacing is the square root of the chord length, the
 * variant that cannot cusp or overshoot when the points are unevenly spaced) in cubic Hermite form: it passes through
 * every control point with a continuous tangent. For evenly spaced points it is the classic Catmull-Rom spline, whose
 * end tangents are `(P[i+1] − P[i−1]) / 2`. `tension` scales every tangent by `1 − tension`: 0 is the full spline,
 * and 1 removes the tangents so each segment is a straight line between its two points (traversed with an ease-in /
 * ease-out speed). An open path mirrors its first and last neighbour (`2·P0 − P1`) so the ends have no artificial
 * curl; a closed path wraps around.
 *
 * Two parameters address a point on the curve:
 *  - `t` ∈ [0, 1], uniform over *segments* (each segment takes the same slice of `t`, so a path with unevenly
 *    spaced points runs fast through long segments);
 *  - the arc length `s` ∈ [0, length] in metres, which moves at constant speed — what movers want. The mapping is a
 *    table built once per curve (`samplesPerSegment` chords per segment), so evaluating either is O(log n).
 *
 * `closed` paths wrap `t` and `s`; open paths clamp them. Positions are returned in the frame of the points given to
 * the constructor; `pathCurveOf(entity)` builds a curve in world space.
 */
import { qrot, type Quat, type Vec3 } from '../core/math';
import type { PathEntity } from './types';

export interface PathSpec {
  points: readonly Vec3[];
  closed: boolean;
  /** 0 = Catmull-Rom … 1 = straight segments. */
  tension: number;
}

const DEFAULT_SAMPLES = 32;

export class PathCurve {
  /** Number of Hermite segments (open: points − 1, closed: points; 0 for fewer than two points). */
  readonly segments: number;
  /** Total arc length in metres. */
  readonly length: number;
  readonly closed: boolean;
  private readonly first: Vec3 | null;
  private readonly samples: number;
  /** Per segment: P1, P2, M1, M2 (12 numbers) — the Hermite form, tangents taken with respect to `u` ∈ [0, 1]. */
  private readonly seg: Float64Array;
  /** Cumulative arc length at every table node; node k sits at t = k / (segments · samples). */
  private readonly cum: Float64Array;
  private readonly nodes: number;

  constructor(spec: PathSpec, samplesPerSegment = DEFAULT_SAMPLES) {
    const pts = spec.points.map((p) => [p[0], p[1], p[2]] as Vec3);
    const n = pts.length;
    this.first = pts[0] ?? null;
    this.closed = spec.closed && n >= 3;
    this.segments = n < 2 ? 0 : this.closed ? n : n - 1;
    this.samples = Math.max(2, Math.floor(samplesPerSegment));
    this.nodes = this.segments * this.samples;
    this.seg = buildSegments(pts, this.closed, this.segments, 1 - Math.min(1, Math.max(0, spec.tension)));
    this.cum = new Float64Array(this.nodes + 1);
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [0, 0, 0];
    if (this.segments > 0) this.eval(0, a, false);
    for (let k = 1; k <= this.nodes; k++) {
      this.eval(k / this.nodes, b, false);
      this.cum[k] = this.cum[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      a[0] = b[0];
      a[1] = b[1];
      a[2] = b[2];
    }
    this.length = this.cum[this.nodes];
  }

  /** Clamp (open) or wrap (closed) `t` into [0, 1]. */
  private norm(t: number): number {
    if (!Number.isFinite(t)) return 0;
    if (this.closed) return t - Math.floor(t);
    return t < 0 ? 0 : t > 1 ? 1 : t;
  }

  /** Evaluate the Hermite segment under `t`: position (`deriv = false`) or d/du of it (`deriv = true`). */
  private eval(t: number, out: Vec3, deriv: boolean): Vec3 {
    if (this.segments === 0) {
      out[0] = this.first ? this.first[0] : 0;
      out[1] = this.first ? this.first[1] : 0;
      out[2] = this.first ? this.first[2] : 0;
      return out;
    }
    const x = this.norm(t) * this.segments;
    let seg = Math.floor(x);
    if (seg >= this.segments) seg = this.segments - 1; // t = 1 on an open path: the end of the last segment
    const u = x - seg;
    const u2 = u * u;
    const u3 = u2 * u;
    const s = this.seg;
    const o = seg * 12;
    if (deriv) {
      const a = 6 * u2 - 6 * u;
      const b = 3 * u2 - 4 * u + 1;
      const c = -a;
      const d = 3 * u2 - 2 * u;
      for (let ax = 0; ax < 3; ax++)
        out[ax] = a * s[o + ax] + c * s[o + 3 + ax] + b * s[o + 6 + ax] + d * s[o + 9 + ax];
    } else {
      const a = 2 * u3 - 3 * u2 + 1;
      const b = u3 - 2 * u2 + u;
      const c = 1 - a;
      const d = u3 - u2;
      for (let ax = 0; ax < 3; ax++)
        out[ax] = a * s[o + ax] + c * s[o + 3 + ax] + b * s[o + 6 + ax] + d * s[o + 9 + ax];
    }
    return out;
  }

  /** Position at parameter `t` ∈ [0, 1]. */
  positionAt(t: number, out: Vec3 = [0, 0, 0]): Vec3 {
    return this.eval(t, out, false);
  }

  /** Unit tangent (direction of travel) at parameter `t`; a degenerate point falls back to the chord, then +X. */
  tangentAt(t: number, out: Vec3 = [0, 0, 0]): Vec3 {
    this.eval(t, out, true);
    let l = Math.hypot(out[0], out[1], out[2]);
    if (l < 1e-9) {
      // A stationary point (coincident control points, or tension 1 at a segment end): look a little ahead / back.
      const e = 1e-3;
      const a = this.eval(this.norm(t + e), [0, 0, 0], false);
      const b = this.eval(this.norm(t - e), [0, 0, 0], false);
      out[0] = a[0] - b[0];
      out[1] = a[1] - b[1];
      out[2] = a[2] - b[2];
      l = Math.hypot(out[0], out[1], out[2]);
      if (l < 1e-9) {
        out[0] = 1;
        out[1] = 0;
        out[2] = 0;
        return out;
      }
    }
    out[0] /= l;
    out[1] /= l;
    out[2] /= l;
    return out;
  }

  /** Arc length from the start of the path to parameter `t`. */
  distanceAt(t: number): number {
    if (this.segments === 0) return 0;
    const x = this.norm(t) * this.nodes;
    const k = Math.min(this.nodes - 1, Math.floor(x));
    return this.cum[k] + (x - k) * (this.cum[k + 1] - this.cum[k]);
  }

  /** Parameter `t` at arc length `s` (wrapped for a closed path, clamped for an open one). */
  tAtDistance(s: number): number {
    if (this.segments === 0 || this.length <= 0) return 0;
    let d = s;
    if (!Number.isFinite(d)) d = 0;
    if (this.closed) d -= Math.floor(d / this.length) * this.length;
    else d = d < 0 ? 0 : d > this.length ? this.length : d;
    let lo = 0;
    let hi = this.nodes;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const span = this.cum[lo + 1] - this.cum[lo];
    const f = span > 1e-12 ? (d - this.cum[lo]) / span : 0;
    return (lo + f) / this.nodes;
  }

  /** Position after travelling `s` metres along the path. */
  positionAtDistance(s: number, out: Vec3 = [0, 0, 0]): Vec3 {
    return this.eval(this.tAtDistance(s), out, false);
  }

  /** Unit tangent after travelling `s` metres along the path. */
  tangentAtDistance(s: number, out: Vec3 = [0, 0, 0]): Vec3 {
    return this.tangentAt(this.tAtDistance(s), out);
  }

  /**
   * A polyline that follows the curve, `perSegment` chords per segment (for drawing). Open paths include the end
   * point; a closed one repeats the first point so the loop is visibly closed.
   */
  polyline(perSegment = 16): Vec3[] {
    const out: Vec3[] = [];
    if (this.segments === 0) {
      if (this.first) out.push([this.first[0], this.first[1], this.first[2]]);
      return out;
    }
    const n = this.segments * Math.max(1, Math.floor(perSegment));
    for (let k = 0; k <= n; k++) out.push(this.eval(k === n && this.closed ? 0 : k / n, [0, 0, 0], false));
    return out;
  }
}

/**
 * Hermite form of every segment. The tangent at a control point follows the non-uniform (centripetal, α = ½)
 * Catmull-Rom construction: with knot spacings `dt = |ΔP|^½` and neighbours P0 … P3 around the segment P1 → P2,
 *   M1 = dt₁ · ((P1 − P0)/dt₀ − (P2 − P0)/(dt₀ + dt₁) + (P2 − P1)/dt₁)
 *   M2 = dt₁ · ((P2 − P1)/dt₁ − (P3 − P1)/(dt₁ + dt₂) + (P3 − P2)/dt₂)
 * which equals (P2 − P0)/2 and (P3 − P1)/2 for evenly spaced points; both are then scaled by `c = 1 − tension`.
 */
function buildSegments(pts: Vec3[], closed: boolean, segments: number, c: number): Float64Array {
  const out = new Float64Array(segments * 12);
  const n = pts.length;
  const at = (i: number): Vec3 => {
    if (closed) return pts[((i % n) + n) % n];
    if (i < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1], 2 * pts[0][2] - pts[1][2]];
    if (i >= n) {
      const a = pts[n - 1];
      const b = pts[n - 2];
      return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
    }
    return pts[i];
  };
  const knot = (a: Vec3, b: Vec3): number => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  for (let i = 0; i < segments; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    let dt0 = knot(p0, p1);
    let dt1 = knot(p1, p2);
    let dt2 = knot(p2, p3);
    // Coincident points would divide by zero: borrow a neighbouring spacing.
    if (dt1 < 1e-4) dt1 = 1;
    if (dt0 < 1e-4) dt0 = dt1;
    if (dt2 < 1e-4) dt2 = dt1;
    const o = i * 12;
    for (let ax = 0; ax < 3; ax++) {
      out[o + ax] = p1[ax];
      out[o + 3 + ax] = p2[ax];
      out[o + 6 + ax] = c * dt1 * ((p1[ax] - p0[ax]) / dt0 - (p2[ax] - p0[ax]) / (dt0 + dt1) + (p2[ax] - p1[ax]) / dt1);
      out[o + 9 + ax] = c * dt1 * ((p2[ax] - p1[ax]) / dt1 - (p3[ax] - p1[ax]) / (dt1 + dt2) + (p3[ax] - p2[ax]) / dt2);
    }
  }
  return out;
}

/** A curve through the path entity's points, expressed in world space (its `position` / `rotation` applied). */
export function pathCurveOf(
  path: Pick<PathEntity, 'points' | 'closed' | 'tension' | 'position' | 'rotation'>,
): PathCurve {
  return new PathCurve({
    points: path.points.map((p) => localToWorld(path.position, path.rotation, p)),
    closed: path.closed,
    tension: path.tension,
  });
}

/** Rigid transform of a point from a frame at (`position`, `rotation`) into world space. */
export function localToWorld(position: Vec3, rotation: Quat, p: Vec3): Vec3 {
  const r = qrot(rotation, p);
  return [position[0] + r[0], position[1] + r[1], position[2] + r[2]];
}
