/**
 * Direction lattices on the unit sphere for the rounded shapes: the octahedron subdivided `L` times and projected
 * onto the sphere. The directions are spaced almost evenly (about 90° / L apart), which matters for the physics:
 * the engine merges neighbouring hull faces whose normals differ by less than about 1.5°, and a hull built from
 * evenly spaced directions never has such faces — unlike latitude rings, whose faces crowd together at the poles.
 */
import type { Vec3 } from '../../core/math';
import { memo } from './memo';

/** Directions of one octant (x, y, z ≥ 0): `(L + 1)(L + 2) / 2` unit vectors. */
export function octantLattice(L: number): Vec3[] {
  return memo(`lattice|octant|${L}`, () => {
    const out: Vec3[] = [];
    for (let i = 0; i <= L; i++)
      for (let j = 0; j <= L - i; j++) {
        const k = L - i - j;
        const l = Math.hypot(i, j, k);
        out.push([i / l, j / l, k / l]);
      }
    return out;
  });
}

/** All directions of the sphere, each exactly once: `4 L² + 2` unit vectors. */
export function sphereLattice(L: number): Vec3[] {
  return memo(`lattice|sphere|${L}`, () => {
    const seen = new Set<string>();
    const out: Vec3[] = [];
    for (const sx of [1, -1])
      for (const sy of [1, -1])
        for (const sz of [1, -1])
          for (const d of octantLattice(L)) {
            const v: Vec3 = [d[0] * sx, d[1] * sy, d[2] * sz];
            const key = v.map((c) => Math.round(c * 1e9)).join(',');
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(v);
          }
    return out;
  });
}
