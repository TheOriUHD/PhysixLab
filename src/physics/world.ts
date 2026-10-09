/**
 * PhysicsWorld — the simulation core.
 *
 * Wraps a Rapier (WASM) world and knows how to build it from a SceneDocument, apply live
 * edits, advance it with a fixed timestep + interpolation, and report poses, joint state and
 * energy. It has no DOM / worker dependencies, so it runs identically inside the physics
 * worker and in Node (the unit tests drive it directly).
 */
import RAPIER from '@dimforge/rapier3d-compat';
import {
  clamp, qconj, qfromUnitVectors, qmul, qrot, qrotInv, qslerp, qtwist, vadd, vcross, vdot, vlen,
  vnorm, vscale, vsub, type Quat, type Vec3,
} from '../core/math';
import { hullPoints, primitiveParams } from '../model/shapes';
import type { BodyEntity, JointEntity, SceneDocument, SceneSettings } from '../model/types';
import {
  BODY_STRIDE, CONTACT_STRIDE, J, JOINT_STRIDE, type BuiltInfo, type EnergyStats, type SimEvent,
  type SimOp, type SimStats,
} from './protocol';

let rapierReady: Promise<void> | null = null;
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

const ZERO: Vec3 = [0, 0, 0];
const QI: Quat = [0, 0, 0, 1];
const X_AXIS: Vec3 = [1, 0, 0];
/** Bodies that fall below this height are switched off. */
const KILL_Y = -400;
/** Grab spring natural frequency (rad/s) and acceleration cap (m/s²). */
const GRAB_OMEGA = 15;
const GRAB_MAX_ACCEL = 400;

const rv = (v: Vec3) => ({ x: v[0], y: v[1], z: v[2] });
const rq = (q: Quat) => ({ x: q[0], y: q[1], z: q[2], w: q[3] });

interface BodyRec {
  id: string;
  def: BodyEntity;
  rb: RAPIER.RigidBody;
  col: RAPIER.Collider;
  mass: number;
  ephemeral: boolean;
  disabled: boolean;
  /** Pose before the most recent step, for render interpolation. */
  prev: Float64Array; // px py pz qx qy qz qw
  hasPrev: boolean;
  vPrev: Vec3;
  force: Vec3;
  forced: boolean;
}

interface JointRec {
  id: string;
  def: JointEntity;
  joint: RAPIER.ImpulseJoint | null;
  A: BodyRec | null;
  B: BodyRec | null;
  /** Local anchors actually used (B's derived for rigid joints). */
  aA: Vec3;
  aB: Vec3;
  frameA: Quat;
  frameB: Quat;
  broken: boolean;
  angle: number; // unwrapped hinge angle
  lastTwist: number;
  value: number;
  speed: number;
  force: number;
  motorTarget: number; // slewed position-motor target
  cache: [number, number, number]; // last (mode-specific) motor parameters sent to the engine
}

export class PhysicsWorld {
  readonly world: RAPIER.World;
  settings: SceneSettings;
  simTime = 0;
  stepCount = 0;
  layoutVersion = 0;

  private bodies = new Map<string, BodyRec>();
  private order: BodyRec[] = [];
  private joints = new Map<string, JointRec>();
  private jointOrder: JointRec[] = [];
  private worldBody: RAPIER.RigidBody;
  private ground: { body: RAPIER.RigidBody; col: RAPIER.Collider } | null = null;
  private acc = 0;
  private keys = new Set<string>();
  private grab: { rec: BodyRec; local: Vec3; target: Vec3 } | null = null;
  private events: SimEvent[] = [];
  private stepMsEma = 0;
  private rtf = 1;
  private lastEnergy: EnergyStats = { kinetic: 0, rotational: 0, potential: 0, elastic: 0, momentum: [0, 0, 0] };
  private lastContacts = 0;

  static async create(doc: SceneDocument): Promise<PhysicsWorld> {
    await initRapier();
    return new PhysicsWorld(doc);
  }

  /** Requires initRapier() to have resolved. */
  constructor(doc: SceneDocument) {
    this.settings = doc.settings;
    this.world = new RAPIER.World(rv(doc.settings.gravity));
    this.worldBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.applySettings(doc.settings, true);
    for (const e of doc.entities) if (e.kind === 'body') this.addBody(e, false);
    for (const e of doc.entities) if (e.kind === 'joint') this.addJoint(e);
    this.layoutVersion++;
  }

