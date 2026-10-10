/**
 * Ellipsoid: a sphere with independent radii along x, y and z, as one convex hull.
 *
 * The hull's vertices are the *support points* of an evenly spaced lattice of directions (see `lattice.ts`): the
 * point of the ellipsoid whose surface normal is that direction. They all lie on the true ellipsoid, are spaced by
 * normal angle (so the faces crowd where the surface curves most, never where it is nearly flat), and no two
 * neighbouring faces are near-coplanar — which is what keeps the engine's hull builder exact: the integrated mass
 * equals `density × volume()` to better than 0.1 % for every shape this module allows. `volume()` is the exact
 * volume of that polyhedron, which is inscribed in the ellipsoid and holds 97 % of its volume at the default detail
 * for a ball, ~93 % for the flattest allowed ellipsoid; raise *Detail* to approach the smooth solid.
 *
 * Size: the three full diameters; no axis may be shorter than a quarter of the longest — thinner than that the
 * engine's hull builder merges the nearly flat faces of the caps and mis-computes the mass (use a cylinder for a
 * disc). The mesh is the very same polyhedron with the exact ellipsoid normals.
 */
import type { Vec3 } from '../../core/math';
import type { ShapeDef } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { clampDims, hullCollider, WIDTH_HEIGHT_DEPTH } from './helpers';
import { convexHull3, hullVolume, type Hull } from './hull3';
import { sphereLattice } from './lattice';
import { memo } from './memo';
import { PolyMesh, type UV } from './polyMesh';
import { SHAPE_ICONS } from './shapeIcons';

/** Shortest axis relative to the longest. */
export const ELLIPSOID_MIN_RATIO = 0.25;

export const ellipsoidDetail = (spec: ShapeSpec): number =>
  Math.max(4, Math.min(16, Math.round(Number(spec.params?.detail ?? 8))));

interface Solid {
  hull: Hull;
  volume: number;
}

/** Support points of the lattice directions on the ellipsoid with the given full diameters. */
export function ellipsoidPoints(size: Vec3, L: number): Vec3[] {
  const a = size[0] / 2,
    b = size[1] / 2,
    c = size[2] / 2;
  return sphereLattice(L).map(([nx, ny, nz]): Vec3 => {
    const s = Math.sqrt(a * a * nx * nx + b * b * ny * ny + c * c * nz * nz) || 1;
    return [(a * a * nx) / s, (b * b * ny) / s, (c * c * nz) / s];
  });
}

function solid(spec: ShapeSpec): Solid {
  const L = ellipsoidDetail(spec);
  return memo(`ellipsoid|${L}|${spec.size.join(',')}`, () => {
    const hull = convexHull3(ellipsoidPoints(spec.size, L)) as Hull;
    return { hull, volume: hullVolume(hull) };
  });
}

export const ellipsoid: ShapeDef = {
  id: 'ellipsoid',
  label: 'Ellipsoid',
  icon: SHAPE_ICONS.ellipsoid,
  category: 'basic',
  blurb: 'Stretched ball with independent x, y, z diameters: eggs, rugby balls, pebbles',
  keywords: ['egg', 'oval', 'spheroid', 'pebble', 'rugby', 'football', 'stone', 'lens'],
  defaultSize: [1.4, 0.9, 1],
  params: [
    {
      key: 'detail',
      label: 'Detail',
      kind: 'int',
      min: 4,
      max: 16,
      step: 1,
      default: 8,
      hint: 'Subdivision of the convex collider (4 L² + 2 corners): rounder when higher, but dearer to simulate',
    },
  ],
  sizeFields: WIDTH_HEIGHT_DEPTH,
  normalizeSize: (size) => {
    const s = clampDims(size);
    const floor = ELLIPSOID_MIN_RATIO * Math.max(s[0], s[1], s[2]);
    return [Math.max(s[0], floor), Math.max(s[1], floor), Math.max(s[2], floor)];
  },
  volume: (spec) => solid(spec).volume,
  boundingRadius: ({ size }) => Math.max(size[0], size[1], size[2]) / 2,
  halfHeight: ({ size }) => size[1] / 2,
  convexPoints: (spec) => solid(spec).hull.points,
  colliders: (R, spec) => hullCollider(R, solid(spec).hull.points, spec.size),
  // The mesh is built at the real size (the support points are not an affine image of one another), so it is
  // shared only by ellipsoids of the same size and detail.
  geometryKey: (spec) => `ellipsoid:${ellipsoidDetail(spec)}:${spec.size.join(',')}`,
  visualScale: () => [1, 1, 1],
  geometry: (T, spec) => {
    const { hull } = solid(spec);
    const [sx, sy, sz] = spec.size;
    const a = sx / 2,
      b = sy / 2,
      c = sz / 2;
    const normal = (p: Vec3): Vec3 => {
      const n: Vec3 = [p[0] / (a * a), p[1] / (b * b), p[2] / (c * c)];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      return [n[0] / l, n[1] / l, n[2] / l];
    };
    const uv = (p: Vec3): UV => [
      Math.atan2(p[2] / c, p[0] / a) / (2 * Math.PI) + 0.5,
      Math.acos(Math.max(-1, Math.min(1, p[1] / b))) / Math.PI,
    ];
    const m = new PolyMesh();
    for (const [i, j, k] of hull.tris) {
      const p = hull.points[i],
        q = hull.points[j],
        r = hull.points[k];
      m.tri(p, q, r, [normal(p), normal(q), normal(r)], [uv(p), uv(q), uv(r)]);
    }
    return m.build(T);
  },
};
