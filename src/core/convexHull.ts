/**
 * Pure 3D convex hull (incremental / quickhull style) plus the volume, centroid and plane-clipping helpers the
 * cut tool is built on. No dependencies; works in the worker, on the main thread and in Node.
 *
 * Robustness: points closer than a scale-relative epsilon to a face plane count as "on" it and are skipped, so
 * duplicated, coplanar and nearly coplanar inputs are fine. A point set that does not span a volume (all
 * coplanar, collinear, fewer than four distinct points) yields `null`.
 */
import { vadd, vcross, vdot, vscale, vsub, type Vec3 } from './math';

export interface Hull {
  /** Hull vertices only (every one is a corner of the hull). */
  vertices: Vec3[];
  /** Triangles as indices into `vertices`, counter-clockwise seen from outside. */
  faces: [number, number, number][];
}

interface Face {
  a: number;
  b: number;
  c: number;
  n: Vec3;
  d: number;
  alive: boolean;
}

const REL_EPS = 1e-9;

function makeFace(P: Vec3[], a: number, b: number, c: number): Face {
  const n = vcross(vsub(P[b], P[a]), vsub(P[c], P[a]));
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const nn: Vec3 = [n[0] / len, n[1] / len, n[2] / len];
  return { a, b, c, n: nn, d: vdot(nn, P[a]), alive: true };
}

/** Convex hull of a point set, or null if the points do not span a volume. */
export function convexHull(input: readonly Vec3[]): Hull | null {
  const P = input as Vec3[];
  const n = P.length;
  if (n < 4) return null;
  let scale = 0;
  for (const p of P) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const eps = REL_EPS * scale;

  // Initial tetrahedron: the two points farthest apart along an axis, the farthest from their line, then from the plane.
  let i0 = 0,
    i1 = 0;
  let best = -1;
  for (let axis = 0; axis < 3; axis++) {
    let lo = 0,
      hi = 0;
    for (let i = 1; i < n; i++) {
      if (P[i][axis] < P[lo][axis]) lo = i;
      if (P[i][axis] > P[hi][axis]) hi = i;
    }
    const span = P[hi][axis] - P[lo][axis];
    if (span > best) {
      best = span;
      i0 = lo;
      i1 = hi;
    }
  }
  if (!(best > eps)) return null;
  const dir = vsub(P[i1], P[i0]);
  let i2 = -1;
  best = eps;
  for (let i = 0; i < n; i++) {
    const c = vcross(dir, vsub(P[i], P[i0]));
    const dist = Math.hypot(c[0], c[1], c[2]) / Math.hypot(dir[0], dir[1], dir[2]);
    if (dist > best) {
      best = dist;
      i2 = i;
    }
  }
  if (i2 < 0) return null;
  const nrm = vcross(dir, vsub(P[i2], P[i0]));
  const nl = Math.hypot(nrm[0], nrm[1], nrm[2]);
  let i3 = -1;
  best = eps;
  for (let i = 0; i < n; i++) {
    const dist = Math.abs(vdot(nrm, vsub(P[i], P[i0]))) / nl;
    if (dist > best) {
      best = dist;
      i3 = i;
    }
  }
  if (i3 < 0) return null;

  const faces: Face[] = [];
  const inside = vscale(vadd(vadd(P[i0], P[i1]), vadd(P[i2], P[i3])), 0.25);
  const addOriented = (a: number, b: number, c: number) => {
    const f = makeFace(P, a, b, c);
    if (vdot(f.n, inside) - f.d > 0) {
      // Facing the interior: flip the winding.
      faces.push(makeFace(P, a, c, b));
    } else faces.push(f);
  };
  addOriented(i0, i1, i2);
  addOriented(i0, i1, i3);
  addOriented(i0, i2, i3);
  addOriented(i1, i2, i3);

  const used = new Set([i0, i1, i2, i3]);
  const visible: Face[] = [];
  let dead = 0;
  for (let p = 0; p < n; p++) {
    if (used.has(p)) continue;
    const pt = P[p];
    visible.length = 0;
    for (const f of faces) {
      if (f.alive && vdot(f.n, pt) - f.d > eps) visible.push(f);
    }
    if (!visible.length) continue;
    // Horizon = directed edges of visible faces whose reverse edge is not part of a visible face.
    const edges = new Set<number>();
    const key = (a: number, b: number) => a * n + b;
    for (const f of visible) {
      edges.add(key(f.a, f.b));
      edges.add(key(f.b, f.c));
      edges.add(key(f.c, f.a));
    }
    const horizon: [number, number][] = [];
    for (const f of visible) {
      for (const [a, b] of [
        [f.a, f.b],
        [f.b, f.c],
        [f.c, f.a],
      ] as [number, number][]) {
        if (!edges.has(key(b, a))) horizon.push([a, b]);
      }
      f.alive = false;
    }
    for (const [a, b] of horizon) faces.push(makeFace(P, a, b, p));
    used.add(p);
    // Compact occasionally so the visibility scan stays proportional to the live hull.
    dead += visible.length;
    if (dead > 256 && dead > faces.length / 2) {
      dead = 0;
      let w = 0;
      for (const f of faces) if (f.alive) faces[w++] = f;
      faces.length = w;
    }
  }

  const remap = new Map<number, number>();
  const vertices: Vec3[] = [];
  const out: [number, number, number][] = [];
  const idx = (i: number) => {
    let r = remap.get(i);
    if (r === undefined) {
      r = vertices.length;
      remap.set(i, r);
      vertices.push([P[i][0], P[i][1], P[i][2]]);
    }
    return r;
  };
  for (const f of faces) if (f.alive) out.push([idx(f.a), idx(f.b), idx(f.c)]);
  return out.length >= 4 ? { vertices, faces: out } : null;
}

