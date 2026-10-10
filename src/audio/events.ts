/**
 * Event sounds: the one-shots that are not a plain collision — an explosion, something spawning, a body breaking
 * apart, a joint snapping, a trampoline's boing, a launch — and the subtle interface sounds (select, place, delete,
 * error, success, toggle). Each is a **sound event definition** in a small registry: a recipe built from a few
 * parameters (size, level 0 … 1, speed, material), a quantised cache key, and a loudness. A package adds a sound with
 * `registerSoundEvent` and plays it with `app.audio.playEvent(id, position, params)`.
 *
 * Everything here is pure data and maths (the recipes are rendered by `dsp.ts`), so the tests render each event and
 * measure it: a bigger blast is lower and longer, a harder launch brighter, the error buzz lower than the success
 * chime.
 */
import type { GrainSpec, ModeSpec, NoiseSpec, Recipe } from './dsp';
import { clamp, clamp01, dbToGain } from './mapping';
import type { AudioCategory } from './settings';

export interface SoundEventParams {
  /** Characteristic size / radius, metres. */
  size?: number;
  /** Intensity 0 … 1 (strength of a blast, force of a snap, speed of a launch …). */
  level?: number;
  /** Speed, m/s, where it matters (a launch). */
  speed?: number;
  /** Material preset id (`break`). */
  material?: string;
}

export interface SoundEventDef {
  id: string;
  label: string;
  category: AudioCategory;
  /** Pan and attenuate by the position of the event (false: heard at the same level everywhere, e.g. the interface). */
  spatial: boolean;
  /** Cache key: equal keys render equal buffers. Parameters are quantised so a few hundred buffers cover everything. */
  key(p: SoundEventParams): string;
  recipe(p: SoundEventParams): Recipe;
  /** Linear gain before the category / master volumes. */
  gain(p: SoundEventParams): number;
  /** Importance when voices compete (default 1). */
  priority?: number;
  /** Pitch rate (default 1). */
  rate?(p: SoundEventParams): number;
}

const events = new Map<string, SoundEventDef>();

/** Register a sound event. Throws on a malformed or duplicate definition. Returns the unregister function. */
export function registerSoundEvent(def: SoundEventDef): () => void {
  if (!/^[a-z][a-z0-9]*([.\-_][a-z0-9]+)*$/.test(def.id)) throw new Error(`sound event id "${def.id}" is malformed`);
  if (events.has(def.id)) throw new Error(`sound event "${def.id}" is already registered`);
  if (typeof def.recipe !== 'function' || typeof def.key !== 'function' || typeof def.gain !== 'function')
    throw new Error(`sound event "${def.id}" needs key(), recipe() and gain()`);
  events.set(def.id, def);
  return () => {
    if (events.get(def.id) === def) events.delete(def.id);
  };
}

export const soundEvent = (id: string): SoundEventDef | undefined => events.get(id);
export const listSoundEvents = (): SoundEventDef[] => [...events.values()];

// -- parameter quantisation ----------------------------------------------------------------------------------------------

const lvlBucket = (p: SoundEventParams): number => Math.min(3, Math.floor(clamp01(p.level ?? 0.5) * 4));
const lvlOf = (b: number): number => (b + 0.5) / 4;
const sizeBucket = (size: number | undefined, fallback: number): number =>
  Math.round(Math.log2(clamp(size ?? fallback, 0.05, 60)) * 2);
const sizeOf = (b: number): number => Math.pow(2, b / 2);

const note = (freq: number, gain: number, t60: number, start = 0, extra: Partial<ModeSpec> = {}): ModeSpec => ({
  freq,
  gain,
  t60,
  start,
  ...extra,
});

/** A harmonic tone: partials at integer multiples with the given relative loudness, each dying a little faster. */
function tone(freq: number, gains: readonly number[], t60: number, start = 0): ModeSpec[] {
  return gains.map((g, i) => note(freq * (i + 1), g, t60 / (1 + 0.6 * i), start));
}

