/**
 * Position control of a joint shaft — the loop servos and linear actuators share.
 *
 * A cascade, like a real servo drive: an outer PID loop turns the position error into a *speed command* (capped at the
 * servo's maximum speed), and an inner loop makes the shaft follow that speed with a bounded torque (a `drive` row of
 * the network, solved exactly). The inner loop is therefore unconditionally stable and the torque limit is honest —
 * overload the servo and it stops following; the outer loop is the only thing the gains have to be tuned for.
 *
 *   v_cmd = clamp( Kp·e + Ki·∫e − Kd·ω , ±v_max ),   |v_cmd| ≤ |e| / dt   (never overshoots the target within a step)
 */
import { clamp } from '../../../core/math';
import type { DriveAccess, Row, Shaft } from '../drive/network';

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

export function positionRow(
  drive: DriveAccess,
  shaft: Shaft,
  target: number,
  g: PositionGains,
  loop: PositionLoop,
  dt: number,
): Row {
  const e = target - shaft.position;
  if (g.ki > 0) {
    const cap = g.vmax / g.ki; // the integral term alone can never ask for more than the speed cap
    loop.integral = clamp(loop.integral + e * dt, -cap, cap);
  } else loop.integral = 0;
  let v = g.kp * e + g.ki * loop.integral - g.kd * shaft.speed;
  v = clamp(v, -g.vmax, g.vmax);
  const reach = Math.abs(e) / dt;
  v = clamp(v, -reach, reach);
  return drive.drive(shaft, v, g.fmax);
}
