/** Tube / pipe: a hollow cylinder with a wall thickness, open at both ends. Pass things through, or stand in it. */
import type { ShapeDef } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { annulusColliders, annulusGeometry, annulusVolume, segmentsOf, type Annulus } from './annulus';
import { axialDiameter, clampDims, DIAMETER_HEIGHT } from './helpers';
import { SHAPE_ICONS } from './shapeIcons';

const wallOf = (spec: ShapeSpec): number => Math.max(0.03, Math.min(0.6, Number(spec.params?.wall ?? 0.15)));

function dims(spec: ShapeSpec): Annulus {
  const ro = spec.size[0] / 2;
  return { ro, ri: ro * (1 - wallOf(spec)), h: spec.size[1], n: segmentsOf(spec) };
}

export const tube: ShapeDef = {
  id: 'tube',
  label: 'Tube',
  icon: SHAPE_ICONS.tube,
  category: 'structural',
  blurb: 'Hollow pipe open at both ends: chutes, barrels, sleeves, columns',
  defaultSize: [0.6, 1.5, 0.6],
  params: [
    {
      key: 'wall',
      label: 'Wall',
      kind: 'float',
      min: 0.03,
      max: 0.6,
      step: 0.01,
      default: 0.15,
      hint: 'Wall thickness as a fraction of the outer radius',
    },
    {
      key: 'segments',
      label: 'Segments',
      kind: 'int',
      min: 8,
      max: 64,
      step: 1,
      default: 32,
      hint: 'Convex collider wedges around the pipe: more is rounder but costs more',
    },
  ],
  sizeFields: DIAMETER_HEIGHT.map((f) =>
    f.axis === 0 ? { ...f, label: 'Outer diameter' } : { ...f, label: 'Length' },
  ),
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
  // The wall is a fraction of the radius, so the pipe scales affinely and shares one mesh per wall and side count.
  geometry: (T, spec) => annulusGeometry(T, 1 - wallOf(spec), segmentsOf(spec)),
};
