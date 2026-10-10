/**
 * Mesh building blocks for the shape geometry factories (`ShapeDef.geometry`): a vertex / triangle collector
 * with crease-angle smoothing, a lathe (profile revolved about Y) and an outline extruder with ear-clip caps.
 *
 * Everything here is plain TypeScript that talks to three.js only through the `GeometryKit` it is handed, so the
 * physics worker never pulls three.js in. Conventions (the shapes rely on them):
 *
 *  - triangles are counter-clockwise seen from outside, so the geometric normal points out of the solid; the unit
 *    tests integrate the signed volume of every mesh and compare it with the analytic volume to prove it;
 *  - normals are computed from the *position-welded* triangle soup with a crease angle: faces that meet at an
 *    angle below it share a smooth normal, genuine edges (a rim, a step) stay sharp. The caller does not have to
 *    duplicate vertices along edges nor weld them along seams;
 *  - the output is non-indexed (one vertex per triangle corner), like the convex-hull geometries.
 */
import type { BufferGeometry } from 'three';
import type { Vec3 } from '../../core/math';
import type { GeometryKit } from '../shapeRegistry';

/** A 2-D point: (x, y) of an outline, or (radius, height) of a lathe profile. */
export type P2 = [number, number];

/** Maps profile coordinates (u, v) and the extrusion axis w to a 3-D point. */
export type AxisMap = (u: number, v: number, w: number) => Vec3;
export const IDENTITY_MAP: AxisMap = (u, v, w) => [u, v, w];

const TAU = Math.PI * 2;
/** Welding resolution of the smoothing pass: positions closer than this are the same point. */
const WELD = 1e5;

/**
 * The crease angle (degrees) that smooths a surface tessellated into `counts` steps per turn but keeps real
 * edges sharp. Below 12 steps the polygon is meant to look faceted, so nothing is smoothed.
 */
export function creaseFor(...counts: number[]): number {
  const coarsest = Math.min(...counts);
  if (!(coarsest >= 12)) return 5;
  return Math.min(60, (1.5 * 360) / coarsest);
}

export class MeshBuilder {
  private pos: number[] = [];
  private uvs: number[] = [];
  private tris: number[] = [];
  private creases: number[] = [];
  /** Crease angle (degrees) of the triangles added from now on. */
  crease = 40;

  vertex(x: number, y: number, z: number, u = 0, v = 0): number {
    this.pos.push(x, y, z);
    this.uvs.push(u, v);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.tris.push(a, b, c);
    this.creases.push(this.crease);
  }

  /** Quad a-b-c-d (counter-clockwise from outside) as two triangles. */
  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  get triangleCount(): number {
    return this.tris.length / 3;
  }

  /** The triangle soup as plain arrays (tests integrate volumes from it). */
  positions(): readonly number[] {
    return this.pos;
  }

  indices(): readonly number[] {
    return this.tris;
  }

