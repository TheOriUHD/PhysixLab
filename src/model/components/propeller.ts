/**
 * Propeller — thrust and load torque that grow with the square of the rotation speed, thrust that fades as the
 * airspeed approaches the blade pitch speed (the advance ratio). It turns with a hinge (driven by an engine or motor),
 * with a named shaft of the drive train, or by itself at a throttle-set speed. Runtime:
 * `src/physics/components/propeller.ts`.
 */
import type { ComponentDef } from '../componentRegistry';
import { axisField, keyField, shaftField } from './powerHelpers';

export const propeller: ComponentDef = {
  type: 'propeller',
  label: 'Propeller',
  icon: 'propeller',
  category: 'Thrusters & rotors',
  blurb:
    'Thrust and torque ∝ rpm², fading with airspeed. On a hinge or a shaft it is driven by an engine; alone it spins at the throttle.',
  appliesTo: 'any',
  fields: [
    shaftField(
      'shaft',
      'Drive shaft',
      '',
      'On a body: the drive-train shaft that turns the propeller (engine → gearbox → propeller). Empty = it drives itself at the throttle speed. On a hinge: ignored, the hinge turns it.',
    ),
    { kind: 'number', key: 'diameter', label: 'Diameter', default: 1, min: 0.02, max: 50, step: 0.05, unit: 'm' },
    {
      kind: 'number',
      key: 'thrustCoeff',
      label: 'Thrust coefficient',
      default: 0.1,
      min: 0,
      max: 2,
      step: 0.005,
      hint: 'C_T: static thrust = C_T·ρ·n²·D⁴ (n in rev/s)',
    },
    {
      kind: 'number',
      key: 'torqueCoeff',
      label: 'Torque coefficient',
      default: 0.012,
      min: 0,
      max: 1,
      step: 0.001,
      hint: 'C_Q: load torque = C_Q·ρ·n²·D⁵',
    },
    {
      kind: 'number',
      key: 'advance',
      label: 'Zero-thrust advance',
      default: 1.1,
      min: 0.1,
      max: 5,
      step: 0.05,
      hint: 'Advance ratio J = V / (n·D) at which the thrust has faded to nothing',
    },
    {
      kind: 'number',
      key: 'density',
      label: 'Fluid density',
      default: 1.225,
      min: 0.01,
      max: 20000,
      step: 0.1,
      unit: 'kg/m³',
      hint: '1.225 = air, 1000 = water',
    },
    {
      kind: 'vec3',
      key: 'direction',
      label: 'Thrust direction',
      default: [0, 0, 1],
      step: 0.1,
      hint: 'In the body frame (a body-mounted propeller). On a hinge the thrust is along the hinge axis.',
    },
    {
      kind: 'vec3',
      key: 'position',
      label: 'Hub position',
      default: [0, 0, 0],
      step: 0.05,
      unit: 'm',
      hint: 'In the body frame (a body-mounted propeller)',
    },
    {
      kind: 'bool',
      key: 'reverse',
      label: 'Reverse thrust',
      default: false,
      hint: 'Flip the thrust direction (a pusher turned into a tractor)',
    },
    {
      kind: 'number',
      key: 'maxRpm',
      label: 'Self-driven speed',
      default: 3000,
      min: 1,
      max: 60000,
      step: 100,
      unit: 'rpm',
      hint: 'Full-throttle speed when nothing drives it',
    },
    keyField('key', 'Throttle key', '', 'Self-driven: held = full speed'),
    axisField('axis', 'Throttle axis', 'Self-driven: analog axis 0 … 1'),
    {
      kind: 'number',
      key: 'throttle',
      label: 'Throttle',
      default: 1,
      min: 0,
      max: 1,
      step: 0.05,
      hint: 'Self-driven, with no key or axis',
    },
    {
      kind: 'number',
      key: 'spool',
      label: 'Spool time',
      default: 0.6,
      min: 0,
      max: 20,
      step: 0.1,
      unit: 's',
      hint: 'Self-driven: time constant of the speed',
    },
    {
      kind: 'bool',
      key: 'reaction',
      label: 'Torque reaction',
      default: true,
      hint: 'Self-driven: the body feels the opposite torque (a lone rotor turns it the other way)',
    },
    {
      kind: 'bool',
      key: 'blur',
      label: 'Show blades',
      default: true,
      hint: 'A spinning disc in the viewport, fading into a blur as the speed rises',
    },
    { kind: 'color', key: 'bladeColor', label: 'Blade colour', default: '#d6e4f2', showIf: (p) => p.blur === true },
  ],
  state: [
    { label: 'Speed', unit: 'rpm', digits: 0 },
    { label: 'Thrust', unit: 'N', digits: 1 },
    { label: 'Load torque', unit: 'N·m', digits: 2 },
    { label: 'Advance ratio', digits: 2 },
    { label: 'Power', unit: 'kW', digits: 2 },
  ],
  check: (owner, p) => {
    if (owner.kind === 'joint') return owner.type !== 'hinge' ? 'A propeller on a joint needs a hinge.' : null;
    if (owner.bodyType !== 'dynamic') return 'Thrust only moves dynamic bodies. Set the body type to Dynamic.';
    const d = p.direction as number[];
    return Math.hypot(d[0], d[1], d[2]) < 1e-6 ? 'The thrust direction is zero.' : null;
  },
};
