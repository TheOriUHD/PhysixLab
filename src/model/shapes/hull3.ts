/**
 * A small, dependency-free 3-D convex hull (quickhull) for the shape definitions.
 *
 * The shape registry needs three things about a convex solid that the engine's own hull builder does not hand
 * back: the exact volume of the polyhedron the collider will be (so `density × volume()` equals the integrated
 * mass), the faces (for the mesh, and for the numbered faces of a die) and a stable triangulation (so the mesh
 * encloses exactly the volume the collider does). This module computes all three from the same points the
 * collider is built from, in plain TypeScript, so it runs in the physics worker, the page and Node alike.
 *
 * Coplanar points are tolerated: a point within `eps` of a face plane does not extend the hull, so the four
 * corners of a rectangular face, or the rim points of a flat polygon, produce a proper polygon (two or more
 * triangles) rather than failing.
 */
import type { Vec3 } from '../../core/math';

export type Tri = [number, number, number];

export interface Hull {
  /** The distinct input points (duplicates within the tolerance removed); `tris` index into this list. */
  points: Vec3[];
  /** Triangles, counter-clockwise seen from outside. Every point of `points` that is not strictly inside is used. */
  tris: Tri[];
}

export interface HullFace {
  /** Outward unit normal. */
  normal: Vec3;
  /** Plane offset: `normal · p = d` for every vertex of the face. */
  d: number;
  /** Vertex indices (into `Hull.points`), counter-clockwise seen from outside. */
  verts: number[];
}

