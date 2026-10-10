/**
 * Convex solids of revolution made of regular N-gon rings: the hemisphere, the dome and the frustum.
 *
 * The solid is described by a *profile*, the (radius, y) points from the bottom centre up to the top, y never
 * decreasing and the outline convex (so the hull of the rings is the stack of ring-to-ring frusta). Because
 * every ring is a regular N-gon with its first vertex on the +X axis, consecutive rings are similar polygons
 * with aligned corners: the solid between two of them is a *frustum of a pyramid* whose side faces are planar
 * trapezoids, and its volume is exact, `h/3 · (A₁ + A₂ + √(A₁A₂))`. So the engine's integrated hull mass equals
 * `density × revolvedVolume(...)` to rounding, and the mesh built from the same rings encloses that volume.
 */
import type { BufferGeometry } from 'three';
import type { Vec3 } from '../../core/math';
import type { GeometryKit } from '../shapeRegistry';
import { creaseFor, lathe, MeshBuilder, type P2 } from './meshKit';

/** Area of a regular `n`-gon with circumradius `r`. */
export const ngonArea = (n: number, r: number): number => 0.5 * n * r * r * Math.sin((Math.PI * 2) / n);

/** Exact volume of the polyhedron the profile's rings span. */
export function revolvedVolume(profile: readonly P2[], n: number): number {
  let v = 0;
  for (let j = 0; j + 1 < profile.length; j++) {
    const [r0, y0] = profile[j],
      [r1, y1] = profile[j + 1];
    const a0 = ngonArea(n, r0),
      a1 = ngonArea(n, r1);
    v += ((y1 - y0) / 3) * (a0 + a1 + Math.sqrt(a0 * a1));
  }
  return v;
}

/** The distinct vertices of the rings: `n` per ring, one for a ring on the axis. */
export function revolvedPoints(profile: readonly P2[], n: number): Vec3[] {
  const out: Vec3[] = [];
  let last: P2 | null = null;
  for (const p of profile) {
    if (last && last[0] === p[0] && last[1] === p[1]) continue; // a repeated profile point adds no vertex
    last = p;
    const [r, y] = p;
    if (r < 1e-9) {
      out.push([0, y, 0]);
      continue;
    }
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      out.push([r * Math.cos(a), y, r * Math.sin(a)]);
    }
  }
  return out;
}

/** Smooth-shaded mesh of the solid (crease from `n`), uvs by azimuth and profile length. */
export function revolvedGeometry(T: GeometryKit, profile: readonly P2[], n: number): BufferGeometry {
  const b = new MeshBuilder();
  b.crease = creaseFor(n);
  lathe(b, profile, n);
  return b.build(T);
}

/** Quarter-circle arc points of radius `r` about `(0, cy)` from the equator (angle 0) to the pole, `q` steps. */
export function quarterArc(r: number, cy: number, q: number): P2[] {
  const out: P2[] = [];
  for (let j = 0; j <= q; j++) {
    const phi = (Math.PI / 2) * (j / q);
    out.push([j === q ? 0 : r * Math.cos(phi), cy + r * Math.sin(phi)]);
  }
  return out;
}
