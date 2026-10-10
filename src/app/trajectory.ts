/**
 * Ballistic flight prediction for the throw / aim tool (ED-44). Mirrors what the engine does to a free projectile:
 * semi-implicit Euler at the fixed step, gravity scaled by `gravityScale`, and Rapier's linear damping
 * (v ← v / (1 + damping·dt)), so the preview line is the path the projectile takes in empty space.
 */
import type { Vec3 } from '../core/math';

export interface FlightInput {
  origin: Vec3;
  velocity: Vec3;
  gravity: Vec3;
  gravityScale: number;
  /** Rapier linear damping of the projectile. */
  damping: number;
  /** Fixed step, s (the scene's 1 / physicsHz; default 1/120). */
  dt?: number;
  /** Stop after this much flight time, s. */
  maxTime?: number;
  /** Stop when the path reaches this height (the ground plane); `null` flies on. */
  floorY?: number | null;
}

export interface Flight {
  /** Flat x y z samples, one per step (including the start). */
  points: number[];
  /** Where the path met the floor plane (interpolated), if it did. */
  landing: Vec3 | null;
  time: number;
}

export function predictFlight(f: FlightInput): Flight {
  const dt = f.dt ?? 1 / 120;
  const maxT = f.maxTime ?? 6;
  const floor = f.floorY === undefined ? 0 : f.floorY;
  const points: number[] = [...f.origin];
  let [x, y, z] = f.origin;
  let [vx, vy, vz] = f.velocity;
  const gx = f.gravity[0] * f.gravityScale,
    gy = f.gravity[1] * f.gravityScale,
    gz = f.gravity[2] * f.gravityScale;
  const damp = 1 / (1 + f.damping * dt);
  const steps = Math.round(maxT / dt);
  let t = 0;
  let landing: Vec3 | null = null;
  for (let i = 0; i < steps; i++) {
    vx = (vx + gx * dt) * damp;
    vy = (vy + gy * dt) * damp;
    vz = (vz + gz * dt) * damp;
    const nx = x + vx * dt,
      ny = y + vy * dt,
      nz = z + vz * dt;
    t += dt;
    if (floor !== null && ny <= floor && y > floor) {
      const k = (y - floor) / (y - ny);
      landing = [x + (nx - x) * k, floor, z + (nz - z) * k];
      points.push(landing[0], landing[1], landing[2]);
      return { points, landing, time: t - dt * (1 - k) };
    }
    x = nx;
    y = ny;
    z = nz;
    points.push(x, y, z);
  }
  return { points, landing, time: t };
}
