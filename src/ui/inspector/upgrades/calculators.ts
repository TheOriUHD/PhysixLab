/**
 * UI-A: the physics behind the inspector's contextual calculators — pure functions in SI units (m, kg, s, rad, N).
 * No DOM, no document; `calcUi.ts` wires them to the selected object.
 */
import type { ShapeSpec } from '../../../model/types';

/** Standard gravity, m/s². */
export const G0 = 9.80665;

// ---- mass · density · volume -------------------------------------------------------------------

export const massFromDensity = (density: number, volume: number): number => density * volume;
export const densityFromMass = (mass: number, volume: number): number => (volume > 0 ? mass / volume : NaN);

// ---- spring · damper ---------------------------------------------------------------------------

/** Mass that effectively oscillates when two free bodies are joined: m₁·m₂/(m₁+m₂). One side fixed: the other mass. */
export function reducedMass(m1: number, m2: number): number {
  if (m1 > 0 && m2 > 0) return (m1 * m2) / (m1 + m2);
  return Math.max(m1, m2, 0);
}

/** Spring constant (N/m) that gives a mass the period T (s): k = m·(2π/T)². */
export const springConstantFromPeriod = (mass: number, period: number): number =>
  period > 0 ? mass * ((2 * Math.PI) / period) ** 2 : NaN;

/** Spring constant (N/m) from the frequency f (Hz): k = m·(2πf)². */
export const springConstantFromFrequency = (mass: number, freq: number): number => mass * (2 * Math.PI * freq) ** 2;

export const naturalFrequency = (k: number, mass: number): number =>
  k > 0 && mass > 0 ? Math.sqrt(k / mass) / (2 * Math.PI) : NaN;

export const naturalPeriod = (k: number, mass: number): number => 1 / naturalFrequency(k, mass);

/** Damping ratio ζ = c / (2·√(k·m)): < 1 oscillates, 1 is critical, > 1 creeps back. */
export const dampingRatio = (c: number, k: number, mass: number): number =>
  k > 0 && mass > 0 ? c / (2 * Math.sqrt(k * mass)) : NaN;

/** Damping coefficient (N·s/m) for the ratio ζ: c = 2ζ·√(k·m). */
export const dampingFromRatio = (zeta: number, k: number, mass: number): number =>
  k > 0 && mass > 0 ? 2 * zeta * Math.sqrt(k * mass) : NaN;

/** Damped period T_d = T / √(1−ζ²) for ζ < 1 (NaN when over- or critically damped). */
export const dampedPeriod = (k: number, mass: number, zeta: number): number =>
  zeta >= 0 && zeta < 1 ? naturalPeriod(k, mass) / Math.sqrt(1 - zeta * zeta) : NaN;

// ---- air drag · terminal velocity --------------------------------------------------------------

/** Quadratic drag coefficient c = ½·ρ·Cd·A (N·s²/m²): F = c·|v|·v. */
export const dragCoefficient = (airDensity: number, cd: number, area: number): number => 0.5 * airDensity * cd * area;

/** Terminal velocity (m/s) under F = c·v²: v = √(m·g / c). */
export const terminalVelocity = (mass: number, g: number, c: number): number =>
  c > 0 && mass > 0 && g > 0 ? Math.sqrt((mass * g) / c) : NaN;

/** The drag coefficient c (N·s²/m²) that gives the terminal velocity vt: c = m·g / vt². */
export const dragForTerminalVelocity = (mass: number, g: number, vt: number): number =>
  vt > 0 ? (mass * g) / (vt * vt) : NaN;

/** Speed after t seconds of a fall from rest with quadratic drag: v(t) = vt·tanh(g·t / vt). */
export const fallSpeedAt = (vt: number, g: number, t: number): number => vt * Math.tanh((g * t) / vt);

// ---- projectile --------------------------------------------------------------------------------

export interface Projectile {
  /** Horizontal distance travelled until the height drops back to the ground level (m). */
  range: number;
  /** Time of flight (s). */
  time: number;
  /** Greatest height above the ground level (m). */
  apex: number;
}

/**
 * Ballistic flight without air: launch speed `v` (m/s) at the elevation angle `theta` (rad, above horizontal) from the
 * height `h0` (m) above the landing level, gravity `g`. Range = v·cosθ·t with t the positive root of
 * h0 + v·sinθ·t − ½·g·t² = 0; on level ground this is v²·sin2θ / g.
 */
