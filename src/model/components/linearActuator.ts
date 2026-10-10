/**
 * Linear actuator — drives a slider to a target extension with a speed cap and a force limit: an electric screw
 * actuator, a rack, a piston on a rail. Position control as for the servo (cascade loop), with hard end stops at the
 * travel limits. Runtime: `src/physics/components/linearActuator.ts`.
 */
import type { ComponentDef } from '../componentRegistry';
import { axisField, keyField, needsJoint } from './powerHelpers';

export const linearActuator: ComponentDef = {
  type: 'linearActuator',
  label: 'Linear actuator',
  icon: 'actuator',
  category: 'Actuators',
  blurb: 'Drives a slider to a target extension: speed cap, force limit, travel stops; jog keys or an analog axis.',
  appliesTo: 'joint',
  unique: true,
  fields: [
    {
      kind: 'number',
      key: 'target',
      label: 'Target',
      default: 0,
      min: -1000,
      max: 1000,
      step: 0.05,
      unit: 'm',
      hint: 'Extension relative to the position the slider has when the simulation starts',
    },
    { kind: 'number', key: 'min', label: 'Travel min', default: -1, min: -1000, max: 1000, step: 0.05, unit: 'm' },
    { kind: 'number', key: 'max', label: 'Travel max', default: 1, min: -1000, max: 1000, step: 0.05, unit: 'm' },
    {
      kind: 'number',
      key: 'speed',
      label: 'Max speed',
      default: 1,
      min: 0.001,
      max: 1000,
      step: 0.1,
      unit: 'm/s',
      hint: 'Also the jog speed of the keys',
    },
    { kind: 'number', key: 'force', label: 'Max force', default: 2000, min: 0.1, max: 100000000, step: 100, unit: 'N' },
    { kind: 'number', key: 'kp', label: 'Kp', default: 10, min: 0.1, max: 100, step: 0.5, unit: '1/s' },
    keyField('keyPlus', 'Extend key', '', 'Held: the target moves toward the travel max'),
    keyField('keyMinus', 'Retract key', '', 'Held: the target moves toward the travel min'),
    axisField(
      'axis',
      'Position axis',
      'Analog axis −1 … 1 mapped onto the travel range (replaces the target and the keys)',
    ),
  ],
  state: [
    { label: 'Position', unit: 'm', digits: 3 },
    { label: 'Target', unit: 'm', digits: 3 },
    { label: 'Speed', unit: 'm/s', digits: 2 },
    { label: 'Force', unit: 'N', digits: 0 },
  ],
  sanitise(p) {
    const lo = p.min as number;
    const hi = p.max as number;
    return lo <= hi ? p : { ...p, min: hi, max: lo };
  },
  check: (owner) => needsJoint(owner, ['slider'], 'A linear actuator'),
};
