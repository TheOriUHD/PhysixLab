/**
 * Seeded random numbers for the simulation: mulberry32, a 32-bit generator whose whole state is one integer.
 *
 * Everything stochastic in a scene (spawner jitter, sensor noise, wind gusts …) must draw from the world's `Rng`
 * (`ctx.random()` for components), which is seeded from `SceneSettings.seed` — never from `Math.random()` — so that
 * the same scene with the same seed plays out identically, and a snapshot can restore the exact stream by saving the
 * state (`Rng.state`).
 */
export class Rng {
  private s: number;

  constructor(seed = 1) {
    this.s = seed >>> 0;
  }

  /** The generator state (an unsigned 32-bit integer). Setting it resumes the stream from that point. */
  get state(): number {
    return this.s;
  }
  set state(v: number) {
    this.s = v >>> 0;
  }

  /** Restart the stream from `seed`. */
  seed(seed: number): void {
    this.s = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Normally distributed (Box–Muller; always draws two numbers, so the state alone describes the stream). */
  normal(mean = 0, sigma = 1): number {
    const u = 1 - this.next(); // (0, 1]
    const v = this.next();
    return mean + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
