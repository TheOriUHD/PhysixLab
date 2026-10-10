/** Ring / washer: a flat annulus. A compound of wedge hulls, so things fall through its hole. */
import type { ShapeDef } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { annulusColliders, annulusGeometry, annulusVolume, segmentsOf, type Annulus } from './annulus';
import { axialDiameter, clampDims } from './helpers';
import { SHAPE_ICONS } from './shapeIcons';

const holeOf = (spec: ShapeSpec): number => Math.max(0.1, Math.min(0.95, Number(spec.params?.hole ?? 0.55)));

function dims(spec: ShapeSpec): Annulus {
  const ro = spec.size[0] / 2;
  return { ro, ri: ro * holeOf(spec), h: spec.size[1], n: segmentsOf(spec) };
}

export const ring: ShapeDef = {
  id: 'ring',
  label: 'Ring',
  icon: SHAPE_ICONS.ring,
  category: 'mechanical',
  blurb: 'Flat washer with a real hole: rings to toss, spacers, discs',
  defaultSize: [1, 0.1, 1],
  params: [
    {
      key: 'hole',
      label: 'Hole',
      kind: 'float',
      min: 0.1,
      max: 0.95,
      step: 0.01,
      default: 0.55,
      hint: 'Hole diameter as a fraction of the outer diameter',
    },
    {
      key: 'segments',
      label: 'Segments',
      kind: 'int',
      min: 8,
      max: 64,
      step: 1,
      default: 32,
      hint: 'Convex collider wedges around the ring: more is rounder but costs more',
    },
  ],
  sizeFields: [
    { axis: 0, label: 'Outer diameter' },
    { axis: 1, label: 'Thickness' },
  ],
  axial: true,
  normalizeSize: (size, _params, prev) => {
    const s = clampDims(size);
    const d = axialDiameter(s, prev);
    return [d, s[1], d];
  },
  volume: (spec) => annulusVolume(dims(spec)),
  boundingRadius: (spec) => Math.hypot(spec.size[0] / 2, spec.size[1] / 2),
  halfHeight: ({ size }) => size[1] / 2,
  colliders: (R, spec) => annulusColliders(R, dims(spec)),
  geometry: (T, spec) => annulusGeometry(T, holeOf(spec), segmentsOf(spec)),
};
