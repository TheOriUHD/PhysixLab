/**
 * Field and warning helpers shared by the definitions of the powered parts (engines, motors, actuators, brakes,
 * thrusters …): the same key / axis fields and the same "this joint has its own motor" warning everywhere.
 */
import type { BodyEntity, JointEntity } from '../types';
import type { FieldDef } from '../componentRegistry';

/** A key field (`KeyboardEvent.code`). */
export const keyField = (key: string, label: string, def = '', hint?: string): FieldDef => ({
  kind: 'key',
  key,
  label,
  default: def,
  ...(hint ? { hint } : {}),
});

/** A text field naming an analog input axis (−1 … 1, supplied by the Controls panel, a gamepad or a script). */
export const axisField = (
  key: string,
  label: string,
  hint = 'Name of an analog input axis (−1 … 1); empty = none',
): FieldDef => ({
  kind: 'text',
  key,
  label,
  default: '',
  maxLength: 40,
  placeholder: 'axis name',
  role: 'axis',
  hint,
});

/** A text field naming a drive-train shaft. */
export const shaftField = (key: string, label: string, def: string, hint: string): FieldDef => ({
  kind: 'text',
  key,
  label,
  default: def,
  maxLength: 40,
  placeholder: 'shaft name',
  role: 'shaft',
  hint,
});

/** Warning when the owner's built-in joint motor is on (it would fight the component). */
export function jointMotorWarning(owner: BodyEntity | JointEntity): string | null {
  return owner.kind === 'joint' && owner.motor.mode !== 'off'
    ? 'This joint’s own motor is on and would fight the component. Set the joint’s motor mode to Off.'
    : null;
}

/** Warning unless the owner is a joint of one of the given types. */
export function needsJoint(
  owner: BodyEntity | JointEntity,
  types: readonly JointEntity['type'][],
  what: string,
): string | null {
  if (owner.kind !== 'joint') return `${what} sits on a joint. Select the joint and add it there.`;
  return types.includes(owner.type) ? jointMotorWarning(owner) : `${what} needs a ${types.join(' or ')} joint.`;
}
