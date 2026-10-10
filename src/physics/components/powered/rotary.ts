/**
 * Where a propeller or rotor gets its spin from — one of three sources, chosen by where the component sits:
 *
 *   - on a **hinge**: the hinge's own speed (an engine or motor drives the hinge; the aerodynamic load goes back onto
 *     the hinge as a torque, so the engine feels the propeller). The engine limits a body to 45° of rotation per step,
 *     which caps this at π/4 × the physics rate (94 rad/s at 120 Hz);
 *   - on a **body with a shaft name**: a virtual shaft of the drive train (engine → gearbox → propeller). Virtual
 *     shafts have no speed limit, so this is the way to turn a propeller at thousands of rpm;
 *   - on a **body without a shaft**: an idealised self-driven rotor that spools up to `maxRpm` × throttle.
 */
import { clamp } from '../../../core/math';
import type { BodyHandle, ComponentContext } from '../context';
import type { Shaft } from '../drive/network';
import { approach, fromRpm, pedal } from './common';

export interface SpinState {
  /** Speed of a self-driven rotor, rad/s. */
  w: number;
}

export interface Spin {
  /** Signed speed, rad/s. */
  w: number;
  /** The shaft the aerodynamic load goes on (hinge or drive-train shaft); null when self-driven. */
  shaft: Shaft | null;
  /** The hinge shaft, when the component sits on a hinge. */
  hinge: Shaft | null;
}

export function spinOf(ctx: ComponentContext, st: SpinState, dt: number, shaftField = 'shaft'): Spin {
  if (ctx.ownerKind === 'joint') {
    const hinge = ctx.drive.own();
    return { w: hinge && hinge.kind === 'rot' ? hinge.speed : 0, shaft: hinge, hinge };
  }
  const name = ctx.str(shaftField);
  if (name) {
    const shaft = ctx.drive.shaft(name);
    return { w: shaft.omega, shaft, hinge: null };
  }
  const throttle = clamp(pedal(ctx, 'key', 'axis', ctx.num('throttle')), 0, 1);
  st.w = approach(st.w, throttle * fromRpm(ctx.num('maxRpm')), ctx.num('spool'), dt);
  return { w: st.w, shaft: null, hinge: null };
}

/**
 * Put an aerodynamic load T = −k·ω·|ω| on a shaft, linearised implicitly (dT/dω = −2k|ω|) so a light propeller
 * on a strong motor cannot oscillate between steps.
 */
export function loadShaft(ctx: ComponentContext, shaft: Shaft, k: number): void {
  const w = shaft.kind === 'rot' ? shaft.speed : 0;
  ctx.drive.torque(shaft, k * w * Math.abs(w), 2 * k * Math.abs(w));
}

/** The dynamic body that carries a hinge-mounted propeller or rotor: A when it can move, else B. */
export function hingeCarrier(ctx: ComponentContext): BodyHandle | null {
  const j = ctx.joint;
  if (!j) return null;
  const a = j.bodyA ? ctx.bodyById(j.bodyA) : null;
  const b = j.bodyB ? ctx.bodyById(j.bodyB) : null;
  if (a && a.type === 'dynamic') return a;
  if (b && b.type === 'dynamic') return b;
  return null;
}
