/**
 * Settings of the visual-effects system: the user-facing switches (stored in the preferences) and the quality tiers
 * that turn them into budgets. Pure data — no three.js, no DOM — so the sanitiser and the tier table are unit-tested
 * in Node and the preferences can validate whatever a stale or hand-edited localStorage entry contains.
 */

/** `auto` follows the graphics quality of the viewport (View menu). */
export type FxQuality = 'auto' | 'low' | 'medium' | 'high';
export type FxTierId = 'low' | 'medium' | 'high';

export interface FxSettings {
  /** Master switch: off = nothing is emitted, drawn or tracked, and the physics is asked for no extra events. */
  enabled: boolean;
  quality: FxQuality;
  /** Overall amount of particles and size of the effects, 0.25 … 2. */
  intensity: number;
  /** Sparks, dust, chips, shards and scuffs from impacts (FX-2). */
  impacts: boolean;
  /** Dust trails behind fast bodies and tyre smoke from slipping wheels (FX-3). */
  trails: boolean;
  /** Persistent skid marks on the ground (FX-4). */
  skidMarks: boolean;
  /** Blast tool and projectile explosions: fireball, shock ring, smoke, light flash (FX-5). */
  explosions: boolean;
  /** Short-lived visual chips from hard hits on brittle materials (FX-6). */
  debris: boolean;
  /** Also spawn a few real, capped, auto-cleaned rigid fragments from the hardest hits (FX-6). Off by default. */
  physicalDebris: boolean;
}

export const DEFAULT_FX_SETTINGS: FxSettings = {
  enabled: true,
  quality: 'auto',
  intensity: 1,
  impacts: true,
  trails: true,
  skidMarks: true,
  explosions: true,
  debris: true,
  physicalDebris: false,
};

export const FX_INTENSITY_RANGE = { min: 0.25, max: 2 } as const;

/** What a quality tier allows. */
export interface FxTier {
  id: FxTierId;
  label: string;
  /** One line for the UI. */
  blurb: string;
  /** Live particles over both blend batches. */
  maxParticles: number;
  /** Multiplies every particle count. */
  emission: number;
  /** Impact bursts spawned per rendered frame (the strongest ones win). */
  burstsPerFrame: number;
  /** Skid-mark segments kept (the oldest are overwritten). */
  skidSegments: number;
  /** Real point-light flash for explosions. */
  lightFlash: boolean;
  /** Effects farther than this from the camera are not spawned (metres). */
  maxDistance: number;
  /** Concurrent physical debris bodies. */
  physicalDebrisCap: number;
}

export const FX_TIERS: Record<FxTierId, FxTier> = {
  low: {
    id: 'low',
    label: 'Low',
    blurb: 'Up to 1,500 particles, 4 impact bursts per frame, no light flash',
    maxParticles: 1500,
    emission: 0.55,
    burstsPerFrame: 4,
    skidSegments: 700,
    lightFlash: false,
    maxDistance: 70,
    physicalDebrisCap: 8,
  },
  medium: {
    id: 'medium',
    label: 'Medium',
    blurb: 'Up to 6,000 particles, 12 impact bursts per frame, light flash',
    maxParticles: 6000,
    emission: 1,
    burstsPerFrame: 12,
    skidSegments: 2500,
    lightFlash: true,
    maxDistance: 140,
    physicalDebrisCap: 24,
  },
  high: {
    id: 'high',
    label: 'High',
    blurb: 'Up to 14,000 particles, 32 impact bursts per frame, light flash',
    maxParticles: 14000,
    emission: 1.4,
    burstsPerFrame: 32,
    skidSegments: 7000,
    lightFlash: true,
    maxDistance: 260,
    physicalDebrisCap: 64,
  },
};

/** The largest capacity any tier uses: buffers are allocated once for it. */
export const FX_MAX_PARTICLES = FX_TIERS.high.maxParticles;
export const FX_MAX_SKID_SEGMENTS = FX_TIERS.high.skidSegments;

/** The tier an `FxQuality` setting resolves to, given the viewport's graphics quality. */
export function resolveTier(quality: FxQuality, graphics: FxTierId): FxTier {
  return FX_TIERS[quality === 'auto' ? graphics : quality];
}

type BoolKey = { [K in keyof FxSettings]: FxSettings[K] extends boolean ? K : never }[keyof FxSettings];

const QUALITIES: readonly FxQuality[] = ['auto', 'low', 'medium', 'high'];

/** Coerce whatever was stored (or a partial patch) into a complete, valid `FxSettings`. */
export function sanitizeFxSettings(raw: unknown, base: FxSettings = DEFAULT_FX_SETTINGS): FxSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const bool = (k: BoolKey): boolean => {
    const v = r[k];
    return typeof v === 'boolean' ? v : base[k];
  };
  const q = r.quality;
  const intensity = typeof r.intensity === 'number' && Number.isFinite(r.intensity) ? r.intensity : base.intensity;
  return {
    enabled: bool('enabled'),
    quality: QUALITIES.includes(q as FxQuality) ? (q as FxQuality) : base.quality,
    intensity: Math.min(FX_INTENSITY_RANGE.max, Math.max(FX_INTENSITY_RANGE.min, intensity)),
    impacts: bool('impacts'),
    trails: bool('trails'),
    skidMarks: bool('skidMarks'),
    explosions: bool('explosions'),
    debris: bool('debris'),
    physicalDebris: bool('physicalDebris'),
  };
}
