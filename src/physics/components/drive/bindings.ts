/**
 * The physical end of a shaft: a hinge (a rotational shaft: speed = relative angular velocity of the joint's two
 * bodies about its axis) or a slider (a linear shaft: relative speed along the axis). The network measures the speed
 * and the effective inertia from the live bodies and delivers the impulse it solved for as equal and opposite
 * (angular) impulses on the two bodies — the same thing a joint motor does, so reactions flow into the chassis.
 *
 * The effective inertia of the relative degree of freedom is 1 / (1/I_A + 1/I_B): the response of the joint's speed
 * to a unit impulse when nothing else acts. Contacts and other joints are not in that number; they act in the engine's
 * own solve right after, and the network sees their effect as a changed speed on the next step.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { qmul, qrot, vcross, vdot, vsub, type Vec3 } from '../../../core/math';
import { measureJoint } from '../../world/joints';
import type { BodyRec, JointRec, WorldState } from '../../world/state';
import { pos, QI, rot, rv, X_AXIS, ZERO } from '../../world/util';

const scratchInertia = new RAPIER.SdpMatrix3(new Float32Array(6));
const scratchInvInertia = new RAPIER.SdpMatrix3(new Float32Array(6));

/** nᵀ·W·n for a symmetric matrix stored as [m11, m12, m13, m22, m23, m33]. */
function quad(e: Float32Array, n: Vec3): number {
  return (
    e[0] * n[0] * n[0] +
    e[3] * n[1] * n[1] +
    e[5] * n[2] * n[2] +
    2 * (e[1] * n[0] * n[1] + e[2] * n[0] * n[2] + e[4] * n[1] * n[2])
  );
}

const usable = (r: BodyRec | null): r is BodyRec => !!r && r.def.bodyType === 'dynamic' && !r.disabled;

export class JointBinding {
  readonly kind: 'rot' | 'lin';
  constructor(
    private readonly s: WorldState,
    readonly jointId: string,
  ) {
    this.kind = s.joints.get(jointId)?.def.type === 'slider' ? 'lin' : 'rot';
  }

  /** The live joint record, or null once it is gone or broken. */
  get rec(): JointRec | null {
    const r = this.s.joints.get(this.jointId);
    return r && !r.broken && r.joint ? r : null;
  }
  alive(): boolean {
    return this.rec !== null;
  }

  /** The joint axis in the world frame (unit). */
  axis(out: Vec3 = [0, 0, 0]): Vec3 {
    const r = this.rec;
    if (!r) return out;
    const qa = r.A ? rot(r.A.rb) : QI;
    const a = qrot(qmul(qa, r.frameA), X_AXIS);
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    return out;
  }

  /** The anchor on body A (the joint's pivot) in the world frame. */
  anchorWorld(out: Vec3 = [0, 0, 0]): Vec3 {
    const r = this.rec;
    if (!r) return out;
    const p = r.A ? pos(r.A.rb) : ZERO;
    const a = qrot(r.A ? rot(r.A.rb) : QI, r.aA);
    out[0] = p[0] + a[0];
    out[1] = p[1] + a[1];
    out[2] = p[2] + a[2];
    return out;
  }

  private anchorB(): Vec3 {
    const r = this.rec;
    if (!r) return [0, 0, 0];
    const p = r.B ? pos(r.B.rb) : ZERO;
    const a = qrot(r.B ? rot(r.B.rb) : QI, r.aB);
    return [p[0] + a[0], p[1] + a[1], p[2] + a[2]];
  }

  /** Relative speed of B with respect to A: rad/s about the axis (hinge) or m/s along it (slider). */
  speed(): number {
    const r = this.rec;
    if (!r) return 0;
    const n = this.axis();
    if (this.kind === 'rot') {
      const wa = r.A ? r.A.rb.angvel() : { x: 0, y: 0, z: 0 };
      const wb = r.B ? r.B.rb.angvel() : { x: 0, y: 0, z: 0 };
      return (wb.x - wa.x) * n[0] + (wb.y - wa.y) * n[1] + (wb.z - wa.z) * n[2];
    }
    const pa = this.anchorWorld();
    const pb = this.anchorB();
    const va = r.A ? r.A.rb.velocityAtPoint(rv(pa)) : { x: 0, y: 0, z: 0 };
    const vb = r.B ? r.B.rb.velocityAtPoint(rv(pb)) : { x: 0, y: 0, z: 0 };
    return (vb.x - va.x) * n[0] + (vb.y - va.y) * n[1] + (vb.z - va.z) * n[2];
  }

