/**
 * Closed triangle surfaces for volumetric soft bodies (SF-5): jelly versions of any shape. Convex shapes use their
 * hull; the analytic primitives (sphere, cylinder, capsule, cone) are sampled densely and hulled. A non-convex
 * shape contributes its convex hull until imported-mesh triangles are available (see `softSurfaceFrom`).
 * Pure TypeScript: runs in the physics worker and in Node.
 */
import { convexHullMesh, type TriMesh } from '../core/hull';
import type { Vec3 } from '../core/math';
import { shapeConvexPoints } from './shapeRegistry';
import type { ShapeSpec } from './types';

/** Fibonacci sphere samples of radius 1 (even coverage, poles included implicitly). */
function fibonacci(n: number): Vec3[] {
  const out: Vec3[] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    out.push([Math.cos(ga * i) * r, y, Math.sin(ga * i) * r]);
  }
  return out;
}

function ring(r: number, y: number, n: number): Vec3[] {
  return Array.from({ length: n }, (_, i) => [
    r * Math.cos((2 * Math.PI * i) / n),
    y,
    r * Math.sin((2 * Math.PI * i) / n),
  ]);
}

/** Boundary sample points of a shape, local space, or null if the shape has no closed convex description. */
export function softSurfacePoints(spec: ShapeSpec): Vec3[] | null {
  const [x, y, z] = spec.size;
  switch (spec.type) {
    case 'sphere':
      return fibonacci(200).map((p) => [p[0] * (x / 2), p[1] * (y / 2), p[2] * (z / 2)] as Vec3);
    case 'cylinder':
      return [...ring(x / 2, y / 2, 28), ...ring(x / 2, -y / 2, 28)].map((p) => [p[0], p[1], p[2] * (z / x)] as Vec3);
    case 'cone':
      return [...ring(x / 2, -y / 2, 28), [0, y / 2, 0] as Vec3].map((p) => [p[0], p[1], p[2] * (z / x)] as Vec3);
    case 'capsule': {
      const r = x / 2;
      const cyl = Math.max(0, y / 2 - r);
      const pts: Vec3[] = [];
      for (const p of fibonacci(160)) pts.push([p[0] * r, p[1] * r + (p[1] >= 0 ? cyl : -cyl), p[2] * r]);
      return pts;
    }
    default:
      return shapeConvexPoints(spec);
  }
}

/** Split triangles (midpoint rule, shared edge vertices) until no edge is longer than `maxEdge`; capped at `maxVerts`. */
export function subdivideMesh(mesh: TriMesh, maxEdge: number, maxVerts = 6000): TriMesh {
  const verts = Array.from(mesh.vertices);
  let tris = Array.from(mesh.indices);
  for (let pass = 0; pass < 5; pass++) {
    const long = (a: number, b: number): number =>
      Math.hypot(verts[3 * a] - verts[3 * b], verts[3 * a + 1] - verts[3 * b + 1], verts[3 * a + 2] - verts[3 * b + 2]);
    let longest = 0;
    for (let t = 0; t < tris.length; t += 3)
      longest = Math.max(
        longest,
        long(tris[t], tris[t + 1]),
        long(tris[t + 1], tris[t + 2]),
        long(tris[t + 2], tris[t]),
      );
    if (longest <= maxEdge || (verts.length / 3) * 4 > maxVerts) break;
    const mid = new Map<number, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * 1e7 + b : b * 1e7 + a;
      let m = mid.get(key);
      if (m === undefined) {
        m = verts.length / 3;
        verts.push(
          (verts[3 * a] + verts[3 * b]) / 2,
          (verts[3 * a + 1] + verts[3 * b + 1]) / 2,
          (verts[3 * a + 2] + verts[3 * b + 2]) / 2,
        );
        mid.set(key, m);
      }
      return m;
    };
    const next: number[] = [];
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
      const ab = midpoint(a, b),
        bc = midpoint(b, c),
        ca = midpoint(c, a);
      next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    tris = next;
  }
  return { vertices: new Float32Array(verts), indices: new Uint32Array(tris) };
}

/** Closed surface mesh for a shape (local space), or null when it cannot be built. `maxEdge` refines flat faces. */
export function softSurface(spec: ShapeSpec, maxEdge = 0): TriMesh | null {
  const pts = softSurfacePoints(spec);
  const hull = pts ? convexHullMesh(pts) : null;
  return hull && maxEdge > 0 ? subdivideMesh(hull, maxEdge) : hull;
}

/**
 * Torus surface for a tyre, axle along local Y: `major` = distance of the tube centre from the axle, `radial` / `axial`
 * = the tube's semi-axes (sidewall height / 2, width / 2). Vertex index = around · `across` + j; j = across/2 is
 * the innermost point of each cross-section (the rim side).
 */
export function torusSurface(major: number, radial: number, axial: number, around: number, across: number): TriMesh {
  const v = new Float32Array(around * across * 3);
  for (let i = 0; i < around; i++) {
    const a = (2 * Math.PI * i) / around;
    for (let j = 0; j < across; j++) {
      const b = (2 * Math.PI * j) / across;
      const rr = major + radial * Math.cos(b);
      const k = (i * across + j) * 3;
      v[k] = rr * Math.cos(a);
      v[k + 1] = axial * Math.sin(b);
      v[k + 2] = rr * Math.sin(a);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < around; i++)
    for (let j = 0; j < across; j++) {
      const i2 = (i + 1) % around,
        j2 = (j + 1) % across;
      const a = i * across + j,
        b = i2 * across + j,
        c = i2 * across + j2,
        d = i * across + j2;
      idx.push(a, d, b, b, d, c);
    }
  return { vertices: v, indices: new Uint32Array(idx) };
}

/** Number of cross-section vertices of a tyre torus. */
export const TYRE_ACROSS = 10;

/** Derived tyre geometry from the entity size [outer diameter, width, sidewall height]. */
export function tyreGeometry(size: Vec3): { major: number; radial: number; axial: number; rimRadius: number } {
  const radial = Math.max(0.01, size[2] / 2);
  const axial = Math.max(0.01, size[1] / 2);
  const major = Math.max(radial + 0.02, size[0] / 2 - radial);
  return { major, radial, axial, rimRadius: major - radial };
}
