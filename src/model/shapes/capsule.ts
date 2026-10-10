import type { ShapeDef } from '../shapeRegistry';
import { axialDiameter, clampDims, DIAMETER_HEIGHT, halfDiagonal, single } from './helpers';

export const capsule: ShapeDef = {
  id: 'capsule',
  label: 'Capsule',
  icon: 'capsule',
  category: 'basic',
  blurb: 'Pill: characters, rollers, rounded rods',
  defaultSize: [0.6, 1.4, 0.6],
  params: [],
  sizeFields: DIAMETER_HEIGHT,
  axial: true,
  normalizeSize: (size, _params, prev) => {
    const s = clampDims(size);
    const d = axialDiameter(s, prev);
    return [d, Math.max(s[1], d), d]; // never shorter than a sphere
  },
  volume: ({ size }) => {
    const r = size[0] / 2;
    return Math.PI * r * r * Math.max(0, size[1] - size[0]) + (4 / 3) * Math.PI * r * r * r;
  },
  boundingRadius: ({ size }) => halfDiagonal(size),
  halfHeight: ({ size }) => size[1] / 2,
  colliders: (R, { size }) => single(R.ColliderDesc.capsule(Math.max(0, (size[1] - size[0]) / 2), size[0] / 2)),
  // The mesh is a unit-diameter capsule whose cylinder section is (height − diameter) / diameter long,
  // scaled uniformly by the diameter, so one geometry serves every capsule with the same aspect ratio.
  geometryKey: ({ size: [x, y] }) => `capsule:${Math.round(((y - x) / x) * 1000)}`,
  visualScale: ({ size }) => [size[0], size[0], size[0]],
  geometry: (T, { size: [x, y] }) => new T.CapsuleGeometry(0.5, Math.max(0, (y - x) / x), 10, 32),
};
