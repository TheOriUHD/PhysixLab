/**
 * Stepper motor — turns a hinge in discrete steps. Each step key press (or each pulse of a pulse train) moves the
 * commanded position by one step angle; the rotor is pulled toward it with a torque-angle characteristic, so it
 * holds against loads up to the holding torque, rings and settles after a step, and *loses steps* when overloaded.
 * Runtime: `src/physics/components/stepper.ts`.
 */
import type { ComponentDef } from '../componentRegistry';
import { axisField, keyField, needsJoint } from './powerHelpers';

export const stepper: ComponentDef = {
  type: 'stepper',
  label: 'Stepper motor',
  icon: 'stepper',
  category: 'Actuators',
  blurb:
    'Turns a hinge in discrete steps from a key, a pulse train or an axis; holds up to its holding torque, loses steps when overloaded.',
  appliesTo: 'joint',
  unique: true,
  fields: [
    {
      kind: 'number',
      key: 'stepAngle',
      label: 'Step angle',
      default: 1.8,
      min: 0.01,
      max: 90,
      step: 0.1,
      unit: '°',
      hint: '1.8° = 200 full steps per turn',
    },
    {
      kind: 'number',
      key: 'holdTorque',
      label: 'Holding torque',
      default: 2,
      min: 0.001,
      max: 10000,
      step: 0.1,
      unit: 'N·m',
      hint: 'Largest steady load the stopped motor can hold',
    },
    {
      kind: 'number',
      key: 'damping',
      label: 'Damping ratio',
      default: 0.35,
      min: 0.05,
      max: 3,
      step: 0.05,
      hint: 'How quickly the rotor settles after a step (1 = no overshoot)',
    },
    {
      kind: 'number',
      key: 'falloffRate',
      label: 'Torque falls off at',
      default: 600,
      min: 1,
      max: 100000,
      step: 50,
      unit: 'steps/s',
      hint: 'Pulse rate where the torque has fallen to half; faster pulsing loses steps under load',
    },
    keyField('stepKey', 'Step + key', '', 'One step forward per press; hold to repeat'),
    keyField('stepKeyReverse', 'Step − key', '', 'One step back per press; hold to repeat'),
    {
      kind: 'number',
      key: 'repeatRate',
      label: 'Repeat rate',
      default: 8,
      min: 0,
      max: 5000,
      step: 1,
      unit: 'steps/s',
      hint: 'While a step key is held (after a short delay); 0 = one step per press',
    },
    axisField('axis', 'Pulse axis', 'Analog axis −1 … 1: a pulse train of axis × maximum rate'),
    {
      kind: 'number',
      key: 'maxRate',
      label: 'Max pulse rate',
      default: 400,
      min: 1,
      max: 20000,
      step: 10,
      unit: 'steps/s',
      hint: 'Pulse rate at full axis deflection',
    },
    {
      kind: 'number',
      key: 'pulseRate',
      label: 'Constant pulses',
      default: 0,
      min: -20000,
      max: 20000,
      step: 5,
      unit: 'steps/s',
      hint: 'A steady pulse train (negative = backwards); 0 = off',
    },
  ],
  state: [
    { label: 'Steps', digits: 0 },
    { label: 'Commanded', unit: '°', digits: 1 },
    { label: 'Angle', unit: '°', digits: 1 },
    { label: 'Lag', unit: 'steps', digits: 2 },
    { label: 'Torque', unit: 'N·m', digits: 2 },
  ],
  check: (owner) => needsJoint(owner, ['hinge'], 'A stepper'),
};
