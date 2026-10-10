/** The seeded random number generator (src/core/rng.ts): mulberry32. */
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';

/** The canonical mulberry32, written independently of the class under test. */
function reference(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Rng (mulberry32)', () => {
  it('produces exactly the canonical mulberry32 stream', () => {
    for (const seed of [0, 1, 42, 0xdeadbeef, 0xffffffff]) {
      const r = new Rng(seed);
      const ref = reference(seed);
      for (let i = 0; i < 500; i++) expect(r.next()).toBe(ref());
    }
  });

  it('is deterministic per seed, and different seeds give different streams', () => {
    const a = new Rng(7);
    const b = new Rng(7);
    const c = new Rng(8);
    const sa = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 20 }, () => c.next())).not.toEqual(sa);
  });

  it('stays in [0, 1) and is roughly uniform (mean 0.5, deciles within 15% of even)', () => {
    const r = new Rng(123);
    const n = 20000;
    const bins = new Array<number>(10).fill(0);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      sum += x;
      bins[Math.floor(x * 10)]++;
    }
    expect(sum / n).toBeGreaterThan(0.49);
    expect(sum / n).toBeLessThan(0.51);
    for (const b of bins) expect(Math.abs(b - n / 10)).toBeLessThan((n / 10) * 0.15);
  });

  it('state can be saved and resumed exactly; seed() restarts the stream', () => {
    const r = new Rng(99);
    for (let i = 0; i < 17; i++) r.next();
    const saved = r.state;
    const after = Array.from({ length: 10 }, () => r.next());
    const resumed = new Rng(0);
    resumed.state = saved;
    expect(Array.from({ length: 10 }, () => resumed.next())).toEqual(after);
    r.seed(99);
    expect(r.next()).toBe(reference(99)());
  });

  it('range / int / chance / normal draw from the same stream', () => {
    const r = new Rng(5);
    const ref = reference(5);
    expect(r.range(10, 20)).toBeCloseTo(10 + 10 * ref(), 12);
    expect(r.int(6)).toBe(Math.floor(ref() * 6));
    expect(r.chance(0.5)).toBe(ref() < 0.5);
    // normal(): two draws, mean ≈ 0, σ ≈ 1 over many samples
    const g = new Rng(11);
    const xs = Array.from({ length: 20000 }, () => g.normal());
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(sd - 1)).toBeLessThan(0.03);
    const h = new Rng(3);
    h.normal();
    const s = new Rng(3);
    s.next();
    s.next();
    expect(h.state).toBe(s.state);
  });
});
