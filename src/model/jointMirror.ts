/**
 * Mirror joints (and the bodies they connect) across a world plane (JT-22). Pure functions, no store access.
 *
 * Mirroring conventions, derived once here and tested in `tests/jointMirror.test.ts`:
 *  - A point reflects through the plane. A *polar* vector (a direction, a velocity, a slider axis) reflects: the
 *    component along the plane normal changes sign.
 *  - A *pseudo* vector (an angular velocity, a hinge axis) reflects and then changes sign: reflecting a rotation of θ
 *    about `a` gives a rotation of θ about `−M·a`. A mirrored hinge therefore uses `axis' = −M·axis`, which keeps
 *    the limits, the motor target and the live angle numerically identical to the original.
 *  - A rigid body reflects by conjugation: position `M·p`, rotation `M R M`, which for the quaternion `(x, y, z, w)`
 *    flips the two components perpendicular to the normal and keeps the normal one. For such a mirrored copy the
 *    *local* frame is reflected along the normal's axis, so a local anchor simply has that component negated.
 *    (Shapes that are not mirror-symmetric, such as a wedge, are copied rather than reflected.)
 */
import { qrot, qrotInv, vadd, vsub, type Quat, type Vec3 } from '../core/math';
import type { DofSpec } from './jointParams';
import type { BodyEntity, JointEntity } from './types';

/** The plane `p[axis] = offset`. */
export interface MirrorPlane {
  axis: 0 | 1 | 2;
  offset: number;
}

export const MIRROR_PLANES: Record<'x' | 'y' | 'z', MirrorPlane> = {
  x: { axis: 0, offset: 0 },
  y: { axis: 1, offset: 0 },
  z: { axis: 2, offset: 0 },
};

export const mirrorPoint = (p: Vec3, pl: MirrorPlane): Vec3 => {
  const o: Vec3 = [p[0], p[1], p[2]];
  o[pl.axis] = 2 * pl.offset - p[pl.axis];
  return o;
};

/** Reflect a polar vector (direction, velocity). */
export const mirrorDir = (d: Vec3, pl: MirrorPlane): Vec3 => {
  const o: Vec3 = [d[0], d[1], d[2]];
  o[pl.axis] = -d[pl.axis];
  return o;
};

/** Reflect a pseudo vector (angular velocity, hinge axis): reflect, then negate. */
export const mirrorPseudo = (d: Vec3, pl: MirrorPlane): Vec3 => {
  const r = mirrorDir(d, pl);
  return [-r[0], -r[1], -r[2]];
};

/** Rotation of the mirror image: `M R M`. */
export function mirrorRotation(q: Quat, pl: MirrorPlane): Quat {
  const o: Quat = [-q[0], -q[1], -q[2], q[3]];
  o[pl.axis] = q[pl.axis];
  return o;
}

export interface Pose {
  position: Vec3;
  rotation: Quat;
}

export function mirrorPose(p: Pose, pl: MirrorPlane): Pose {
  return { position: mirrorPoint(p.position, pl), rotation: mirrorRotation(p.rotation, pl) };
}

/** The mirror image of a body: same everything, reflected pose and velocities (a new id is the caller's job). */
export function mirrorBody(b: BodyEntity, pl: MirrorPlane): BodyEntity {
  const pose = mirrorPose(b, pl);
  const lockP: [boolean, boolean, boolean] = [...b.lockPosition];
  return {
    ...b,
    position: pose.position,
    rotation: pose.rotation,
    velocity: mirrorDir(b.velocity, pl),
    angularVelocity: mirrorPseudo(b.angularVelocity, pl),
    lockPosition: lockP,
    lockRotation: [...b.lockRotation],
    // the body's own frame is reflected too: compound parts and a centre-of-mass override move with it
    ...(b.comOverride ? { comOverride: mirrorDir(b.comOverride, pl) } : {}),
    ...(b.parts
      ? {
          parts: b.parts.map((c) => ({
            ...c,
            position: mirrorDir(c.position, pl),
            rotation: mirrorRotation(c.rotation, pl),
          })),
        }
      : {}),
  };
}

/** Is `b` its own mirror image (it sits on the plane and is symmetric about it)? Such a body is shared, not copied. */
export function isOnPlane(b: Pose, pl: MirrorPlane, eps = 1e-4): boolean {
  const m = mirrorRotation(b.rotation, pl);
  const same = Math.abs(m[0] * b.rotation[0] + m[1] * b.rotation[1] + m[2] * b.rotation[2] + m[3] * b.rotation[3]);
  return Math.abs(b.position[pl.axis] - pl.offset) < eps && same > 1 - eps;
}

/**
 * The body in `all` that is the mirror image of `b` (same shape and size, mirrored pose), or undefined.
 * Used to attach a mirrored joint to bodies that were mirrored earlier.
 */
