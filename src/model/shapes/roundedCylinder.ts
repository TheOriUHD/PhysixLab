/**
 * Rounded cylinder: a cylinder whose two rims are rounded off or chamfered — coins, pucks, drums, wheels, buttons,
 * stools. Its axis is Y like the cylinder's, and it is a natural hinge axle just the same.
 *
 * The collider is a single convex hull of regular N-gon rings with aligned corners (the cap, the arc of each
 * fillet, the side), the polyhedron `revolve.ts` describes: a stack of pyramid frusta whose volume has an exact
 * closed form, so the engine's integrated mass equals `density × volume()`. The mesh is the same rings with the
 * exact surface normals of the fillets, so the caps and the side stay flat-shaded and the rim blends smoothly.
 *
 * Size: x = z = diameter, y = height. `roundness` is the rim radius as a fraction of the smaller of the radius and
 * the half height (so 1 turns a squat cylinder into a rounded disc and a tall one into a capsule-like pill).
 */
import type { BufferGeometry } from 'three';
import { clamp, type Vec3 } from '../../core/math';
import type { ShapeDef } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { axialDiameter, clampDims, DIAMETER_HEIGHT, hullCollider } from './helpers';
import { bevelPlan } from './bevel';
import { firstSafeHull, hullVolume, type Hull } from './hull3';
import { latheSmooth } from './latheMesh';
import type { P2 } from './meshKit';
import { memo } from './memo';
import { PolyMesh, type UV } from './polyMesh';
import { revolvedPoints } from './revolve';
import { BEVEL_PARAM, bevelOf, radiusQuantity, ROUNDNESS_PARAM, STEPS_PARAM } from './roundedBox';
import { SHAPE_ICONS } from './shapeIcons';

const sidesOf = (spec: ShapeSpec): number => Math.max(8, Math.min(48, Math.round(Number(spec.params?.segments ?? 32))));

/** The rim radius in metres. */
export const rimRadius = (spec: ShapeSpec): number =>
  clamp(bevelOf(spec).roundness, 0, 1) * Math.min(spec.size[0] / 2, spec.size[1] / 2);

/** (radius, y) profile from the bottom centre, counter-clockwise: bottom, fillet, side, fillet, top. */
export function roundedCylinderProfile(R: number, H: number, rim: number, steps: number): P2[] {
  const h = H / 2;
  if (!(rim > 1e-9)) {
    return [
      [0, -h],
      [R, -h],
      [R, h],
      [0, h],
    ];
  }
  const out: P2[] = [[0, -h]];
  const arc = (cy: number, from: number, to: number) => {
    for (let j = 0; j <= steps; j++) {
      const t = from + ((to - from) * j) / steps;
      out.push([R - rim + rim * Math.cos(t), cy + rim * Math.sin(t)]);
    }
  };
  arc(-h + rim, -Math.PI / 2, 0);
  arc(h - rim, 0, Math.PI / 2);
  out.push([0, h]);
  // a rim as wide as the radius leaves the cap a point: drop the repeated vertices
  return out.filter((p, i) => i === 0 || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 1e-9);
}

export interface RoundedCylinderSolid {
  profile: P2[];
  n: number;
  hull: Hull;
  volume: number;
  /** The rim radius actually built: the requested one, or 0 when it is too fine for the engine. */
  rim: number;
  /** Facets across each rim actually built (0 for a sharp edge). */
  steps: number;
}

/** The solid actually built for a spec (exported for the tests): the profile, the rim and the facets it kept. */
export function roundedCylinderSolid(spec: ShapeSpec): RoundedCylinderSolid {
  const n = sidesOf(spec);
  const b = bevelOf(spec);
  const rim = rimRadius(spec);
  return memo(`rcyl|${spec.size[0]},${spec.size[1]}|${rim}|${b.chamfer}|${b.steps}|${n}`, () => {
    const R = spec.size[0] / 2;
    const plans = bevelPlan(rim, b.steps, Math.hypot(spec.size[0], spec.size[1]), b.chamfer, n);
    const profiles = plans.map((p) => roundedCylinderProfile(R, spec.size[1], p.rim, p.steps));
    const found = firstSafeHull(profiles.map((profile, i) => () => revolvedPoints(profile, plans[i].sides ?? n))) as {
      hull: Hull;
      index: number;
    };
    return {
      profile: profiles[found.index],
      n: plans[found.index].sides ?? n,
      hull: found.hull,
      volume: hullVolume(found.hull),
      rim: plans[found.index].rim,
      steps: plans[found.index].rim > 0 ? plans[found.index].steps : 0,
    };
  });
}