interface Face {
  a: number;
  b: number;
  c: number;
  nx: number;
  ny: number;
  nz: number;
  d: number;
  outside: number[];
  alive: boolean;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Remove points closer than `tol` to an earlier one (grid-hashed, so a few thousand points stay cheap). */
function dedupe(pts: readonly Vec3[], tol: number): Vec3[] {
  const cell = Math.max(tol * 4, 1e-12);
  const grid = new Map<string, Vec3[]>();
  const out: Vec3[] = [];
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (const p of pts) {
    const ix = Math.floor(p[0] / cell),
      iy = Math.floor(p[1] / cell),
      iz = Math.floor(p[2] / cell);
    let dup = false;
    for (let dx = -1; dx <= 1 && !dup; dx++)
      for (let dy = -1; dy <= 1 && !dup; dy++)
        for (let dz = -1; dz <= 1 && !dup; dz++) {
          const bucket = grid.get(key(ix + dx, iy + dy, iz + dz));
          if (!bucket) continue;
          for (const q of bucket)
            if (Math.abs(q[0] - p[0]) <= tol && Math.abs(q[1] - p[1]) <= tol && Math.abs(q[2] - p[2]) <= tol) {
              dup = true;
              break;
            }
        }
    if (dup) continue;
    out.push(p);
    const k = key(ix, iy, iz);
    const bucket = grid.get(k);
    if (bucket) bucket.push(p);
    else grid.set(k, [p]);
  }
  return out;
}

/**
 * Convex hull of a point cloud, or null when the points do not span a volume (fewer than four, or all coplanar /
 * collinear to within the tolerance). `eps` is relative to the cloud's largest extent.
 */
export function convexHull3(input: readonly Vec3[], eps = 1e-9): Hull | null {
  if (input.length < 4) return null;
  let extent = 0;
  for (const p of input) extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  if (!(extent > 0)) return null;
  const tol = eps * extent;
  const pts = dedupe(input, tol);
  if (pts.length < 4) return null;

  // ── initial tetrahedron: two extreme points, the one farthest from their line, the one farthest from that plane
  let i0 = 0,
    i1 = 0;
  {
    let best = -1;
    for (let axis = 0; axis < 3; axis++) {
      let lo = 0,
        hi = 0;
      for (let i = 1; i < pts.length; i++) {
        if (pts[i][axis] < pts[lo][axis]) lo = i;
        if (pts[i][axis] > pts[hi][axis]) hi = i;
      }
      const span = pts[hi][axis] - pts[lo][axis];
      if (span > best) {
        best = span;
        i0 = lo;
        i1 = hi;
      }
    }
  }
  if (i0 === i1) return null;
  const dir = sub(pts[i1], pts[i0]);
  let i2 = -1,
    best2 = tol;
  for (let i = 0; i < pts.length; i++) {
    const l = Math.hypot(...cross(dir, sub(pts[i], pts[i0]))) / Math.hypot(...dir);
    if (l > best2) {
      best2 = l;
      i2 = i;
    }
  }
  if (i2 < 0) return null;
  const nrm = cross(dir, sub(pts[i2], pts[i0]));
  const nl = Math.hypot(...nrm);
  let i3 = -1,
    best3 = tol;
  for (let i = 0; i < pts.length; i++) {
    const dd = Math.abs(dot(nrm, sub(pts[i], pts[i0]))) / nl;
    if (dd > best3) {
      best3 = dd;
      i3 = i;
    }
  }
  if (i3 < 0) return null;

  const faces: Face[] = [];
  const edgeFace = new Map<number, Face>();
  const N = pts.length;
  const ek = (a: number, b: number) => a * N + b;

  const centre: Vec3 = [
    (pts[i0][0] + pts[i1][0] + pts[i2][0] + pts[i3][0]) / 4,
    (pts[i0][1] + pts[i1][1] + pts[i2][1] + pts[i3][1]) / 4,
    (pts[i0][2] + pts[i1][2] + pts[i2][2] + pts[i3][2]) / 4,
  ];

  function makeFace(a: number, b: number, c: number, interior: Vec3): Face | null {
    const n = cross(sub(pts[b], pts[a]), sub(pts[c], pts[a]));
    const l = Math.hypot(...n);
    if (!(l > 0)) return null;
    let nx = n[0] / l,
      ny = n[1] / l,
      nz = n[2] / l;
    let d = nx * pts[a][0] + ny * pts[a][1] + nz * pts[a][2];
    // orient away from the interior reference point
    if (nx * interior[0] + ny * interior[1] + nz * interior[2] - d > 0) {
      [b, c] = [c, b];
      nx = -nx;
      ny = -ny;
      nz = -nz;
      d = -d;
    }
    const f: Face = { a, b, c, nx, ny, nz, d, outside: [], alive: true };
    faces.push(f);
    edgeFace.set(ek(a, b), f);
    edgeFace.set(ek(b, c), f);
    edgeFace.set(ek(c, a), f);
    return f;
  }

  const seed = [
    makeFace(i0, i1, i2, centre),
    makeFace(i0, i1, i3, centre),
    makeFace(i0, i2, i3, centre),
    makeFace(i1, i2, i3, centre),
  ];
  if (seed.some((f) => !f)) return null;

  const dist = (f: Face, p: Vec3): number => f.nx * p[0] + f.ny * p[1] + f.nz * p[2] - f.d;

  // ── assign every other point to a face it lies outside of
  const used = new Set([i0, i1, i2, i3]);
  for (let i = 0; i < N; i++) {
    if (used.has(i)) continue;
    let bestF: Face | null = null,
      bestD = tol;
    for (const f of seed as Face[]) {
      const dd = dist(f, pts[i]);
      if (dd > bestD) {
        bestD = dd;
        bestF = f;
      }
    }
    if (bestF) bestF.outside.push(i);
  }

  // ── grow the hull
  const stack: Face[] = [...(seed as Face[])];
  let guard = 50 * N + 1000;
  while (stack.length && guard-- > 0) {
    const f = stack.pop() as Face;
    if (!f.alive || f.outside.length === 0) continue;
    // farthest point of this face's outside set
    let eye = f.outside[0],
      eyeD = -Infinity;
    for (const i of f.outside) {
      const dd = dist(f, pts[i]);
      if (dd > eyeD) {
        eyeD = dd;
        eye = i;
      }
    }
    const p = pts[eye];
    // visible region: faces the eye is outside of, connected through shared edges
    const visible: Face[] = [f];
    const seen = new Set<Face>([f]);
    const horizon: [number, number][] = [];
    for (let k = 0; k < visible.length; k++) {
      const v = visible[k];
      for (const [a, b] of [
        [v.a, v.b],
        [v.b, v.c],
        [v.c, v.a],
      ] as [number, number][]) {
        const nb = edgeFace.get(ek(b, a));
        if (!nb || !nb.alive) continue;
        if (seen.has(nb)) continue;
        if (dist(nb, p) > tol) {
          seen.add(nb);
          visible.push(nb);
        } else horizon.push([a, b]);
      }
    }
    const rim = horizon;

    // collect the points the visible faces owned, drop the faces
    const orphans: number[] = [];
    for (const v of visible) {
      for (const i of v.outside) if (i !== eye) orphans.push(i);
      v.alive = false;
      edgeFace.delete(ek(v.a, v.b));
      edgeFace.delete(ek(v.b, v.c));
      edgeFace.delete(ek(v.c, v.a));
    }
    const created: Face[] = [];
    for (const [a, b] of rim) {
      const nf = makeFace(a, b, eye, centre);
      if (nf) created.push(nf);
    }
    for (const i of orphans) {
      let bestF: Face | null = null,
        bestD = tol;
      for (const nf of created) {
        const dd = dist(nf, pts[i]);
        if (dd > bestD) {
          bestD = dd;
          bestF = nf;
        }
      }
      if (bestF) bestF.outside.push(i);
    }
    for (const nf of created) if (nf.outside.length) stack.push(nf);
  }

  const alive = faces.filter((f) => f.alive);
  const tris: Tri[] = alive.map((f) => [f.a, f.b, f.c]);
  // drop points that ended up unused (strictly inside, or coplanar-interior), renumbering the triangles
  const remap = new Map<number, number>();
  const outPts: Vec3[] = [];
  for (const t of tris)
    for (const i of t)
      if (!remap.has(i)) {
        remap.set(i, outPts.length);
        outPts.push(pts[i]);
      }
  return {
    points: outPts,
    tris: tris.map(([a, b, c]) => [remap.get(a) as number, remap.get(b) as number, remap.get(c) as number]),
  };
}

/** Volume of the polyhedron (divergence theorem over the triangles). Positive for the outward winding `convexHull3` returns. */
export function hullVolume(h: Hull): number {
  let v = 0;
  for (const [a, b, c] of h.tris) {
    const p = h.points[a],
      q = h.points[b],
      r = h.points[c];
    v += dot(p, cross(q, r)) / 6;
  }
  return v;
}

/** Surface area of the polyhedron. */
export function hullArea(h: Hull): number {
  let s = 0;
  for (const [a, b, c] of h.tris) {
    s += 0.5 * Math.hypot(...cross(sub(h.points[b], h.points[a]), sub(h.points[c], h.points[a])));
  }
  return s;
}

/** Volume of the convex hull of `pts` (0 when they do not span a volume). */
export function convexVolume(pts: readonly Vec3[]): number {
  const h = convexHull3(pts);
  return h ? hullVolume(h) : 0;
}

/**
 * Merge the hull's coplanar triangles into polygonal faces (a cube has six, not twelve). Vertices of each face
 * are ordered counter-clockwise seen from outside. `angleTol` (radians) and `offsetTol` (relative to the
 * cloud's extent) say how close two planes must be to count as the same.
 */
export function hullFaces(h: Hull, angleTol = 1e-6, offsetTol = 1e-7): HullFace[] {
  let extent = 0;
  for (const p of h.points) extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const planeOf = (t: Tri): { n: Vec3; d: number } => {
    const [a, b, c] = t;
    const n = cross(sub(h.points[b], h.points[a]), sub(h.points[c], h.points[a]));
    const l = Math.hypot(...n) || 1;
    const nn: Vec3 = [n[0] / l, n[1] / l, n[2] / l];
    return { n: nn, d: dot(nn, h.points[a]) };
  };
  const groups: { n: Vec3; d: number; tris: Tri[] }[] = [];
  for (const t of h.tris) {
    const pl = planeOf(t);
    const g = groups.find(
      (q) => dot(q.n, pl.n) > Math.cos(angleTol) && Math.abs(q.d - pl.d) <= offsetTol * Math.max(extent, 1e-12),
    );
    if (g) g.tris.push(t);
    else groups.push({ n: pl.n, d: pl.d, tris: [t] });
  }
  const out: HullFace[] = [];
  for (const g of groups) {
    const directed = new Map<number, number[]>();
    const has = new Set<string>();
    for (const [a, b, c] of g.tris) {
      has.add(`${a},${b}`);
      has.add(`${b},${c}`);
      has.add(`${c},${a}`);
    }
    for (const [a, b, c] of g.tris)
      for (const [x, y] of [
        [a, b],
        [b, c],
        [c, a],
      ] as [number, number][]) {
        if (has.has(`${y},${x}`)) continue; // interior edge of the face
        const list = directed.get(x);
        if (list) list.push(y);
        else directed.set(x, [y]);
      }
    const first = directed.keys().next();
    if (first.done) continue;
    const verts: number[] = [first.value];
    let cur = first.value;
    for (let guard = 0; guard < h.points.length + 2; guard++) {
      const nexts = directed.get(cur);
      if (!nexts || !nexts.length) break;
      const nx = nexts[0];
      if (nx === verts[0]) break;
      verts.push(nx);
      cur = nx;
    }
    // average the triangle normals for a cleaner plane
    out.push({ normal: g.n, d: g.d, verts });
  }
  return out;
}

/** Centroid of a point list. */
export function centroidOf(pts: readonly Vec3[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  const n = Math.max(1, pts.length);
  return [c[0] / n, c[1] / n, c[2] / n];
}
