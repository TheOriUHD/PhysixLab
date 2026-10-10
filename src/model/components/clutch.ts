/**
 * Clutch — a friction coupling between two shafts of the drive train. Engaged it locks them together up to its torque
 * capacity and slips beyond it; a pedal (key or analog axis) disengages it, and the bite point comes from the capacity
 * following the pedal travel. Runtime: `src/physics/components/clutch.ts`.
 */
import type { ComponentDef } from '../componentRegistry';
import { axisField, keyField, shaftField } from './powerHelpers';

export const clutch: ComponentDef = {
  type: 'clutch',
  label: 'Clutch',
  icon: 'clutch',
  category: 'Drivetrain',
  blurb: 'Friction clutch between two shafts: torque capacity, slips beyond it; pedal by key or axis.',
  appliesTo: 'body',
  fields: [
    shaftField('in', 'Input shaft', 'crank', 'The engine side. Components find each other by shaft name.'),
    shaftField('out', 'Output shaft', 'clutch', 'The gearbox side'),
    {
      kind: 'number',
      key: 'maxTorque',
      label: 'Capacity',
      default: 400,
      min: 0,
      max: 1000000,
      step: 10,
      unit: 'N·m',
      hint: 'Torque the clutch can carry fully engaged; above it the plates slip',
    },
    {
      kind: 'number',
      key: 'engaged',
      label: 'Engagement at rest',
      default: 1,
      min: 0,
      max: 1,
      step: 0.05,
      hint: '1 = engaged, 0 = disengaged',
    },
    keyField('key', 'Pedal key', '', 'Held = clutch disengaged'),
    axisField('axis', 'Pedal axis', 'Analog axis 0 … 1: how far the pedal is pressed (0 = engaged, 1 = disengaged)'),
    { kind: 'number', key: 'response', label: 'Pedal response', default: 0.08, min: 0, max: 2, step: 0.01, unit: 's' },
    {
      kind: 'bool',
      key: 'centrifugal',
      label: 'Centrifugal',
      default: false,
      hint: 'Engages by itself as the input speeds up (a kart or scooter clutch, or a torque converter): no creeping at idle, a smooth pull-away',
    },
    {
      kind: 'number',
      key: 'engageRpm',
      label: 'Starts to bite at',
      default: 1500,
      min: 0,
      max: 20000,
      step: 100,
      unit: 'rpm',
      showIf: (p) => p.centrifugal === true,
    },
    {
      kind: 'number',
      key: 'lockRpm',
      label: 'Fully engaged at',
      default: 2600,
      min: 0,
      max: 20000,
      step: 100,
      unit: 'rpm',
      showIf: (p) => p.centrifugal === true,
    },
  ],
  state: [
    { label: 'Engagement', unit: '%', digits: 0 },
    { label: 'Slip', unit: 'rpm', digits: 0 },
    { label: 'Torque', unit: 'N·m', digits: 0 },
    { label: 'Locked', digits: 0 },
  ],
  sanitise(p) {
    const lo = p.engageRpm as number;
    const hi = p.lockRpm as number;
    return hi > lo ? p : { ...p, lockRpm: Math.min(20000, lo + 100) };
  },
  check: (owner, p) =>
    owner.kind === 'body' && p.in === p.out ? 'Input and output are the same shaft, so the clutch does nothing.' : null,
};
