// File: src/model/shapes/spire.ts   (then add `spire` to BUILTIN_SHAPES in src/model/shapes/index.ts)
import type { Vec3 } from '../../src/core/math';
import type { ShapeDef } from '../../src/model/shapeRegistry';
import {
  clampDims,
  halfDiagonal,
  hullCollider,
  hullGeometry,
  unitSpec,
  WIDTH_HEIGHT_DEPTH,
} from '../../src/model/shapes/helpers';

/** Square spire: the base lies in the XZ plane at the bottom of the size box, the apex is above its centre. */
function spirePoints([x, y, z]: Vec3): Vec3[] {
  const hx = x / 2,
    hy = y / 2,
    hz = z / 2;
  return [
    [-hx, -hy, -hz],
    [hx, -hy, -hz],
    [-hx, -hy, hz],
    [hx, -hy, hz],
    [0, hy, 0],
  ];
}

export const spire: ShapeDef = {
  id: 'spire',
  label: 'Spire',
  icon: 'cone',
  category: 'structural',
  blurb: 'Square spire: roofs, spikes, monuments',
  defaultSize: [1, 1, 1],
  params: [],
  sizeFields: WIDTH_HEIGHT_DEPTH,
  normalizeSize: (size) => clampDims(size),
  volume: ({ size }) => (size[0] * size[1] * size[2]) / 3,
  boundingRadius: ({ size }) => halfDiagonal(size),
  halfHeight: ({ size }) => size[1] / 2,
  convexPoints: ({ size }) => spirePoints(size),
  colliders: (R, { size }) => hullCollider(R, spirePoints(size), size),
  geometry: (T, spec) => hullGeometry(T, spirePoints(unitSpec(spec).size)),
};
