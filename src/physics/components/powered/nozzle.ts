/** Thrust geometry shared by the force-producing parts: a direction and a point in the body frame, in the world. */
import { qrot, vadd, vnorm, type Vec3 } from '../../../core/math';
import type { BodyHandle, ComponentContext } from '../context';

export interface Nozzle {
  /** Unit thrust direction, world frame. */
  dir: Vec3;
  /** Where the force acts, world frame. */
  at: Vec3;
}

export function nozzleOf(
  ctx: ComponentContext,
  body: BodyHandle,
  dirField = 'direction',
  posField = 'position',
): Nozzle {
  const q = body.rotation();
  return {
    dir: qrot(q, vnorm(ctx.vec3(dirField), [0, 1, 0])),
    at: vadd(body.position(), qrot(q, ctx.vec3(posField))),
  };
}