  dispose(): void {
    this.world.free();
  }

  get fixedDt(): number { return 1 / this.settings.physicsHz; }

  // ------------------------------------------------------------------------------------------
  // construction
  // ------------------------------------------------------------------------------------------

  private makeCollider(def: BodyEntity): RAPIER.ColliderDesc {
    const { radius, halfHeight, half } = primitiveParams(def.shape);
    let desc: RAPIER.ColliderDesc | null = null;
    switch (def.shape.type) {
      case 'box': desc = RAPIER.ColliderDesc.cuboid(half[0], half[1], half[2]); break;
      case 'sphere': desc = RAPIER.ColliderDesc.ball(radius); break;
      case 'cylinder': desc = RAPIER.ColliderDesc.cylinder(halfHeight, radius); break;
      case 'capsule': desc = RAPIER.ColliderDesc.capsule(halfHeight, radius); break;
      case 'cone': desc = RAPIER.ColliderDesc.cone(halfHeight, radius); break;
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

  addBody(def: BodyEntity, ephemeral: boolean): BodyRec {
    const isDyn = def.bodyType === 'dynamic';
    let desc =
      def.bodyType === 'static' ? RAPIER.RigidBodyDesc.fixed()
      : def.bodyType === 'kinematic' ? RAPIER.RigidBodyDesc.kinematicVelocityBased()
      : RAPIER.RigidBodyDesc.dynamic();
    desc = desc
      .setTranslation(def.position[0], def.position[1], def.position[2])
      .setRotation(rq(def.rotation));
    if (isDyn) {
      desc = desc
        .setLinearDamping(def.linearDamping + this.settings.airDrag)
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
    const rb = this.world.createRigidBody(desc);
    const col = this.world.createCollider(this.makeCollider(def), rb);
    const rec: BodyRec = {
      id: def.id, def, rb, col, mass: isDyn ? rb.mass() : 0, ephemeral, disabled: false,
      prev: new Float64Array(7), hasPrev: false, vPrev: [...def.velocity] as Vec3, force: [0, 0, 0], forced: false,
    };
    this.bodies.set(def.id, rec);
    this.order.push(rec);
    this.layoutVersion++;
    return rec;
  }

  addJoint(def: JointEntity): JointRec | null {
    const A = def.bodyA ? this.bodies.get(def.bodyA) ?? null : null;
    const B = def.bodyB ? this.bodies.get(def.bodyB) ?? null : null;
    if ((def.bodyA && !A) || (def.bodyB && !B)) return null;
    const qA = A ? this.rot(A.rb) : QI;
    const qB = B ? this.rot(B.rb) : QI;
    const pA = A ? this.pos(A.rb) : ZERO;
    const pB = B ? this.pos(B.rb) : ZERO;
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
      case 'fixed': jd = RAPIER.JointData.fixed(rv(aA), rq(frameA), rv(aB), rq(frameB)); break;
      case 'hinge': jd = RAPIER.JointData.revolute(rv(aA), rv(aB), rv(X_AXIS)); break;
      case 'slider': jd = RAPIER.JointData.prismatic(rv(aA), rv(aB), rv(X_AXIS)); break;
      case 'ball': jd = RAPIER.JointData.spherical(rv(aA), rv(aB)); break;
      case 'spring': jd = RAPIER.JointData.spring(def.spring.restLength, def.spring.stiffness, def.spring.damping, rv(aA), rv(aB)); break;
      case 'rope': jd = RAPIER.JointData.rope(def.ropeLength, rv(aA), rv(aB)); break;
    }
    const joint = this.world.createImpulseJoint(jd, A ? A.rb : this.worldBody, B ? B.rb : this.worldBody, true);
    if (def.type === 'hinge' || def.type === 'slider') {
      joint.setLocalFrame1(rv(aA), rq(frameA));
      joint.setLocalFrame2(rv(aB), rq(frameB));
    }
    joint.setContactsEnabled(def.collideConnected);

    const rec: JointRec = {
      id: def.id, def, joint, A, B, aA, aB, frameA, frameB, broken: false,
      angle: 0, lastTwist: 0, value: 0, speed: 0, force: 0, motorTarget: 0, cache: [NaN, NaN, NaN],
    };
    this.configureUnitJoint(rec, true);
    this.joints.set(def.id, rec);
    this.jointOrder.push(rec);
    this.layoutVersion++;
    return rec;
  }

  private configureUnitJoint(rec: JointRec, initial: boolean): void {
    const { def, joint } = rec;
    if (!joint || (def.type !== 'hinge' && def.type !== 'slider')) return;
    const u = joint as RAPIER.UnitImpulseJoint;
    if (initial) {
      if (def.limit.enabled) u.setLimits(Math.min(def.limit.min, def.limit.max), Math.max(def.limit.min, def.limit.max));
      u.configureMotorModel(RAPIER.MotorModel.ForceBased);
      u.setMotorMaxForce(def.motor.mode === 'off' ? 0 : def.motor.maxForce);
      rec.motorTarget = def.motor.mode === 'position' && !(def.motor.keyPos || def.motor.keyNeg) ? def.motor.targetPosition : 0;
    }
    this.driveMotor(rec, 0);
  }

  /** Update the motor targets from key state; cheap no-op when nothing changed. */
  private driveMotor(rec: JointRec, dt: number): void {
    const { def, joint } = rec;
    if (!joint || rec.broken || (def.type !== 'hinge' && def.type !== 'slider')) return;
    const m = def.motor;
    const u = joint as RAPIER.UnitImpulseJoint;
    if (m.mode === 'off') {
      if (rec.cache[0] !== 0) { u.configureMotorVelocity(0, 0); u.setMotorMaxForce(0); rec.cache = [0, 0, 0]; }
      return;
    }
    const hasKeys = !!(m.keyPos || m.keyNeg);
    const input = hasKeys ? (this.keys.has(m.keyPos) && m.keyPos ? 1 : 0) - (this.keys.has(m.keyNeg) && m.keyNeg ? 1 : 0) : 1;
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

  // ------------------------------------------------------------------------------------------
  // settings / live edits
  // ------------------------------------------------------------------------------------------

  applySettings(s: SceneSettings, initial = false): void {
    const prev = this.settings;
    this.settings = s;
    const gravityChanged = !initial && (prev.gravity[0] !== s.gravity[0] || prev.gravity[1] !== s.gravity[1] || prev.gravity[2] !== s.gravity[2]);
    this.world.gravity = rv(s.gravity);
    // Sleeping bodies would otherwise ignore the new gravity until something touches them.
    if (gravityChanged) for (const r of this.order) r.rb.wakeUp();
    this.world.integrationParameters.dt = 1 / s.physicsHz;
    this.world.integrationParameters.numSolverIterations = s.solverIterations;
    if (initial || prev.ground !== s.ground) this.buildGround();
    if (prev.airDrag !== s.airDrag) {
      for (const r of this.order) if (r.def.bodyType === 'dynamic') r.rb.setLinearDamping(r.def.linearDamping + s.airDrag);
    }
  }

  private buildGround(): void {
    if (this.ground) {
      this.world.removeRigidBody(this.ground.body);
      this.ground = null;
    }
    const g = this.settings.ground;
    if (!g.enabled) return;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1, 0));
    const col = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(g.halfSize, 1, g.halfSize)
        .setFriction(g.friction)
        .setRestitution(g.restitution)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max),
      body,
    );
    this.ground = { body, col };
  }

  removeEntities(ids: string[]): void {
    for (const id of ids) {
      const j = this.joints.get(id);
      if (j) {
        if (j.joint && j.joint.isValid()) this.world.removeImpulseJoint(j.joint, true);
        this.dropJoint(id);
      }
    }
    for (const id of ids) {
      const b = this.bodies.get(id);
      if (!b) continue;
      if (this.grab?.rec === b) this.grab = null;
      // Rapier deletes attached joints with the body; mirror that in our bookkeeping.
      for (const jr of [...this.jointOrder]) if (jr.A === b || jr.B === b) this.dropJoint(jr.id);
      this.world.removeRigidBody(b.rb);
      this.bodies.delete(id);
      this.order = this.order.filter((r) => r !== b);
    }
    this.layoutVersion++;
  }

  private dropJoint(id: string): void {
    this.joints.delete(id);
    this.jointOrder = this.jointOrder.filter((r) => r.id !== id);
    this.layoutVersion++;
  }

  /** Apply the edited body definition, in place when possible, otherwise by rebuilding the body. */
  updateBody(next: BodyEntity): void {
    const rec = this.bodies.get(next.id);
    if (!rec) return;
    const old = rec.def;
    const structural =
      old.bodyType !== next.bodyType ||
      (old.shape !== next.shape && JSON.stringify(old.shape) !== JSON.stringify(next.shape)) ||
      old.material.density !== next.material.density || old.ccd !== next.ccd || old.ghost !== next.ghost ||
      old.lockPosition.some((v, i) => v !== next.lockPosition[i]) || old.lockRotation.some((v, i) => v !== next.lockRotation[i]);
    if (structural) {
      this.rebuildBody(rec, next);
      return;
    }
    rec.def = next;
    if (next.bodyType === 'dynamic') {
      rec.rb.setLinearDamping(next.linearDamping + this.settings.airDrag);
      rec.rb.setAngularDamping(next.angularDamping);
      rec.rb.setGravityScale(next.gravityScale, true);
    }
    if (next.bodyType === 'kinematic') {
      rec.rb.setLinvel(rv(next.velocity), true);
      rec.rb.setAngvel(rv(next.angularVelocity), true);
    }
    rec.col.setFriction(next.material.friction);
    rec.col.setRestitution(next.material.restitution);
    rec.rb.wakeUp();
  }

  private rebuildBody(rec: BodyRec, next: BodyEntity): void {
    const pos = this.pos(rec.rb), rot = this.rot(rec.rb);
    const lv = rec.rb.linvel(), av = rec.rb.angvel();
    const attached = this.jointOrder.filter((j) => j.A === rec || j.B === rec).map((j) => j.def);
    const ephemeral = rec.ephemeral;
    this.removeEntities([rec.id]);
    const moved: BodyEntity = {
      ...next,
      position: pos, rotation: rot,
      velocity: [lv.x, lv.y, lv.z], angularVelocity: [av.x, av.y, av.z],
    };
    // Keep the original initial-velocity fields on the stored definition.
    const nr = this.addBody(moved, ephemeral);
    nr.def = next;
    for (const jd of attached) this.addJoint(jd);
  }

  updateJoint(next: JointEntity): void {
    const rec = this.joints.get(next.id);
    if (!rec) return;
    // Recreate (preserves current body poses; anchors are re-derived from them).
    if (rec.joint && rec.joint.isValid()) this.world.removeImpulseJoint(rec.joint, true);
    this.dropJoint(rec.id);
    this.addJoint(next);
  }

  teleport(id: string, position: Vec3, rotation: Quat, keepVelocity = false): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    rec.rb.setTranslation(rv(position), true);
    rec.rb.setRotation(rq(rotation), true);
    if (!keepVelocity) {
      rec.rb.setLinvel(rv(ZERO), true);
      rec.rb.setAngvel(rv(ZERO), true);
      rec.vPrev = [0, 0, 0];
    }
    rec.hasPrev = false;
    if (rec.disabled) { rec.disabled = false; rec.rb.setEnabled(true); }
  }

  setVelocity(id: string, lin: Vec3, ang: Vec3): void {
    const rec = this.bodies.get(id);
    if (!rec) return;
    rec.rb.setLinvel(rv(lin), true);
    rec.rb.setAngvel(rv(ang), true);
    rec.vPrev = [...lin] as Vec3;
  }

  applyOp(op: SimOp): void {
    switch (op.op) {
      case 'addBody': this.addBody(op.body, !!op.ephemeral); break;
      case 'addJoint': this.addJoint(op.joint); break;
      case 'remove': this.removeEntities(op.ids); break;
      case 'updateBody': this.updateBody(op.body); break;
      case 'updateJoint': this.updateJoint(op.joint); break;
      case 'settings': this.applySettings(op.settings); break;
      case 'teleport': this.teleport(op.id, op.position, op.rotation, op.keepVelocity); break;
      case 'setVelocity': this.setVelocity(op.id, op.linvel, op.angvel); break;
      case 'grab': this.beginGrab(op.id, op.point, op.target); break;
      case 'grabMove': if (this.grab) this.grab.target = op.target; break;
      case 'release': this.grab = null; break;
      case 'impulse': this.impulse(op.id, op.impulse, op.point); break;
      case 'explode': this.explode(op.center, op.strength, op.radius); break;
      case 'wakeAll': for (const r of this.order) r.rb.wakeUp(); break;
    }
  }

  private beginGrab(id: string, point: Vec3, target: Vec3): void {
    const rec = this.bodies.get(id);
    if (!rec || rec.def.bodyType !== 'dynamic') return;
    const local = qrotInv(this.rot(rec.rb), vsub(point, this.pos(rec.rb)));
    rec.rb.wakeUp();
    this.grab = { rec, local, target };
  }

  private impulse(id: string, impulse: Vec3, point: Vec3): void {
    const rec = this.bodies.get(id);
    if (!rec || rec.def.bodyType !== 'dynamic') return;
    rec.rb.applyImpulseAtPoint(rv(impulse), rv(point), true);
  }

  private explode(center: Vec3, strength: number, radius: number): void {
    for (const r of this.order) {
      if (r.def.bodyType !== 'dynamic' || r.disabled) continue;
      const com = r.rb.worldCom();
      const d = vsub([com.x, com.y, com.z], center);
      const dist = vlen(d);
      if (dist > radius) continue;
      const falloff = 1 - dist / radius;
      const dir = dist < 1e-6 ? ([0, 1, 0] as Vec3) : vscale(d, 1 / dist);
      // Impulse scales with exposed area (~ mass^(2/3)) so light and heavy objects both react.
      const j = strength * falloff * falloff * Math.pow(Math.max(r.mass, 0.01), 2 / 3);
      r.rb.applyImpulse(rv(vadd(vscale(dir, j), [0, j * 0.25, 0])), true);
      const spin = vcross(dir, [0, 1, 0]);
      r.rb.applyTorqueImpulse(rv(vscale(spin, j * 0.05)), true);
    }
  }

  // ------------------------------------------------------------------------------------------
  // stepping
  // ------------------------------------------------------------------------------------------

  setKeys(keys: Iterable<string>): void {
    this.keys = new Set(keys);
  }

  private pos(rb: RAPIER.RigidBody): Vec3 { const t = rb.translation(); return [t.x, t.y, t.z]; }
  private rot(rb: RAPIER.RigidBody): Quat { const q = rb.rotation(); return [q.x, q.y, q.z, q.w]; }

  /** Apply thrusters, the grab spring and motors before a step. */
  private preStep(dt: number): void {
    for (const j of this.jointOrder) if (j.def.motor.mode !== 'off' || j.cache[0] !== 0) this.driveMotor(j, dt);

    for (const r of this.order) {
      if (r.def.bodyType !== 'dynamic' || r.disabled) continue;
      const t = r.def.thrust;
      const active = !!t && (t.mode === 'always' || (!!t.key && this.keys.has(t.key)));
      if (!active && !r.forced) continue;
      r.rb.resetForces(false);
      r.rb.resetTorques(false);
      r.forced = false;
      if (active && t) {
        const q = this.rot(r.rb);
        r.rb.addForce(rv(qrot(q, t.force)), true);
        r.rb.addTorque(rv(qrot(q, t.torque)), true);
        r.forced = true;
      }
    }

    const g = this.grab;
    if (g && !g.rec.disabled) {
      const rb = g.rec.rb;
      const q = this.rot(rb);
      const p = vadd(this.pos(rb), qrot(q, g.local));
      const v = rb.velocityAtPoint(rv(p));
      const err = vsub(g.target, p);
      const m = g.rec.mass;
      let acc = vsub(vscale(err, GRAB_OMEGA * GRAB_OMEGA), vscale([v.x, v.y, v.z], 2 * GRAB_OMEGA));
      const al = vlen(acc);
      if (al > GRAB_MAX_ACCEL) acc = vscale(acc, GRAB_MAX_ACCEL / al);
      // Counter gravity so a held body hovers under the cursor, as if carried by hand.
      const grav = vscale(this.settings.gravity, -g.rec.def.gravityScale);
      const f = vscale(vadd(acc, grav), m);
      rb.resetForces(false);
      rb.resetTorques(false);
      rb.addForceAtPoint(rv(f), rv(p), true);
      const w = rb.angvel();
      const inertia = rb.principalInertia();
      const iAvg = (inertia.x + inertia.y + inertia.z) / 3;
      rb.addTorque(rv(vscale([w.x, w.y, w.z], -iAvg * 6)), true);
      g.rec.forced = true;
    }
  }

  private postStep(): void {
    for (const r of this.order) {
      if (r.disabled || r.def.bodyType === 'static') continue;
      if (r.rb.translation().y < KILL_Y) {
        r.disabled = true;
        r.rb.setEnabled(false);
      }
    }
    for (const j of this.jointOrder) {
      if (j.broken || !j.joint) continue;
      if (j.def.type === 'spring') this.measureSpring(j);
      else if (j.def.type === 'hinge') this.measureJoint(j); // keeps the unwrapped angle continuous
    }
  }

  private jointAnchorsWorld(j: JointRec): { pa: Vec3; pb: Vec3; qa: Quat; qb: Quat } {
    const qa = j.A ? this.rot(j.A.rb) : QI;
    const qb = j.B ? this.rot(j.B.rb) : QI;
    const pa = vadd(j.A ? this.pos(j.A.rb) : ZERO, qrot(qa, j.aA));
    const pb = vadd(j.B ? this.pos(j.B.rb) : ZERO, qrot(qb, j.aB));
    return { pa, pb, qa, qb };
  }

  private measureSpring(j: JointRec): void {
    const { pa, pb } = this.jointAnchorsWorld(j);
    const d = vsub(pb, pa);
    const len = vlen(d);
    const dir: Vec3 = len > 1e-9 ? vscale(d, 1 / len) : [0, 1, 0];
    const va = j.A ? j.A.rb.velocityAtPoint(rv(pa)) : { x: 0, y: 0, z: 0 };
    const vb = j.B ? j.B.rb.velocityAtPoint(rv(pb)) : { x: 0, y: 0, z: 0 };
    const rel = vdot(vsub([vb.x, vb.y, vb.z], [va.x, va.y, va.z]), dir);
    const s = j.def.spring;
    const force = s.stiffness * (len - s.restLength) + s.damping * rel;
    j.value = len;
    j.speed = rel;
    j.force = force;
    if (s.breakForce > 0 && Math.abs(force) > s.breakForce) this.breakJoint(j, Math.abs(force));
  }

  private breakJoint(j: JointRec, force: number): void {
    if (j.joint && j.joint.isValid()) this.world.removeImpulseJoint(j.joint, true);
    j.joint = null;
    j.broken = true;
    j.force = 0;
    this.events.push({ kind: 'jointBroken', id: j.id, force });
  }

  /** Advance the simulation by exactly one fixed step. */
  stepOnce(): void {
    const dt = this.fixedDt;
    this.preStep(dt);
    this.world.step();
    this.simTime += dt;
    this.simSinceRead += dt;
    this.stepCount++;
    this.postStep();
  }

  /**
   * Advance by wall-clock time (scaled), interpolating the remainder. Returns the number of
   * fixed steps taken. `budgetMs` bounds the work done in one call (the sim then falls behind
   * real time instead of freezing the worker).
   */
  advance(realDt: number, timeScale: number, budgetMs = 28): number {
    const dt = this.fixedDt;
    this.acc += Math.min(realDt, 0.25) * timeScale;
    const wanted = Math.floor(this.acc / dt);
    let done = 0;
    const t0 = performance.now();
    while (done < wanted) {
      if (done === wanted - 1 || (done >= 1 && performance.now() - t0 > budgetMs)) this.snapshotPrev();
      this.stepOnce();
      done++;
      if (performance.now() - t0 > budgetMs && done < wanted) break;
    }
    this.acc -= done * dt;
    if (done < wanted) this.acc = Math.min(this.acc, dt); // fell behind: drop the backlog
    if (done > 0) {
      const ms = (performance.now() - t0) / done;
      this.stepMsEma = this.stepMsEma === 0 ? ms : this.stepMsEma * 0.9 + ms * 0.1;
    }
    const wantedTime = realDt * timeScale;
    this.rtf = wantedTime > 0 ? clamp((done * dt) / wantedTime, 0, 4) : 1;
    return done;
  }

  /** Manual stepping (paused): render the exact post-step state. */
  stepManual(n: number): void {
    for (let i = 0; i < n; i++) this.stepOnce();
    this.acc = 0;
    for (const r of this.order) r.hasPrev = false;
  }

  private snapshotPrev(): void {
    for (const r of this.order) {
      if (r.def.bodyType === 'static' || r.disabled) { r.hasPrev = false; continue; }
      const t = r.rb.translation(), q = r.rb.rotation();
      const p = r.prev;
      p[0] = t.x; p[1] = t.y; p[2] = t.z; p[3] = q.x; p[4] = q.y; p[5] = q.z; p[6] = q.w;
      r.hasPrev = true;
    }
  }

  // ------------------------------------------------------------------------------------------
  // readout
  // ------------------------------------------------------------------------------------------

  /** Fixed-step interpolation factor for the current accumulator. */
  get alpha(): number { return clamp(this.acc / this.fixedDt, 0, 1); }

  get bodyIds(): string[] { return this.order.map((r) => r.id); }
  get jointIds(): string[] { return this.jointOrder.map((r) => r.id); }

  readPoses(alpha: number, out?: Float32Array): Float32Array {
    const frameDt = this.simSinceRead;
    this.simSinceRead = 0;
    const n = this.order.length;
    const buf = out && out.length >= n * BODY_STRIDE ? out : new Float32Array(n * BODY_STRIDE);
    const g = this.settings.gravity;
    let kinT = 0, kinR = 0, pot = 0;
    const mom: Vec3 = [0, 0, 0];
    let awake = 0;
    for (let i = 0; i < n; i++) {
      const r = this.order[i];
      const o = i * BODY_STRIDE;
      const t = r.rb.translation();
      const q = r.rb.rotation();
      let px = t.x, py = t.y, pz = t.z;
      let qx = q.x, qy = q.y, qz = q.z, qw = q.w;
      if (alpha < 1 && r.hasPrev && !r.disabled) {
        const p = r.prev;
        px = p[0] + (px - p[0]) * alpha;
        py = p[1] + (py - p[1]) * alpha;
        pz = p[2] + (pz - p[2]) * alpha;
        const s = qslerp([p[3], p[4], p[5], p[6]], [qx, qy, qz, qw], alpha);
        qx = s[0]; qy = s[1]; qz = s[2]; qw = s[3];
      }
      buf[o] = px; buf[o + 1] = py; buf[o + 2] = pz;
      buf[o + 3] = qx; buf[o + 4] = qy; buf[o + 5] = qz; buf[o + 6] = qw;
      const isDyn = r.def.bodyType === 'dynamic';
      const lv = r.rb.linvel(), av = r.rb.angvel();
      buf[o + 7] = lv.x; buf[o + 8] = lv.y; buf[o + 9] = lv.z;
      buf[o + 10] = av.x; buf[o + 11] = av.y; buf[o + 12] = av.z;
      const sleeping = r.disabled ? 2 : isDyn && r.rb.isSleeping() ? 1 : 0;
      buf[o + 16] = sleeping;
      let ke = 0;
      if (isDyn && !r.disabled) {
        if (frameDt > 0 && !sleeping) {
          buf[o + 13] = (r.mass * (lv.x - r.vPrev[0])) / frameDt;
          buf[o + 14] = (r.mass * (lv.y - r.vPrev[1])) / frameDt;
          buf[o + 15] = (r.mass * (lv.z - r.vPrev[2])) / frameDt;
        } else if (sleeping) {
          buf[o + 13] = buf[o + 14] = buf[o + 15] = 0;
        }
        r.vPrev = [lv.x, lv.y, lv.z];
        const v2 = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
        const com = r.rb.worldCom();
        // rotational KE in the principal frame: ½ Σ Iᵢ ωᵢ²
        const qb: Quat = [q.x, q.y, q.z, q.w];
        const pf = r.rb.principalInertiaLocalFrame();
        const pi = r.rb.principalInertia();
        const wl = qrotInv(qmul(qb, [pf.x, pf.y, pf.z, pf.w]), [av.x, av.y, av.z]);
        const rot = 0.5 * (pi.x * wl[0] * wl[0] + pi.y * wl[1] * wl[1] + pi.z * wl[2] * wl[2]);
        const tr = 0.5 * r.mass * v2;
        ke = tr + rot;
        kinT += tr; kinR += rot;
        pot += -r.mass * r.def.gravityScale * (g[0] * com.x + g[1] * com.y + g[2] * com.z);
        mom[0] += r.mass * lv.x; mom[1] += r.mass * lv.y; mom[2] += r.mass * lv.z;
        if (!sleeping) awake++;
      } else {
        buf[o + 13] = buf[o + 14] = buf[o + 15] = 0;
      }
      buf[o + 17] = ke;
    }
    let elastic = 0;
    for (const j of this.jointOrder) if (j.def.type === 'spring' && !j.broken) {
      const x = j.value - j.def.spring.restLength;
      elastic += 0.5 * j.def.spring.stiffness * x * x;
    }
    this.lastEnergy = { kinetic: kinT, rotational: kinR, potential: pot, elastic, momentum: mom };
    this.awakeCount = awake;
    return buf;
  }

  private awakeCount = 0;
  private simSinceRead = 0;

  readJoints(out?: Float32Array): Float32Array {
    const n = this.jointOrder.length;
    const buf = out && out.length >= n * JOINT_STRIDE ? out : new Float32Array(n * JOINT_STRIDE);
    for (let i = 0; i < n; i++) {
      const j = this.jointOrder[i];
      const o = i * JOINT_STRIDE;
      if (!j.broken && j.joint) this.measureJoint(j);
      buf[o + J.value] = j.value;
      buf[o + J.speed] = j.speed;
      buf[o + J.force] = j.force;
      buf[o + J.broken] = j.broken ? 1 : 0;
    }
    return buf;
  }

  private measureJoint(j: JointRec): void {
    const t = j.def.type;
    if (t === 'spring') return; // measured every step
    const { pa, pb, qa, qb } = this.jointAnchorsWorld(j);
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

  /** Contact points (world space) of awake bodies for the contact overlay. */
  readContacts(max = 800): Float32Array {
    const out: number[] = [];
    let total = 0;
    const dt = this.fixedDt;
    for (const r of this.order) {
      if (r.def.bodyType !== 'dynamic' || r.disabled || r.rb.isSleeping()) continue;
      const c = r.col;
      this.world.contactPairsWith(c, (c2) => {
        const other = c2.parent();
        const otherDyn = other ? other.isDynamic() : false;
        if (otherDyn && c2.handle < c.handle) return; // report each dynamic pair once
        this.world.contactPair(c, c2, (m, flipped) => {
          const ns = m.numSolverContacts();
          if (ns === 0) return;
          const nc = m.numContacts();
          let imp = 0;
          for (let i = 0; i < nc; i++) imp += m.contactImpulse(i);
          const force = imp / dt;
          const n = m.normal();
          const s = flipped ? -1 : 1;
          for (let i = 0; i < ns; i++) {
            total++;
            if (out.length / CONTACT_STRIDE >= max) continue;
            const p = m.solverContactPoint(i);
            if (!p) continue;
            out.push(p.x, p.y, p.z, n.x * s, n.y * s, n.z * s, force / ns);
          }
        });
      });
    }
    this.lastContacts = total;
    return new Float32Array(out);
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  builtInfo(): BuiltInfo {
    const mass: Record<string, number> = {};
    const com: Record<string, Vec3> = {};
    for (const r of this.order) {
      mass[r.id] = r.mass;
      const c = r.rb.localCom();
      com[r.id] = [c.x, c.y, c.z];
    }
    return { mass, com };
  }

  stats(): SimStats {
    let awake = this.awakeCount;
    if (awake === 0) awake = this.order.filter((r) => r.def.bodyType === 'dynamic' && !r.rb.isSleeping()).length;
    return {
      simTime: this.simTime,
      stepCount: this.stepCount,
      stepMs: this.stepMsEma,
      bodies: this.order.length,
      awake,
      contacts: this.lastContacts,
      realtimeFactor: this.rtf,
      energy: this.lastEnergy,
    };
  }

  /** Test helper: pose of a body in the live world. */
  getPose(id: string): { position: Vec3; rotation: Quat; linvel: Vec3; angvel: Vec3 } | null {
    const r = this.bodies.get(id);
    if (!r) return null;
    const lv = r.rb.linvel(), av = r.rb.angvel();
    return { position: this.pos(r.rb), rotation: this.rot(r.rb), linvel: [lv.x, lv.y, lv.z], angvel: [av.x, av.y, av.z] };
  }

  getJointRec(id: string): { value: number; speed: number; force: number; broken: boolean } | null {
    const j = this.joints.get(id);
    if (!j) return null;
    if (!j.broken && j.joint) this.measureJoint(j);
    return { value: j.value, speed: j.speed, force: j.force, broken: j.broken };
  }
}
