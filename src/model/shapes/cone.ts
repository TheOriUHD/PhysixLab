import type { ShapeDef } from '../shapeRegistry';
import { axialDiameter, clampDims, DIAMETER_HEIGHT, halfDiagonal, single } from './helpers';

export const cone: ShapeDef = {
  id: 'cone',
  label: 'Cone',
  icon: 'cone',
  category: 'basic',
  blurb: 'Pointed cone: spinning tops, markers',
  defaultSize: [0.9, 1.2, 0.9],
  params: [],
  sizeFields: DIAMETER_HEIGHT,
  axial: true,
  normalizeSize: (size, _params, prev) => {
    const s = clampDims(size);
    const d = axialDiameter(s, prev);
    return [d, s[1], d];
  },
  volume: ({ size }) => (Math.PI / 3) * (size[0] / 2) * (size[2] / 2) * size[1],
  boundingRadius: ({ size }) => halfDiagonal(size),
  halfHeight: ({ size }) => size[1] / 2,
  colliders: (R, { size }) => single(R.ColliderDesc.cone(size[1] / 2, size[0] / 2)),
  geometry: (T) => new T.ConeGeometry(0.5, 1, 48, 1),
};
