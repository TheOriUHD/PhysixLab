/**
 * Sine mover — drives a kinematic body back and forth along an axis: x(t) = A·sin(2π·f·t + φ) from where the body
 * was authored. The body is moved by velocity each step so it lands exactly on the curve, which makes friction carry
 * anything resting on it (a lift, a moving platform). Runtime: `src/physics/components/sineMover.ts`.
 */
import type { ComponentDef } from '../componentRegistry';

export const sineMover: ComponentDef = {
  type: 'sineMover',
  label: 'Sine mover',
  icon: 'wave',
  category: 'Movers',
  blurb: 'Swings a kinematic body back and forth along an axis. Riders are carried by friction.',
  appliesTo: 'body',
  unique: true,
  fields: [
    {
      kind: 'vec3',
      key: 'axis',
      label: 'Direction',
      default: [1, 0, 0],
      step: 0.1,
      hint: 'World direction of travel (normalised)',
    },
    { kind: 'number', key: 'amplitude', label: 'Amplitude', default: 1, min: 0, max: 1000, step: 0.1, unit: 'm' },
    { kind: 'number', key: 'frequency', label: 'Frequency', default: 0.5, min: 0, max: 50, step: 0.05, unit: 'Hz' },
    {
      kind: 'number',
      key: 'phase',
      label: 'Phase',
      default: 0,
      min: -360,
      max: 360,
      step: 5,
      unit: '°',
      hint: 'Where in the cycle the body starts (0° = at its authored position, moving forwards)',
    },
  ],
  state: [
    { label: 'Offset', unit: 'm', digits: 3 },
    { label: 'Speed', unit: 'm/s', digits: 3 },
  ],
  check: (owner) =>
    owner.kind === 'body' && owner.bodyType !== 'kinematic'
      ? 'A sine mover drives a kinematic body. Set the body type to Kinematic.'
      : null,
};
