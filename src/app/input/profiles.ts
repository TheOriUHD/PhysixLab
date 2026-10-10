/**
 * Vehicle profiles: which analog axes a kind of vehicle uses, how a gamepad drives them, and how they are tuned.
 *
 * An axis is just a name (`steer`, `drive`, `pitch` …) that a motor (`JointMotor.axis`) or a component
 * (`constantForce.axis`) reads as `ctx.input.axis(name)`. A profile says where each name comes from on a pad;
 * keyboard (ramped), touch joysticks and the pad all land on the same names, so a scene authored once is driven by
 * any device. Names not listed in the active profile are still fed by keys bound to the motor.
 */
import type { AxisCfg } from './axes';
import type { PadButton, PadStick } from './gamepad';

/** One thing that drives an axis: a stick, or a pair of triggers / buttons (positive minus negative). */
export type PadSource =
  { stick: PadStick; invert?: boolean } | { pos: PadButton | PadStick; neg?: PadButton | PadStick };

export interface VehicleProfile {
  id: string;
  label: string;
  blurb: string;
  /** Axis name → the pad inputs summed (and clamped to ±1) into it. */
  pad: Record<string, readonly PadSource[]>;
  /** Axis name → tuning on top of `DEFAULT_AXIS`. */
  tuning: Record<string, Partial<AxisCfg>>;
}

const driveSources: readonly PadSource[] = [{ pos: 'RT', neg: 'LT' }, { stick: 'LY' }];

export const PROFILES: readonly VehicleProfile[] = [
  {
    id: 'car',
    label: 'Car',
    blurb: 'Left stick steers, right trigger accelerates, left trigger brakes / reverses.',
    pad: {
      // Steering motors treat + as a left turn, so pushing the stick left is +.
      steer: [{ stick: 'LX', invert: true }],
      drive: driveSources,
      lift: [{ stick: 'RY' }],
    },
    tuning: { steer: { expo: 1.6, deadzone: 0.1, rise: 0.3, fall: 0.18 }, drive: { rise: 0.35, fall: 0.25 } },
  },
  {
    id: 'plane',
    label: 'Plane',
    blurb: 'Left stick pitches and rolls, right stick X yaws, triggers set throttle.',
    pad: {
      pitch: [{ stick: 'LY' }],
      roll: [{ stick: 'LX' }],
      yaw: [{ stick: 'RX' }],
      throttle: [{ pos: 'RT', neg: 'LT' }],
      drive: driveSources,
    },
    tuning: {
      pitch: { expo: 2, sensitivity: 0.9 },
      roll: { expo: 2, sensitivity: 0.9 },
      throttle: { smoothing: 0.12, autoCentre: false },
    },
  },
  {
    id: 'tank',
    label: 'Tank',
    blurb: 'Each stick drives one track (push both forward to advance, opposite to spin).',
    pad: {
      left: [{ stick: 'LY' }],
      right: [{ stick: 'RY' }],
      drive: [{ pos: 'RT', neg: 'LT' }],
      steer: [{ stick: 'LX', invert: true }],
    },
    tuning: { left: { expo: 1.3 }, right: { expo: 1.3 } },
  },
  {
    id: 'crane',
    label: 'Crane',
    blurb: 'Left stick slews and trolleys, right stick lifts, D-pad nudges.',
    pad: {
      slew: [{ stick: 'LX' }],
      trolley: [{ stick: 'LY' }],
      lift: [{ stick: 'RY' }],
      hoist: [{ stick: 'RY' }],
      grab: [{ pos: 'RT', neg: 'LT' }],
    },
    tuning: { slew: { expo: 2, sensitivity: 0.8, rise: 0.5 }, lift: { expo: 2 }, hoist: { expo: 2 } },
  },
  {
    id: 'general',
    label: 'General',
    blurb: 'Plain stick names for custom rigs: moveX / moveY, lookX / lookY, plus steer and drive.',
    pad: {
      moveX: [{ stick: 'LX' }],
      moveY: [{ stick: 'LY' }],
      lookX: [{ stick: 'RX' }],
      lookY: [{ stick: 'RY' }],
      steer: [{ stick: 'LX', invert: true }],
      drive: driveSources,
      lift: [{ stick: 'RY' }],
    },
    tuning: {},
  },
];

export function profileById(id: string): VehicleProfile {
  return PROFILES.find((p) => p.id === id) ?? PROFILES[0];
}

/**
 * Pad button → pseudo key presses in the simulation key set, so scenes that only bind keys still play with a
 * pad. D-pad = arrows, shoulder buttons = Q / E, South = Space-bar equivalent for motors bound to Space.
 */
export const PAD_TO_KEY: Partial<Record<PadButton, string>> = {
  DUp: 'ArrowUp',
  DDown: 'ArrowDown',
  DLeft: 'ArrowLeft',
  DRight: 'ArrowRight',
  LB: 'KeyQ',
  RB: 'KeyE',
};

/** Pad button → command id run on press (never a held key). */
export const PAD_TO_COMMAND: Partial<Record<PadButton, string>> = {
  Start: 'sim.toggle',
  Back: 'sim.reset',
  North: 'view.frameAll',
};
