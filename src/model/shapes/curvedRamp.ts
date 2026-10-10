/**
 * Curved ramp and quarter-pipe — launch ramps, skate transitions, hills, bowl walls. Size: x = width, y = height,
 * z = depth; the low end is at −z (a thin edge flush with the floor, `base` thick), the high end at +z. The surface is
 * a circular arc stretched to the box, tangent to the floor at the low end (concave) or at the top (convex). Built
 * from convex pieces (`profileSolid.ts`), so it is as good dynamic as static; a ball rolls up and over it.
 */
import type { ParamDef, ShapeDef } from '../shapeRegistry';
import type { ShapeParams, ShapeSpec } from '../types';
import { clampDims, halfDiagonal, WIDTH_HEIGHT_DEPTH } from './helpers';
import { memo, paramsKey } from './memo';
import {
  profileArea,
  profileColliders,
  profileGeometry,
  safeTop,
  profilePoints,
  rampTop,
  type ProfileAxis,
} from './profileSolid';
import type { P2 } from './meshKit';
import { SHAPE_ICONS } from './shapeIcons';

const num = (p: ShapeParams | undefined, key: string, def: number): number => Number(p?.[key] ?? def);

export const SEGMENTS_PARAM = (def: number): ParamDef => ({
  key: 'segments',
  label: 'Segments',
  kind: 'int',
  min: 4,
  max: 32,
  step: 1,
  default: def,
  hint: 'Convex pieces along the curve: smoother when higher, dearer to simulate',
});

export const BASE_PARAM = (def: number): ParamDef => ({
  key: 'base',
  label: 'Edge thickness',
  kind: 'float',
  min: 0.02,
  max: 0.5,
  step: 0.01,
  default: def,
  hint: 'Thickness of the low end as a fraction of the height',
});

export const DECK_PARAM = (def: number, max: number): ParamDef => ({
  key: 'deck',
  label: 'Deck',
  kind: 'float',
  min: 0,
  max,
  step: 0.01,
  default: def,
  hint: 'Flat platform at the top, as a fraction of the depth',
});

/** A profile-extruded shape: everything but the top polyline is the same for all of them. */
const BUILT = new Map<string, (spec: ShapeSpec) => { top: P2[]; repaired: boolean }>();

/** The top polyline a profile shape actually built for `spec` (the tests and the thumbnails read it). */
export function builtProfileTop(spec: ShapeSpec): { top: P2[]; repaired: boolean } | undefined {
  return BUILT.get(spec.type)?.(spec);
}

export function profileShape(o: {
  id: string;
  label: string;
  icon: string;
  blurb: string;
  keywords: readonly string[];
  defaultSize: [number, number, number];
  params: readonly ParamDef[];
  axis: ProfileAxis;
  top: (params: ShapeParams) => P2[];
}): ShapeDef {
  const completeParams = (spec: ShapeSpec): ShapeParams => {
    const params: ShapeParams = {};
    for (const p of o.params) params[p.key] = spec.params?.[p.key] ?? p.default;
    return params;
  };
  /**
   * The top actually built: the shape's own, or — when the engine could not integrate its pieces at this size, because
   * the shape is very narrow, very tall or very gently curved — a shorter one (`safeTop`).
   */
  const solid = (spec: ShapeSpec): { top: P2[]; repaired: boolean } => {
    const params = completeParams(spec);
    return memo(`profile|${o.id}|${paramsKey(params)}|${spec.size.join(',')}`, () => {
      const wanted = Number(params.segments ?? 0);
      if (!wanted) return { top: o.top(params), repaired: false };
      return safeTop((segments) => o.top({ ...params, segments }), wanted, o.axis, spec.size);
    });
  };
  BUILT.set(o.id, solid);
  return {
    id: o.id,
    label: o.label,
    icon: o.icon,
    category: 'structural',
    blurb: o.blurb,
    keywords: o.keywords,
    defaultSize: o.defaultSize,
    params: o.params,
    sizeFields: WIDTH_HEIGHT_DEPTH,
    normalizeSize: (size) => clampDims(size),
    // the unit profile times the size box
    volume: (spec) => profileArea(solid(spec).top) * spec.size[0] * spec.size[1] * spec.size[2],
    // the bottom corners of the box are always part of the solid
    boundingRadius: ({ size }) => halfDiagonal(size),
    halfHeight: ({ size }) => size[1] / 2,
    colliders: (R, spec) => profileColliders(R, solid(spec).top, o.axis, spec.size),
    // one mesh per parameter set, shared by every size — unless the size forced a shortened top
    geometryKey: (spec) =>
      `${o.id}:${paramsKey(completeParams(spec))}${solid(spec).repaired ? `:${spec.size.join(',')}` : ''}`,
    geometry: (T, spec) => profileGeometry(T, solid(spec).top, o.axis),
  };
}

export const curvedRamp: ShapeDef = profileShape({
  id: 'curved-ramp',
  label: 'Curved ramp',
  icon: SHAPE_ICONS['curved-ramp'],
  blurb: 'Ramp whose surface curves: launch ramps, bowl walls, hills. Concave or convex',
  keywords: ['jump', 'launch', 'slope', 'hill', 'bump', 'skate', 'transition', 'arc'],
  defaultSize: [2, 1, 2.5],
  params: [
    {
      key: 'arc',
      label: 'Curve',
      kind: 'float',
      min: 10,
      max: 90,
      step: 1,
      default: 70,
      unit: '°',
      hint: 'How far the surface turns over its length: 90° ends vertical (a quarter-pipe), less is a gentler launch',
    },
    {
      key: 'curve',
      label: 'Shape',
      kind: 'enum',
      default: 'concave',
      options: [
        { value: 'concave', label: 'Concave (launch)' },
        { value: 'convex', label: 'Convex (hill)' },
      ],
      hint: 'Concave leaves the floor tangentially and curls up; convex rises steeply and flattens at the top',
    },
    BASE_PARAM(0.06),
    DECK_PARAM(0, 0.6),
    SEGMENTS_PARAM(14),
  ],
  axis: 'z',
  top: (p) =>
    rampTop(num(p, 'arc', 70), p.curve === 'convex', num(p, 'base', 0.06), num(p, 'deck', 0), num(p, 'segments', 14)),
});

export const quarterPipe: ShapeDef = profileShape({
  id: 'quarter-pipe',
  label: 'Quarter-pipe',
  icon: SHAPE_ICONS['quarter-pipe'],
  blurb: 'Skate ramp: a concave quarter-circle wall with a flat deck on top',
  keywords: ['skate', 'bowl', 'wall', 'transition', 'vert', 'ramp', 'curve'],
  defaultSize: [2, 1.2, 1.4],
  params: [BASE_PARAM(0.04), DECK_PARAM(0.15, 0.6), SEGMENTS_PARAM(16)],
  axis: 'z',
  top: (p) => rampTop(90, false, num(p, 'base', 0.04), num(p, 'deck', 0.15), num(p, 'segments', 16)),
});

/** For tests: the convex points of every piece at a size. */
export const rampPoints = profilePoints;
