/**
 * Helpers for compound bodies (`BodyEntity.parts`): building parts, the material a part ends up with, mass
 * estimates and proportional scaling. The physics world, the renderer and the inspector share them.
 */
import { qrot, type Quat, type Vec3 } from '../core/math';
import { uid } from './factory';
import { makeShapeSpec, normalizeShapeSize, shapeVolume } from './shapeRegistry';
import type { BodyEntity, ColliderPart, MaterialSpec, PartMaterial, ShapeSpec } from './types';

export interface PartInit {
  id?: string;
  shape: Partial<ShapeSpec> & { type: string };
  position?: Vec3;
  rotation?: Quat;
  material?: PartMaterial;
  sensor?: boolean;
  visible?: boolean;
}

/** A complete part: the shape is normalised through the registry, pose defaults to the body origin. */
export function makePart(init: PartInit): ColliderPart {
  const part: ColliderPart = {
    id: init.id ?? uid('p'),
    shape: makeShapeSpec(init.shape.type, init.shape.size, init.shape.params),
    position: init.position ? ([...init.position] as Vec3) : [0, 0, 0],
    rotation: init.rotation ? ([...init.rotation] as Quat) : [0, 0, 0, 1],
  };
  if (init.material) part.material = { ...init.material };
  if (init.sensor) part.sensor = true;
  if (init.visible === false) part.visible = false;
  return part;
}

export const isCompound = (b: Pick<BodyEntity, 'parts'>): boolean => !!b.parts && b.parts.length > 0;

/** The body's material with the part's overrides applied. */
export function partMaterial(body: Pick<BodyEntity, 'material'>, part: ColliderPart): MaterialSpec {
  return part.material ? { ...body.material, ...part.material } : body.material;
}

/** Σ density × volume over the parts, or of the body's own shape — before any `massOverride`. */
export function naturalMass(b: BodyEntity): number {
  if (!isCompound(b)) return b.material.density * shapeVolume(b.shape);
  return (b.parts as ColliderPart[]).reduce(
    (sum, p) => sum + (p.material?.density ?? b.material.density) * shapeVolume(p.shape),
    0,
  );
}

/** Mass a dynamic body will have: the override if set, else density × volume of its shape / parts. */
export function massEstimate(b: BodyEntity): number {
  return b.massOverride ?? naturalMass(b);
}

/**
 * Scale a compound body's parts when the body is resized by `factor` (per body axis): positions scale
 * exactly; each part's size scales by the length its own axes take after the body-space scaling, which is
 * exact for axis-aligned parts and a close approximation for rotated ones (a rotated part cannot be sheared).
 */
export function scaleParts(parts: readonly ColliderPart[], factor: Vec3): ColliderPart[] {
  return parts.map((p) => {
    const axes: Vec3[] = [qrot(p.rotation, [1, 0, 0]), qrot(p.rotation, [0, 1, 0]), qrot(p.rotation, [0, 0, 1])];
    const sf = axes.map((a) => Math.hypot(a[0] * factor[0], a[1] * factor[1], a[2] * factor[2])) as Vec3;
    const size = normalizeShapeSize(
      p.shape.type,
      [p.shape.size[0] * sf[0], p.shape.size[1] * sf[1], p.shape.size[2] * sf[2]],
      p.shape.params,
      p.shape.size,
    );
    return {
      ...p,
      position: [p.position[0] * factor[0], p.position[1] * factor[1], p.position[2] * factor[2]],
      shape: { ...p.shape, size },
    };
  });
}
