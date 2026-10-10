import type { ShapeDef } from '../shapeRegistry';
import { boxCorners, clampDims, halfDiagonal, single, WIDTH_HEIGHT_DEPTH } from './helpers';

export const box: ShapeDef = {
  id: 'box',
  label: 'Box',
  icon: 'box',
  category: 'basic',
  blurb: 'Cuboid: blocks, walls, crates',
  defaultSize: [1, 1, 1],
  params: [],
  sizeFields: WIDTH_HEIGHT_DEPTH,
  normalizeSize: (size) => clampDims(size),
  volume: ({ size }) => size[0] * size[1] * size[2],
  boundingRadius: ({ size }) => halfDiagonal(size),
  halfHeight: ({ size }) => size[1] / 2,
  convexPoints: ({ size }) => boxCorners(size),
  colliders: (R, { size }) => single(R.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2)),
  geometry: (T) => new T.BoxGeometry(1, 1, 1),
};
