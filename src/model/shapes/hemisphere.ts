/**
 * Hemisphere: a solid half ball, flat face down. A convex hull of `segments`-gon rings (see `revolve.ts`), so the
 * integrated mass is exactly `density × volume`. It rocks back upright when nudged and sits happily on its flat
 * face; turn it over and it is a bowl-shaped weeble.
 *
 * Size: x = z = diameter, y = radius (locked: it is half a ball).
 */
import type { Vec3 } from '../../core/math';
import type { ShapeDef } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { MIN_DIM } from './helpers';
import type { P2 } from './meshKit';
import { hullPart } from './parts';
import { quarterArc, revolvedGeometry, revolvedPoints, revolvedVolume } from './revolve';
import { SHAPE_ICONS } from './shapeIcons';

const segmentsOf = (spec: ShapeSpec): number =>
  Math.max(8, Math.min(48, Math.round(Number(spec.params?.segments ?? 24))));

/** (radius, y) profile for a hemisphere of radius `r` whose flat face is at y = −r/2. */
export function hemisphereProfile(r: number, n: number): P2[] {
  const y0 = -r / 2;
  const q = Math.max(2, Math.ceil(n / 4));
  const arc = quarterArc(r, y0, q); // equator point first (same as the rim), pole last
  return [[0, y0], ...arc];
}

const profileOf = (spec: ShapeSpec): P2[] => hemisphereProfile(Math.max(spec.size[0], MIN_DIM) / 2, segmentsOf(spec));

/** Which diameter the edit changed: x, z, or twice y (the height is the radius). */
function diameterOf(s: Vec3, prev?: Vec3): number {
  if (!prev) return Math.max(s[0], MIN_DIM);
  const dx = Math.abs(s[0] - prev[0]),
    dz = Math.abs(s[2] - prev[2]),
    dy = Math.abs(2 * s[1] - 2 * prev[1]);
  return Math.max(MIN_DIM, dy > dx && dy > dz ? 2 * s[1] : dz > dx ? s[2] : s[0]);
}

export const hemisphere: ShapeDef = {
  id: 'hemisphere',
  label: 'Hemisphere',
  icon: SHAPE_ICONS.hemisphere,
  category: 'solids',
  blurb: 'Solid half ball: bowls to turn over, domes, rocking toys',
  defaultSize: [1, 0.5, 1],
  params: [
    {
      key: 'segments',
      label: 'Segments',
      kind: 'int',
      min: 8,
      max: 48,
      step: 1,
      default: 24,
      hint: 'Sides of the rings the convex collider and mesh are built from',
    },
  ],
  sizeFields: [{ axis: 0, label: 'Diameter' }],
  normalizeSize: (size, _params, prev) => {
    const d = diameterOf(size, prev);
    return [d, d / 2, d];
  },
  volume: (spec) => revolvedVolume(profileOf(spec), segmentsOf(spec)),
  // the rim of the flat face is the farthest point; the pole is nearer
  boundingRadius: ({ size }) => Math.hypot(size[0] / 2, size[1] / 2),
  halfHeight: ({ size }) => size[1] / 2,
  convexPoints: (spec) => revolvedPoints(profileOf(spec), segmentsOf(spec)),
  colliders: (R, spec) => [hullPart(R, revolvedPoints(profileOf(spec), segmentsOf(spec)))],
  // one mesh per side count, scaled uniformly by the diameter
  visualScale: ({ size }) => [size[0], size[0], size[0]],
  geometry: (T, spec) => {
    const n = segmentsOf(spec);
    return revolvedGeometry(T, hemisphereProfile(0.5, n), n);
  },
};
