/**
 * A mesh collector for shapes whose normals are known analytically (rounded boxes, revolved profiles, flat-faced
 * solids) — the counterpart of `MeshBuilder` in `meshKit.ts`, which derives smooth normals from the triangle soup.
 *
 * Every triangle is stored with its own three vertices (non-indexed, like the rest of the shape meshes). A vertex
 * normal is whatever the caller says it is — the exact surface normal of a rounded corner, an axis for a flat cap —
 * or the triangle's own normal when none is given (flat shading). Optional per-vertex colours tint a region of a
 * shape (the tyre of a wheel); the renderer turns vertex colours on only for geometries that carry them.
 *
 * Plain TypeScript: it talks to three.js only through the `GeometryKit` it is handed.
 */
import type { BufferGeometry } from 'three';
import type { Vec3 } from '../../core/math';
import type { GeometryKit } from '../shapeRegistry';
import type { Hull, HullFace } from './hull3';

export type UV = [number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(n[0], n[1], n[2]);
  return l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 1, 0];
}

export class PolyMesh {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uvs: number[] = [];
  private cols: number[] = [];
  private colored = false;
  /** Colour (linear 0..1) of the vertices added from now on; null leaves them white. */
  tint: Vec3 | null = null;

  get triangleCount(): number {
    return this.pos.length / 9;
  }

  /** One triangle, counter-clockwise from outside. Omitted normals are the face normal, omitted uvs zero. */
  tri(a: Vec3, b: Vec3, c: Vec3, n?: readonly [Vec3, Vec3, Vec3], uv?: readonly [UV, UV, UV]): void {
    // a collapsed triangle (a pole of a revolved profile) adds nothing and would carry a meaningless normal
    const area2 = cross(sub(b, a), sub(c, a));
    if (Math.hypot(area2[0], area2[1], area2[2]) < 1e-14) return;
    const fn = n ? null : faceNormal(a, b, c);
    const pts = [a, b, c];
    for (let i = 0; i < 3; i++) {
      const p = pts[i];
      const nn = n ? n[i] : (fn as Vec3);
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(nn[0], nn[1], nn[2]);
      this.uvs.push(uv ? uv[i][0] : 0, uv ? uv[i][1] : 0);
      if (this.tint) {
        this.colored = true;
        this.cols.push(this.tint[0], this.tint[1], this.tint[2]);
      } else this.cols.push(1, 1, 1);
    }
  }

  /** A convex polygon (counter-clockwise from outside) as a fan, flat-shaded unless normals are given. */
  polygon(pts: readonly Vec3[], normals?: readonly Vec3[], uvs?: readonly UV[]): void {
    for (let i = 1; i + 1 < pts.length; i++) {
      this.tri(
        pts[0],
        pts[i],
        pts[i + 1],
        normals ? [normals[0], normals[i], normals[i + 1]] : undefined,
        uvs ? [uvs[0], uvs[i], uvs[i + 1]] : undefined,
      );
    }
  }

  /** A quad a-b-c-d (counter-clockwise from outside) as two triangles. */
  quad(
    a: Vec3,
    b: Vec3,
    c: Vec3,
    d: Vec3,
    n?: readonly [Vec3, Vec3, Vec3, Vec3],
    uv?: readonly [UV, UV, UV, UV],
  ): void {
    this.tri(a, b, c, n ? [n[0], n[1], n[2]] : undefined, uv ? [uv[0], uv[1], uv[2]] : undefined);
    this.tri(a, c, d, n ? [n[0], n[2], n[3]] : undefined, uv ? [uv[0], uv[2], uv[3]] : undefined);
  }

  build(T: GeometryKit): BufferGeometry {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(this.uvs, 2));
    if (this.colored) g.setAttribute('color', new T.Float32BufferAttribute(this.cols, 3));
    return g;
  }
}

/**
 * Flat-shaded mesh of a convex polyhedron: one polygon per planar face (a cube is six quads), uvs projected onto
 * each face's plane. `faces` is `hullFaces(hull)`.
 */
export function flatFacesMesh(hull: Hull, faces: readonly HullFace[]): PolyMesh {
  const m = new PolyMesh();
  for (const f of faces) {
    const pts = f.verts.map((i) => hull.points[i]);
    // an in-plane frame: u along the first edge, v = n × u
    const e = sub(pts[1], pts[0]);
    const el = Math.hypot(e[0], e[1], e[2]) || 1;
    const u: Vec3 = [e[0] / el, e[1] / el, e[2] / el];
    const v = cross(f.normal, u);
    const uvs = pts.map((p): UV => [p[0] * u[0] + p[1] * u[1] + p[2] * u[2], p[0] * v[0] + p[1] * v[1] + p[2] * v[2]]);
    m.polygon(pts, undefined, uvs);
  }
  return m;
}