  /** Angle (rad, unwrapped, 0 at the pose the simulation started in) or extension (m, 0 at the start). */
  position(): number {
    const r = this.rec;
    if (!r) return 0;
    if (this.kind === 'rot') {
      measureJoint(r); // idempotent: keeps the unwrapped angle current inside a component's poststep
      return r.angle;
    }
    return vdot(vsub(this.anchorB(), this.anchorWorld()), this.axis());
  }

  /**
   * 1 / (effective inertia or mass) of the relative degree of freedom; 0 when both bodies are immovable.
   *
   * Because the joint holds the pivot, a torque about a hinge makes a body turn about the *axis through the pivot*:
   * its inertia is the one about its own centre plus m·d² (parallel axis theorem, d = distance of the centre of mass
   * from the axis). A slider holds the orientation, so a force along it moves the body as a plain mass.
   */
  invInertia(): number {
    const r = this.rec;
    if (!r) return 0;
    const n = this.axis();
    return this.invOf(r.A, n, this.anchorWorld()) + this.invOf(r.B, n, this.anchorB());
  }

  private invOf(b: BodyRec | null, n: Vec3, at: Vec3): number {
    if (!usable(b)) return 0;
    if (this.kind === 'lin') {
      const m = b.rb.effectiveInvMass();
      return m.x * n[0] * n[0] + m.y * n[1] * n[1] + m.z * n[2] * n[2];
    }
    if (quad(b.rb.effectiveWorldInvInertia(scratchInvInertia).elements, n) < 1e-12) return 0; // rotation locked
    return 1 / this.axisInertia(b, n, at);
  }

  /** Inertia of a body about the line through `at` along `n`. */
  private axisInertia(b: BodyRec, n: Vec3, at: Vec3): number {
    const c = b.rb.worldCom();
    const d: Vec3 = [at[0] - c.x, at[1] - c.y, at[2] - c.z];
    const along = vdot(d, n);
    const perp2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] - along * along;
    return quad(b.rb.effectiveAngularInertia(scratchInertia).elements, n) + b.rb.mass() * perp2;
  }

  /**
   * How much gravity alone will change the joint's speed during the next step. The engine adds gravity *after* our
   * impulse is applied, so a controller that wants "speed 0 at the end of the step" (a hold, a servo target, a
   * cylinder speed) has to pre-compensate for it or it creeps by g·dt every step. Only the driven side counts — B,
   * or A when B cannot move — because the other side is usually held up by something else (the ground, other
   * joints), and its weight must not be predicted as a motion.
   */
  gravityDelta(dt: number): number {
    const r = this.rec;
    if (!r) return 0;
    const g = this.s.settings.gravity;
    const n = this.axis();
    const body = usable(r.B) ? r.B : usable(r.A) ? r.A : null;
    if (!body) return 0;
    const sign = body === r.B ? 1 : -1; // speeds are B relative to A
    const k = body.rb.gravityScale();
    if (this.kind === 'lin') return sign * vdot([g[0] * k, g[1] * k, g[2] * k], n) * dt;
    const at = body === r.B ? this.anchorB() : this.anchorWorld();
    const c = body.rb.worldCom();
    const m = body.rb.mass() * k;
    const torque = vdot(vcross(vsub([c.x, c.y, c.z], at), [g[0] * m, g[1] * m, g[2] * m]), n);
    return (sign * torque * dt) / this.axisInertia(body, n, at);
  }

  /** Deliver an impulse: +J on body B and −J on body A, about / along the axis. */
  apply(impulse: number): void {
    const r = this.rec;
    if (!r || impulse === 0) return;
    const n = this.axis();
    const a = usable(r.A) ? r.A : null;
    const b = usable(r.B) ? r.B : null;
    if (this.kind === 'rot') {
      if (b) b.rb.applyTorqueImpulse({ x: n[0] * impulse, y: n[1] * impulse, z: n[2] * impulse }, true);
      if (a) a.rb.applyTorqueImpulse({ x: -n[0] * impulse, y: -n[1] * impulse, z: -n[2] * impulse }, true);
      return;
    }
    if (b)
      b.rb.applyImpulseAtPoint({ x: n[0] * impulse, y: n[1] * impulse, z: n[2] * impulse }, rv(this.anchorB()), true);
    if (a)
      a.rb.applyImpulseAtPoint(
        { x: -n[0] * impulse, y: -n[1] * impulse, z: -n[2] * impulse },
        rv(this.anchorWorld()),
        true,
      );
  }

  /** The body that carries reaction forces (A when it can move, else B); null when both are immovable. */
  support(): BodyRec | null {
    const r = this.rec;
    if (!r) return null;
    return usable(r.A) ? r.A : usable(r.B) ? r.B : null;
  }
  /** The body on the moving side (B when it can move, else A). */
  moving(): BodyRec | null {
    const r = this.rec;
    if (!r) return null;
    return usable(r.B) ? r.B : usable(r.A) ? r.A : null;
  }
}
