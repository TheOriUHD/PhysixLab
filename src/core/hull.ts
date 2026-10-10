/**
 * 3D convex hull (incremental, O(n·f)) for the small point clouds shapes produce. Returns a closed triangle
 * mesh with counter-clockwise (outward) winding, or null when the points are degenerate (coplanar / collinear).
 */
import { vcross, vdot, vsub, type Vec3 } from './math';

export interface TriMesh {
  /** xyz per vertex. */
  vertices: Float32Array;
  indices: Uint32Array;
}

export function convexHullMesh(pts: readonly Vec3[]): TriMesh | null {
  const n = pts.length;
  if (n < 4) return null;
  // Scale-aware tolerance.
  let ext = 0;
  for (const p of pts) ext = Math.max(ext, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const eps = 1e-9 * Math.max(1, ext);

  // Initial tetrahedron: the extreme pair on x, the farthest point from that line, then from that plane.
  let i0 = 0,
    i1 = 0;
  for (let i = 1; i < n; i++) {
    if (pts[i][0] < pts[i0][0]) i0 = i;
    if (pts[i][0] > pts[i1][0]) i1 = i;
  }
  if (i0 === i1) i1 = i0 === 0 ? 1 : 0;
  let i2 = -1,
    best = eps;
  for (let i = 0; i < n; i++) {
    const c = vcross(vsub(pts[i1], pts[i0]), vsub(pts[i], pts[i0]));
    const d = Math.hypot(c[0], c[1], c[2]);
    if (d > best) {
      best = d;
      i2 = i;
    }
  }
  if (i2 < 0) return null;
  const nrm = vcross(vsub(pts[i1], pts[i0]), vsub(pts[i2], pts[i0]));
  let i3 = -1;
  best = eps;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(vdot(nrm, vsub(pts[i], pts[i0]))) / Math.hypot(nrm[0], nrm[1], nrm[2]);
    if (d > best) {
      best = d;
      i3 = i;
    }
  }
  if (i3 < 0) return null;

  type Face = { a: number; b: number; c: number; n: Vec3; alive: boolean };
  const faces: Face[] = [];
  const mk = (a: number, b: number, c: number): Face => {
    const nn = vcross(vsub(pts[b], pts[a]), vsub(pts[c], pts[a]));
    const l = Math.hypot(nn[0], nn[1], nn[2]) || 1;
    const f: Face = { a, b, c, n: [nn[0] / l, nn[1] / l, nn[2] / l], alive: true };
    faces.push(f);
    return f;
  };
  const centre: Vec3 = [
    (pts[i0][0] + pts[i1][0] + pts[i2][0] + pts[i3][0]) / 4,
    (pts[i0][1] + pts[i1][1] + pts[i2][1] + pts[i3][1]) / 4,
    (pts[i0][2] + pts[i1][2] + pts[i2][2] + pts[i3][2]) / 4,
  ];
  const addOriented = (a: number, b: number, c: number): void => {
    const f = mk(a, b, c);
    if (vdot(f.n, vsub(centre, pts[a])) > 0) {
      // faces the interior → flip
      f.b = c;
      f.c = b;
      f.n = [-f.n[0], -f.n[1], -f.n[2]];
    }
  };
  addOriented(i0, i1, i2);
  addOriented(i0, i1, i3);
  addOriented(i0, i2, i3);
  addOriented(i1, i2, i3);

  const used = new Set([i0, i1, i2, i3]);
  for (let p = 0; p < n; p++) {
    if (used.has(p)) continue;
    const P = pts[p];
    const visible: Face[] = [];
    for (const f of faces) if (f.alive && vdot(f.n, vsub(P, pts[f.a])) > eps) visible.push(f);
    if (!visible.length) continue; // inside (or on) the hull
    const edges = new Map<string, [number, number]>();
    for (const f of visible) {
      for (const [u, v] of [
        [f.a, f.b],
        [f.b, f.c],
        [f.c, f.a],
      ] as [number, number][]) {
        const rev = `${v}_${u}`;
        if (edges.has(rev)) edges.delete(rev);
        else edges.set(`${u}_${v}`, [u, v]);
      }
      f.alive = false;
    }
    for (const [u, v] of edges.values()) mk(u, v, p);
  }

  const remap = new Map<number, number>();
  const verts: number[] = [];
  const idx: number[] = [];
  for (const f of faces) {
    if (!f.alive) continue;
    for (const k of [f.a, f.b, f.c]) {
      let m = remap.get(k);
      if (m === undefined) {
        m = remap.size;
        remap.set(k, m);
        verts.push(pts[k][0], pts[k][1], pts[k][2]);
      }
      idx.push(m);
    }
  }
  return { vertices: new Float32Array(verts), indices: new Uint32Array(idx) };
}
