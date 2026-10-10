/**
 * VZ-20 / VZ-22: graphics settings. `GraphicsOptions` is what the user stored (per user, in prefs): each effect has a
 * tri-state `on` — `null` follows the quality tier, `true` / `false` force it — plus its parameters. `resolveGraphics`
 * turns options + the tier that is currently in force (a fixed choice, or what the Auto governor picked) into the
 * concrete `ResolvedGraphics` the renderer applies. Pure TypeScript: unit-tested in Node.
 */
import { clamp } from '../core/math';

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';
export type QualityChoice = QualityTier | 'auto';
export const QUALITY_TIERS: readonly QualityTier[] = ['low', 'medium', 'high', 'ultra'];
export const QUALITY_CHOICES: readonly QualityChoice[] = ['auto', ...QUALITY_TIERS];
export type AAMode = 'none' | 'fxaa' | 'smaa' | 'msaa';
export const AA_MODES: readonly AAMode[] = ['none', 'fxaa', 'smaa', 'msaa'];

export type EffectId =
  'ao' | 'bloom' | 'dof' | 'motionBlur' | 'ssr' | 'godRays' | 'vignette' | 'aberration' | 'grain' | 'grading';

export const EFFECT_IDS: readonly EffectId[] = [
  'ao',
  'bloom',
  'ssr',
  'godRays',
  'dof',
  'motionBlur',
  'vignette',
  'aberration',
  'grain',
  'grading',
];

/** Lowest tier at which an effect is on by default (a user override wins over this); 'never' = opt-in only. */
export const EFFECT_DEFAULT_TIER: Record<EffectId, QualityTier | 'never'> = {
  ao: 'high',
  bloom: 'high',
  ssr: 'ultra',
  godRays: 'ultra',
  dof: 'never',
  motionBlur: 'ultra',
  vignette: 'medium',
  aberration: 'never',
  grain: 'never',
  grading: 'never',
};

export interface EffectParams {
  ao: { radius: number; intensity: number };
  bloom: { threshold: number; strength: number; radius: number };
  ssr: { intensity: number; maxDistance: number };
  godRays: { intensity: number; decay: number };
  dof: { focusMode: 'target' | 'manual'; focusDistance: number; aperture: number; maxBlur: number };
  motionBlur: { strength: number };
  vignette: { amount: number; softness: number };
  aberration: { amount: number };
  grain: { amount: number };
  grading: { exposure: number; contrast: number; saturation: number; temperature: number };
}

export type EffectOptions<K extends EffectId> = { on: boolean | null } & EffectParams[K];

export interface GraphicsOptions {
  /** 'auto' lets the quality tier choose. */
  aa: AAMode | 'auto';
  /** Multiplier on the device pixel ratio (the Auto governor scales it further under load). */
  resolutionScale: number;
  shadows: { enabled: boolean | null; resolution: 'auto' | 1024 | 2048 | 4096 | 8192; softness: number };
  /** Draw identical bodies through shared InstancedMeshes (VZ-30). */
  instancing: boolean;
  /** Cheaper meshes for small / distant round bodies (VZ-31). */
  lod: boolean;
  ao: EffectOptions<'ao'>;
  bloom: EffectOptions<'bloom'>;
  ssr: EffectOptions<'ssr'>;
  godRays: EffectOptions<'godRays'>;
  dof: EffectOptions<'dof'>;
  motionBlur: EffectOptions<'motionBlur'>;
  vignette: EffectOptions<'vignette'>;
  aberration: EffectOptions<'aberration'>;
  grain: EffectOptions<'grain'>;
  grading: EffectOptions<'grading'>;
}

export const DEFAULT_GRAPHICS: GraphicsOptions = {
  aa: 'auto',
  resolutionScale: 1,
  shadows: { enabled: null, resolution: 'auto', softness: 0.5 },
  instancing: true,
  lod: true,
  ao: { on: null, radius: 0.6, intensity: 0.9 },
  bloom: { on: null, threshold: 1.0, strength: 0.35, radius: 0.5 },
  ssr: { on: null, intensity: 0.5, maxDistance: 12 },
  godRays: { on: null, intensity: 0.5, decay: 0.95 },
  dof: { on: null, focusMode: 'target', focusDistance: 10, aperture: 0.35, maxBlur: 12 },
  motionBlur: { on: null, strength: 0.6 },
  vignette: { on: null, amount: 0.3, softness: 0.55 },
  aberration: { on: null, amount: 0.004 },
  grain: { on: null, amount: 0.05 },
  grading: { on: null, exposure: 0, contrast: 1, saturation: 1, temperature: 0 },
};