// -- the built-in events ----------------------------------------------------------------------------------------------------

interface Param extends SoundEventParams {
  level: number;
  size: number;
}
const norm = (p: SoundEventParams, size: number): Param => ({
  ...p,
  level: lvlOf(lvlBucket(p)),
  size: sizeOf(sizeBucket(p.size, size)),
});

const explosion: SoundEventDef = {
  id: 'explosion',
  label: 'Explosion',
  category: 'impacts',
  spatial: true,
  priority: 3,
  key: (p) => `e|x|s${sizeBucket(p.size, 7)}|l${lvlBucket(p)}`,
  gain: (p) => dbToGain(-12 + 8 * clamp01(p.level ?? 0.5)),
  recipe(raw) {
    const { size: radius, level: L } = norm(raw, 7);
    const r = clamp(radius, 1, 40);
    const boom = Math.max(24, 95 / Math.pow(1 + r / 5, 0.7));
    const noise: NoiseSpec[] = [
      {
        color: 'brown',
        gain: 1.1,
        t60: 1.2 + r * 0.04,
        filter: { type: 'lowpass', freq: 2600 * (0.5 + 0.5 * L), freqEnd: 90, q: 0.7 },
      },
      {
        color: 'white',
        gain: 0.8 * (0.4 + 0.6 * L),
        t60: 0.045,
        attack: 0.0003,
        filter: { type: 'highpass', freq: 1400 },
      },
      { color: 'pink', gain: 0.6, t60: 0.28, filter: { type: 'bandpass', freq: 650, freqEnd: 220, q: 0.7 } },
      { color: 'brown', gain: 0.45, t60: 2.0, start: 0.1, filter: { type: 'lowpass', freq: 240, freqEnd: 80 } },
    ];
    const grains: GrainSpec[] = [{ count: 30, start: 0.25, spread: 1.3, fMin: 300, fMax: 2200, gain: 0.06, t60: 0.06 }];
    return {
      duration: Math.min(3.4, 2.4 + r * 0.04),
      modes: [
        note(boom, 1, 0.7 + r * 0.03, 0, { glide: { from: 2.2, time: 0.07 } }),
        note(boom * 1.9, 0.42, 0.45, 0, { glide: { from: 1.8, time: 0.05 } }),
        note(boom * 3.1, 0.2 * L, 0.3),
      ],
      noise,
      grains,
      drive: 1.4,
    };
  },
};

const spawn: SoundEventDef = {
  id: 'spawn',
  label: 'Spawn',
  category: 'impacts',
  spatial: true,
  key: (p) => `e|sp|s${sizeBucket(p.size, 0.5)}`,
  gain: () => dbToGain(-22),
  recipe(raw) {
    const { size } = norm(raw, 0.5);
    const f = clamp(520 * Math.pow(0.5 / size, 0.3), 260, 1100);
    return {
      duration: 0.22,
      modes: [note(f, 1, 0.1, 0, { glide: { from: 0.55, time: 0.03 } }), note(f * 2, 0.3, 0.05)],
      noise: [{ color: 'pink', gain: 0.25, t60: 0.05, filter: { type: 'bandpass', freq: 1800, q: 0.9 } }],
    };
  },
};

/** Fragments of a breaking object, by material class. */
const BREAK_GRAINS: Record<string, { f: [number, number]; count: number; spread: number }> = {
  glass: { f: [1800, 9000], count: 40, spread: 0.5 },
  ice: { f: [2500, 10000], count: 30, spread: 0.45 },
  wood: { f: [600, 3000], count: 14, spread: 0.4 },
  stone: { f: [300, 2000], count: 22, spread: 0.6 },
  ceramic: { f: [900, 6000], count: 30, spread: 0.5 },
  metal: { f: [1500, 7000], count: 10, spread: 0.3 },
  plastic: { f: [700, 3500], count: 10, spread: 0.25 },
};

