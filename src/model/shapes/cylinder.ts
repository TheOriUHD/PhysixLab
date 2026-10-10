import type { ShapeDef } from '../shapeRegistry';
import { axialDiameter, clampDims, DIAMETER_HEIGHT, halfDiagonal, single } from './helpers';

export const cylinder: ShapeDef = {
  id: 'cylinder',
  label: 'Cylinder',
  icon: 'cylinder',
  category: 'basic',
  blurb: 'Drum, wheel, pillar. Its axis is a natural hinge axle',
  defaultSize: [0.8, 1, 0.8],
  params: [],
  sizeFields: DIAMETER_HEIGHT,
  axial: true,
  normalizeSize: (size, _params, prev) => {
    const s = clampDims(size);
    const d = axialDiameter(s, prev);
    return [d, s[1], d];
  },
  volume: ({ size }) => Math.PI * (size[0] / 2) * (size[2] / 2) * size[1],
  boundingRadius: ({ size }) => halfDiagonal(size),
  halfHeight: ({ size }) => size[1] / 2,
  colliders: (R, { size }) => single(R.ColliderDesc.cylinder(size[1] / 2, size[0] / 2)),
  geometry: (T) => new T.CylinderGeometry(0.5, 0.5, 1, 48, 1),
};
