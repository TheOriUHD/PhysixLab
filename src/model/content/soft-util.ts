/**
 * Shared helpers of the soft-body example scenes (`soft-*.ts`). Not a scene itself: it registers nothing.
 */
import { qrotInv, vsub, type Vec3 } from '../../core/math';
import { uid } from '../factory';
import { noKeys } from '../builder';
import type { BodyEntity, MotorSpec, SoftAttachment, SoftEntity } from '../types';

/**
 * Fasten the particles of `soft` that lie within `radius` of the world point `point` to `body`. The stored recipe is
 * the same one the attach tool writes: the centre in the soft body's rest frame, the body-local offset of that centre.
 */
export function fasten(
  soft: SoftEntity,
  body: BodyEntity,
  point: Vec3,
  radius: number,
  joint?: string,
): SoftAttachment {
  const att: SoftAttachment = {
    id: uid('sa'),
    body: body.id,
    kind: 'region',
    center: qrotInv(soft.rotation, vsub(point, soft.position)),
    radius,
    offset: qrotInv(body.rotation, vsub(point, body.position)),
    ...(joint ? { joint } : {}),
  };
  soft.attachments.push(att);
  return att;
}

/** Density that gives a box of `size` the mass `kg`. */
export const boxDensity = (size: Vec3, kg: number): number => kg / (size[0] * size[1] * size[2]);

/** A motor that always runs: holds `speed` (rad/s on a hinge, m/s on a slider) with at most `maxForce`. */
export const velocityMotor = (speed: number, damping: number, maxForce: number): MotorSpec => ({
  mode: 'velocity',
  targetVelocity: speed,
  targetPosition: 0,
  stiffness: 0,
  damping,
  maxForce,
  ...noKeys,
  slewRate: 1,
  brake: false,
});
