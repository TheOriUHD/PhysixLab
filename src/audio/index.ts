/**
 * Public entry of the sound system: `import { AudioEngine, registerSoundEvent, registerSoundMaterial } from '../audio'`.
 *
 * The engine itself is `app.audio` (class `AudioEngine`): `app.audio.playEvent('explosion', [x, y, z], { size: 7 })`
 * plays a registered sound event; a package adds its own with `registerSoundEvent`, and describes how a new material
 * sounds with `registerSoundMaterial`. Everything is procedural — see `dsp.ts` for the recipe format.
 */
export { AudioEngine, LoopHandle, type EngineState, type EngineStats, type OneShotRequest } from './engine';
export {
  AUDIO_CATEGORIES,
  AUDIO_CATEGORY_IDS,
  DEFAULT_AUDIO_SETTINGS,
  patchAudioSettings,
  sanitizeAudioSettings,
  type AudioCategory,
  type AudioSettings,
} from './settings';
export { listSoundEvents, registerSoundEvent, soundEvent, type SoundEventDef, type SoundEventParams } from './events';
export { registerSoundMaterial, soundProfileFor, type SoundClass, type SoundProfile } from './materials';
export { planImpact, type ImpactInput, type ImpactVoice } from './impact';
export type { Recipe, ModeSpec, NoiseSpec, GrainSpec } from './dsp';
export { pitchForTimeScale, volumeToGain } from './mapping';
