/** Small building blocks shared by the built-in shape definitions. */
import type { BufferGeometry } from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Quat, Vec3 } from '../../core/math';
import type { GeometryKit, RapierModule, ShapeCollider, SizeField } from '../shapeRegistry';
import type { ShapeSpec } from '../types';

/** Smallest extent a shape may have along any axis, metres. */
export const MIN_DIM = 0.02;

export const ORIGIN: Vec3 = [0, 0, 0];
export const NO_ROT: Quat = [0, 0, 0, 1];

export const WIDTH_HEIGHT_DEPTH: readonly SizeField[] = [
  { axis: 0, label: 'Width' },
  { axis: 1, label: 'Height' },
  { axis: 2, label: 'Depth' },
];
export const DIAMETER_HEIGHT: readonly SizeField[] = [
  { axis: 0, label: 'Diameter' },
  { axis: 1, label: 'Height' },
];
export const DIAMETER: readonly SizeField[] = [{ axis: 0, label: 'Diameter' }];

/** Every axis at least `MIN_DIM`. */
export const clampDims = (size: Vec3): Vec3 => [
  Math.max(MIN_DIM, size[0]),
  Math.max(MIN_DIM, size[1]),
  Math.max(MIN_DIM, size[2]),
];

/** Uniform shapes (sphere): whichever axis changed most wins; without `prev` the x axis does. */
export function uniformDiameter(s: Vec3, prev?: Vec3): number {
  if (!prev) return s[0];
  const dx = Math.abs(s[0] - prev[0]),
    dy = Math.abs(s[1] - prev[1]),
    dz = Math.abs(s[2] - prev[2]);
  return dx >= dy && dx >= dz ? s[0] : dy >= dz ? s[1] : s[2];
}

/** Round-in-XZ shapes (cylinder, cone, capsule): x and z follow whichever changed most. */
export function axialDiameter(s: Vec3, prev?: Vec3): number {
  if (!prev) return s[0];
  return Math.abs(s[0] - prev[0]) >= Math.abs(s[2] - prev[2]) ? s[0] : s[2];
}

/** A shape made of a single collider at its origin. */
export const single = (desc: RAPIER.ColliderDesc): ShapeCollider[] => [
  { desc, localPos: [...ORIGIN], localRot: [...NO_ROT] },
];

/** Convex-hull collider; a cuboid around the extents if the points are degenerate. */
export function hullCollider(R: RapierModule, pts: Vec3[], size: Vec3): ShapeCollider[] {
  const desc =
    R.ColliderDesc.convexHull(new Float32Array(pts.flat())) ??
    R.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2);
  return single(desc);
}

/** Flat-shaded mesh of the convex hull of `pts`. */
export function hullGeometry(T: GeometryKit, pts: Vec3[]): BufferGeometry {
  const g = new T.ConvexGeometry(pts.map((p) => new T.Vector3(p[0], p[1], p[2])));
  g.computeVertexNormals();
  return g;
}

/** The same spec at unit size — hull shapes build their shared mesh from it and scale it by the size. */
export const unitSpec = (spec: ShapeSpec): ShapeSpec => ({ ...spec, size: [1, 1, 1] });

/** Eight corners of an axis-aligned box of the given size, centred on the origin. */
export function boxCorners([x, y, z]: Vec3): Vec3[] {
  const hx = x / 2,
    hy = y / 2,
    hz = z / 2;
  const out: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) out.push([sx * hx, sy * hy, sz * hz]);
  return out;
}

/** Half-diagonal of the bounding box — the default bounding radius. */
export const halfDiagonal = ([x, y, z]: Vec3): number => Math.hypot(x, y, z) / 2;
