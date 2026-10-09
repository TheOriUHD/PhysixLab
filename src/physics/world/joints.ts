/**
 * Joints: construction, key-driven motors, and per-joint measurement (angle / extension / speed /
 * spring force) including spring breakage.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import {
  clamp,
  qconj,
  qfromUnitVectors,
  qmul,
  qrot,
  qrotInv,
  qtwist,
  vadd,
  vdot,
  vlen,
  vnorm,
  vscale,
  vsub,
  type Quat,
  type Vec3,
} from '../../core/math';
import type { JointEntity } from '../../model/types';
import type { JointRec, WorldState } from './state';
import { pos, QI, rot, rq, rv, X_AXIS, ZERO } from './util';

export function addJoint(s: WorldState, def: JointEntity): JointRec | null {
  const A = def.bodyA ? (s.bodies.get(def.bodyA) ?? null) : null;
  const B = def.bodyB ? (s.bodies.get(def.bodyB) ?? null) : null;
  if ((def.bodyA && !A) || (def.bodyB && !B)) return null;
  const qA = A ? rot(A.rb) : QI;
  const qB = B ? rot(B.rb) : QI;
  const pA = A ? pos(A.rb) : ZERO;
  const pB = B ? pos(B.rb) : ZERO;
  const rigid = def.type !== 'spring' && def.type !== 'rope';

  const aA: Vec3 = def.anchorA;
  let aB: Vec3;
  if (rigid) {
    const worldPoint = vadd(pA, qrot(qA, aA));
    aB = qrotInv(qB, vsub(worldPoint, pB));
  } else {
    aB = def.anchorB;
  }

  const axisWorld = vnorm(qrot(qA, def.axis), [0, 0, 1]);
  const qAxis = qfromUnitVectors(X_AXIS, axisWorld);
  let frameA = qmul(qconj(qA), qAxis);
  let frameB = qmul(qconj(qB), qAxis);
  if (def.type === 'fixed') {
    frameA = qconj(qA);
    frameB = qconj(qB);
  }

  let jd: RAPIER.JointData;
  switch (def.type) {
    case 'fixed':
      jd = RAPIER.JointData.fixed(rv(aA), rq(frameA), rv(aB), rq(frameB));
      break;
    case 'hinge':
      jd = RAPIER.JointData.revolute(rv(aA), rv(aB), rv(X_AXIS));
      break;
    case 'slider':
      jd = RAPIER.JointData.prismatic(rv(aA), rv(aB), rv(X_AXIS));
      break;
    case 'ball':
      jd = RAPIER.JointData.spherical(rv(aA), rv(aB));
      break;
    case 'spring':
      jd = RAPIER.JointData.spring(def.spring.restLength, def.spring.stiffness, def.spring.damping, rv(aA), rv(aB));
      break;
    case 'rope':
      jd = RAPIER.JointData.rope(def.ropeLength, rv(aA), rv(aB));
      break;
  }
  const joint = s.world.createImpulseJoint(jd, A ? A.rb : s.worldBody, B ? B.rb : s.worldBody, true);
  if (def.type === 'hinge' || def.type === 'slider') {
    joint.setLocalFrame1(rv(aA), rq(frameA));
    joint.setLocalFrame2(rv(aB), rq(frameB));
  }
  joint.setContactsEnabled(def.collideConnected);

  const rec: JointRec = {
    id: def.id,
    def,
    joint,
    A,
    B,
    aA,
    aB,
    frameA,
    frameB,
    broken: false,
    angle: 0,
    lastTwist: 0,
    value: 0,
    speed: 0,
    force: 0,
    motorTarget: 0,
    cache: [NaN, NaN, NaN],
  };
  configureUnitJoint(s, rec, true);
  s.joints.set(def.id, rec);
  s.jointOrder.push(rec);
  s.layoutVersion++;
  return rec;
}

/** Forget a joint in our bookkeeping (the engine joint is removed separately by the caller). */
export function dropJoint(s: WorldState, id: string): void {
  s.joints.delete(id);
  s.jointOrder = s.jointOrder.filter((r) => r.id !== id);
  s.layoutVersion++;
}

/** Recreate a joint from its edited definition (preserves current body poses; anchors are re-derived). */
export function updateJoint(s: WorldState, next: JointEntity): void {
  const rec = s.joints.get(next.id);
  if (!rec) return;
  if (rec.joint && rec.joint.isValid()) s.world.removeImpulseJoint(rec.joint, true);
  dropJoint(s, rec.id);
  addJoint(s, next);
}

export function configureUnitJoint(s: WorldState, rec: JointRec, initial: boolean): void {
  const { def, joint } = rec;
  if (!joint || (def.type !== 'hinge' && def.type !== 'slider')) return;
  const u = joint as RAPIER.UnitImpulseJoint;
  if (initial) {
    if (def.limit.enabled) u.setLimits(Math.min(def.limit.min, def.limit.max), Math.max(def.limit.min, def.limit.max));
    u.configureMotorModel(RAPIER.MotorModel.ForceBased);
    u.setMotorMaxForce(def.motor.mode === 'off' ? 0 : def.motor.maxForce);
    rec.motorTarget =
      def.motor.mode === 'position' && !(def.motor.keyPos || def.motor.keyNeg) ? def.motor.targetPosition : 0;
  }
  driveMotor(s, rec, 0);
}

