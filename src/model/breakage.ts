/**
 * JT-11: joint breakage helpers — defaults, presets, sanitising and the "does this joint break by load?" test.
 * The engine side (load estimation, failure) lives in `src/physics/world/jointLoad.ts`.
 */
import type { BreakSpec, JointEntity } from './types';

export const DEFAULT_FATIGUE = { enabled: false, start: 0.6, life: 2 } as const;

/** A fresh, unbreakable spec (thresholds 0) — what the inspector edits when the user first enables breakage. */
export function defaultBreakage(): BreakSpec {
  return { force: 0, torque: 0, fatigue: { ...DEFAULT_FATIGUE } };
}

const finite = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Sanitise a raw `breakage` value into a spread-able fragment (nothing when absent or entirely unbreakable and default). */
export function breakageField(raw: unknown): { breakage?: BreakSpec } {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const f = (r.fatigue && typeof r.fatigue === 'object' ? r.fatigue : {}) as Record<string, unknown>;
  const spec: BreakSpec = {
    force: Math.min(1e9, Math.max(0, finite(r.force, 0))),
    torque: Math.min(1e9, Math.max(0, finite(r.torque, 0))),
    fatigue: {
      enabled: f.enabled === true,
      start: Math.min(0.99, Math.max(0, finite(f.start, DEFAULT_FATIGUE.start))),
      life: Math.min(1e5, Math.max(0.01, finite(f.life, DEFAULT_FATIGUE.life))),
    },
  };
  return { breakage: spec };
}

/** True when the joint can fail from its estimated load (springs use `spring.breakForce` instead). */
export function isLoadBreakable(j: JointEntity): boolean {
  const b = j.breakage;
  return j.type !== 'spring' && !!b && (b.force > 0 || b.torque > 0);
}

/** Does this joint type transmit a torque worth a threshold? Ball joints and ropes do not. */
export function transmitsTorque(type: JointEntity['type']): boolean {
  return type !== 'ball' && type !== 'rope' && type !== 'spring' && type !== 'pulley' && type !== 'winch';
}

export type BreakPreset = 'fragile' | 'normal' | 'tough';

/** Safety factor over the supported weight for each preset. */
export const PRESET_FACTOR: Record<BreakPreset, number> = { fragile: 3, normal: 10, tough: 40 };

/**
 * Thresholds for a preset, scaled to what the joint carries: `mass` is the mass (kg) of the lighter of its bodies
 * (or the one body when the other end is the world), `lever` a representative lever arm (m) for the torque limit.
 */
export function presetBreakage(preset: BreakPreset, mass: number, lever = 0.5, g = 9.81): BreakSpec {
  const force = PRESET_FACTOR[preset] * Math.max(0.1, mass) * g;
  return { force: round3(force), torque: round3(force * lever), fatigue: { ...DEFAULT_FATIGUE } };
}

function round3(v: number): number {
  const e = Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.max(v, 1))) - 2));
  return Math.round(v / e) * e;
}
