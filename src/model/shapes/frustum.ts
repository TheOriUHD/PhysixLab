/**
 * Frustum (truncated cone): a cone with its tip cut off — buckets, flower pots, lampshades, cooling towers.
 *
 * Size: x = z = the diameter of the *wider* end, y = height. `top` is the top diameter over the bottom diameter:
 * below 1 the top is the narrow end (a pot standing on its base), above 1 it is the wide end (a bucket), 1 is a
 * cylinder. A convex hull of two regular `segments`-gons, so the integrated mass is exactly the volume of the
 * polyhedron (the frustum-of-a-pyramid formula `h/3 · (A₁ + A₂ + √(A₁A₂))`).
 */
import type { ShapeDef } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { axialDiameter, clampDims, MIN_DIM } from './helpers';
import type { P2 } from './meshKit';
import { hullPart } from './parts';
import { revolvedGeometry, revolvedPoints, revolvedVolume } from './revolve';
import { SHAPE_ICONS } from './shapeIcons';

const segmentsOf = (spec: ShapeSpec): number =>
  Math.max(6, Math.min(64, Math.round(Number(spec.params?.segments ?? 32))));
const topOf = (spec: ShapeSpec): number => Math.max(0.05, Math.min(2, Number(spec.params?.top ?? 0.5)));

/** (radius, y) profile of a frustum whose wider end has diameter `d` and which is `h` tall. */
export function frustumProfile(d: number, h: number, top: number): P2[] {
  const wide = d / 2;
  const rb = top <= 1 ? wide : wide / top;
  const rt = top <= 1 ? wide * top : wide;
  return [
    [0, -h / 2],
    [rb, -h / 2],
    [rt, h / 2],
    [0, h / 2],
  ];
}

const profileOf = (spec: ShapeSpec): P2[] => frustumProfile(Math.max(spec.size[0], MIN_DIM), spec.size[1], topOf(spec));

export const frustum: ShapeDef = {
  id: 'frustum',
  label: 'Frustum',
  icon: SHAPE_ICONS.frustum,
  category: 'basic',
  blurb: 'Truncated cone: buckets, pots, lampshades, tapered pillars',
  defaultSize: [1, 1, 1],
  params: [
    {
      key: 'top',
      label: 'Top ÷ bottom',
      kind: 'float',
      min: 0.05,
      max: 2,
      step: 0.05,
      default: 0.5,
      hint: 'Top diameter over bottom diameter: below 1 narrows upward, above 1 widens upward, 1 is a cylinder',
    },
    {
      key: 'segments',
      label: 'Segments',
      kind: 'int',
      min: 6,
      max: 64,
      step: 1,
      default: 32,
      hint: 'Sides of the polygon the collider and mesh are built from',
    },
  ],
  sizeFields: [
    { axis: 0, label: 'Diameter (wide end)' },
    { axis: 1, label: 'Height' },
  ],
  axial: true,
  normalizeSize: (size, _params, prev) => {
    const s = clampDims(size);
    const d = axialDiameter(s, prev);
    return [d, s[1], d];
  },
  volume: (spec) => revolvedVolume(profileOf(spec), segmentsOf(spec)),
  boundingRadius: ({ size }) => Math.hypot(size[0] / 2, size[1] / 2),
  halfHeight: ({ size }) => size[1] / 2,
  convexPoints: (spec) => revolvedPoints(profileOf(spec), segmentsOf(spec)),
  colliders: (R, spec) => [hullPart(R, revolvedPoints(profileOf(spec), segmentsOf(spec)))],
  // a frustum scales affinely: one unit mesh per taper and side count
  geometry: (T, spec) => revolvedGeometry(T, frustumProfile(1, 1, topOf(spec)), segmentsOf(spec)),
};
