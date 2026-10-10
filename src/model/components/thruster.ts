/**
 * Thruster / rocket — pushes the body along a direction from a nozzle point. With a fuel mass it is a rocket: the
 * fuel is part of the body's mass, burns at a rate set by the burn time, and the body gets lighter as it goes (the
 * rocket equation emerges from F = ṁ·v_e). Liquid engines are throttleable by key or analog axis; solid motors burn
 * out once lit. Runtime: `src/physics/components/thruster.ts`.
 */
import type { ComponentDef } from '../componentRegistry';
import { axisField, keyField } from './powerHelpers';

export const thruster: ComponentDef = {
  type: 'thruster',
  label: 'Thruster / rocket',
  icon: 'rocket',
  category: 'Thrusters & rotors',
  blurb:
    'Rocket motor or thruster: thrust, burn time and fuel mass that burns off and lightens the body; visible flame.',
  appliesTo: 'body',
  fields: [
    {
      kind: 'number',
      key: 'thrust',
      label: 'Thrust',
      default: 200,
      min: 0,
      max: 100000000,
      step: 10,
      unit: 'N',
      hint: 'At full throttle',
    },
    {
      kind: 'number',
      key: 'fuelMass',
      label: 'Fuel mass',
      default: 2,
      min: 0,
      max: 1000000,
      step: 0.5,
      unit: 'kg',
      hint: 'Added to the body’s own mass and burned off. 0 = unlimited fuel (a plain thruster, no mass change).',
    },
    {
      kind: 'number',
      key: 'burnTime',
      label: 'Burn time',
      default: 8,
      min: 0.05,
      max: 3600,
      step: 0.5,
      unit: 's',
      hint: 'How long the fuel lasts at full throttle: mass flow = fuel ÷ burn time, exhaust speed = thrust ÷ mass flow',
    },
    {
      kind: 'enum',
      key: 'mode',
      label: 'Motor type',
      default: 'liquid',
      options: [
        { value: 'liquid', label: 'Liquid (throttleable)' },
        { value: 'solid', label: 'Solid (burns until empty)' },
      ],
      hint: 'A solid motor cannot be throttled or shut down once lit',
    },
    keyField('key', 'Fire key', '', 'Liquid: held = full throttle. Solid: a press ignites.'),
    axisField('axis', 'Throttle axis', 'Analog axis 0 … 1: the throttle (a solid motor ignites above 0.5)'),
    {
      kind: 'number',
      key: 'throttle',
      label: 'Throttle',
      default: 1,
      min: 0,
      max: 1,
      step: 0.05,
      hint: 'Used when no key or axis is set: the motor fires from the start',
    },
    {
      kind: 'number',
      key: 'ramp',
      label: 'Spool time',
      default: 0.1,
      min: 0,
      max: 10,
      step: 0.05,
      unit: 's',
      hint: 'Time constant of the thrust rising and falling',
    },
    {
      kind: 'vec3',
      key: 'direction',
      label: 'Thrust direction',
      default: [0, 1, 0],
      step: 0.1,
      hint: 'In the body frame: the way the body is pushed (the exhaust goes the other way)',
    },
    {
      kind: 'vec3',
      key: 'position',
      label: 'Nozzle position',
      default: [0, -0.5, 0],
      step: 0.05,
      unit: 'm',
      hint: 'In the body frame: where the force acts. Off the centre of mass it also turns the body.',
    },
    { kind: 'bool', key: 'flame', label: 'Show flame', default: true },
    { kind: 'color', key: 'flameColor', label: 'Flame colour', default: '#ffa94d', showIf: (p) => p.flame === true },
    {
      kind: 'number',
      key: 'flameLength',
      label: 'Flame length',
      default: 0.8,
      min: 0.05,
      max: 20,
      step: 0.05,
      unit: 'm',
      hint: 'At full thrust',
      showIf: (p) => p.flame === true,
    },
  ],
  state: [
    { label: 'Thrust', unit: 'N', digits: 0 },
    { label: 'Throttle', unit: '%', digits: 0 },
    { label: 'Fuel', unit: 'kg', digits: 2 },
    { label: 'Body mass', unit: 'kg', digits: 2 },
    { label: 'Exhaust speed', unit: 'm/s', digits: 0 },
  ],
  check: (owner, p) => {
    if (owner.kind !== 'body') return null;
    if (owner.bodyType !== 'dynamic') return 'Thrust only moves dynamic bodies. Set the body type to Dynamic.';
    const d = p.direction as number[];
    return Math.hypot(d[0], d[1], d[2]) < 1e-6 ? 'The thrust direction is zero.' : null;
  },
};