export function projectile(v: number, theta: number, h0: number, g: number): Projectile {
  if (!(g > 0)) return { range: NaN, time: NaN, apex: NaN };
  const vy = v * Math.sin(theta);
  const vx = v * Math.cos(theta);
  const disc = vy * vy + 2 * g * h0;
  if (disc < 0) return { range: NaN, time: NaN, apex: NaN };
  const time = (vy + Math.sqrt(disc)) / g;
  const apex = h0 + (vy > 0 ? (vy * vy) / (2 * g) : 0);
  return { range: vx * time, time, apex };
}

/** Elevation angle (rad) and horizontal heading (rad, atan2(z, x)) of a velocity vector. */
export function launchAngles(vel: readonly [number, number, number]): {
  speed: number;
  elevation: number;
  heading: number;
} {
  const horiz = Math.hypot(vel[0], vel[2]);
  return {
    speed: Math.hypot(vel[0], vel[1], vel[2]),
    elevation: Math.atan2(vel[1], horiz),
    heading: Math.atan2(vel[2], vel[0]),
  };
}

/** A velocity vector from speed, elevation and heading (a zero heading points along +x). */
export function launchVelocity(speed: number, elevation: number, heading: number): [number, number, number] {
  const h = speed * Math.cos(elevation);
  return [h * Math.cos(heading), speed * Math.sin(elevation), h * Math.sin(heading)];
}

// ---- pendulum ----------------------------------------------------------------------------------

/** Arithmetic–geometric mean. */
function agm(a: number, b: number): number {
  for (let i = 0; i < 40 && Math.abs(a - b) > 1e-15 * a; i++) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
  return a;
}

/**
 * Period (s) of a simple pendulum of length L (m) in gravity g. With `amplitude` = 0 this is the small-angle
 * 2π√(L/g); otherwise the exact large-angle period T = 4√(L/g)·K(sin(θ₀/2)) (K by the AGM), amplitude in rad < π.
 */
export function pendulumPeriod(length: number, g: number, amplitude = 0): number {
  if (!(length > 0) || !(g > 0)) return NaN;
  const small = 2 * Math.PI * Math.sqrt(length / g);
  if (!amplitude) return small;
  const a = Math.abs(amplitude);
  if (a >= Math.PI) return Infinity;
  const k = Math.sin(a / 2);
  return small * kRatio(k);
}

/** K(k)/(π/2) via the AGM: the factor by which a finite amplitude lengthens the period. */
function kRatio(k: number): number {
  return 1 / agm(1, Math.sqrt(1 - k * k));
}

/** Length (m) of a small-angle pendulum with the period T: L = g·T² / (4π²). */
export const pendulumLength = (period: number, g: number): number =>
  period > 0 ? (g * period * period) / (4 * Math.PI * Math.PI) : NaN;

// ---- moment of inertia -------------------------------------------------------------------------

export interface Inertia {
  /** Principal moments about the body's local x, y, z axes through the centre of mass (kg·m²). */
  moments: [number, number, number];
  /** Is it the exact value for this shape (a solid box, ellipsoid or cylinder of uniform density)? */
  exact: boolean;
  /** What was assumed when it is not exact. */
  note: string;
}

/**
 * Principal moments of inertia of a uniform solid from its mass and the shape spec (sizes are full extents; sphere and
 * cylinder sizes are diameters). Box, sphere / ellipsoid and cylinder are exact; any other shape is approximated by
 * the box of its bounding size and says so.
 */
export function momentsOfInertia(mass: number, shape: Pick<ShapeSpec, 'type' | 'size'>): Inertia {
  const [sx, sy, sz] = shape.size;
  if (shape.type === 'sphere') {
    const a = sx / 2,
      b = sy / 2,
      c = sz / 2;
    return {
      moments: [(mass * (b * b + c * c)) / 5, (mass * (a * a + c * c)) / 5, (mass * (a * a + b * b)) / 5],
      exact: true,
      note: 'solid ellipsoid',
    };
  }
  if (shape.type === 'cylinder') {
    const a = sx / 2,
      c = sz / 2;
    return {
      moments: [(mass * (3 * c * c + sy * sy)) / 12, (mass * (a * a + c * c)) / 4, (mass * (3 * a * a + sy * sy)) / 12],
      exact: true,
      note: 'solid cylinder, axis along y',
    };
  }
  const box: [number, number, number] = [
    (mass * (sy * sy + sz * sz)) / 12,
    (mass * (sx * sx + sz * sz)) / 12,
    (mass * (sx * sx + sy * sy)) / 12,
  ];
  return shape.type === 'box'
    ? { moments: box, exact: true, note: 'solid box' }
    : { moments: box, exact: false, note: 'approximated by the box of its bounding size' };
}
