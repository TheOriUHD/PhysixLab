import type { ShapeDef } from '../shapeRegistry';
import { clampDims, DIAMETER, single, uniformDiameter } from './helpers';

export const sphere: ShapeDef = {
  id: 'sphere',
  label: 'Sphere',
  icon: 'sphere',
  category: 'basic',
  blurb: 'Ball: rolls, bounces, swings',
  defaultSize: [1, 1, 1],
  params: [],
  sizeFields: DIAMETER,
  normalizeSize: (size, _params, prev) => {
    const d = uniformDiameter(clampDims(size), prev);
    return [d, d, d];
  },
  // size is uniform, so the product of the three diameters is d³
  volume: ({ size }) => (Math.PI / 6) * size[0] * size[1] * size[2],
  boundingRadius: ({ size }) => size[0] / 2,
  halfHeight: ({ size }) => size[1] / 2,
  colliders: (R, { size }) => single(R.ColliderDesc.ball(size[0] / 2)),
  geometry: (T) => new T.SphereGeometry(0.5, 40, 28),
};