  /** Build the geometry: welded crease-angle normals, uvs as given, degenerate triangles dropped. */
  build(T: GeometryKit): BufferGeometry {
    const pos = this.pos;
    const nTri = this.tris.length / 3;
    const fn = new Float64Array(nTri * 3);
    const ang = new Float64Array(nTri * 3);
    const live = new Uint8Array(nTri);
    const keys: string[] = new Array<string>(nTri * 3);
    const groups = new Map<string, number[]>();
    let kept = 0;

    for (let f = 0; f < nTri; f++) {
      const i0 = this.tris[f * 3] * 3,
        i1 = this.tris[f * 3 + 1] * 3,
        i2 = this.tris[f * 3 + 2] * 3;
      const ax = pos[i1] - pos[i0],
        ay = pos[i1 + 1] - pos[i0 + 1],
        az = pos[i1 + 2] - pos[i0 + 2];
      const bx = pos[i2] - pos[i0],
        by = pos[i2 + 1] - pos[i0 + 1],
        bz = pos[i2 + 2] - pos[i0 + 2];
      const nx = ay * bz - az * by,
        ny = az * bx - ax * bz,
        nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz);
      const scale = Math.max(Math.hypot(ax, ay, az), Math.hypot(bx, by, bz));
      if (!(len > 1e-12 * Math.max(1e-6, scale * scale))) continue; // sliver or zero-area
      live[f] = 1;
      kept++;
      fn[f * 3] = nx / len;
      fn[f * 3 + 1] = ny / len;
      fn[f * 3 + 2] = nz / len;
      // corner angles, for angle-weighted averaging
      const idx = [i0, i1, i2];
      for (let c = 0; c < 3; c++) {
        const p = idx[c],
          q = idx[(c + 1) % 3],
          r = idx[(c + 2) % 3];
        const ux = pos[q] - pos[p],
          uy = pos[q + 1] - pos[p + 1],
          uz = pos[q + 2] - pos[p + 2];
        const vx = pos[r] - pos[p],
          vy = pos[r + 1] - pos[p + 1],
          vz = pos[r + 2] - pos[p + 2];
        const d = (ux * vx + uy * vy + uz * vz) / (Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz) || 1);
        ang[f * 3 + c] = Math.acos(Math.max(-1, Math.min(1, d)));
        const key = `${Math.round(pos[p] * WELD)},${Math.round(pos[p + 1] * WELD)},${Math.round(pos[p + 2] * WELD)}`;
        keys[f * 3 + c] = key;
        const g = groups.get(key);
        if (g) g.push(f * 3 + c);
        else groups.set(key, [f * 3 + c]);
      }
    }

    const outPos = new Float32Array(kept * 9);
    const outNrm = new Float32Array(kept * 9);
    const outUv = new Float32Array(kept * 6);
    let o = 0;
    for (let f = 0; f < nTri; f++) {
      if (!live[f]) continue;
      const cos = Math.cos((this.creases[f] * Math.PI) / 180);
      for (let c = 0; c < 3; c++) {
        const vi = this.tris[f * 3 + c];
        const group = groups.get(keys[f * 3 + c]) as number[];
        let sx = 0,
          sy = 0,
          sz = 0;
        for (const corner of group) {
          const g = Math.floor(corner / 3);
          const d = fn[g * 3] * fn[f * 3] + fn[g * 3 + 1] * fn[f * 3 + 1] + fn[g * 3 + 2] * fn[f * 3 + 2];
          if (d < cos) continue;
          const w = ang[corner];
          sx += fn[g * 3] * w;
          sy += fn[g * 3 + 1] * w;
          sz += fn[g * 3 + 2] * w;
        }
        const l = Math.hypot(sx, sy, sz);
        if (l > 1e-12) {
          sx /= l;
          sy /= l;
          sz /= l;
        } else {
          sx = fn[f * 3];
          sy = fn[f * 3 + 1];
          sz = fn[f * 3 + 2];
        }
        outPos[o * 9 + c * 3] = pos[vi * 3];
        outPos[o * 9 + c * 3 + 1] = pos[vi * 3 + 1];
        outPos[o * 9 + c * 3 + 2] = pos[vi * 3 + 2];
        outNrm[o * 9 + c * 3] = sx;
        outNrm[o * 9 + c * 3 + 1] = sy;
        outNrm[o * 9 + c * 3 + 2] = sz;
        outUv[o * 6 + c * 2] = this.uvs[vi * 2];
        outUv[o * 6 + c * 2 + 1] = this.uvs[vi * 2 + 1];
      }
      o++;
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(outPos, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(outNrm, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(outUv, 2));
    return g;
  }
}

// ── 2-D helpers ─────────────────────────────────────────────────────────────────────────────────────

