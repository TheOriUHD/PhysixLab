/** Projectile types of the throw / aim tool (ED-44). Each is a recipe for the body that is fired. */
import type { BodyInit } from '../model/factory';

export interface ProjectileType {
  id: string;
  label: string;
  blurb: string;
  shape: { type: string; size: (r: number) => [number, number, number] };
  /** Material preset id and colour. */
  material: { preset: string; color: string; metalness?: number };
  /** Mass in kg (`massOverride`); null keeps density × volume (the original ball). */
  mass: ((r: number) => number) | null;
  /** Multiplies the speed option. */
  speedMul: number;
  /** Multiplies the size option (radius, m). */
  sizeMul: number;
  linearDamping: number;
  /** Aligned with its direction of flight (darts), otherwise it starts unrotated. */
  aligned?: boolean;
  /** Detonates this many seconds after it is fired. */
  fuse?: number;
}

const sphereOf = (r: number): [number, number, number] => [r * 2, r * 2, r * 2];

export const PROJECTILE_TYPES: readonly ProjectileType[] = [
  {
    id: 'ball',
    label: 'Ball',
    blurb: 'Steel ball (density × volume)',
    shape: { type: 'sphere', size: sphereOf },
    material: { preset: 'steel', color: '#ffb347', metalness: 0.5 },
    mass: null,
    speedMul: 1,
    sizeMul: 1,
    linearDamping: 0.01,
  },
  {
    id: 'bowling',
    label: 'Bowling ball',
    blurb: '7 kg, 22 cm — rolls through anything light',
    shape: { type: 'sphere', size: sphereOf },
    material: { preset: 'plastic', color: '#2b3a67' },
    mass: () => 7,
    speedMul: 0.8,
    sizeMul: 0.55,
    linearDamping: 0.01,
  },
  {
    id: 'bomb',
    label: 'Bomb',
    blurb: 'Explodes 2 s after it is fired, or on a second click',
    shape: { type: 'sphere', size: sphereOf },
    material: { preset: 'steel', color: '#2a2a2e', metalness: 0.6 },
    mass: () => 4,
    speedMul: 0.6,
    sizeMul: 0.6,
    linearDamping: 0.02,
    fuse: 2,
  },
  {
    id: 'bullet',
    label: 'Bullet',
    blurb: 'Tiny and very fast (continuous collision)',
    shape: { type: 'sphere', size: sphereOf },
    material: { preset: 'lead', color: '#c9a45c', metalness: 0.8 },
    mass: () => 0.05,
    speedMul: 4,
    sizeMul: 0.12,
    linearDamping: 0,
  },
  {
    id: 'crate',
    label: 'Crate',
    blurb: 'Wooden box that tumbles',
    shape: { type: 'box', size: (r) => [r * 2, r * 2, r * 2] },
    material: { preset: 'wood', color: '#b98552' },
    mass: (r) => 400 * (r * 2) ** 3,
    speedMul: 0.8,
    sizeMul: 1,
    linearDamping: 0.02,
  },
  {
    id: 'heavy',
    label: 'Heavy ball',
    blurb: '500 kg wrecking ball',
    shape: { type: 'sphere', size: sphereOf },
    material: { preset: 'lead', color: '#59606c', metalness: 0.7 },
    mass: () => 500,
    speedMul: 0.6,
    sizeMul: 1.1,
    linearDamping: 0.01,
  },
  {
    id: 'dart',
    label: 'Dart',
    blurb: 'Light cone that flies point-first',
    shape: { type: 'cone', size: (r) => [r * 0.6, r * 3, r * 0.6] },
    material: { preset: 'aluminum', color: '#7ee0ff' },
    mass: () => 0.15,
    speedMul: 1.4,
    sizeMul: 0.4,
    linearDamping: 0.05,
    aligned: true,
  },
];

export const projectileType = (id: string): ProjectileType =>
  PROJECTILE_TYPES.find((t) => t.id === id) ?? PROJECTILE_TYPES[0];

/** Everything the shot's body, speed and flight need, from the type and the tool's size / speed / mass options. */
export function projectileRecipe(
  type: ProjectileType,
  size: number,
  speed: number,
  massOption: number,
): {
  radius: number;
  speed: number;
  mass: number | null;
  init: Pick<BodyInit, 'shape' | 'material' | 'linearDamping'>;
} {
  const radius = size * type.sizeMul;
  const mass = massOption > 0 ? massOption : type.mass ? type.mass(radius) : null;
  return {
    radius,
    speed: speed * type.speedMul,
    mass,
    init: {
      shape: { type: type.shape.type, size: type.shape.size(radius) },
      material: type.material,
      linearDamping: type.linearDamping,
    },
  };
}