const breaking: SoundEventDef = {
  id: 'break',
  label: 'Break',
  category: 'impacts',
  spatial: true,
  priority: 2,
  key: (p) => `e|b|${p.material ?? 'plastic'}|s${sizeBucket(p.size, 0.5)}|l${lvlBucket(p)}`,
  gain: (p) => dbToGain(-18 + 12 * clamp01(p.level ?? 0.5)),
  recipe(raw) {
    const { size, level: L } = norm(raw, 0.5);
    const mat = raw.material ?? 'plastic';
    const g = BREAK_GRAINS[mat] ?? BREAK_GRAINS.plastic;
    const scale = clamp(Math.pow(0.5 / size, 0.4), 0.5, 2);
    const noise: NoiseSpec[] = [
      { color: 'white', gain: 0.9, t60: 0.04, attack: 0.0002, filter: { type: 'highpass', freq: 1800 * scale } },
    ];
    const modes: ModeSpec[] = [];
    if (mat === 'wood') {
      noise.push({
        color: 'white',
        gain: 0.8,
        t60: 0.12,
        filter: { type: 'bandpass', freq: 1400, freqEnd: 600, q: 1.2 },
      });
      modes.push(note(180 * scale, 0.9, 0.2));
    } else if (mat === 'stone' || mat === 'ceramic') {
      noise.push({ color: 'brown', gain: 1, t60: 0.5, filter: { type: 'lowpass', freq: 900, freqEnd: 250 } });
      modes.push(note(90 * scale, 0.8, 0.25, 0, { glide: { from: 1.5, time: 0.03 } }));
    } else if (mat === 'metal') {
      modes.push(note(1200 * scale, 0.8, 0.5, 0, { glide: { from: 1.15, time: 0.08 } }), note(1720 * scale, 0.5, 0.35));
    } else if (mat === 'glass' || mat === 'ice') {
      modes.push(note(2300 * scale, 0.6, 0.3), note(5300 * scale, 0.3, 0.2));
    } else {
      noise.push({ color: 'pink', gain: 0.7, t60: 0.07, filter: { type: 'bandpass', freq: 1200, q: 0.8 } });
      modes.push(note(420 * scale, 0.7, 0.1));
    }
    return {
      duration: 0.35 + g.spread + 0.2 * L,
      modes,
      noise,
      grains: [
        {
          count: Math.round(g.count * (0.6 + 0.6 * L)),
          start: 0.01,
          spread: g.spread,
          fMin: g.f[0] * scale,
          fMax: g.f[1] * scale,
          gain: 0.34,
          t60: 0.05,
        },
      ],
    };
  },
};

const snap: SoundEventDef = {
  id: 'snap',
  label: 'Joint snap',
  category: 'impacts',
  spatial: true,
  priority: 2,
  key: (p) => `e|sn|l${lvlBucket(p)}`,
  gain: (p) => dbToGain(-16 + 8 * clamp01(p.level ?? 0.5)),
  recipe(raw) {
    const { level: L } = norm(raw, 0.5);
    const f = 360 - 120 * L;
    const ratios = [1, 2.01, 3.02, 4.04];
    const gains = [1, 0.5, 0.3, 0.2];
    const t60 = [0.6, 0.4, 0.25, 0.15];
    return {
      duration: 0.75,
      modes: ratios.map((r, i) =>
        note(f * r, gains[i], t60[i], 0, i === 0 ? { glide: { from: 1.18, time: 0.04 } } : {}),
      ),
      noise: [{ color: 'white', gain: 0.9, t60: 0.02, attack: 0.0002, filter: { type: 'highpass', freq: 3000 } }],
    };
  },
};

