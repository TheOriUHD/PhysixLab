/**
 * Pyramid (n-gonal base) and tetrahedron: a base polygon in the XZ plane at the bottom of the size box and an apex
 * above its centre. The base polygon is stretched to fill the width × depth box, so a four-sided pyramid has a
 * rectangular base and a triangle fills its box corner to corner. The tetrahedron is the three-sided pyramid with
 * the size that makes it regular, and it rests on a face.
 */
import type { Vec3 } from '../../core/math';
import type { ShapeDef } from '../shapeRegistry';
import { convexSolid } from './convexSolid';
import { SHAPE_ICONS } from './shapeIcons';

/**
 * Base polygon of `n` corners stretched to fill a unit square, apex above the polygon's centre. An even `n` has a
 * flat side toward +Z (a square base is axis-aligned); an odd `n` has a corner there (a triangle points at +Z).
 */
export function pyramidUnitPoints(n: number): Vec3[] {
  const start = n % 2 === 0 ? Math.PI / 2 + Math.PI / n : Math.PI / 2;
  const base: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a = start + (k * 2 * Math.PI) / n;
    base.push([Math.cos(a), Math.sin(a)]);
  }
  const xs = base.map((p) => p[0]),
    zs = base.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2,
    cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const sx = (Math.max(...xs) - Math.min(...xs)) / 2,
    sz = (Math.max(...zs) - Math.min(...zs)) / 2;
  const fit = (x: number, z: number): [number, number] => [((x - cx) / sx) * 0.5, ((z - cz) / sz) * 0.5];
  const out: Vec3[] = base.map(([x, z]): Vec3 => {
    const [fx, fz] = fit(x, z);
    return [fx, -0.5, fz];
  });
  const [ax, az] = fit(0, 0);
  out.push([ax, 0.5, az]);
  return out;
}

export const pyramid: ShapeDef = convexSolid({
  id: 'pyramid',
  label: 'Pyramid',
  icon: SHAPE_ICONS.pyramid,
  category: 'solids',
  blurb: 'N-sided pyramid: roofs, spikes, monuments, wedges of cheese',
  keywords: ['spike', 'cone', 'roof', 'egypt', 'triangle'],
  params: [
    {
      key: 'sides',
      label: 'Base sides',
      kind: 'int',
      min: 3,
      max: 16,
      step: 1,
      default: 4,
      hint: 'Corners of the base polygon',
    },
  ],
  unitPoints: (p) => pyramidUnitPoints(Math.max(3, Math.min(16, Math.round(Number(p.sides))))),
});

/** The size of a regular tetrahedron of edge 1: base width 1, depth √3/2, height √(2/3). */
export const TETRA_SIZE: Vec3 = [1, Math.sqrt(2 / 3), Math.sqrt(3) / 2];

export const tetrahedron: ShapeDef = convexSolid({
  id: 'tetrahedron',
  label: 'Tetrahedron',
  icon: SHAPE_ICONS.tetrahedron,
  category: 'solids',
  blurb: 'Regular four-faced solid: the simplest polyhedron, a d4 without numbers',
  keywords: ['d4', 'triangle', 'four', 'platonic', 'caltrop'],
  unitPoints: () => pyramidUnitPoints(3),
  defaultSize: TETRA_SIZE,
});
