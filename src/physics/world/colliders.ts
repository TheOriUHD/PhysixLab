/**
 * Collider construction: the body's shape (via the shape registry) → Rapier collider descriptions with the
 * body's material applied. A primitive yields one collider, a compound shape several.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { shapeColliders } from '../../model/shapeRegistry';
import type { BodyEntity } from '../../model/types';
import { interactionGroups } from './bodyFields';
import { rq } from './util';

export function makeColliders(def: BodyEntity): RAPIER.ColliderDesc[] {
  return shapeColliders(RAPIER, def.shape).map((c) => {
    const desc = c.desc
      .setDensity(def.bodyType === 'dynamic' ? def.material.density : 0)
      .setFriction(def.material.friction)
      .setRestitution(def.material.restitution)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
      .setCollisionGroups(interactionGroups(def.collision))
      .setSensor(def.ghost);
    const [x, y, z] = c.localPos;
    if (x !== 0 || y !== 0 || z !== 0) desc.setTranslation(x, y, z);
    const q = c.localRot;
    if (q[0] !== 0 || q[1] !== 0 || q[2] !== 0 || q[3] !== 1) desc.setRotation(rq(q));
    return desc;
  });
}
