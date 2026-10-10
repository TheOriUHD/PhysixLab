/**
 * How a material sounds when it is struck. Every material preset maps to a **sound profile**: the modes of a struck
 * object of that material (frequency ratios and their relative loudness), how long the fundamental rings, how much of
 * the sound is a contact click or a dull body "thump", and how brittle it is. The numbers are textbook-flavoured
 * rather than measured: the partial ratios of a free bar (1, 2.76, 5.40, 8.93 …) give the metallic inharmonic clang,
 * a wine glass rings at 1, 2.32, 4.25, 6.63 …, wood is short and damped, rubber is a thud with a falling pitch.
 *
 * Profiles live in a registry keyed by the preset id (`registerSoundMaterial`) with a fallback derived from the
 * preset's physical numbers for presets nobody described — a package that adds a material adds one profile.
 */
import { PRESET_BY_ID } from '../model/materials';

export type SoundClass =
  'metal' | 'wood' | 'glass' | 'stone' | 'ceramic' | 'rubber' | 'plastic' | 'foam' | 'ice' | 'ground';

export interface SoundProfile {
  cls: SoundClass;
  /** 0 (foam) … 1 (steel): how hard it is, which decides how much it damps a softer partner and how bright it clicks. */
  hardness: number;
  /** Frequency of the fundamental of a 0.5 m object of this material, Hz. */
  pitch: number;
  /** `[frequency ratio, relative loudness]` of each mode. */
  modes: readonly (readonly [number, number])[];
  /** Seconds for the fundamental of a 0.5 m object to fall 60 dB. */
  ring: number;
  /** Higher modes die faster: `t60 = ring / (1 + damp·i)` for mode `i`. */
  damp: number;
  /** Random relative detuning of the upper modes (the beating of an imperfect object). */
  detune: number;
  /** Contact click: loudness 0 … 1 and the centre frequency of its noise burst, Hz. */
  click: number;
  clickFreq: number;
  /** Dull thump of the body: loudness 0 … 1 and its centre frequency, Hz. */
  body: number;
  bodyFreq: number;
  /** 0 … 1: tendency to burst into a spray of fragments when hit very hard. */
  brittle: number;
  /** Loudness trim relative to the other classes. */
  gain: number;
  /** The pitch starts at this multiple and settles (a rubber thud falls). */
  glide?: { from: number; time: number };
}

const METAL_MODES = [
  [1, 1],
  [2.756, 0.62],
  [5.404, 0.42],
  [8.933, 0.24],
  [13.344, 0.12],
  [18.638, 0.06],
] as const;

const metal = (over: Partial<SoundProfile>): SoundProfile => ({
  cls: 'metal',
  hardness: 1,
  pitch: 780,
  modes: METAL_MODES,
  ring: 1.5,
  damp: 0.35,
  detune: 0.004,
  click: 0.5,
  clickFreq: 5200,
  body: 0.12,
  bodyFreq: 240,
  brittle: 0,
  gain: 1,
  ...over,
});

