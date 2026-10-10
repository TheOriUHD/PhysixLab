/** Public entry of the visual-effects system: `import { Fx, registerParticleType } from '../render/fx'`. */
export { Fx, type FxEnvironment, type FxImpact, type FxStats, type Vec3Like } from './fx';
export type { EmitOptions, EmitPattern } from './emitter';
export type { ExplosionLight, ExplosionOptions } from './explosion';
export {
  particleTypes,
  registerParticleType,
  type ColorStops,
  type Keyframes,
  type ParticleBlend,
  type ParticleOrient,
  type ParticleTypeDef,
} from './particleTypes';
export { SPRITE_NAMES, type SpriteName } from './sprites';
export {
  DEFAULT_FX_SETTINGS,
  FX_INTENSITY_RANGE,
  FX_TIERS,
  resolveTier,
  sanitizeFxSettings,
  type FxQuality,
  type FxSettings,
  type FxTier,
  type FxTierId,
} from './settings';
export {
  impactBursts,
  impactEnergy,
  impactLevel,
  registerFxSurface,
  surfaceFor,
  type FxSurface,
  type FxSurfaceClass,
  type ImpactBurst,
  type ImpactInput,
} from './surfaces';
