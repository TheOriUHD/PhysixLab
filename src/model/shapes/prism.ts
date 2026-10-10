import type { Vec3 } from '../../core/math';
import type { ShapeDef } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { clampDims, halfDiagonal, hullCollider, hullGeometry, unitSpec, WIDTH_HEIGHT_DEPTH } from './helpers';

const sidesOf = (spec: ShapeSpec): number => Math.max(3, Math.min(32, Math.round(Number(spec.params?.sides ?? 6))));

/** Regular N-gon in the XZ plane, extruded along Y. */
function prismPoints(spec: ShapeSpec): Vec3[] {
  const [x, y, z] = spec.size;
  const hx = x / 2,
    hy = y / 2,
    hz = z / 2;
  const n = sidesOf(spec);
  const pts: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.PI / 2;
    const px = Math.cos(a) * hx,
      pz = Math.sin(a) * hz;
    pts.push([px, -hy, pz], [px, hy, pz]);
  }
  return pts;
}

export const prism: ShapeDef = {
  id: 'prism',
  label: 'Prism',
  icon: 'prism',
  category: 'solids',
  blurb: 'Regular N-sided prism: pillars, fulcrums, nuts',
  defaultSize: [1, 0.8, 1],
  params: [{ key: 'sides', label: 'Sides', kind: 'int', min: 3, max: 32, step: 1, default: 6 }],
  sizeFields: WIDTH_HEIGHT_DEPTH,
  normalizeSize: (size) => clampDims(size),
  volume: (spec) => {
    const n = sidesOf(spec);
    return 0.5 * n * (spec.size[0] / 2) * (spec.size[2] / 2) * Math.sin((Math.PI * 2) / n) * spec.size[1];
  },
  boundingRadius: ({ size }) => halfDiagonal(size),
  halfHeight: ({ size }) => size[1] / 2,
  convexPoints: prismPoints,
  colliders: (R, spec) => hullCollider(R, prismPoints(spec), spec.size),
  geometryKey: (spec) => `prism:${sidesOf(spec)}`,
  geometry: (T, spec) => hullGeometry(T, prismPoints(unitSpec(spec))),
};
