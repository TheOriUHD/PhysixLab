/**
 * Constant force — pushes (and optionally spins) a dynamic body every step: a fan, a thruster, a wind, a motor
 * with no moving parts. The first reference component of the component system; the runtime is
 * `src/physics/components/constantForce.ts`.
 */
import type { ComponentDef } from '../componentRegistry';

export const constantForce: ComponentDef = {
  type: 'constantForce',
  label: 'Constant force',
  icon: 'force',
  category: 'Forces',
  blurb: 'Pushes and spins the body with a steady force — thrusters, wind, fans.',
  appliesTo: 'body',
  fields: [
    {
      kind: 'vec3',
      key: 'force',
      label: 'Force',
      default: [0, 10, 0],
      step: 0.5,
      unit: 'N',
      hint: 'Newtons — or m/s² when "Per unit mass" is on',
    },
    { kind: 'vec3', key: 'torque', label: 'Torque', default: [0, 0, 0], step: 0.1, unit: 'N·m' },
    {
      kind: 'enum',
      key: 'space',
      label: 'Frame',
      default: 'world',
      options: [
        { value: 'world', label: 'World axes' },
        { value: 'local', label: 'Body axes' },
      ],
      hint: 'Body axes turn with the body (a thruster); world axes stay put (wind, gravity-like pushes)',
    },
    {
      kind: 'enum',
      key: 'applyAt',
      label: 'Acts at',
      default: 'center',
      options: [
        { value: 'center', label: 'Centre of mass' },
        { value: 'point', label: 'A point' },
      ],
      hint: 'Off-centre forces also spin the body',
    },
    {
      kind: 'vec3',
      key: 'point',
      label: 'Point',
      default: [0, 0, 0],
      step: 0.05,
      unit: 'm',
      hint: 'In the body frame, from the body origin',
      showIf: (p) => p.applyAt === 'point',
    },
    {
      kind: 'bool',
      key: 'perMass',
      label: 'Per unit mass',
      default: false,
      hint: 'Read the force as an acceleration (m/s²): every body then speeds up the same, like gravity',
    },
    { kind: 'key', key: 'key', label: 'Only while held', default: '', hint: 'Empty = always on' },
    {
      kind: 'text',
      key: 'axis',
      label: 'Scale by axis',
      default: '',
      maxLength: 40,
      placeholder: 'axis name',
      hint: 'Name of an analog input axis (−1 … 1) that scales the force; empty = no scaling',
    },
  ],
  state: [
    { label: 'Force', unit: 'N', digits: 2 },
    { label: 'Torque', unit: 'N·m', digits: 2 },
  ],
  check: (owner) =>
    owner.kind === 'body' && owner.bodyType !== 'dynamic'
      ? 'Forces only move dynamic bodies. Set the body type to Dynamic.'
      : null,
};
