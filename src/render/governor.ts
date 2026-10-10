/**
 * VZ-22: the Auto quality governor. It watches a rolling average of the frame time and walks a ladder of
 * (tier, resolution scale) steps: down quickly when frames are slow, up slowly and only when there is clear
 * headroom (hysteresis: a wide gap between the two thresholds, a cool-down after every change, and an upgrade
 * delay that doubles each time an upgrade had to be undone). Pure: the viewport feeds it frame times.
 */
import { QUALITY_TIERS, tierIndex, type QualityTier } from './graphics';

export interface Step {
  tier: QualityTier;
  /** Multiplier on the pixel ratio. */
  scale: number;
}

/** Best → cheapest. */
export const LADDER: readonly Step[] = [
  { tier: 'ultra', scale: 1 },
  { tier: 'high', scale: 1 },
  { tier: 'high', scale: 0.8 },
  { tier: 'medium', scale: 0.8 },
  { tier: 'medium', scale: 0.65 },
  { tier: 'low', scale: 0.65 },
  { tier: 'low', scale: 0.5 },
];

export interface GovernorOptions {
  /** Frame time the governor aims at, ms. */
  targetMs: number;
  /** Slower than target × this for `downAfter` seconds → step down. */
  slowFactor: number;
  /** Faster than target × this for `upAfter` seconds → step up. */
  fastFactor: number;
  downAfter: number;
  upAfter: number;
  cooldown: number;
}

export const DEFAULT_GOVERNOR: GovernorOptions = {
  targetMs: 1000 / 50,
  slowFactor: 1.25,
  fastFactor: 0.6,
  downAfter: 1.2,
  upAfter: 6,
  cooldown: 3,
};

/** Ladder index of the first step whose tier is `tier` (the best step at that tier). */
export function startLevel(tier: QualityTier): number {
  const i = LADDER.findIndex((s) => s.tier === tier);
  return i < 0 ? 0 : i;
}

export class Governor {
  /** Index into LADDER currently in force. */
  level: number;
  /** The best level the governor may climb back to (the probe's guess). */
  readonly ceiling: number;
  private ema = 0;
  /** Slowly rising minimum frame time: the display's own refresh interval (vsync caps what a fast GPU can show). */
  private floorMs = Infinity;
  private slowFor = 0;
  private fastFor = 0;
  private sinceChange = 0;
  private upDelay: number;
  private lastDirection: 'up' | 'down' | null = null;

  constructor(
    start: QualityTier,
    private opts: GovernorOptions = DEFAULT_GOVERNOR,
  ) {
    this.level = this.ceiling = startLevel(start);
    this.upDelay = opts.upAfter;
  }

  get step(): Step {
    return LADDER[this.level];
  }

  get averageMs(): number {
    return this.ema;
  }

  /** Feed one frame (`dtSeconds` of wall time). Returns true when the step changed. */
  update(dtSeconds: number): boolean {
    // A hidden tab or a long stall is not a sign of an overloaded GPU.
    if (!(dtSeconds > 0) || dtSeconds > 0.5) return false;
    const ms = dtSeconds * 1000;
    this.ema = this.ema === 0 ? ms : this.ema + (ms - this.ema) * 0.08;
    this.floorMs = ms < this.floorMs ? ms : this.floorMs + (ms - this.floorMs) * 0.002;
    this.sinceChange += dtSeconds;
    const o = this.opts;
    if (this.ema > o.targetMs * o.slowFactor) {
      this.slowFor += dtSeconds;
      this.fastFor = 0;
    } else if (this.ema < Math.max(o.targetMs * o.fastFactor, Math.min(o.targetMs, this.floorMs * 1.25))) {
      this.fastFor += dtSeconds;
      this.slowFor = 0;
    } else {
      this.slowFor = this.fastFor = 0;
    }
    if (this.sinceChange < o.cooldown) return false;
    if (this.slowFor >= o.downAfter && this.level < LADDER.length - 1) {
      // An upgrade that did not hold: wait longer before trying again.
      if (this.lastDirection === 'up') this.upDelay = Math.min(60, this.upDelay * 2);
      return this.move(+1, 'down');
    }
    if (this.fastFor >= this.upDelay && this.level > this.ceiling) return this.move(-1, 'up');
    return false;
  }

  private move(delta: number, dir: 'up' | 'down'): boolean {
    this.level += delta;
    this.lastDirection = dir;
    this.sinceChange = this.slowFor = this.fastFor = 0;
    // The average belongs to the old settings: start measuring again.
    this.ema = 0;
    return true;
  }

  /** Jump to a tier's best step (a manual choice) and forget the history. */
  reset(tier: QualityTier): void {
    this.level = startLevel(tier);
    (this as { ceiling: number }).ceiling = this.level;
    this.ema = this.slowFor = this.fastFor = this.sinceChange = 0;
    this.upDelay = this.opts.upAfter;
    this.lastDirection = null;
  }
}

export { QUALITY_TIERS, tierIndex };
