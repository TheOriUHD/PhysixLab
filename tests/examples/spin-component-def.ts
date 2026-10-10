// File: src/model/components/spin.ts   (then add `spin` to BUILTIN_COMPONENTS in src/model/components/index.ts)
import type { ComponentDef } from '../../src/model/componentRegistry';

export const spin: ComponentDef = {
  type: 'spin',
  label: 'Spin',
  icon: 'rotate',
  category: 'Movers',
  blurb: 'Turns the body at a steady rate about an axis — a turntable, a rotor, a rolling pin.',
  appliesTo: 'body',
  unique: true,
  fields: [
    { kind: 'vec3', key: 'axis', label: 'Axis', default: [0, 1, 0], step: 0.1, hint: 'World axis (normalised)' },
    { kind: 'number', key: 'speed', label: 'Speed', default: 2, min: -100, max: 100, step: 0.1, unit: 'rad/s' },
  ],
  state: [{ label: 'Spin rate', unit: 'rad/s', digits: 2 }],
  check: (owner) =>
    owner.kind === 'body' && owner.bodyType === 'static' ? 'A static body cannot spin. Make it dynamic.' : null,
};
