/**
 * UI-A: reset-to-default for body fields. Every entry names an inspector row (by its label), says whether a body's
 * value is still the default and which patch restores it. The defaults are the factory's (`createBody`); the material
 * fields reset to the body's own material preset (or plastic, the factory default, once it has been edited by hand).
 * Pure: the DOM wiring is in `enhance.ts`.
 */
import { createBody } from '../../../model/factory';
import { MATERIAL_PRESETS, PRESET_BY_ID } from '../../../model/materials';
import type { MaterialPreset } from '../../../model/materials';
import type { BodyEntity, MaterialSpec } from '../../../model/types';

export interface ResetDef {
  /** The row label without its unit ("Velocity (m/s)" → "Velocity"). */
  label: string;
  /** What "default" means, for the tooltip. */
  describe: (b: BodyEntity) => string;
  isDefault: (b: BodyEntity) => boolean;
  patch: (b: BodyEntity) => Partial<BodyEntity>;
}

let factory: BodyEntity | null = null;
const defaults = (): BodyEntity => (factory ??= createBody({ shape: { type: 'box' } }));

const basePreset = (b: BodyEntity): MaterialPreset =>
  PRESET_BY_ID.get(b.material.preset) ?? PRESET_BY_ID.get('plastic') ?? MATERIAL_PRESETS[0];

const MAT_KEYS = ['density', 'friction', 'restitution', 'color', 'metalness', 'roughness', 'opacity'] as const;

/** The preset a material equals exactly, or 'custom'. */
export function matchPreset(m: Omit<MaterialSpec, 'preset'>): string {
  const hit = MATERIAL_PRESETS.find((p) => MAT_KEYS.every((k) => p[k] === m[k]));
  return hit ? hit.id : 'custom';
}

function matField(label: string, key: (typeof MAT_KEYS)[number], unit = ''): ResetDef {
  return {
    label,
    describe: (b) => `${basePreset(b).label}: ${basePreset(b)[key]}${unit}`,
    isDefault: (b) => b.material[key] === basePreset(b)[key],
    patch: (b) => {
      const material = { ...b.material, [key]: basePreset(b)[key] };
      return { material: { ...material, preset: matchPreset(material) } };
    },
  };
}

function plain<K extends 'linearDamping' | 'angularDamping' | 'gravityScale'>(label: string, key: K): ResetDef {
  return {
    label,
    describe: () => String(defaults()[key]),
    isDefault: (b) => b[key] === defaults()[key],
    patch: () => ({ [key]: defaults()[key] }),
  };
}

function structured<K extends 'velocity' | 'angularVelocity' | 'lockPosition' | 'lockRotation'>(
  label: string,
  key: K,
): ResetDef {
  const text = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)).join(', ') : String(v));
  return {
    label,
    describe: () => text(defaults()[key]),
    isDefault: (b) => JSON.stringify(b[key]) === JSON.stringify(defaults()[key]),
    patch: () => ({ [key]: JSON.parse(JSON.stringify(defaults()[key])) as BodyEntity[K] }),
  };
}

export const BODY_RESETS: readonly ResetDef[] = [
  matField('Density', 'density', ' kg/m³'),
  matField('Friction', 'friction'),
  matField('Bounciness', 'restitution'),
  plain('Lin. damping', 'linearDamping'),
  plain('Ang. damping', 'angularDamping'),
  plain('Gravity scale', 'gravityScale'),
  structured('Lock move', 'lockPosition'),
  structured('Lock rotate', 'lockRotation'),
  structured('Velocity', 'velocity'),
  structured('Spin', 'angularVelocity'),
  matField('Colour', 'color'),
  matField('Metalness', 'metalness'),
  matField('Roughness', 'roughness'),
  matField('Opacity', 'opacity'),
];
