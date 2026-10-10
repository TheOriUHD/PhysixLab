/**
 * Position control of a joint — the loop servos and linear actuators share.
 *
 * A cascade, like a real servo drive: an outer PID loop turns the position error into a *speed command* (capped at the
 * servo's maximum speed), and an inner loop makes the joint follow that speed with a bounded force: the engine's own
 * implicit joint motor with a large gain. Being part of the constraint solve, the inner loop is stable at any gain, it
 * sees the whole mechanism the joint moves (an arm with a payload, a crane boom), and the force limit is honest —
 * overload the servo and it stops following. The outer loop is the only thing the gains have to be tuned for.
 *
 *   v_cmd = clamp( Kp·e + Ki·∫e − Kd·v , ±v_max ),   |v_cmd| ≤ |e| / dt   (never overshoots the target within a step)
 */
import { clamp } from '../../../core/math';
import type { Shaft } from '../drive/network';

export interface PositionGains {
  kp: number;
  ki: number;
  kd: number;
  /** Speed cap (rad/s or m/s). */
  vmax: number;
  /** Torque / force cap (N·m or N). */
  fmax: number;
}

export interface PositionLoop {
  integral: number;
}

/** Motor gain of a "hold this speed" joint motor: N·m·s/rad for a hinge, N·s/m for a slider. */
export const HOLD_GAIN = { rot: 1e5, lin: 1e8 } as const;

export interface MotorReport {
  /** The speed that was commanded. */
  command: number;
  /** The force or torque the motor is estimated to deliver: gain × (command − speed), within its limit. */
  force: number;
}

/**
 * One step of the loop on `shaft`: command the joint motor, and (from the speed the joint has *now*, i.e. after the
 * previous step) estimate the force the motor delivered.
 */
export function followTarget(
  shaft: Shaft,
  target: number,
  g: PositionGains,
  loop: PositionLoop,
  dt: number,
): MotorReport {
  const e = target - shaft.position;
  if (g.ki > 0) {
    const cap = g.vmax / g.ki; // the integral term alone can never ask for more than the speed cap
    loop.integral = clamp(loop.integral + e * dt, -cap, cap);
  } else loop.integral = 0;
  let v = g.kp * e + g.ki * loop.integral - g.kd * shaft.speed;
  v = clamp(v, -g.vmax, g.vmax);
  const reach = Math.abs(e) / dt;
  v = clamp(v, -reach, reach);
  const gain = HOLD_GAIN[shaft.kind];
  shaft.motorVelocity(v, gain, g.fmax);
  return { command: v, force: clamp(gain * (v - shaft.speed), -g.fmax, g.fmax) };
}