const BUILTIN: Record<string, SoundProfile> = {
  steel: metal({}),
  aluminum: metal({ hardness: 0.8, pitch: 980, ring: 1.0, damp: 0.5, clickFreq: 6200 }),
  gold: metal({ hardness: 0.5, pitch: 640, ring: 0.55, damp: 0.8, click: 0.3, clickFreq: 3600, body: 0.3 }),
  lead: metal({
    hardness: 0.3,
    pitch: 380,
    ring: 0.09,
    damp: 1.2,
    click: 0.15,
    clickFreq: 1800,
    body: 0.7,
    bodyFreq: 160,
  }),
  wood: {
    cls: 'wood',
    hardness: 0.45,
    pitch: 520,
    modes: [
      [1, 1],
      [2.4, 0.45],
      [4.1, 0.25],
      [6.3, 0.12],
    ],
    ring: 0.14,
    damp: 0.8,
    detune: 0.01,
    click: 0.55,
    clickFreq: 2200,
    body: 0.7,
    bodyFreq: 330,
    brittle: 0.55,
    gain: 0.95,
  },
  glass: {
    cls: 'glass',
    hardness: 0.8,
    pitch: 2300,
    modes: [
      [1, 1],
      [2.32, 0.6],
      [4.25, 0.35],
      [6.63, 0.2],
      [9.38, 0.1],
    ],
    ring: 1.4,
    damp: 0.25,
    detune: 0.002,
    click: 0.35,
    clickFreq: 6000,
    body: 0,
    bodyFreq: 400,
    brittle: 1,
    gain: 0.8,
  },
  concrete: {
    cls: 'stone',
    hardness: 0.85,
    pitch: 1250,
    modes: [
      [1, 1],
      [1.59, 0.7],
      [2.14, 0.5],
      [2.65, 0.35],
      [3.3, 0.2],
    ],
    ring: 0.07,
    damp: 0.5,
    detune: 0.02,
    click: 0.7,
    clickFreq: 2500,
    body: 0.5,
    bodyFreq: 700,
    brittle: 0.6,
    gain: 0.9,
  },
  ceramic: {
    cls: 'ceramic',
    hardness: 0.8,
    pitch: 1700,
    modes: [
      [1, 1],
      [2.4, 0.55],
      [4.6, 0.3],
      [7.1, 0.15],
    ],
    ring: 0.45,
    damp: 0.5,
    detune: 0.006,
    click: 0.45,
    clickFreq: 4000,
    body: 0.1,
    bodyFreq: 500,
    brittle: 0.9,
    gain: 0.85,
  },
  rubber: {
    cls: 'rubber',
    hardness: 0.1,
    pitch: 150,
    modes: [
      [1, 1],
      [2, 0.25],
    ],
    ring: 0.05,
    damp: 0.5,
    detune: 0,
    click: 0.05,
    clickFreq: 900,
    body: 0.8,
    bodyFreq: 180,
    brittle: 0,
    gain: 0.9,
    glide: { from: 1.4, time: 0.012 },
  },
  plastic: {
    cls: 'plastic',
    hardness: 0.35,
    pitch: 1700,
    modes: [
      [1, 1],
      [1.87, 0.5],
      [3.1, 0.3],
    ],
    ring: 0.045,
    damp: 0.6,
    detune: 0.01,
    click: 0.5,
    clickFreq: 3500,
    body: 0.35,
    bodyFreq: 650,
    brittle: 0.18,
    gain: 0.85,
  },
  foam: {
    cls: 'foam',
    hardness: 0,
    pitch: 300,
    modes: [],
    ring: 0.04,
    damp: 0,
    detune: 0,
    click: 0,
    clickFreq: 800,
    body: 1,
    bodyFreq: 300,
    brittle: 0.1,
    gain: 0.4,
  },
  ice: {
    cls: 'ice',
    hardness: 0.55,
    pitch: 3000,
    modes: [
      [1, 1],
      [2.76, 0.5],
      [5.4, 0.3],
    ],
    ring: 0.28,
    damp: 0.6,
    detune: 0.004,
    click: 0.5,
    clickFreq: 7000,
    body: 0.05,
    bodyFreq: 500,
    brittle: 0.85,
    gain: 0.8,
  },
};

/** The ground slab: a dull, deep thump. */
export const GROUND_SOUND: SoundProfile = {
  cls: 'ground',
  hardness: 0.7,
  pitch: 70,
  modes: [
    [1, 1],
    [1.8, 0.4],
  ],
  ring: 0.16,
  damp: 0.6,
  detune: 0,
  click: 0.08,
  clickFreq: 700,
  body: 1,
  bodyFreq: 140,
  brittle: 0,
  gain: 1,
  glide: { from: 1.3, time: 0.02 },
};

const PROFILES = new Map<string, SoundProfile>();

/** Describe how a material preset sounds when struck. Returns the function that removes the profile again. */
export function registerSoundMaterial(presetId: string, profile: SoundProfile): () => void {
  PROFILES.set(presetId, profile);
  return () => {
    if (PROFILES.get(presetId) === profile) PROFILES.delete(presetId);
  };
}

/** A profile for a preset nobody described, from its physical numbers. */
function derive(id: string): SoundProfile {
  const p = PRESET_BY_ID.get(id);
  if (!p) return BUILTIN.plastic;
  if (p.metalness >= 0.5)
    return metal({ hardness: 0.7, pitch: 700 * Math.pow(7850 / Math.max(500, p.density), 0.25), ring: 0.7 });
  if (p.opacity < 0.7) return BUILTIN.glass;
  if (p.density < 200) return BUILTIN.foam;
  if (p.restitution >= 0.7 || p.friction >= 0.9) return BUILTIN.rubber;
  return BUILTIN.plastic;
}

/** The sound profile of a material preset (`'ground'` is the ground slab). */
export function soundProfileFor(presetId: string): SoundProfile {
  if (presetId === 'ground') return GROUND_SOUND;
  return PROFILES.get(presetId) ?? BUILTIN[presetId] ?? derive(presetId);
}

export const SOUND_CLASSES: readonly SoundClass[] = [
  'metal',
  'wood',
  'glass',
  'stone',
  'ceramic',
  'rubber',
  'plastic',
  'foam',
  'ice',
  'ground',
];
