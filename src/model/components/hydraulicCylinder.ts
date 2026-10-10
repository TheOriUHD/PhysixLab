/**
 * Hydraulic cylinder — a double-acting cylinder on a slider. The pump supplies a pressure and a flow; a proportional
 * valve (keys or an analog axis) sets how much of both reaches the piston. Force is pressure × piston area (the rod
 * takes area away on the retract stroke), speed is flow ÷ area, and with the valve centred the trapped oil holds
 * the load up to the relief pressure. Runtime: `src/physics/components/hydraulicCylinder.ts`.
 */
import type { ComponentDef } from '../componentRegistry';
import { axisField, keyField, needsJoint } from './powerHelpers';

export const hydraulicCylinder: ComponentDef = {
  type: 'hydraulicCylinder',
  label: 'Hydraulic cylinder',
  icon: 'hydraulic',
  category: 'Actuators',
  blurb: 'Double-acting cylinder: force = pressure × area, speed = flow ÷ area, holds with the valve centred.',
  appliesTo: 'joint',
  unique: true,
  fields: [
    {
      kind: 'number',
      key: 'pressure',
      label: 'Pump pressure',
      default: 100,
      min: 0,
      max: 1000,
      step: 5,
      unit: 'bar',
      hint: 'Force on the extend stroke = pressure × bore area',
    },
    { kind: 'number', key: 'bore', label: 'Bore diameter', default: 50, min: 5, max: 2000, step: 1, unit: 'mm' },
    {
      kind: 'number',
      key: 'rod',
      label: 'Rod diameter',
      default: 28,
      min: 0,
      max: 1900,
      step: 1,
      unit: 'mm',
      hint: 'The rod takes area from the retract stroke',
    },
    {
      kind: 'number',
      key: 'flow',
      label: 'Pump flow',
      default: 30,
      min: 0.1,
      max: 100000,
      step: 1,
      unit: 'L/min',
      hint: 'Full-valve speed = flow ÷ piston area',
    },
    {
      kind: 'number',
      key: 'min',
      label: 'Stroke min',
      default: 0,
      min: -1000,
      max: 1000,
      step: 0.05,
      unit: 'm',
      hint: 'Relative to the slider position at the start of the simulation',
    },
    { kind: 'number', key: 'max', label: 'Stroke max', default: 1, min: -1000, max: 1000, step: 0.05, unit: 'm' },
    keyField('key', 'Extend key', '', 'Held: valve fully open toward extending'),
    keyField('keyReverse', 'Retract key', '', 'Held: valve fully open toward retracting'),
    axisField('axis', 'Valve axis', 'Analog axis −1 … 1: the proportional valve opening (added to the keys)'),
    {
      kind: 'enum',
      key: 'idle',
      label: 'Valve centred',
      default: 'hold',
      options: [
        { value: 'hold', label: 'Hold (oil trapped)' },
        { value: 'float', label: 'Float (open centre)' },
      ],
      hint: 'Hold keeps the load where it is up to the relief pressure; float lets it move freely',
    },
    {
      kind: 'number',
      key: 'relief',
      label: 'Relief pressure',
      default: 160,
      min: 0,
      max: 2000,
      step: 5,
      unit: 'bar',
      hint: 'Holding pressure limit with the valve centred',
    },
  ],
  state: [
    { label: 'Stroke', unit: 'mm', digits: 0 },
    { label: 'Speed', unit: 'mm/s', digits: 0 },
    { label: 'Force', unit: 'N', digits: 0 },
    { label: 'Pressure', unit: 'bar', digits: 1 },
  ],
  sanitise(p) {
    let out = p;
    const bore = p.bore as number;
    // the rod must be thinner than the bore, or the retract stroke would have no area
    if ((p.rod as number) > bore * 0.95) out = { ...out, rod: Math.floor(bore * 0.95) };
    const lo = p.min as number;
    const hi = p.max as number;
    return lo <= hi ? out : { ...out, min: hi, max: lo };
  },
  check: (owner) => needsJoint(owner, ['slider'], 'A hydraulic cylinder'),
};
