/**
 * Servo — holds a hinge at a target angle with PID position control, a speed cap and a torque limit. The target
 * comes from the field, from jog keys, or from an analog axis mapped onto the travel range. Runtime:
 * `src/physics/components/servo.ts`.
 */
import type { ComponentDef } from '../componentRegistry';
import { axisField, keyField, needsJoint } from './powerHelpers';

export const servo: ComponentDef = {
  type: 'servo',
  label: 'Servo',
  icon: 'servo',
  category: 'Actuators',
  blurb: 'Holds a hinge at a target angle: PID position control, speed cap, torque limit; jog keys or an analog axis.',
  appliesTo: 'joint',
  unique: true,
  fields: [
    {
      kind: 'number',
      key: 'target',
      label: 'Target angle',
      default: 0,
      min: -3600,
      max: 3600,
      step: 1,
      unit: '°',
      hint: 'Relative to the angle the hinge has when the simulation starts',
    },
    { kind: 'number', key: 'minAngle', label: 'Travel min', default: -90, min: -3600, max: 3600, step: 5, unit: '°' },
    { kind: 'number', key: 'maxAngle', label: 'Travel max', default: 90, min: -3600, max: 3600, step: 5, unit: '°' },
    {
      kind: 'number',
      key: 'kp',
      label: 'Kp',
      default: 8,
      min: 0.1,
      max: 100,
      step: 0.5,
      unit: '1/s',
      hint: 'Proportional gain: speed commanded per radian of error',
    },
    {
      kind: 'number',
      key: 'ki',
      label: 'Ki',
      default: 0,
      min: 0,
      max: 100,
      step: 0.1,
      unit: '1/s²',
      hint: 'Integral gain: removes a steady error under constant load',
    },
    {
      kind: 'number',
      key: 'kd',
      label: 'Kd',
      default: 0,
      min: 0,
      max: 10,
      step: 0.05,
      unit: 's',
      hint: 'Derivative (on the measured speed): damps the approach',
    },
    { kind: 'number', key: 'maxSpeed', label: 'Max speed', default: 180, min: 1, max: 5000, step: 10, unit: '°/s' },
    {
      kind: 'number',
      key: 'maxTorque',
      label: 'Max torque',
      default: 50,
      min: 0.01,
      max: 100000,
      step: 1,
      unit: 'N·m',
      hint: 'Beyond this load the servo can no longer follow',
    },
    keyField('keyPlus', 'Jog + key', '', 'Held: the target moves toward the travel max'),
    keyField('keyMinus', 'Jog − key', '', 'Held: the target moves toward the travel min'),
    { kind: 'number', key: 'jogRate', label: 'Jog rate', default: 60, min: 0, max: 2000, step: 5, unit: '°/s' },
    axisField(
      'axis',
      'Target axis',
      'Analog axis −1 … 1 mapped onto the travel range (replaces the target and the jog keys)',
    ),
  ],
  state: [
    { label: 'Angle', unit: '°', digits: 1 },
    { label: 'Target', unit: '°', digits: 1 },
    { label: 'Speed', unit: '°/s', digits: 1 },
    { label: 'Torque', unit: 'N·m', digits: 1 },
  ],
  sanitise(p) {
    const lo = p.minAngle as number;
    const hi = p.maxAngle as number;
    return lo <= hi ? p : { ...p, minAngle: hi, maxAngle: lo };
  },
  check: (owner) => needsJoint(owner, ['hinge'], 'A servo'),
};
