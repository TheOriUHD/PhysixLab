import type { Vec3 } from '../../core/math';
import type { ShapeDef } from '../shapeRegistry';
import { clampDims, halfDiagonal, hullCollider, hullGeometry, unitSpec, WIDTH_HEIGHT_DEPTH } from './helpers';

const PHI = (1 + Math.sqrt(5)) / 2;
const RAW: Vec3[] = [
  [-1, PHI, 0],
  [1, PHI, 0],
  [-1, -PHI, 0],
  [1, -PHI, 0],
  [0, -1, PHI],
  [0, 1, PHI],
  [0, -1, -PHI],
  [0, 1, -PHI],
  [PHI, 0, -1],
  [PHI, 0, 1],
  [-PHI, 0, -1],
  [-PHI, 0, 1],
];
const LEN = Math.hypot(1, PHI);

/** Vertices of a regular icosahedron scaled to the ellipsoid inscribed in the size box. */
function icoPoints([x, y, z]: Vec3): Vec3[] {
  return RAW.map((p) => [(p[0] / LEN) * (x / 2), (p[1] / LEN) * (y / 2), (p[2] / LEN) * (z / 2)] as Vec3);
}

export const icosahedron: ShapeDef = {
  id: 'icosahedron',
  label: 'Icosahedron',
  icon: 'icosahedron',
  category: 'solids',
  blurb: 'Twenty-sided gem: a faceted, rolling ball',
  defaultSize: [1, 1, 1],
  params: [],
  sizeFields: WIDTH_HEIGHT_DEPTH,
  normalizeSize: (size) => clampDims(size),
  volume: ({ size }) => {
    // Regular icosahedron with circumradius 1 has volume (5/12)(3+√5) a³, a = 1/sin(2π/5)
    const a = 1 / Math.sin((2 * Math.PI) / 5);
    const v1 = (5 / 12) * (3 + Math.sqrt(5)) * a * a * a;
    return v1 * (size[0] / 2) * (size[1] / 2) * (size[2] / 2);
  },
  boundingRadius: ({ size }) => halfDiagonal(size),
  halfHeight: ({ size }) => size[1] / 2,
  convexPoints: ({ size }) => icoPoints(size),
  colliders: (R, { size }) => hullCollider(R, icoPoints(size), size),
  geometry: (T, spec) => hullGeometry(T, icoPoints(unitSpec(spec).size)),
};
