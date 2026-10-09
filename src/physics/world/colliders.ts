/** Collider construction: shape → Rapier collider description with the body's material applied. */
import RAPIER from '@dimforge/rapier3d-compat';
import { hullPoints, primitiveParams } from '../../model/shapes';
import type { BodyEntity } from '../../model/types';

export function makeCollider(def: BodyEntity): RAPIER.ColliderDesc {
  const { radius, halfHeight, half } = primitiveParams(def.shape);
  let desc: RAPIER.ColliderDesc | null = null;
  switch (def.shape.type) {
    case 'box':
      desc = RAPIER.ColliderDesc.cuboid(half[0], half[1], half[2]);
      break;
    case 'sphere':
      desc = RAPIER.ColliderDesc.ball(radius);
      break;
    case 'cylinder':
      desc = RAPIER.ColliderDesc.cylinder(halfHeight, radius);
      break;
    case 'capsule':
      desc = RAPIER.ColliderDesc.capsule(halfHeight, radius);
      break;
    case 'cone':
      desc = RAPIER.ColliderDesc.cone(halfHeight, radius);
      break;
    default: {
      const pts = hullPoints(def.shape);
      if (pts) desc = RAPIER.ColliderDesc.convexHull(new Float32Array(pts.flat()));
    }
  }
  if (!desc) desc = RAPIER.ColliderDesc.cuboid(half[0], half[1], half[2]);
  return desc
    .setDensity(def.bodyType === 'dynamic' ? def.material.density : 0)
    .setFriction(def.material.friction)
    .setRestitution(def.material.restitution)
    .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
    .setSensor(def.ghost);
}