/** Signed area of a polygon: positive when the points run counter-clockwise (x right, y up). */
export function signedArea(poly: readonly P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** The polygon as given when it runs counter-clockwise, otherwise reversed. Drops repeated points. */
export function ensureCcw(poly: readonly P2[]): P2[] {
  const clean = poly.filter((p, i) => {
    const q = poly[(i + 1) % poly.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9;
  });
  return signedArea(clean) >= 0 ? [...clean] : [...clean].reverse();
}

const cross2 = (a: P2, b: P2, c: P2): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function inTriangle(p: P2, a: P2, b: P2, c: P2): boolean {
  const eps = 1e-12;
  return cross2(a, b, p) >= -eps && cross2(b, c, p) >= -eps && cross2(c, a, p) >= -eps;
}

/**
 * Ear-clip a simple, counter-clockwise polygon (concave allowed, collinear points tolerated) into triangles of
 * indices into `poly`. Falls back to a fan for what cannot be clipped, so it always returns something.
 */
export function triangulate(poly: readonly P2[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  const idx = poly.map((_, i) => i);
  let guard = poly.length * poly.length + 16;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    const n = idx.length;
    for (let i = 0; i < n; i++) {
      const ia = idx[(i + n - 1) % n],
        ib = idx[i],
        ic = idx[(i + 1) % n];
      const a = poly[ia],
        b = poly[ib],
        c = poly[ic];
      if (cross2(a, b, c) <= 1e-12) continue; // reflex or collinear
      let blocked = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        const p = poly[j];
        // a vertex coincident with a corner of the ear does not block it
        if ((p[0] === a[0] && p[1] === a[1]) || (p[0] === b[0] && p[1] === b[1]) || (p[0] === c[0] && p[1] === c[1]))
          continue;
        if (inTriangle(p, a, b, c)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      out.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (clipped) continue;
    // no ear: drop a collinear vertex, else give up on ears
    let dropped = false;
    for (let i = 0; i < n; i++) {
      const a = poly[idx[(i + n - 1) % n]],
        b = poly[idx[i]],
        c = poly[idx[(i + 1) % n]];
      if (Math.abs(cross2(a, b, c)) <= 1e-12) {
        idx.splice(i, 1);
        dropped = true;
        break;
      }
    }
    if (!dropped) break;
  }
  if (idx.length >= 3) for (let i = 1; i + 1 < idx.length; i++) out.push([idx[0], idx[i], idx[i + 1]]);
  return out;
}

/** Orientation of an axis map: negative when it mirrors (so triangle winding must flip). */
function mapDeterminant(map: AxisMap): number {
  const o = map(0, 0, 0);
  const col = (v: Vec3): Vec3 => [v[0] - o[0], v[1] - o[1], v[2] - o[2]];
  const a = col(map(1, 0, 0)),
    b = col(map(0, 1, 0)),
    c = col(map(0, 0, 1));
  return a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
}

/**
 * Extrude a simple outline (any winding; concave allowed) from `w0` to `w1` along the third axis of `map`: two
 * ear-clipped caps and one quad per outline edge. Outward-facing whatever the map's handedness.
 * `uvScale` is metres per uv unit (1 = one texture repeat per metre).
 */
export function extrudeOutline(
  b: MeshBuilder,
  outline: readonly P2[],
  w0: number,
  w1: number,
  map: AxisMap = IDENTITY_MAP,
  uvScale = 1,
): void {
  const poly = ensureCcw(outline);
  if (poly.length < 3) return;
  const flip = mapDeterminant(map) < 0;
  const tri = (a: number, c: number, d: number) => (flip ? b.tri(a, d, c) : b.tri(a, c, d));
  const at = (p: P2, w: number, u: number, v: number): number => {
    const q = map(p[0], p[1], w);
    return b.vertex(q[0], q[1], q[2], u / uvScale, v / uvScale);
  };
  // caps
  const front = poly.map((p) => at(p, w1, p[0], p[1]));
  const back = poly.map((p) => at(p, w0, p[0], p[1]));
  for (const [i, j, k] of triangulate(poly)) {
    tri(front[i], front[j], front[k]);
    tri(back[i], back[k], back[j]);
  }
  // walls
  let run = 0;
  const depth = Math.abs(w1 - w0);
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i],
      q = poly[(i + 1) % poly.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 1e-9) continue;
    const v00 = at(p, w0, run, 0),
      v10 = at(q, w0, run + len, 0),
      v11 = at(q, w1, run + len, depth),
      v01 = at(p, w1, run, depth);
    tri(v00, v10, v11);
    tri(v00, v11, v01);
    run += len;
  }
}

/**
 * Revolve a profile about the Y axis. `profile` is (radius, y), counter-clockwise around the solid in the
 * (radius, y) plane (up the outside, down the inside), so the faces look outward. A point on the axis (radius 0)
 * collapses its ring to a pole. `closed` joins the last point back to the first (a torus, a pipe wall).
 * `start` is the azimuth of the first meridian.
 */
export function lathe(b: MeshBuilder, profile: readonly P2[], segments: number, closed = false, start = 0): void {
  const m = profile.length;
  if (m < 2 || segments < 3) return;
  // arc length along the profile → the v coordinate
  const cum: number[] = [0];
  const count = closed ? m + 1 : m;
  for (let j = 1; j < count; j++) {
    const p = profile[(j - 1) % m],
      q = profile[j % m];
    cum.push(cum[j - 1] + Math.hypot(q[0] - p[0], q[1] - p[1]));
  }
  const total = cum[count - 1] || 1;
  // one ring of vertices per profile point (the closing point is its own ring, so uvs run 0..1)
  const rings: number[][] = [];
  for (let j = 0; j < count; j++) {
    const [r, y] = profile[j % m];
    const ring: number[] = [];
    for (let k = 0; k <= segments; k++) {
      const a = start + (k / segments) * TAU;
      ring.push(b.vertex(r * Math.cos(a), y, r * Math.sin(a), k / segments, cum[j] / total));
    }
    rings.push(ring);
  }
  for (let j = 0; j < count - 1; j++) {
    for (let k = 0; k < segments; k++) {
      const a = rings[j][k],
        bb = rings[j + 1][k],
        c = rings[j][k + 1],
        d = rings[j + 1][k + 1];
      b.tri(a, bb, c);
      b.tri(bb, d, c);
    }
  }
}