/** Update the motor targets from key state; cheap no-op when nothing changed. */
export function driveMotor(s: WorldState, rec: JointRec, dt: number): void {
  const { def, joint } = rec;
  if (!joint || rec.broken || (def.type !== 'hinge' && def.type !== 'slider')) return;
  const m = def.motor;
  const u = joint as RAPIER.UnitImpulseJoint;
  if (m.mode === 'off') {
    if (rec.cache[0] !== 0) {
      u.configureMotorVelocity(0, 0);
      u.setMotorMaxForce(0);
      rec.cache = [0, 0, 0];
    }
    return;
  }
  const hasKeys = !!(m.keyPos || m.keyNeg);
  const input = hasKeys ? (s.keys.has(m.keyPos) && m.keyPos ? 1 : 0) - (s.keys.has(m.keyNeg) && m.keyNeg ? 1 : 0) : 1;
  if (m.mode === 'velocity') {
    const target = m.targetVelocity * input;
    const gain = hasKeys && input === 0 && !m.brake ? 0 : m.damping;
    if (rec.cache[0] !== 1 || rec.cache[1] !== target || rec.cache[2] !== gain) {
      u.setMotorMaxForce(m.maxForce);
      u.configureMotorVelocity(target, gain);
      rec.cache = [1, target, gain];
    }
  } else {
    let target = m.targetPosition;
    if (hasKeys) {
      const desired = m.targetPosition * input;
      const step = m.slewRate * dt;
      rec.motorTarget += clamp(desired - rec.motorTarget, -step, step);
      target = rec.motorTarget;
    }
    if (rec.cache[0] !== 2 || Math.abs(rec.cache[1] - target) > 1e-9) {
      u.setMotorMaxForce(m.maxForce);
      u.configureMotorPosition(target, m.stiffness, m.damping);
      rec.cache = [2, target, 0];
    }
  }
}

function jointAnchorsWorld(j: JointRec): { pa: Vec3; pb: Vec3; qa: Quat; qb: Quat } {
  const qa = j.A ? rot(j.A.rb) : QI;
  const qb = j.B ? rot(j.B.rb) : QI;
  const pa = vadd(j.A ? pos(j.A.rb) : ZERO, qrot(qa, j.aA));
  const pb = vadd(j.B ? pos(j.B.rb) : ZERO, qrot(qb, j.aB));
  return { pa, pb, qa, qb };
}

/** Per-step spring measurement (extension, relative speed, force) and break detection. */
export function measureSpring(s: WorldState, j: JointRec): void {
  const { pa, pb } = jointAnchorsWorld(j);
  const d = vsub(pb, pa);
  const len = vlen(d);
  const dir: Vec3 = len > 1e-9 ? vscale(d, 1 / len) : [0, 1, 0];
  const va = j.A ? j.A.rb.velocityAtPoint(rv(pa)) : { x: 0, y: 0, z: 0 };
  const vb = j.B ? j.B.rb.velocityAtPoint(rv(pb)) : { x: 0, y: 0, z: 0 };
  const rel = vdot(vsub([vb.x, vb.y, vb.z], [va.x, va.y, va.z]), dir);
  const sp = j.def.spring;
  const force = sp.stiffness * (len - sp.restLength) + sp.damping * rel;
  j.value = len;
  j.speed = rel;
  j.force = force;
  if (sp.breakForce > 0 && Math.abs(force) > sp.breakForce) breakJoint(s, j, Math.abs(force));
}

function breakJoint(s: WorldState, j: JointRec, force: number): void {
  if (j.joint && j.joint.isValid()) s.world.removeImpulseJoint(j.joint, true);
  j.joint = null;
  j.broken = true;
  j.force = 0;
  s.events.push({ kind: 'jointBroken', id: j.id, force });
}

/** Measure a joint's current value (angle / position / length) and speed from the body poses. */
export function measureJoint(j: JointRec): void {
  const t = j.def.type;
  if (t === 'spring') return; // measured every step
  const { pa, pb, qa, qb } = jointAnchorsWorld(j);
  if (t === 'hinge') {
    const rel = qmul(qconj(qmul(qa, j.frameA)), qmul(qb, j.frameB));
    const tw = qtwist(rel, X_AXIS);
    let d = tw - j.lastTwist;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    j.angle += d;
    j.lastTwist = tw;
    j.value = j.angle;
    const ax = qrot(qmul(qa, j.frameA), X_AXIS);
    const wa = j.A ? j.A.rb.angvel() : { x: 0, y: 0, z: 0 };
    const wb = j.B ? j.B.rb.angvel() : { x: 0, y: 0, z: 0 };
    j.speed = vdot([wb.x - wa.x, wb.y - wa.y, wb.z - wa.z], ax);
  } else if (t === 'slider') {
    const ax = qrot(qmul(qa, j.frameA), X_AXIS);
    j.value = vdot(vsub(pb, pa), ax);
    const va = j.A ? j.A.rb.velocityAtPoint(rv(pa)) : { x: 0, y: 0, z: 0 };
    const vb = j.B ? j.B.rb.velocityAtPoint(rv(pb)) : { x: 0, y: 0, z: 0 };
    j.speed = vdot([vb.x - va.x, vb.y - va.y, vb.z - va.z], ax);
  } else if (t === 'rope') {
    j.value = vlen(vsub(pb, pa));
    j.speed = 0;
  }
}
