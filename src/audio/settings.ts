/**
 * Sound settings: the user-facing switches and volumes (stored in the preferences, `Prefs.audio`). Pure data, so the
 * sanitiser that validates whatever a stale or hand-edited localStorage entry contains is unit-tested in Node.
 */
import { clamp01 } from './mapping';

/**
 * The sound categories, each with its own volume, voice budget and bus. The checklist's five: impacts (collisions and
 * the events around them: explosions, breaking, joints snapping, launches), rolling and sliding, engines and motors,
 * ambience (wind, the air bed) and UI feedback.
 */
export type AudioCategory = 'impacts' | 'rolling' | 'engines' | 'ambience' | 'ui';

export interface AudioCategoryInfo {
  id: AudioCategory;
  label: string;
  hint: string;
  /** Most voices of this category sounding at once; the quietest is stolen for a louder newcomer. */
  maxVoices: number;
  /** Default volume, 0 … 1. */
  volume: number;
}

export const AUDIO_CATEGORIES: readonly AudioCategoryInfo[] = [
  {
    id: 'impacts',
    label: 'Impacts & events',
    hint: 'Collisions by material, explosions, things breaking, joints snapping, trampolines, launches and spawns',
    maxVoices: 24,
    volume: 1,
  },
  {
    id: 'rolling',
    label: 'Rolling & sliding',
    hint: 'Rumble of rolling bodies and the scrape of sliding ones, following speed and load',
    maxVoices: 6,
    volume: 0.8,
  },
  {
    id: 'engines',
    label: 'Engines & motors',
    hint: 'Pitch and timbre follow the motor speed and load of motorised joints and engine components',
    maxVoices: 4,
    volume: 0.8,
  },
  {
    id: 'ambience',
    label: 'Ambience & wind',
    hint: 'A quiet air bed and the wind that rushes past a camera following a fast body',
    maxVoices: 3,
    volume: 0.5,
  },
  {
    id: 'ui',
    label: 'Interface',
    hint: 'Subtle sounds for select, place, delete, errors and success',
    maxVoices: 6,
    volume: 0.6,
  },
];

export const AUDIO_CATEGORY_IDS: readonly AudioCategory[] = AUDIO_CATEGORIES.map((c) => c.id);

/** Sum of the category budgets is more than the device needs at once: this caps the total. */
export const MAX_TOTAL_VOICES = 36;

export interface AudioSettings {
  /** Master switch: off means no audio context is ever created and no contact events are requested for sound. */
  enabled: boolean;
  /** Muted (key Shift+M, the speaker in the top bar): the context keeps its state but is silent and idle. */
  muted: boolean;
  /** Master volume, 0 … 1. */
  master: number;
  /** Volume per category, 0 … 1. */
  volume: Record<AudioCategory, number>;
  /** Pan and attenuate by position relative to the camera. Off: every sound plays centred at full level. */
  spatial: boolean;
  /** Doppler shift for moving sources and a moving camera (engines, rolling bodies, passing projectiles). */
  doppler: boolean;
  /** Slow motion lowers the pitch of every sound (and fast-forward raises it a little). */
  pitchWithTimeScale: boolean;
  /** Subtle sounds for select / place / delete / error / success. */
  uiSounds: boolean;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  enabled: true,
  muted: false,
  master: 0.8,
  volume: Object.fromEntries(AUDIO_CATEGORIES.map((c) => [c.id, c.volume])) as Record<AudioCategory, number>,
  spatial: true,
  doppler: false,
  pitchWithTimeScale: true,
  uiSounds: true,
};

type BoolKey = { [K in keyof AudioSettings]: AudioSettings[K] extends boolean ? K : never }[keyof AudioSettings];

/** Coerce whatever was stored (or a partial patch) into a complete, valid `AudioSettings`. */
export function sanitizeAudioSettings(raw: unknown, base: AudioSettings = DEFAULT_AUDIO_SETTINGS): AudioSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const bool = (k: BoolKey): boolean => (typeof r[k] === 'boolean' ? r[k] : base[k]);
  const vol = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : fallback;
  const rv = r.volume && typeof r.volume === 'object' ? (r.volume as Record<string, unknown>) : {};
  const volume = {} as Record<AudioCategory, number>;
  for (const id of AUDIO_CATEGORY_IDS) volume[id] = vol(rv[id], base.volume[id]);
  return {
    enabled: bool('enabled'),
    muted: bool('muted'),
    master: vol(r.master, base.master),
    volume,
    spatial: bool('spatial'),
    doppler: bool('doppler'),
    pitchWithTimeScale: bool('pitchWithTimeScale'),
    uiSounds: bool('uiSounds'),
  };
}

/** Copy with `patch` applied and validated (one place for the "change a setting" rule). */
export function patchAudioSettings(
  current: AudioSettings,
  patch: Partial<Omit<AudioSettings, 'volume'>> & { volume?: Partial<Record<AudioCategory, number>> },
): AudioSettings {
  return sanitizeAudioSettings({ ...current, ...patch, volume: { ...current.volume, ...patch.volume } }, current);
}
