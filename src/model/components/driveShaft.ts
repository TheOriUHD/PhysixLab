/**
 * Drive shaft — ties a hinge to a named shaft of the drive train, so engines, gearboxes and differentials can turn it:
 * put one on each driven wheel hinge. Runtime: `src/physics/components/driveShaft.ts`.
 */
import type { ComponentDef } from '../componentRegistry';
import { jointMotorWarning, shaftField } from './powerHelpers';

export const driveShaft: ComponentDef = {
  type: 'driveShaft',
  label: 'Drive shaft',
  icon: 'driveShaft',
  category: 'Drivetrain',
  blurb:
    'Connects this hinge (a wheel, an axle) to a named drive-train shaft: the end of the line for a differential output.',
  appliesTo: 'joint',
  fields: [
    shaftField(
      'shaft',
      'Shaft',
      'left',
      'The drive-train shaft to connect to, e.g. a differential’s left or right output',
    ),
    {
      kind: 'bool',
      key: 'invert',
      label: 'Reverse direction',
      default: false,
      hint: 'Use when this wheel’s hinge axis points the opposite way to its neighbour’s',
    },
    {
      kind: 'number',
      key: 'ratio',
      label: 'Ratio',
      default: 1,
      min: 0.05,
      max: 100,
      step: 0.05,
      hint: 'Shaft turns per turn of the hinge (a hub reduction)',
    },
    {
      kind: 'number',
      key: 'inertia',
      label: 'Inertia',
      default: 0.02,
      min: 0.0001,
      max: 100,
      step: 0.005,
      unit: 'kg·m²',
      hint: 'Rotating mass of the shaft itself',
    },
  ],
  state: [
    { label: 'Speed', unit: 'rpm', digits: 0 },
    { label: 'Torque', unit: 'N·m', digits: 0 },
  ],
  check: (owner) =>
    owner.kind === 'joint' && owner.type !== 'hinge' ? 'A drive shaft needs a hinge.' : jointMotorWarning(owner),
};
