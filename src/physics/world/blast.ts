/**
 * Blast variants (ED-40): the pure impulse maths behind the `explode` op. A blast is a kind (where the push points),
 * a falloff curve (how it weakens with distance) and a radius; `blastImpulse` answers "what does this body feel".
 * Pure functions on plain vectors, so they are tested against analytic values and run identically in the worker.
 */
import { vcross, vlen, vnorm, vscale, vsub, type Vec3 } from '../../core/math';
import type { BlastKind, FalloffKind } from '../protocol';

export const BLAST_KINDS: readonly BlastKind[] = ['radial', 'directional', 'implosion', 'ring', 'gust'];
export const FALLOFF_KINDS: readonly FalloffKind[] = ['quadratic', 'linear', 'smooth', 'constant', 'steep'];

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Strength factor (1 at the centre, 0 at the edge — 1 everywhere inside for `constant`) at normalised distance t = d / radius. */
export function falloffCurve(kind: FalloffKind, t: number): number {
  const u = clamp01(t);
  switch (kind) {
    case 'linear':
      return 1 - u;
    case 'smooth':
      return 1 - u * u * (3 - 2 * u);
    case 'constant':
      return u >= 1 ? 0 : 1;
    case 'steep':
      return (1 - u) ** 4;
    case 'quadratic':
    default:
      return (1 - u) * (1 - u);
  }
}

/** Where the ring of a `ring` blast sits (fraction of the radius) and how wide its band is. */
export const RING_CENTRE = 0.65;
export const RING_HALF_WIDTH = 0.3;

export interface BlastParams {
  kind: BlastKind;
  falloff: FalloffKind;
  center: Vec3;
  /** World direction for `directional` and `gust` (any length; normalised here). */
  dir: Vec3;
  strength: number;
  radius: number;
}

export interface BlastEffect {
  impulse: Vec3;
  torque: Vec3;
}

/**
 * The impulse and torque impulse a body with centre of mass `com` and mass `mass` receives, or null when the blast
 * does not reach it. The impulse scales with exposed area (~ mass^(2/3)) so light and heavy objects both react.
 */
export function blastImpulse(p: BlastParams, com: Vec3, mass: number): BlastEffect | null {
  const d = vsub(com, p.center);
  const dist = vlen(d);
  if (dist > p.radius || p.radius <= 0) return null;
  const area = Math.pow(Math.max(mass, 0.01), 2 / 3);
  const away: Vec3 = dist < 1e-6 ? [0, 1, 0] : vscale(d, 1 / dist);
  switch (p.kind) {
    case 'directional':
    case 'gust': {
      const w = falloffCurve(p.falloff, dist / p.radius);
      if (w <= 0) return null;
      const dir = vnorm(p.dir, [0, 0, -1]);
      return { impulse: vscale(dir, p.strength * w * area), torque: [0, 0, 0] };
    }
    case 'implosion': {
      if (dist < 1e-6) return null;
      const w = falloffCurve(p.falloff, dist / p.radius);
      if (w <= 0) return null;
      return { impulse: vscale(away, -p.strength * w * area), torque: [0, 0, 0] };
    }
    case 'ring': {
      const dh = Math.hypot(d[0], d[2]);
      const centre = p.radius * RING_CENTRE,
        half = p.radius * RING_HALF_WIDTH;
      // Distance from the expanding ring (in the horizontal plane) and height above the plane both count.
      const off = Math.hypot(dh - centre, d[1]);
      const w = falloffCurve(p.falloff === 'constant' ? 'constant' : p.falloff, off / half);
      if (w <= 0 || dh < 1e-6) return null;
      const out: Vec3 = [d[0] / dh, 0, d[2] / dh];
      const j = p.strength * w * area;
      return { impulse: [out[0] * j, j * 0.25, out[2] * j], torque: [0, 0, 0] };
    }
    case 'radial':
    default: {
      const w = falloffCurve(p.falloff, dist / p.radius);
      if (w <= 0) return null;
      const j = p.strength * w * area;
      const spin = vcross(away, [0, 1, 0]);
      return { impulse: [away[0] * j, away[1] * j + j * 0.25, away[2] * j], torque: vscale(spin, j * 0.05) };
    }
  }
}
