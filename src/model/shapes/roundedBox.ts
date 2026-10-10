/**
 * Rounded box: a box whose edges and corners are rounded off (or chamfered) by a radius — dice, crates, soft
 * blocks, pillows, keycaps, bricks that do not catch on every edge.
 *
 * The collider is one convex hull, the box shrunk by the radius plus a lattice of directions at every corner
 * (`lattice.ts`): the Minkowski sum of a smaller box with a polyhedral ball. With `steps` = 1 the ball is an
 * octahedron and the edges are cut by flat chamfers; with more steps the corners approach a sphere and the edges a
 * cylinder. (The engine's own rounded cuboid ignores the rounding when it computes mass and inertia, so it would
 * make a rounded box 1.9× too light; this hull has the true mass distribution, exactly.)
 *
 * Size: the outer box. `roundness` is the radius as a fraction of the shortest half-extent (0 = a sharp box, 1 = the
 * shortest side fully rounded), so scaling the body scales the rounding with it; the *Corner radius* field shows and
 * edits the radius in metres.
 */
import type { Vec3 } from '../../core/math';
import { clamp } from '../../core/math';
import type { QuantityDef, ShapeDef } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { clampDims, hullCollider, WIDTH_HEIGHT_DEPTH } from './helpers';
import { bevelPlan } from './bevel';
import { firstSafeHull, hullFaces, hullVolume, type Hull } from './hull3';
import { octantLattice } from './lattice';
import { memo } from './memo';
import { flatFacesMesh, PolyMesh, type UV } from './polyMesh';
import { SHAPE_ICONS } from './shapeIcons';

export const BEVEL_OPTIONS = [
  { value: 'round', label: 'Round' },
  { value: 'chamfer', label: 'Chamfer' },
] as const;

export interface BevelDims {
  roundness: number;
  chamfer: boolean;
  steps: number;
}

export function bevelOf(spec: ShapeSpec): BevelDims {
  const chamfer = spec.params?.bevel === 'chamfer';
  return {
    roundness: clamp(Number(spec.params?.roundness ?? 0.25), 0, 1),
    chamfer,
    steps: chamfer ? 1 : Math.max(1, Math.min(8, Math.round(Number(spec.params?.steps ?? 4)))),
  };
}

/** Radius in metres for a size: the roundness times the shortest half-extent. */
export const boxRadius = (size: Vec3, roundness: number): number =>
  roundness * (Math.min(size[0], size[1], size[2]) / 2);

/** The corner points of the rounded box (a sharp box's eight corners when the radius is zero). */
export function roundedBoxPoints(size: Vec3, radius: number, steps: number): Vec3[] {
  const half: Vec3 = [size[0] / 2, size[1] / 2, size[2] / 2];
  const r = Math.min(radius, Math.min(...half));
  if (!(r > 1e-9)) return boxCorners(half);
  const core: Vec3 = [half[0] - r, half[1] - r, half[2] - r];
  const out: Vec3[] = [];
  const dirs = octantLattice(steps);
  for (const sx of [1, -1])
    for (const sy of [1, -1])
      for (const sz of [1, -1])
        for (const d of dirs)
          out.push([sx * (core[0] + r * d[0]), sy * (core[1] + r * d[1]), sz * (core[2] + r * d[2])]);
  return out;
}

function boxCorners(h: Vec3): Vec3[] {
  const out: Vec3[] = [];
  for (const sx of [1, -1])
    for (const sy of [1, -1]) for (const sz of [1, -1]) out.push([sx * h[0], sy * h[1], sz * h[2]]);
  return out;
}

interface Solid {
  hull: Hull;
  volume: number;
  /** The radius actually built: the requested one, or 0 when it is too fine for the engine. */
  radius: number;
  /** Facets across each rounded edge actually built. */
  steps: number;
  reach: number;
}

export function roundedBoxSolid(spec: ShapeSpec): Solid {
  const b = bevelOf(spec);
  const radius = boxRadius(spec.size, b.roundness);
  return memo(`rbox|${spec.size.join(',')}|${radius}|${b.chamfer}|${b.steps}`, () => {
    const plans = bevelPlan(radius, b.steps, Math.hypot(...spec.size), b.chamfer);
    const found = firstSafeHull(plans.map((p) => () => roundedBoxPoints(spec.size, p.rim, p.steps))) as {
      hull: Hull;
      index: number;
    };
    const plan = plans[found.index];
    return {
      hull: found.hull,
      volume: hullVolume(found.hull),
      radius: plan.rim,
      steps: plan.rim > 0 ? plan.steps : 0,
      reach: Math.max(...found.hull.points.map((p) => Math.hypot(p[0], p[1], p[2]))),
    };
  });
}

