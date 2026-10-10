/**
 * VZ-41: accumulated impact damage per body (pure model). Each contact event raises the damage of both bodies by an
 * amount that grows with the approach speed above a threshold that depends on how tough the material is; the value
 * (0..1) drives the crack / scorch / dent look in the body shader (`damageShader.ts`). Resets with the simulation.
 */
import type { MaterialSpec } from '../model/types';

export type DamageKind = 'generic' | 'metal' | 'glass' | 'wood';

export interface DamageSettings {
  enabled: boolean;
  /** Multiplier on how fast things get damaged (0.25 .. 4). */
  sensitivity: number;
}

export const DEFAULT_DAMAGE: DamageSettings = { enabled: true, sensitivity: 1 };

export function sanitizeDamage(raw: unknown): DamageSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const s = typeof r.sensitivity === 'number' && Number.isFinite(r.sensitivity) ? r.sensitivity : 1;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    sensitivity: Math.min(4, Math.max(0.25, s)),
  };
}

/** How a material shows damage: metals dent-tint, glass cracks, wood splinters, everything else scuffs and cracks. */
export function damageKindOf(m: Pick<MaterialSpec, 'preset' | 'metalness' | 'opacity'>): DamageKind {
  const p = m.preset.toLowerCase();
  if (p.includes('glass') || m.opacity < 0.9) return 'glass';
  if (/wood|oak|pine|bamboo|plywood|cardboard/.test(p)) return 'wood';
  if (m.metalness >= 0.5) return 'metal';
  return 'generic';
}

/** Index the shader switches on. */
export const DAMAGE_KIND_INDEX: Record<DamageKind, number> = { generic: 0, metal: 1, glass: 2, wood: 3 };

/** Approach speed (m/s) below which nothing happens, and at which a single hit does 60 % damage, per kind. */
const TOUGHNESS: Record<DamageKind, { v0: number; vFull: number }> = {
  glass: { v0: 0.8, vFull: 6 },
  wood: { v0: 1.5, vFull: 10 },
  generic: { v0: 2, vFull: 12 },
  metal: { v0: 3, vFull: 16 },
};

/** Damage one impact of `speed` m/s does to a body of this kind (before the sensitivity multiplier). */
export function impactDamage(kind: DamageKind, speed: number): number {
  const t = TOUGHNESS[kind];
  if (!(speed > t.v0)) return 0;
  return Math.min(1, (speed - t.v0) / (t.vFull - t.v0)) * 0.6;
}

export class DamageModel {
  private readonly values = new Map<string, number>();
  settings: DamageSettings = DEFAULT_DAMAGE;

  get(id: string): number {
    return this.values.get(id) ?? 0;
  }

  /** Apply an impact; returns the new value. */
  hit(id: string, kind: DamageKind, speed: number): number {
    if (!this.settings.enabled) return this.get(id);
    const add = impactDamage(kind, speed) * this.settings.sensitivity;
    if (add <= 0) return this.get(id);
    const v = Math.min(1, this.get(id) + add);
    this.values.set(id, v);
    return v;
  }

  set(id: string, v: number): void {
    if (v > 0) this.values.set(id, Math.min(1, v));
    else this.values.delete(id);
  }

  reset(): void {
    this.values.clear();
  }

  get size(): number {
    return this.values.size;
  }

  entries(): IterableIterator<[string, number]> {
    return this.values.entries();
  }
}
