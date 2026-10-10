/**
 * Engine — a combustion engine with an editable torque curve, idle governor, rev limiter, flywheel inertia and
 * throttle by key or analog axis. On a body it spins a named shaft that a clutch / gearbox / differential continue
 * (runtime: `src/physics/components/engine.ts`); on a hinge it drives that hinge directly.
 */
import type { ComponentDef } from '../componentRegistry';
import { axisField, jointMotorWarning, keyField, shaftField } from './powerHelpers';

export const engine: ComponentDef = {
  type: 'engine',
  label: 'Engine',
  icon: 'engine',
  category: 'Engines & motors',
  blurb:
    'Combustion engine: torque curve, idle, rev limiter, throttle by key or axis. Drives a hinge or a drive train.',
  appliesTo: 'any',
  fields: [
    shaftField(
      'out',
      'Output shaft',
      'crank',
      'On a body: the shaft the engine turns. Clutch, gearbox and differential connect to it by name. On a hinge this is ignored: the engine drives that hinge.',
    ),
    {
      kind: 'curve',
      key: 'curve',
      label: 'Torque curve',
      default: [
        [0, 0],
        [1000, 110],
        [2000, 170],
        [3000, 200],
        [4000, 215],
        [5000, 205],
        [6000, 170],
        [6800, 90],
        [7200, 0],
      ],
      xRange: [0, 12000],
      yRange: [-200, 2500],
      xLabel: 'rpm',
      yLabel: 'N·m',
      hint: 'Torque at full throttle against engine speed. Drag the points; double-click adds or removes one.',
    },
    {
      kind: 'number',
      key: 'idle',
      label: 'Idle speed',
      default: 900,
      min: 0,
      max: 6000,
      step: 50,
      unit: 'rpm',
      hint: 'The idle governor opens the throttle to keep the engine from stalling',
    },
    {
      kind: 'number',
      key: 'revLimit',
      label: 'Rev limit',
      default: 6800,
      min: 500,
      max: 12000,
      step: 100,
      unit: 'rpm',
      hint: 'Fuel is cut over this speed',
    },
    {
      kind: 'number',
      key: 'inertia',
      label: 'Flywheel inertia',
      default: 0.25,
      min: 0.005,
      max: 100,
      step: 0.01,
      unit: 'kg·m²',
      hint: 'Rotating mass of the crank and flywheel: how quickly the engine revs up and down',
    },
    {
      kind: 'number',
      key: 'braking',
      label: 'Engine braking',
      default: 60,
      min: 0,
      max: 1000,
      step: 5,
      unit: 'N·m',
      hint: 'Drag at the rev limit with the throttle closed (scales with speed)',
    },
    {
      kind: 'number',
      key: 'throttle',
      label: 'Throttle',
      default: 1,
      min: 0,
      max: 1,
      step: 0.05,
      hint: 'Used when no throttle key or axis is set',
    },
    keyField('key', 'Throttle key', '', 'Held = full throttle'),
    axisField(
      'axis',
      'Throttle axis',
      'Name of an analog axis whose value 0 … 1 is the throttle (negative values count as 0)',
    ),
    {
      kind: 'number',
      key: 'response',
      label: 'Throttle response',
      default: 0.08,
      min: 0,
      max: 2,
      step: 0.01,
      unit: 's',
      hint: 'Time constant of the throttle opening',
    },
    {
      kind: 'number',
      key: 'ratio',
      label: 'Reduction (on a hinge)',
      default: 1,
      min: 0.05,
      max: 50,
      step: 0.05,
      hint: 'On a hinge: crank turns per turn of the hinge',
    },
    {
      kind: 'bool',
      key: 'invert',
      label: 'Reverse direction',
      default: false,
      hint: 'On a hinge: drive it the other way round',
    },
  ],
  state: [
    { label: 'Speed', unit: 'rpm', digits: 0 },
    { label: 'Torque', unit: 'N·m', digits: 1 },
    { label: 'Throttle', unit: '%', digits: 0 },
    { label: 'Power', unit: 'kW', digits: 1 },
  ],
  sanitise(p) {
    // the limiter must be above idle, or the governor and the limiter would fight
    const idle = p.idle as number;
    const rev = p.revLimit as number;
    return rev > idle + 100 ? p : { ...p, revLimit: Math.min(12000, idle + 100) };
  },
  check: (owner) =>
    owner.kind === 'joint' && owner.type !== 'hinge'
      ? 'An engine on a joint needs a hinge. Put it on a body to drive a drive train instead.'
      : jointMotorWarning(owner),
};
