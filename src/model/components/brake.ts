/**
 * Brake — friction that stops a shaft: a disc brake on a hinge (the wheel), or on a named shaft of the drive train.
 * Pedal by key or analog axis, plus a latching parking brake. The torque is a friction limit, not a damper: it stops
 * a shaft exactly and holds it still (up to the brake's torque) instead of letting it creep.
 * Runtime: `src/physics/components/brake.ts`.
 */
import type { ComponentDef } from '../componentRegistry';
import { axisField, jointMotorWarning, keyField, shaftField } from './powerHelpers';

export const brake: ComponentDef = {
  type: 'brake',
  label: 'Brake',
  icon: 'brake',
  category: 'Drivetrain',
  blurb: 'Disc brake with pedal by key or axis and a latching parking brake. On a hinge it brakes the wheel.',
  appliesTo: 'any',
  fields: [
    shaftField(
      'shaft',
      'Shaft',
      'driveshaft',
      'On a body: the drive-train shaft to brake. On a hinge or slider this is ignored: the joint itself is braked.',
    ),
    {
      kind: 'number',
      key: 'torque',
      label: 'Brake torque',
      default: 800,
      min: 0,
      max: 1000000,
      step: 10,
      unit: 'N·m',
      hint: 'Largest friction torque (force on a slider)',
    },
    keyField('key', 'Brake key', 'KeyB', 'Held = full braking'),
    axisField('axis', 'Brake axis', 'Analog axis 0 … 1: how hard the pedal is pressed'),
    { kind: 'number', key: 'response', label: 'Pedal response', default: 0.03, min: 0, max: 2, step: 0.01, unit: 's' },
    keyField('parkKey', 'Parking brake key', '', 'Each press latches or releases the parking brake'),
    {
      kind: 'number',
      key: 'parkTorque',
      label: 'Parking torque',
      default: 600,
      min: 0,
      max: 1000000,
      step: 10,
      unit: 'N·m',
    },
    {
      kind: 'bool',
      key: 'parked',
      label: 'Parking brake on',
      default: false,
      hint: 'Start with the parking brake applied',
    },
  ],
  state: [
    { label: 'Torque', unit: 'N·m', digits: 0 },
    { label: 'Pedal', unit: '%', digits: 0 },
    { label: 'Parked', digits: 0 },
    { label: 'Speed', unit: 'rad/s', digits: 2 },
  ],
  check: (owner) =>
    owner.kind === 'joint' && owner.type !== 'hinge' && owner.type !== 'slider'
      ? 'A brake on a joint needs a hinge or a slider.'
      : jointMotorWarning(owner),
};
