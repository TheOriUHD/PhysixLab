import type { Vec3 } from '../../core/math';
import type { ShapeDef } from '../shapeRegistry';
import { clampDims, halfDiagonal, hullCollider, hullGeometry, unitSpec, WIDTH_HEIGHT_DEPTH } from './helpers';

/** Right-triangle cross-section in the YZ plane: tall at +z, zero height at -z. */
function wedgePoints([x, y, z]: Vec3): Vec3[] {
  const hx = x / 2,
    hy = y / 2,
    hz = z / 2;
  return [
    [-hx, -hy, -hz],
    [hx, -hy, -hz],
    [-hx, -hy, hz],
    [hx, -hy, hz],
    [-hx, hy, hz],
    [hx, hy, hz],
  ];
}

export const wedge: ShapeDef = {
  id: 'wedge',
  label: 'Ramp',
  icon: 'wedge',
  category: 'structural',
  blurb: 'Wedge: ramps, slopes, launch pads',
  defaultSize: [1, 0.6, 2],
  params: [],
  sizeFields: WIDTH_HEIGHT_DEPTH,
  normalizeSize: (size) => clampDims(size),
  volume: ({ size }) => 0.5 * size[0] * size[1] * size[2],
  boundingRadius: ({ size }) => halfDiagonal(size),
  halfHeight: ({ size }) => size[1] / 2,
  convexPoints: ({ size }) => wedgePoints(size),
  colliders: (R, { size }) => hullCollider(R, wedgePoints(size), size),
  geometry: (T, spec) => hullGeometry(T, wedgePoints(unitSpec(spec).size)),
};
