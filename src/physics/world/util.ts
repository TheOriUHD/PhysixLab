/** Small shared helpers and constants for the world modules. */
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Quat, Vec3 } from '../../core/math';

export const ZERO: Vec3 = [0, 0, 0];
export const QI: Quat = [0, 0, 0, 1];
export const X_AXIS: Vec3 = [1, 0, 0];

/** Our tuples → the plain objects Rapier expects. */
export const rv = (v: Vec3) => ({ x: v[0], y: v[1], z: v[2] });
export const rq = (q: Quat) => ({ x: q[0], y: q[1], z: q[2], w: q[3] });

export function pos(rb: RAPIER.RigidBody): Vec3 {
  const t = rb.translation();
  return [t.x, t.y, t.z];
}

export function rot(rb: RAPIER.RigidBody): Quat {
  const q = rb.rotation();
  return [q.x, q.y, q.z, q.w];
}
