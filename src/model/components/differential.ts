/**
 * Differential — splits one input shaft between a left and a right output shaft through a final-drive ratio.
 * Open: the outputs may turn at different speeds (cornering) and always get equal torque. Locked: they are forced to
 * the same speed and share torque as the traction allows. Limited-slip: a clutch pack between them resists a speed
 * difference up to a torque limit (a preload plus a share of the input torque). Runtime:
 * `src/physics/components/differential.ts`.
 */
import type { ComponentDef } from '../componentRegistry';
import { axisField, keyField, shaftField } from './powerHelpers';

export const differential: ComponentDef = {
  type: 'differential',
  label: 'Differential',
  icon: 'differential',
  category: 'Drivetrain',
  blurb: 'Splits a shaft between left and right outputs: open (equal torque, free speed), locked, or limited-slip.',
  appliesTo: 'body',
  fields: [
    shaftField('in', 'Input shaft', 'driveshaft', 'The gearbox side'),
    shaftField('left', 'Left shaft', 'left', 'Connect a wheel hinge to it with a Drive shaft component'),
    shaftField('right', 'Right shaft', 'right', 'Connect a wheel hinge to it with a Drive shaft component'),
    {
      kind: 'number',
      key: 'finalDrive',
      label: 'Final drive',
      default: 3.7,
      min: 0.1,
      max: 40,
      step: 0.1,
      hint: 'Input turns per turn of the differential carrier (the wheels’ average)',
    },
    {
      kind: 'enum',
      key: 'mode',
      label: 'Type',
      default: 'open',
      options: [
        { value: 'open', label: 'Open' },
        { value: 'locked', label: 'Locked' },
        { value: 'lsd', label: 'Limited slip' },
      ],
    },
    keyField('lockKey', 'Lock key', '', 'Held = lock the differential (a driver-selectable locker)'),
    axisField(
      'lockAxis',
      'Lock axis',
      'Analog axis 0 … 1: an adjustable locker. The clutch pack between the wheels carries axis × Lock torque (full lock needs the key or the Locked type)',
    ),
    {
      kind: 'number',
      key: 'lockTorque',
      label: 'Lock torque',
      default: 800,
      min: 0,
      max: 100000,
      step: 10,
      unit: 'N·m',
      showIf: (p) => typeof p.lockAxis === 'string' && p.lockAxis !== '',
      hint: 'Clutch-pack torque at lock axis = 1',
    },
    {
      kind: 'number',
      key: 'preload',
      label: 'LSD preload',
      default: 40,
      min: 0,
      max: 100000,
      step: 5,
      unit: 'N·m',
      showIf: (p) => p.mode === 'lsd',
      hint: 'Torque the clutch pack carries even with no drive',
    },
    {
      kind: 'number',
      key: 'bias',
      label: 'LSD torque bias',
      default: 0.5,
      min: 0,
      max: 10,
      step: 0.05,
      showIf: (p) => p.mode === 'lsd',
      hint: 'Extra clutch-pack torque per N·m of input torque',
    },
    {
      kind: 'number',
      key: 'inertia',
      label: 'Inertia',
      default: 0.05,
      min: 0.0001,
      max: 100,
      step: 0.005,
      unit: 'kg·m²',
      hint: 'Rotating mass of the carrier, on the input shaft',
    },
  ],
  state: [
    { label: 'Left', unit: 'rpm', digits: 0 },
    { label: 'Right', unit: 'rpm', digits: 0 },
    { label: 'Left torque', unit: 'N·m', digits: 0 },
    { label: 'Right torque', unit: 'N·m', digits: 0 },
    { label: 'Locked', digits: 0 },
  ],
  check: (owner, p) =>
    owner.kind === 'body' && (p.left === p.right || p.in === p.left || p.in === p.right)
      ? 'Input, left and right must be three different shafts.'
      : null,
};
