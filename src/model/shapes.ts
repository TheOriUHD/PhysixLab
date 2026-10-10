/**
 * Shape helpers used across the app. The geometry maths itself lives in the shape registry
 * (`shapeRegistry.ts`, one `ShapeDef` per shape under `shapes/`); these are the short names the rest of the
 * code base calls, all of them registry lookups. They never throw for an unknown shape id — it behaves
 * like a box — so a document naming a shape this build lacks cannot crash rendering or physics.
 */
import type { Vec3 } from '../core/math';
import {
  normalizeShapeSize,
  shapeBoundingRadius,
  shapeDef,
  shapeHalfHeight,
  shapeLabel,
  shapeVolume as registryVolume,
} from './shapeRegistry';
import type { ShapeParams, ShapeSpec, ShapeType, SoftEntity } from './types';

export { MIN_DIM } from './shapes/helpers';
export { shapeLabel };

/** Default bounding size of a shape. */
export function defaultSize(type: ShapeType): Vec3 {
  return [...shapeDef(type).defaultSize] as Vec3;
}

/** Force a size vector into the shape's constraints (uniform axes etc.). `prev` is the size before the edit. */
export function normalizeSize(type: ShapeType, size: Vec3, prev?: Vec3, params?: ShapeParams): Vec3 {
  return normalizeShapeSize(type, size, params, prev);
}

/** Analytic volume in m³ (used for mass previews before a simulation is built). */
export function shapeVolume(shape: ShapeSpec): number {
  return registryVolume(shape);
}

/** Radius of a sphere that bounds the shape (picking, placement, spawn height). */
export function boundingRadius(shape: ShapeSpec): number {
  return shapeBoundingRadius(shape);
}

/** Half height of the shape along local Y (used to rest new objects on the ground). */
export function halfHeight(shape: ShapeSpec): number {
  return shapeHalfHeight(shape);
}

/**
 * Collision radius of one soft-body particle. It also sets how far the visible surface hovers
 * above whatever it rests on, so it is kept small relative to the lattice spacing.
 */
export function softParticleRadius(def: Pick<SoftEntity, 'type' | 'size' | 'resolution'>): number {
  const n = Math.max(2, def.resolution);
  switch (def.type) {
    case 'jelly':
      return Math.min(0.05, Math.max(0.012, (Math.min(...def.size) / (n - 1)) * 0.2));
    case 'balloon':
      return 0.02;
    case 'cloth':
      return Math.min(0.03, Math.max(0.01, (Math.min(def.size[0], def.size[2]) / (n - 1)) * 0.15));
    case 'cable':
      return 0.03;
  }
}
