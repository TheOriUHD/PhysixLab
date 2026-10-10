/**
 * Small helpers shared by the powered parts (engines, motors, brakes, thrusters …): unit conversions and the way a
 * component turns its `key` / `axis` fields into a control value, so every part reads its inputs the same way.
 */
import { clamp } from '../../../core/math';
import type { ComponentContext } from '../context';

/** rad/s → revolutions per minute. */
export const RPM = 60 / (2 * Math.PI);
export const toRpm = (w: number): number => w * RPM;
export const fromRpm = (rpm: number): number => rpm / RPM;
export const DEG = Math.PI / 180;

/** Is a key or an analog axis configured in these fields? (If neither is, a part uses its fixed setting.) */
export function hasControl(ctx: ComponentContext, keyField = 'key', axisField = 'axis'): boolean {
  return ctx.str(keyField) !== '' || ctx.str(axisField) !== '';
}

/**
 * A pedal / throttle value in 0 … 1: 1 while the key is held, otherwise the analog axis (negative values count as
 * 0); when neither is configured, `fallback`.
 */
export function pedal(ctx: ComponentContext, keyField = 'key', axisField = 'axis', fallback = 0): number {
  const key = ctx.str(keyField);
  const axis = ctx.str(axisField);
  if (!key && !axis) return fallback;
  let v = 0;
  if (key && ctx.input.key(key)) v = 1;
  if (axis) v = Math.max(v, clamp(ctx.input.axis(axis), 0, 1));
  return v;
}

/**
 * A signed command in −1 … 1: `keyPos` held = +1, `keyNeg` held = −1 (both cancel), plus the analog axis as it is;
 * when nothing is configured, `fallback`.
 */
export function signed(
  ctx: ComponentContext,
  keyPos = 'key',
  keyNeg = 'keyReverse',
  axisField = 'axis',
  fallback = 0,
): number {
  const kp = ctx.str(keyPos);
  const kn = ctx.str(keyNeg);
  const axis = ctx.str(axisField);
  if (!kp && !kn && !axis) return fallback;
  let v = 0;
  if (kp && ctx.input.key(kp)) v += 1;
  if (kn && ctx.input.key(kn)) v -= 1;
  if (axis) v += ctx.input.axis(axis);
  return clamp(v, -1, 1);
}

/** Smooth first-order approach of `current` to `target` with time constant `tau` (0 = instant). */
export function approach(current: number, target: number, tau: number, dt: number): number {
  if (!(tau > 1e-6)) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

/** A key's rising edge between two steps (the state keeps the previous level). */
export class Edge {
  private was = false;
  /** True exactly on the step the key goes down. */
  pressed(down: boolean): boolean {
    const hit = down && !this.was;
    this.was = down;
    return hit;
  }
}
