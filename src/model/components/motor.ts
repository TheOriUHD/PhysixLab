/**
 * Electric motor — a DC motor with back-EMF droop (torque falls linearly from the stall torque to zero at the no-load
 * speed), a supply limit (current → maximum torque, optional power limit) and a drive command from keys or an
 * analog axis. On a hinge it drives the hinge; on a body it turns a named shaft. Runtime:
 * `src/physics/components/motor.ts`.
 */
import type { ComponentDef } from '../componentRegistry';
import { axisField, jointMotorWarning, keyField, shaftField } from './powerHelpers';

export const motor: ComponentDef = {
  type: 'motor',
  label: 'Electric motor',
  icon: 'motor',
  category: 'Engines & motors',
  blurb: 'DC motor: stall torque, no-load speed, supply limit. Drives a hinge or a drive train by key or analog axis.',
  appliesTo: 'any',
  fields: [
    shaftField(
      'out',
      'Output shaft',
      'crank',
      'On a body: the shaft the motor turns (a gearbox / differential continues it). On a hinge this is ignored.',
    ),
    {
      kind: 'number',
      key: 'stallTorque',
      label: 'Stall torque',
      default: 8,
      min: 0.001,
      max: 100000,
      step: 0.5,
      unit: 'N·m',
      hint: 'Torque at zero speed and full drive. Falls linearly to zero at the no-load speed (back-EMF).',
    },
    {
      kind: 'number',
      key: 'noLoadRpm',
      label: 'No-load speed',
      default: 3000,
      min: 1,
      max: 60000,
      step: 100,
      unit: 'rpm',
      hint: 'Speed at full drive with nothing to turn',
    },
    {
      kind: 'number',
      key: 'currentLimit',
      label: 'Supply limit',
      default: 6,
      min: 0.001,
      max: 100000,
      step: 0.5,
      unit: 'N·m',
      hint: 'Torque cap set by the supply current (torque ∝ current)',
    },
    {
      kind: 'number',
      key: 'powerLimit',
      label: 'Power limit',
      default: 0,
      min: 0,
      max: 10000000,
      step: 50,
      unit: 'W',
      hint: 'Electrical power cap; 0 = none',
    },
    {
      kind: 'number',
      key: 'duty',
      label: 'Drive',
      default: 1,
      min: -1,
      max: 1,
      step: 0.05,
      hint: 'Fixed drive (−1 … 1) used when no key or axis is set',
    },
    keyField('key', 'Forward key', '', 'Held = full drive forward'),
    keyField('keyReverse', 'Reverse key', '', 'Held = full drive backward'),
    axisField('axis', 'Drive axis', 'Analog axis −1 … 1 added to the keys'),
    {
      kind: 'enum',
      key: 'idle',
      label: 'With no drive',
      default: 'brake',
      options: [
        { value: 'brake', label: 'Brake (windings shorted)' },
        { value: 'coast', label: 'Coast (free-wheel)' },
      ],
      hint: 'A shorted DC motor resists being turned; an open one spins freely',
    },
    {
      kind: 'number',
      key: 'inertia',
      label: 'Rotor inertia',
      default: 0.002,
      min: 0.00001,
      max: 100,
      step: 0.001,
      unit: 'kg·m²',
    },
    {
      kind: 'number',
      key: 'ratio',
      label: 'Gear reduction',
      default: 1,
      min: 0.05,
      max: 1000,
      step: 0.5,
      hint: 'On a hinge: motor turns per turn of the hinge (a gear head)',
    },
    { kind: 'bool', key: 'invert', label: 'Reverse direction', default: false },
  ],
  state: [
    { label: 'Speed', unit: 'rpm', digits: 0 },
    { label: 'Torque', unit: 'N·m', digits: 2 },
    { label: 'Drive', unit: '%', digits: 0 },
    { label: 'Power', unit: 'W', digits: 0 },
  ],
  check: (owner) =>
    owner.kind === 'joint' && owner.type !== 'hinge'
      ? 'A motor on a joint needs a hinge. Use a linear actuator on a slider.'
      : jointMotorWarning(owner),
};
