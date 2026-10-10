/**
 * Dome: a solid spherical cap, flat face down — from a shallow lens to a full hemisphere. A convex hull of
 * `segments`-gon rings (see `revolve.ts`), exact mass.
 *
 * Size: x = z = base diameter, y = height. The height is held between 5 % of the diameter (a flat disc-like
 * dome) and 50 % (the hemisphere), so the cap never overhangs its base.
 */
import type { ShapeDef } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { axialDiameter, clampDims, MIN_DIM } from './helpers';
import type { P2 } from './meshKit';
import { hullPart } from './parts';
import { revolvedGeometry, revolvedPoints, revolvedVolume } from './revolve';
import { SHAPE_ICONS } from './shapeIcons';

const MIN_RATIO = 0.05;
const MAX_RATIO = 0.5;

const segmentsOf = (spec: ShapeSpec): number =>
  Math.max(8, Math.min(48, Math.round(Number(spec.params?.segments ?? 32))));

/** (radius, y) profile of a cap with base radius `a` and height `h`, base at y = −h/2, apex at y = +h/2. */
export function domeProfile(a: number, h: number, n: number): P2[] {
  const rs = (a * a + h * h) / (2 * h); // radius of the sphere the cap is cut from
  const cy = h / 2 - rs; // its centre
  const psiMax = Math.asin(Math.min(1, a / rs)); // polar angle of the rim; > 90° never happens (h ≤ a)
  const q = Math.max(3, Math.ceil(psiMax / ((Math.PI * 2) / n)));
  const profile: P2[] = [
    [0, -h / 2],
    [a, -h / 2],
  ];
  for (let j = 1; j < q; j++) {
    const psi = psiMax * (1 - j / q);
    profile.push([rs * Math.sin(psi), cy + rs * Math.cos(psi)]);
  }
  profile.push([0, h / 2]);
  return profile;
}

const profileOf = (spec: ShapeSpec): P2[] =>
  domeProfile(Math.max(spec.size[0], MIN_DIM) / 2, Math.max(spec.size[1], MIN_DIM), segmentsOf(spec));

export const dome: ShapeDef = {
  id: 'dome',
  label: 'Dome',
  icon: SHAPE_ICONS.dome,
  category: 'structural',
  blurb: 'Solid spherical cap, shallow or tall: roofs, bumps, mounds',
  defaultSize: [1.6, 0.6, 1.6],
  params: [
    {
      key: 'segments',
      label: 'Segments',
      kind: 'int',
      min: 8,
      max: 48,
      step: 1,
      default: 32,
      hint: 'Sides of the rings the convex collider and mesh are built from',
    },
  ],
  sizeFields: [
    { axis: 0, label: 'Base diameter' },
    { axis: 1, label: 'Height' },
  ],
  normalizeSize: (size, _params, prev) => {
    const s = clampDims(size);
    const d = axialDiameter(s, prev);
    return [d, Math.max(MIN_RATIO * d, Math.min(MAX_RATIO * d, s[1])), d];
  },
  volume: (spec) => revolvedVolume(profileOf(spec), segmentsOf(spec)),
  boundingRadius: ({ size }) => Math.hypot(size[0] / 2, size[1] / 2),
  halfHeight: ({ size }) => size[1] / 2,
  convexPoints: (spec) => revolvedPoints(profileOf(spec), segmentsOf(spec)),
  colliders: (R, spec) => [hullPart(R, revolvedPoints(profileOf(spec), segmentsOf(spec)))],
  // the cap's curvature depends on height ÷ diameter, so one mesh per ratio and side count serves every size
  geometryKey: (spec) => `dome:${segmentsOf(spec)}:${Math.round((spec.size[1] / spec.size[0]) * 1000)}`,
  visualScale: ({ size }) => [size[0], size[0], size[0]],
  geometry: (T, spec) => {
    const n = segmentsOf(spec);
    const ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, spec.size[1] / spec.size[0]));
    return revolvedGeometry(T, domeProfile(0.5, ratio, n), n);
  },
};