/** Mesh of the rounded box: exact surface normals on the rounded parts, flat shading for chamfers and sharp boxes. */
function roundedBoxGeometry(T: Parameters<ShapeDef['geometry']>[0], spec: ShapeSpec) {
  const { hull, radius, steps } = roundedBoxSolid(spec);
  if (bevelOf(spec).chamfer || radius < 1e-6 || steps < 2) return flatFacesMesh(hull, hullFaces(hull)).build(T);
  const half: Vec3 = [spec.size[0] / 2, spec.size[1] / 2, spec.size[2] / 2];
  const core: Vec3 = [half[0] - radius, half[1] - radius, half[2] - radius];
  const normal = (p: Vec3): Vec3 => {
    const n: Vec3 = [
      p[0] - clamp(p[0], -core[0], core[0]),
      p[1] - clamp(p[1], -core[1], core[1]),
      p[2] - clamp(p[2], -core[2], core[2]),
    ];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  // box-projected uvs along the dominant axis of the normal, one texture repeat per metre
  const uv = (p: Vec3, n: Vec3): UV => {
    const ax = Math.abs(n[0]),
      ay = Math.abs(n[1]),
      az = Math.abs(n[2]);
    return ax >= ay && ax >= az ? [p[2], p[1]] : ay >= az ? [p[0], p[2]] : [p[0], p[1]];
  };
  const m = new PolyMesh();
  for (const [i, j, k] of hull.tris) {
    const p = hull.points[i],
      q = hull.points[j],
      r = hull.points[k];
    const np = normal(p),
      nq = normal(q),
      nr = normal(r);
    m.tri(p, q, r, [np, nq, nr], [uv(p, np), uv(q, nq), uv(r, nr)]);
  }
  return m.build(T);
}

/** The radius in metres as an editable field: setting it changes the roundness, never the size. */
export function radiusQuantity(limit: (spec: ShapeSpec) => number, label: string): QuantityDef {
  return {
    key: 'radius',
    label,
    unit: 'm',
    min: 0,
    step: 0.01,
    digits: 3,
    hint: 'Same as Roundness, in metres. It cannot exceed the shortest half-extent',
    get: (spec) => bevelOf(spec).roundness * limit(spec),
    set: (spec, value) => ({ params: { roundness: clamp(limit(spec) > 0 ? value / limit(spec) : 0, 0, 1) } }),
  };
}

export const ROUNDNESS_PARAM = {
  key: 'roundness',
  label: 'Roundness',
  kind: 'float',
  min: 0,
  max: 1,
  step: 0.01,
  default: 0.25,
  hint: 'Corner radius as a fraction of the shortest half-extent: 0 is a sharp box, 1 rounds the shortest side fully',
} as const;

export const BEVEL_PARAM = {
  key: 'bevel',
  label: 'Edge style',
  kind: 'enum',
  default: 'round',
  options: BEVEL_OPTIONS,
  hint: 'Round: rounded edges. Chamfer: flat 45° cuts',
} as const;

export const STEPS_PARAM = {
  key: 'steps',
  label: 'Corner steps',
  kind: 'int',
  min: 2,
  max: 8,
  step: 1,
  default: 4,
  hint: 'Facets across each rounded edge (round style only): smoother when higher, dearer to simulate',
} as const;

export const roundedBox: ShapeDef = {
  id: 'rounded-box',
  label: 'Rounded box',
  icon: SHAPE_ICONS['rounded-box'],
  category: 'basic',
  blurb: 'Box with rounded or chamfered edges: dice, crates, bricks, cushions, keycaps',
  keywords: ['bevel', 'chamfer', 'cube', 'block', 'fillet', 'soft', 'brick', 'crate'],
  defaultSize: [1, 1, 1],
  params: [ROUNDNESS_PARAM, BEVEL_PARAM, STEPS_PARAM],
  sizeFields: WIDTH_HEIGHT_DEPTH,
  quantities: [radiusQuantity((spec) => Math.min(...spec.size) / 2, 'Corner radius')],
  normalizeSize: (size) => clampDims(size),
  volume: (spec) => roundedBoxSolid(spec).volume,
  boundingRadius: (spec) => roundedBoxSolid(spec).reach,
  halfHeight: ({ size }) => size[1] / 2,
  convexPoints: (spec) => roundedBoxSolid(spec).hull.points,
  colliders: (R, spec) => hullCollider(R, roundedBoxSolid(spec).hull.points, spec.size),
  // The radius is absolute (not an affine image of a unit shape), so the mesh is built at the real size.
  geometryKey: (spec) => {
    const b = bevelOf(spec);
    return `rounded-box:${spec.size.join(',')}:${b.roundness}:${b.chamfer ? 'c' : 'r'}${b.steps}`;
  },
  visualScale: () => [1, 1, 1],
  geometry: roundedBoxGeometry,
};