function geometry(T: Parameters<ShapeDef['geometry']>[0], spec: ShapeSpec): BufferGeometry {
  const { profile, n, hull, rim } = roundedCylinderSolid(spec);
  const b = bevelOf(spec);
  const m = new PolyMesh();
  if (!(rim > 1e-6)) {
    // a sharp cylinder: flat caps, smooth side
    latheSmooth(m, profile, n, 5);
    return m.build(T);
  }
  const R = spec.size[0] / 2,
    h = spec.size[1] / 2;
  const rc = R - rim,
    hc = h - rim;
  const flat = b.chamfer;
  const normal = (p: Vec3): Vec3 => {
    const rho = Math.hypot(p[0], p[2]);
    const dr = rho - Math.min(rho, rc);
    const dy = p[1] - clamp(p[1], -hc, hc);
    const l = Math.hypot(dr, dy) || 1;
    const k = rho > 1e-12 ? dr / l / rho : 0;
    return [p[0] * k, dy / l, p[2] * k];
  };
  for (const [i, j, k] of hull.tris) {
    const p = hull.points[i],
      q = hull.points[j],
      r = hull.points[k];
    const uv = (v: Vec3): UV => [Math.atan2(v[2], v[0]) / (2 * Math.PI) + 0.5, v[1] / spec.size[1] + 0.5];
    if (flat) m.tri(p, q, r, undefined, [uv(p), uv(q), uv(r)]);
    else m.tri(p, q, r, [normal(p), normal(q), normal(r)], [uv(p), uv(q), uv(r)]);
  }
  return m.build(T);
}

export const roundedCylinder: ShapeDef = {
  id: 'rounded-cylinder',
  label: 'Rounded cylinder',
  icon: SHAPE_ICONS['rounded-cylinder'],
  category: 'basic',
  blurb: 'Cylinder with rounded or chamfered rims: coins, pucks, drums, buttons',
  keywords: ['bevel', 'chamfer', 'puck', 'coin', 'disc', 'barrel', 'drum', 'fillet', 'wheel'],
  defaultSize: [0.8, 0.6, 0.8],
  params: [
    ROUNDNESS_PARAM,
    BEVEL_PARAM,
    STEPS_PARAM,
    {
      key: 'segments',
      label: 'Segments',
      kind: 'int',
      min: 8,
      max: 48,
      step: 1,
      default: 32,
      hint: 'Sides around the axis of the convex collider: rounder when higher, dearer to simulate',
    },
  ],
  sizeFields: DIAMETER_HEIGHT,
  axial: true,
  quantities: [radiusQuantity((spec) => Math.min(spec.size[0] / 2, spec.size[1] / 2), 'Rim radius')],
  normalizeSize: (size, _params, prev) => {
    const s = clampDims(size);
    const d = axialDiameter(s, prev);
    return [d, s[1], d];
  },
  volume: (spec) => roundedCylinderSolid(spec).volume,
  boundingRadius: (spec) =>
    Math.max(...roundedCylinderSolid(spec).hull.points.map((p) => Math.hypot(p[0], p[1], p[2]))),
  halfHeight: ({ size }) => size[1] / 2,
  convexPoints: (spec) => roundedCylinderSolid(spec).hull.points,
  colliders: (R, spec) => hullCollider(R, roundedCylinderSolid(spec).hull.points, spec.size),
  geometryKey: (spec) => {
    const b = bevelOf(spec);
    return `rounded-cylinder:${spec.size[0]},${spec.size[1]}:${rimRadius(spec)}:${b.chamfer ? 'c' : 'r'}${b.steps}:${sidesOf(spec)}`;
  },
  visualScale: () => [1, 1, 1],
  geometry,
};