const trampoline: SoundEventDef = {
  id: 'trampoline',
  label: 'Trampoline',
  category: 'impacts',
  spatial: true,
  key: (p) => `e|tr|l${lvlBucket(p)}`,
  gain: (p) => dbToGain(-20 + 10 * clamp01(p.level ?? 0.5)),
  recipe(raw) {
    const { level: L } = norm(raw, 0.5);
    const f = 150 + 70 * L;
    return {
      duration: 0.7,
      modes: [
        note(f, 1, 0.38, 0, { glide: { from: 1.5, time: 0.05 }, vibrato: { rate: 14, depth: 0.09, t60: 0.35 } }),
        note(f * 2, 0.4, 0.3, 0, { glide: { from: 1.5, time: 0.05 }, vibrato: { rate: 14, depth: 0.09, t60: 0.3 } }),
        note(90, 0.7, 0.12),
      ],
      noise: [{ color: 'pink', gain: 0.25, t60: 0.03, filter: { type: 'bandpass', freq: 500, q: 0.8 } }],
    };
  },
};

const launch: SoundEventDef = {
  id: 'launch',
  label: 'Launch',
  category: 'impacts',
  spatial: true,
  priority: 2,
  key: (p) => `e|la|l${lvlBucket(p)}`,
  gain: (p) => dbToGain(-16 + 10 * clamp01(p.level ?? 0.5)),
  recipe(raw) {
    const { level: L } = norm(raw, 0.5);
    return {
      duration: 0.75,
      modes: [note(60, 1, 0.25, 0, { glide: { from: 2.5, time: 0.03 } }), note(120, 0.35, 0.15)],
      noise: [
        {
          color: 'pink',
          gain: 0.7,
          t60: 0.4,
          filter: { type: 'bandpass', freq: 350, freqEnd: 1200 + 1800 * L, q: 0.8 },
        },
        { color: 'white', gain: 0.5, t60: 0.02, attack: 0.0002, filter: { type: 'highpass', freq: 2000 } },
      ],
    };
  },
};

// Interface sounds: short, soft, and not positioned in the world.
const ui = (id: string, label: string, db: number, recipe: () => Recipe): SoundEventDef => ({
  id,
  label,
  category: 'ui',
  spatial: false,
  key: () => `u|${id}`,
  gain: () => dbToGain(db),
  recipe,
});

const uiSelect = ui('ui.select', 'Select', -26, () => ({
  duration: 0.12,
  modes: [note(1320, 1, 0.05), note(1980, 0.35, 0.035)],
}));
const uiPlace = ui('ui.place', 'Place', -22, () => ({
  duration: 0.3,
  modes: [
    ...[1, 2, 3].map((r, i) => note(523 * r, [1, 0.25, 0.1][i], 0.12)),
    ...[1, 2, 3].map((r, i) => note(784 * r, [1, 0.25, 0.1][i], 0.14, 0.05)),
  ],
}));
const uiDelete = ui('ui.delete', 'Delete', -23, () => ({
  duration: 0.3,
  modes: [...tone(440, [1, 0.25], 0.08), ...tone(294, [1, 0.25], 0.14, 0.06)],
}));
const uiError = ui('ui.error', 'Error', -20, () => ({
  duration: 0.4,
  modes: [
    ...[1, 3, 5].map((m, i) => note(196 * m, [1, 0.33, 0.2][i], 0.12)),
    ...[1, 3, 5].map((m, i) => note(196 * m, [1, 0.33, 0.2][i], 0.14, 0.11)),
  ],
  drive: 1.5,
}));
const uiSuccess = ui('ui.success', 'Success', -22, () => ({
  duration: 0.6,
  modes: [523, 659, 784].flatMap((f, i) => [note(f, 1, 0.25, i * 0.07), note(f * 2, 0.25, 0.15, i * 0.07)]),
}));
const uiToggle = ui('ui.toggle', 'Toggle', -26, () => ({
  duration: 0.1,
  modes: [note(880, 1, 0.04), note(1760, 0.3, 0.03)],
}));

let registered = false;
/** Register the built-in events (idempotent). */
export function registerBuiltinSoundEvents(): void {
  if (registered) return;
  registered = true;
  for (const def of [
    explosion,
    spawn,
    breaking,
    snap,
    trampoline,
    launch,
    uiSelect,
    uiPlace,
    uiDelete,
    uiError,
    uiSuccess,
    uiToggle,
  ])
    registerSoundEvent(def);
}
registerBuiltinSoundEvents();
