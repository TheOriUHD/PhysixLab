import type { MaterialSpec } from './types';

/**
 * Material presets. Densities are real-world values (kg/m³) so mass comes out right when
 * you size objects in metres; friction / restitution are representative surface
 * coefficients, tuned for the engine's pairwise combine rules (friction: average,
 * restitution: max — see docs/ARCHITECTURE.md).
 */
export interface MaterialPreset extends Omit<MaterialSpec, 'preset'> {
  id: string;
  label: string;
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  {
    id: 'steel',
    label: 'Steel',
    density: 7850,
    friction: 0.55,
    restitution: 0.2,
    color: '#8e9aa8',
    metalness: 0.9,
    roughness: 0.35,
    opacity: 1,
  },
  {
    id: 'aluminum',
    label: 'Aluminium',
    density: 2700,
    friction: 0.5,
    restitution: 0.25,
    color: '#c4cbd3',
    metalness: 0.85,
    roughness: 0.32,
    opacity: 1,
  },
  {
    id: 'wood',
    label: 'Wood',
    density: 650,
    friction: 0.5,
    restitution: 0.25,
    color: '#b9854f',
    metalness: 0,
    roughness: 0.75,
    opacity: 1,
  },
  {
    id: 'rubber',
    label: 'Rubber',
    density: 1100,
    friction: 1.0,
    restitution: 0.85,
    color: '#e0584c',
    metalness: 0,
    roughness: 0.85,
    opacity: 1,
  },
  {
    id: 'plastic',
    label: 'Plastic',
    density: 1200,
    friction: 0.35,
    restitution: 0.4,
    color: '#3d8bff',
    metalness: 0,
    roughness: 0.4,
    opacity: 1,
  },
  {
    id: 'concrete',
    label: 'Concrete',
    density: 2400,
    friction: 0.75,
    restitution: 0.05,
    color: '#9a9a96',
    metalness: 0,
    roughness: 0.95,
    opacity: 1,
  },
  {
    id: 'glass',
    label: 'Glass',
    density: 2500,
    friction: 0.35,
    restitution: 0.3,
    color: '#9fd8e8',
    metalness: 0,
    roughness: 0.05,
    opacity: 0.45,
  },
  {
    id: 'ice',
    label: 'Ice',
    density: 920,
    friction: 0.03,
    restitution: 0.08,
    color: '#bfe6ff',
    metalness: 0,
    roughness: 0.12,
    opacity: 0.8,
  },
  {
    id: 'foam',
    label: 'Foam',
    density: 60,
    friction: 0.7,
    restitution: 0.15,
    color: '#f3c94e',
    metalness: 0,
    roughness: 0.9,
    opacity: 1,
  },
  {
    id: 'gold',
    label: 'Gold',
    density: 19300,
    friction: 0.45,
    restitution: 0.1,
    color: '#f0b429',
    metalness: 1,
    roughness: 0.25,
    opacity: 1,
  },
  {
    id: 'lead',
    label: 'Lead',
    density: 11340,
    friction: 0.5,
    restitution: 0.03,
    color: '#5c6670',
    metalness: 0.7,
    roughness: 0.55,
    opacity: 1,
  },
  {
    id: 'ceramic',
    label: 'Ceramic',
    density: 2300,
    friction: 0.45,
    restitution: 0.18,
    color: '#efe9de',
    metalness: 0,
    roughness: 0.2,
    opacity: 1,
  },
];

export const PRESET_BY_ID = new Map(MATERIAL_PRESETS.map((p) => [p.id, p]));

export function materialFromPreset(id: string, overrides: Partial<MaterialSpec> = {}): MaterialSpec {
  const p = PRESET_BY_ID.get(id) ?? PRESET_BY_ID.get('plastic')!;
  return {
    preset: p.id,
    density: p.density,
    friction: p.friction,
    restitution: p.restitution,
    color: p.color,
    metalness: p.metalness,
    roughness: p.roughness,
    opacity: p.opacity,
    ...overrides,
  };
}
