/** Live edits of the running world: removal, in-place or rebuilt body updates, teleport, set velocity. */
import type { Quat, Vec3 } from '../../core/math';
import type { BodyEntity } from '../../model/types';
import { addBody } from './bodies';
import { interactionGroups } from './bodyFields';
import { colliderSurface } from './colliders';
import { unregisterColliders } from './events';
import { addJoint, dropJoint } from './joints';
import { removeSoft } from './soft';
import type { BodyRec, WorldState } from './state';
import { pos, rot, rq, rv, ZERO } from './util';

export function removeEntities(s: WorldState, ids: string[]): void {
  for (const id of ids) {
    removeSoft(s, id);
    s.paths.delete(id);
  }
  for (const id of ids) {
    const j = s.joints.get(id);
    if (j) {
      if (j.joint && j.joint.isValid()) s.world.removeImpulseJoint(j.joint, true);
      dropJoint(s, id);
      s.host.detach(id);
    }
  }
  for (const id of ids) {
    const b = s.bodies.get(id);
    if (!b) continue;
    if (s.grab?.rec === b) s.grab = null;
    // Rapier deletes attached joints with the body; mirror that in our bookkeeping.
    for (const jr of [...s.jointOrder]) {
      if (jr.A !== b && jr.B !== b) continue;
      dropJoint(s, jr.id);
      s.host.detach(jr.id);
    }
    s.host.detach(id);
    unregisterColliders(s, b);
    s.queriesDirty = true;
    s.world.removeRigidBody(b.rb);
    s.bodies.delete(id);
    s.order = s.order.filter((r) => r !== b);
    if (b.dragged) s.draggers = s.draggers.filter((r) => r !== b);
    if (b.sleep) s.sleepers = s.sleepers.filter((r) => r !== b);
  }
  s.layoutVersion++;
}

/** Apply the edited body definition, in place when possible, otherwise by rebuilding the body. */
export function updateBody(s: WorldState, next: BodyEntity): void {
  const rec = s.bodies.get(next.id);
  if (!rec) return;
  const old = rec.def;
  const structural =
    old.bodyType !== next.bodyType ||
    (old.shape !== next.shape && JSON.stringify(old.shape) !== JSON.stringify(next.shape)) ||
    old.material.density !== next.material.density ||
    (old.parts !== next.parts && JSON.stringify(old.parts) !== JSON.stringify(next.parts)) ||
    old.ccd !== next.ccd ||
    // the engine only takes the sleep flags when a body is created
    old.canSleep !== next.canSleep ||
    old.sleepThreshold !== next.sleepThreshold ||
    old.ghost !== next.ghost ||
    old.lockPosition.some((v, i) => v !== next.lockPosition[i]) ||
    old.lockRotation.some((v, i) => v !== next.lockRotation[i]) ||
    // mass-property overrides are applied while the body is built
    old.massOverride !== next.massOverride ||
    old.inertiaScale !== next.inertiaScale ||
    (old.comOverride !== next.comOverride && JSON.stringify(old.comOverride) !== JSON.stringify(next.comOverride));
  if (structural) {
    rebuildBody(s, rec, next);
    return;
  }
  rec.def = next;
  if (old.components !== next.components) s.host.sync('body', next.id, next.components);
  if (next.bodyType === 'dynamic') {
    rec.rb.setLinearDamping(next.linearDamping + s.settings.airDrag);
    rec.rb.setAngularDamping(next.angularDamping);
    rec.rb.setGravityScale(next.gravityScale, true);
    const dragged = next.drag.linear2 > 0 || next.drag.angular2 > 0;
    if (dragged !== rec.dragged) {
      rec.dragged = dragged;
      s.draggers = dragged ? [...s.draggers, rec] : s.draggers.filter((r) => r !== rec);
    }
  }
  if (old.collision.group !== next.collision.group || old.collision.mask !== next.collision.mask) {
    const g = interactionGroups(next.collision);
    for (const c of rec.cols) c.setCollisionGroups(g);
  }
  if (next.bodyType === 'kinematic') {
    rec.rb.setLinvel(rv(next.velocity), true);
    rec.rb.setAngvel(rv(next.angularVelocity), true);
  }
  rec.cols.forEach((c, i) => {
    const surface = colliderSurface(next, rec.colParts[i]);
    c.setFriction(surface.friction);
    c.setRestitution(surface.restitution);
  });
  rec.rb.wakeUp();
}

function rebuildBody(s: WorldState, rec: BodyRec, next: BodyEntity): void {
  const p = pos(rec.rb),
    q = rot(rec.rb);
  const lv = rec.rb.linvel(),
    av = rec.rb.angvel();
  const attached = s.jointOrder.filter((j) => j.A === rec || j.B === rec).map((j) => j.def);
  const ephemeral = rec.ephemeral;
  removeEntities(s, [rec.id]);
  const moved: BodyEntity = {
    ...next,
    position: p,
    rotation: q,
    velocity: [lv.x, lv.y, lv.z],
    angularVelocity: [av.x, av.y, av.z],
  };
  // The world keeps the authored definition (`next`), the engine body is built at the live pose (`moved`).
  addBody(s, moved, ephemeral, next);
  for (const jd of attached) addJoint(s, jd);
}

export function teleport(s: WorldState, id: string, position: Vec3, rotation: Quat, keepVelocity = false): void {
  const rec = s.bodies.get(id);
  if (!rec) return;
  rec.rb.setTranslation(rv(position), true);
  rec.rb.setRotation(rq(rotation), true);
  if (!keepVelocity) {
    rec.rb.setLinvel(rv(ZERO), true);
    rec.rb.setAngvel(rv(ZERO), true);
    rec.vPrev = [0, 0, 0];
  }
  rec.hasPrev = false;
  s.queriesDirty = true;
  if (rec.disabled) {
    rec.disabled = false;
    rec.rb.setEnabled(true);
  }
}

export function setVelocity(s: WorldState, id: string, lin: Vec3, ang: Vec3): void {
  const rec = s.bodies.get(id);
  if (!rec) return;
  rec.rb.setLinvel(rv(lin), true);
  rec.rb.setAngvel(rv(ang), true);
  rec.vPrev = [...lin] as Vec3;
}
