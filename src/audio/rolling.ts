/**
 * Rolling and sliding noise (FX-12), as a mapping from what the simulation knows about a body on the ground to the
 * parameters of two filtered-noise layers:
 *
 *   - a **rumble** — low-pass noise for a rounded body rolling without slipping. Its level follows the rolling speed
 *     and the load, its cutoff opens with speed (a faster tyre hums higher);
 *   - a **scrape** — band-pass noise for a surface sliding over the ground, driven by the *slip* speed (the speed of
 *     the contact point itself, see `render/fx/slip.ts`), with a material-dependent centre frequency and resonance
 *     (rubber squeals, metal screeches, stone rasps).
 *
 * A ball rolling freely is all rumble (its slip is zero); a box dragged along the floor is all scrape; a wheel locked
 * by the brakes goes from one to the other. The contact load is the body's weight (the engine does not report contact
 * forces), so a heavier body is louder, on a logarithmic scale: 10 N is faint, 20 kN is full.
 */
import { clamp, clamp01, smoothstep } from './mapping';
import type { SoundClass } from './materials';

export interface RollInput {
  cls: SoundClass;
  /** Horizontal speed of the centre of mass, m/s. */
  speed: number;
  /** Speed of the contact point over the ground, m/s (0 = rolling without slipping). */
  slip: number;
  /** Normal load, N (the weight). */
  load: number;
  /** Characteristic size, metres. */
  size: number;
  /** Round (sphere, cylinder, capsule, cone): can roll; others can only slide. */
  rounded: boolean;
}

export interface RollParams {
  rumbleGain: number;
  rumbleCutoff: number;
  scrapeGain: number;
  scrapeFreq: number;
  scrapeQ: number;
  /** max(rumble, scrape): what voices are ranked by. */
  loudness: number;
}

export const newRollParams = (): RollParams => ({
  rumbleGain: 0,
  rumbleCutoff: 200,
  scrapeGain: 0,
  scrapeFreq: 1000,
  scrapeQ: 1,
  loudness: 0,
});

interface RollClass {
  rumble: number;
  bright: number;
  scrape: number;
  scrapeFreq: number;
  q: number;
}

const CLASSES: Record<SoundClass, RollClass> = {
  metal: { rumble: 0.8, bright: 1, scrape: 1, scrapeFreq: 2400, q: 2.2 },
  wood: { rumble: 0.9, bright: 0.55, scrape: 0.8, scrapeFreq: 900, q: 1.2 },
  glass: { rumble: 0.5, bright: 0.9, scrape: 0.6, scrapeFreq: 3200, q: 3 },
  stone: { rumble: 1, bright: 0.6, scrape: 1, scrapeFreq: 1100, q: 1 },
  ceramic: { rumble: 0.7, bright: 0.75, scrape: 0.8, scrapeFreq: 2000, q: 1.8 },
  rubber: { rumble: 0.55, bright: 0.35, scrape: 1.1, scrapeFreq: 1700, q: 4 },
  plastic: { rumble: 0.6, bright: 0.7, scrape: 0.7, scrapeFreq: 1800, q: 1.5 },
  foam: { rumble: 0.15, bright: 0.25, scrape: 0.2, scrapeFreq: 500, q: 0.8 },
  ice: { rumble: 0.35, bright: 0.8, scrape: 0.5, scrapeFreq: 3600, q: 2.5 },
  ground: { rumble: 0.6, bright: 0.5, scrape: 0.6, scrapeFreq: 800, q: 1 },
};

/** Loudness factor of a load: 10 N → 0.35, 20 kN → 1 (logarithmic). */
export function loadFactor(load: number): number {
  const x = clamp01(Math.log10(Math.max(10, load) / 10) / 3.3);
  return 0.35 + 0.65 * x;
}

const MAX_LEVEL = 0.5;

/** Below this loudness a rolling voice is not worth a place. */
export const ROLL_AUDIBLE = 0.012;

export function rollParams(i: RollInput, out: RollParams): RollParams {
  const c = CLASSES[i.cls];
  const lf = loadFactor(i.load);
  const sf = clamp(Math.pow(0.5 / Math.max(0.05, i.size), 0.3), 0.6, 1.6);
  // Rolling: a rounded body moving without sliding. Its share shrinks as the contact point starts to slip.
  const rollShare = i.rounded ? clamp01(1 - i.slip / (i.speed + 0.5)) : 0;
  const rumbleDrive = smoothstep(0.25, 7, i.speed) * rollShare;
  const scrapeDrive = smoothstep(0.3, 6, i.slip);
  out.rumbleGain = MAX_LEVEL * c.rumble * rumbleDrive * lf;
  out.rumbleCutoff = clamp((140 + 900 * Math.pow(Math.max(0, i.speed) / 8, 0.8)) * c.bright * sf, 90, 3500);
  out.scrapeGain = MAX_LEVEL * c.scrape * scrapeDrive * lf;
  out.scrapeFreq = c.scrapeFreq * sf * (0.8 + 0.5 * clamp01(i.slip / 10));
  out.scrapeQ = c.q;
  out.loudness = Math.max(out.rumbleGain, out.scrapeGain);
  return out;
}
