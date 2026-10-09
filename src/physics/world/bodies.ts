/** Rigid-body construction. */
import RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3 } from '../../core/math';
import type { BodyEntity } from '../../model/types';
import { makeCollider } from './colliders';
import type { BodyRec, WorldState } from './state';
import { rq, rv } from './util';

export function addBody(s: WorldState, def: BodyEntity, ephemeral: boolean): BodyRec {
  const isDyn = def.bodyType === 'dynamic';
  let desc =
    def.bodyType === 'static'
      ? RAPIER.RigidBodyDesc.fixed()
      : def.bodyType === 'kinematic'
        ? RAPIER.RigidBodyDesc.kinematicVelocityBased()
        : RAPIER.RigidBodyDesc.dynamic();
  desc = desc.setTranslation(def.position[0], def.position[1], def.position[2]).setRotation(rq(def.rotation));
  if (isDyn) {
    desc = desc
      .setLinearDamping(def.linearDamping + s.settings.airDrag)
      .setAngularDamping(def.angularDamping)
      .setGravityScale(def.gravityScale)
      .setCcdEnabled(def.ccd)
      .setCanSleep(def.canSleep)
      .enabledTranslations(!def.lockPosition[0], !def.lockPosition[1], !def.lockPosition[2])
      .enabledRotations(!def.lockRotation[0], !def.lockRotation[1], !def.lockRotation[2])
      .setLinvel(def.velocity[0], def.velocity[1], def.velocity[2])
      .setAngvel(rv(def.angularVelocity));
  } else if (def.bodyType === 'kinematic') {
    desc = desc.setLinvel(def.velocity[0], def.velocity[1], def.velocity[2]).setAngvel(rv(def.angularVelocity));
  }
  const rb = s.world.createRigidBody(desc);
  const col = s.world.createCollider(makeCollider(def), rb);
  const rec: BodyRec = {
    id: def.id,
    def,
    rb,
    col,
    mass: isDyn ? rb.mass() : 0,
    ephemeral,
    disabled: false,
    prev: new Float64Array(7),
    hasPrev: false,
    vPrev: [...def.velocity] as Vec3,
    force: [0, 0, 0],
    forced: false,
  };
  s.bodies.set(def.id, rec);
  s.order.push(rec);
  s.layoutVersion++;
  return rec;
}