export function findMirrorPartner(
  b: BodyEntity,
  all: readonly BodyEntity[],
  pl: MirrorPlane,
  eps = 1e-3,
): BodyEntity | undefined {
  const want = mirrorPose(b, pl);
  const key = JSON.stringify(b.shape);
  return all.find((o) => {
    if (o.id === b.id || JSON.stringify(o.shape) !== key) return false;
    const dq = Math.abs(
      o.rotation[0] * want.rotation[0] +
        o.rotation[1] * want.rotation[1] +
        o.rotation[2] * want.rotation[2] +
        o.rotation[3] * want.rotation[3],
    );
    const dp = Math.hypot(
      o.position[0] - want.position[0],
      o.position[1] - want.position[1],
      o.position[2] - want.position[2],
    );
    return dp < eps && dq > 1 - eps;
  });
}

/** How one end of the joint maps onto the mirrored joint. */
export type MirrorEnd =
  /** The end is attached to the world: its anchor is in world coordinates. */
  | { kind: 'world' }
  /** The end's body was mirrored: the new joint attaches to the mirrored copy (same local anchor, reflected). */
  | { kind: 'copy'; body: string }
  /** The end's body stays (it lies on the plane, or the mirrored joint hangs off the same body). */
  | { kind: 'keep'; body: string; pose: Pose };

interface Mapper {
  point: (v: Vec3) => Vec3;
  dir: (v: Vec3) => Vec3;
  pseudo: (v: Vec3) => Vec3;
}

function mapperFor(end: MirrorEnd, pl: MirrorPlane): Mapper {
  switch (end.kind) {
    case 'world':
      return {
        point: (v) => mirrorPoint(v, pl),
        dir: (v) => mirrorDir(v, pl),
        pseudo: (v) => mirrorPseudo(v, pl),
      };
    case 'copy':
      // local frames of mirror twins are reflections of each other along the plane's axis
      return {
        point: (v) => mirrorDir(v, pl),
        dir: (v) => mirrorDir(v, pl),
        pseudo: (v) => mirrorPseudo(v, pl),
      };
    case 'keep': {
      const { position: p, rotation: q } = end.pose;
      return {
        point: (v) => qrotInv(q, vsub(mirrorPoint(vadd(p, qrot(q, v)), pl), p)),
        dir: (v) => qrotInv(q, mirrorDir(qrot(q, v), pl)),
        pseudo: (v) => qrotInv(q, mirrorPseudo(qrot(q, v), pl)),
      };
    }
  }
}

const endBody = (e: MirrorEnd): string | null => (e.kind === 'world' ? null : e.body);

const flipDof = (d: DofSpec): DofSpec => ({ ...d, min: -d.max, max: -d.min, motorVelocity: -d.motorVelocity });

/**
 * The mirror image of joint `j` with its ends mapped as `a` / `b` say. Everything not geometric is kept (limits,
 * motor, springs, break fields of other packages …), because the result spreads `...j`; the caller gives it a new id
 * and a name.
 */
export function mirrorJoint(j: JointEntity, pl: MirrorPlane, a: MirrorEnd, b: MirrorEnd): JointEntity {
  const mA = mapperFor(a, pl);
  const mB = mapperFor(b, pl);
  const p = j.params;
  const out: JointEntity = {
    ...j,
    bodyA: endBody(a),
    bodyB: endBody(b),
    anchorA: mA.point(j.anchorA),
    // For types without an independent end B the anchor is unused, but keep it consistent.
    anchorB: mB.point(j.anchorB),
    axis: mA.pseudo(j.axis),
    limit: { ...j.limit },
    motor: { ...j.motor },
    spring: { ...j.spring },
    components: j.components.map((c) => ({ ...c })),
    params: {
      ...p,
      dof: p.dof.map((d) => ({ ...d })),
      axisB: mB.pseudo(p.axisB),
      pulleyA: mirrorPoint(p.pulleyA, pl),
      pulleyB: mirrorPoint(p.pulleyB, pl),
    },
  };
  switch (j.type) {
    case 'slider':
      // a translation axis is a polar vector: a mirrored slider keeps travel and limits as they are
      out.axis = mA.dir(j.axis);
      break;
    case 'rack':
      // the pinion shaft is a pseudo vector (already done); the rack's travel direction is polar
      out.params.axisB = mB.dir(p.axisB);
      break;
    case 'screw':
      // a mirrored right-hand screw is a left-hand screw
      out.params.pitch = -p.pitch;
      break;
    case 'sixdof': {
      // The frame is spanned along the axis: linear X keeps its sign, angular X is a rotation (its sign flips).
      // Y / Z are perpendicular directions the engine picks, so asymmetric Y / Z settings are only approximate.
      out.axis = mA.dir(j.axis);
      out.params.dof[3] = flipDof(out.params.dof[3]);
      break;
    }
    default:
      break;
  }
  return out;
}