function volumeMoments(h: Hull): { volume: number; centroid: Vec3 } {
  // Reference point inside the hull keeps the signed tetrahedra small and well conditioned.
  let ref: Vec3 = [0, 0, 0];
  for (const v of h.vertices) ref = vadd(ref, v);
  ref = vscale(ref, 1 / h.vertices.length);
  let vol = 0;
  let cx = 0,
    cy = 0,
    cz = 0;
  for (const [a, b, c] of h.faces) {
    const A = vsub(h.vertices[a], ref),
      B = vsub(h.vertices[b], ref),
      C = vsub(h.vertices[c], ref);
    const v6 = vdot(A, vcross(B, C));
    vol += v6;
    cx += v6 * (A[0] + B[0] + C[0]);
    cy += v6 * (A[1] + B[1] + C[1]);
    cz += v6 * (A[2] + B[2] + C[2]);
  }
  if (!(vol > 0)) return { volume: 0, centroid: ref };
  // Tetrahedron (ref, A, B, C) has centroid (A + B + C) / 4 relative to ref and volume v6 / 6.
  return { volume: vol / 6, centroid: vadd(ref, [cx / (4 * vol), cy / (4 * vol), cz / (4 * vol)]) };
}

/** Volume of a hull (m³ for metre inputs). */
export function hullVolume(h: Hull): number {
  return volumeMoments(h).volume;
}

/** Centroid of the solid hull (uniform density centre of mass). */
export function hullCentroid(h: Hull): Vec3 {
  return volumeMoments(h).centroid;
}

/** Volume and centroid in one pass. */
export function hullMoments(h: Hull): { volume: number; centroid: Vec3 } {
  return volumeMoments(h);
}

export interface PlaneClip {
  /** Points whose hull is the part of the solid on the side the normal points to (includes the cap). */
  above: Vec3[];
  /** Points whose hull is the part on the other side (includes the cap). */
  below: Vec3[];
}

/**
 * Split the convex solid spanned by `points` with the plane through `planePoint` with normal `planeNormal`.
 * Returns the point sets of the two halves: the vertices on that side, plus every point where an edge (any pair
 * of vertices, so no topology is needed) crosses the plane. Hull each side to get the half. A side the plane does
 * not reach is returned empty-handed (fewer than four points).
 */
export function clipConvexByPlane(points: readonly Vec3[], planePoint: Vec3, planeNormal: Vec3): PlaneClip {
  const len = Math.hypot(planeNormal[0], planeNormal[1], planeNormal[2]);
  if (!(len > 0)) return { above: [...points], below: [] };
  const nrm: Vec3 = [planeNormal[0] / len, planeNormal[1] / len, planeNormal[2] / len];
  // Only true hull corners can start a crossing edge: this keeps dense clouds cheap.
  const h = convexHull(points);
  const src = h ? h.vertices : [...points];
  let scale = 0;
  for (const p of src) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const eps = REL_EPS * Math.max(scale, 1e-12);
  const dist = src.map((p) => vdot(nrm, vsub(p, planePoint)));
  const above: Vec3[] = [];
  const below: Vec3[] = [];
  const hi: number[] = [];
  const lo: number[] = [];
  src.forEach((p, i) => {
    const d = dist[i];
    if (d > eps) {
      above.push(p);
      hi.push(i);
    } else if (d < -eps) {
      below.push(p);
      lo.push(i);
    } else {
      above.push(p);
      below.push(p);
    }
  });
  for (const i of hi) {
    for (const j of lo) {
      const t = dist[i] / (dist[i] - dist[j]);
      const x: Vec3 = [
        src[i][0] + t * (src[j][0] - src[i][0]),
        src[i][1] + t * (src[j][1] - src[i][1]),
        src[i][2] + t * (src[j][2] - src[i][2]),
      ];
      above.push(x);
      below.push(x);
    }
  }
  return { above, below };
}