export function cloneGraphics(g: GraphicsOptions): GraphicsOptions {
  return {
    ...g,
    shadows: { ...g.shadows },
    ao: { ...g.ao },
    bloom: { ...g.bloom },
    ssr: { ...g.ssr },
    godRays: { ...g.godRays },
    dof: { ...g.dof },
    motionBlur: { ...g.motionBlur },
    vignette: { ...g.vignette },
    aberration: { ...g.aberration },
    grain: { ...g.grain },
    grading: { ...g.grading },
  };
}

// ---- sanitising -----------------------------------------------------------------------------------------------

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function nm(v: unknown, d: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d;
}
function tri(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** Validate whatever a stored preference file carries: unknown keys are dropped, numbers clamped, enums repaired. */
export function sanitizeGraphics(raw: unknown): GraphicsOptions {
  const r = rec(raw);
  const d = DEFAULT_GRAPHICS;
  const eff = <K extends EffectId>(id: K, f: (o: Record<string, unknown>) => EffectParams[K]): EffectOptions<K> => {
    const o = rec(r[id]);
    return { on: tri(o.on), ...f(o) };
  };
  const sh = rec(r.shadows);
  const res = sh.resolution;
  return {
    aa: (AA_MODES as readonly unknown[]).includes(r.aa) ? (r.aa as AAMode) : 'auto',
    resolutionScale: nm(r.resolutionScale, d.resolutionScale, 0.5, 1),
    shadows: {
      enabled: tri(sh.enabled),
      resolution: res === 1024 || res === 2048 || res === 4096 || res === 8192 ? res : 'auto',
      softness: nm(sh.softness, d.shadows.softness, 0, 1),
    },
    instancing: typeof r.instancing === 'boolean' ? r.instancing : d.instancing,
    lod: typeof r.lod === 'boolean' ? r.lod : d.lod,
    ao: eff('ao', (o) => ({
      radius: nm(o.radius, d.ao.radius, 0.1, 3),
      intensity: nm(o.intensity, d.ao.intensity, 0, 1),
    })),
    bloom: eff('bloom', (o) => ({
      threshold: nm(o.threshold, d.bloom.threshold, 0, 3),
      strength: nm(o.strength, d.bloom.strength, 0, 3),
      radius: nm(o.radius, d.bloom.radius, 0, 1),
    })),
    ssr: eff('ssr', (o) => ({
      intensity: nm(o.intensity, d.ssr.intensity, 0, 1),
      maxDistance: nm(o.maxDistance, d.ssr.maxDistance, 1, 100),
    })),
    godRays: eff('godRays', (o) => ({
      intensity: nm(o.intensity, d.godRays.intensity, 0, 2),
      decay: nm(o.decay, d.godRays.decay, 0.8, 0.99),
    })),
    dof: eff('dof', (o) => ({
      focusMode: o.focusMode === 'manual' ? 'manual' : 'target',
      focusDistance: nm(o.focusDistance, d.dof.focusDistance, 0.2, 500),
      aperture: nm(o.aperture, d.dof.aperture, 0, 1),
      maxBlur: nm(o.maxBlur, d.dof.maxBlur, 1, 32),
    })),
    motionBlur: eff('motionBlur', (o) => ({ strength: nm(o.strength, d.motionBlur.strength, 0, 2) })),
    vignette: eff('vignette', (o) => ({
      amount: nm(o.amount, d.vignette.amount, 0, 1),
      softness: nm(o.softness, d.vignette.softness, 0.1, 1),
    })),
    aberration: eff('aberration', (o) => ({ amount: nm(o.amount, d.aberration.amount, 0, 0.02) })),
    grain: eff('grain', (o) => ({ amount: nm(o.amount, d.grain.amount, 0, 0.3) })),
    grading: eff('grading', (o) => ({
      exposure: nm(o.exposure, d.grading.exposure, -3, 3),
      contrast: nm(o.contrast, d.grading.contrast, 0.5, 1.8),
      saturation: nm(o.saturation, d.grading.saturation, 0, 2),
      temperature: nm(o.temperature, d.grading.temperature, -1, 1),
    })),
  };
}

// ---- resolving ------------------------------------------------------------------------------------------------

export interface ResolvedGraphics {
  tier: QualityTier;
  aa: AAMode;
  msaaSamples: number;
  /** Final pixel ratio multiplier (device ratio cap × options scale × governor scale applied by the viewport). */
  pixelRatioCap: number;
  shadows: { enabled: boolean; resolution: number; softness: number; contactHardening: boolean };
  instancing: boolean;
  lod: boolean;
  ao: ({ on: boolean } & EffectParams['ao']) | null;
  bloom: ({ on: boolean } & EffectParams['bloom']) | null;
  ssr: ({ on: boolean } & EffectParams['ssr']) | null;
  godRays: ({ on: boolean } & EffectParams['godRays']) | null;
  dof: ({ on: boolean } & EffectParams['dof']) | null;
  motionBlur: ({ on: boolean } & EffectParams['motionBlur']) | null;
  vignette: ({ on: boolean } & EffectParams['vignette']) | null;
  aberration: ({ on: boolean } & EffectParams['aberration']) | null;
  grain: ({ on: boolean } & EffectParams['grain']) | null;
  grading: ({ on: boolean } & EffectParams['grading']) | null;
}

export function tierIndex(t: QualityTier): number {
  return QUALITY_TIERS.indexOf(t);
}

/** Is the effect on at this tier given the user's tri-state? */
export function effectOn(id: EffectId, user: boolean | null, tier: QualityTier): boolean {
  if (user !== null) return user;
  const min = EFFECT_DEFAULT_TIER[id];
  return min !== 'never' && tierIndex(tier) >= tierIndex(min);
}

const TIER_AA: Record<QualityTier, AAMode> = { low: 'none', medium: 'fxaa', high: 'msaa', ultra: 'msaa' };
const TIER_SHADOW: Record<QualityTier, number> = { low: 1024, medium: 2048, high: 4096, ultra: 4096 };

export function resolveGraphics(o: GraphicsOptions, tier: QualityTier, maxSamples = 4): ResolvedGraphics {
  const aa = o.aa === 'auto' ? TIER_AA[tier] : o.aa;
  const pick = <K extends EffectId>(id: K): ({ on: boolean } & EffectParams[K]) | null => {
    const e = o[id];
    const on = effectOn(id, e.on, tier);
    return on ? { ...e, on } : null;
  };
  const shadowsOn = o.shadows.enabled ?? tier !== 'low';
  return {
    tier,
    aa,
    msaaSamples: aa === 'msaa' ? Math.min(tier === 'ultra' ? 8 : 4, maxSamples) : 0,
    pixelRatioCap: tier === 'low' ? 1 : 2,
    shadows: {
      enabled: shadowsOn,
      resolution: o.shadows.resolution === 'auto' ? TIER_SHADOW[tier] : o.shadows.resolution,
      softness: o.shadows.softness,
      contactHardening: tierIndex(tier) >= tierIndex('high'),
    },
    instancing: o.instancing,
    lod: o.lod,
    ao: pick('ao'),
    bloom: pick('bloom'),
    ssr: pick('ssr'),
    godRays: pick('godRays'),
    dof: pick('dof'),
    motionBlur: pick('motionBlur'),
    vignette: pick('vignette'),
    aberration: pick('aberration'),
    grain: pick('grain'),
    grading: pick('grading'),
  };
}

/** Which passes the post stack needs: a change here means the composer has to be rebuilt (not just re-tuned). */
export function passSignature(r: ResolvedGraphics): string {
  const fx = EFFECT_IDS.filter((id) => r[id]).join(',');
  return `${r.aa}:${r.msaaSamples}|${fx}`;
}

// ---- GPU probe ------------------------------------------------------------------------------------------------

/** First guess of the Auto tier from the WebGL renderer string (software GL is the headless / CI case). */
export function probeTier(rendererString: string, isMobile = false): QualityTier {
  const s = rendererString.toLowerCase();
  if (/swiftshader|llvmpipe|software|softpipe|microsoft basic render/.test(s)) return 'low';
  if (isMobile || /adreno|mali|powervr|apple gpu|videocore/.test(s)) return 'medium';
  if (/rtx|rx [5-9]\d{3}|radeon pro|geforce gtx 1[06-9]|geforce gtx 20|arc a[5-9]|apple m[1-9]/.test(s)) return 'ultra';
  if (/gtx|geforce|radeon|nvidia|quadro|apple m/.test(s)) return 'high';
  if (/intel|iris|uhd|hd graphics/.test(s)) return 'medium';
  return 'high';
}

/** The three-step tier older consumers (the effects package) understand: ultra counts as high, auto as what is in force. */
export function legacyTier(q: QualityChoice, active: QualityTier): 'low' | 'medium' | 'high' {
  const t = q === 'auto' ? active : q;
  return t === 'ultra' ? 'high' : t;
}
