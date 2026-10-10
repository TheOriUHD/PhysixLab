/**
 * Collider construction: a body's shape — or, for a compound body, each of its parts — goes through the shape
 * registry and comes out as Rapier collider descriptions with the right material applied. A primitive yields
 * one collider, a compound shape (or a part with a compound shape) several.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { isTriggerLayer, type CollisionLayers } from '../../model/collisionLayers';
import { composeCollider, shapeColliders, type ShapeCollider } from '../../model/shapeRegistry';
import type { BodyEntity, ColliderPart } from '../../model/types';
import { interactionGroups } from './bodyFields';
import { rq } from './util';

export interface BuiltCollider {
  desc: RAPIER.ColliderDesc;
  /** The part this collider belongs to; null when the body has no parts (the body's own shape). */
  part: ColliderPart | null;
}

/** Surface values of a collider: the part's overrides over the body's material. */
export function colliderSurface(def: BodyEntity, part: ColliderPart | null): { friction: number; restitution: number } {
  return {
    friction: part?.material?.friction ?? def.material.friction,
    restitution: part?.material?.restitution ?? def.material.restitution,
  };
}

/** The raw colliders of a body: the parts when it has any, otherwise its own shape. */
function rawColliders(def: BodyEntity): { c: ShapeCollider; part: ColliderPart | null }[] {
  if (def.parts && def.parts.length > 0) {
    return def.parts.flatMap((part) =>
      shapeColliders(RAPIER, part.shape).map((c) => ({ c: composeCollider(c, part.position, part.rotation), part })),
    );
  }
  return shapeColliders(RAPIER, def.shape).map((c) => ({ c, part: null }));
}

export function makeColliders(def: BodyEntity, layers?: CollisionLayers): BuiltCollider[] {
  const groups = interactionGroups(def.collision, layers);
  const trigger = isTriggerLayer(layers, def.collision.group); // -- JT-B: a trigger layer's bodies are sensors
  return rawColliders(def).map(({ c, part }) => {
    const surface = colliderSurface(def, part);
    const density = def.bodyType === 'dynamic' ? (part?.material?.density ?? def.material.density) : 0;
    const desc = c.desc
      .setDensity(density)
      .setFriction(surface.friction)
      .setRestitution(surface.restitution)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
      .setCollisionGroups(groups)
      .setSensor(def.ghost || !!part?.sensor || trigger)
      .setActiveHooks(def.oneWay !== undefined ? RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS : RAPIER.ActiveHooks.NONE);
    const [x, y, z] = c.localPos;
    if (x !== 0 || y !== 0 || z !== 0) desc.setTranslation(x, y, z);
    const q = c.localRot;
    if (q[0] !== 0 || q[1] !== 0 || q[2] !== 0 || q[3] !== 1) desc.setRotation(rq(q));
    return { desc, part };
  });
}
