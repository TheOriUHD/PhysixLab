import { describe, expect, it } from 'vitest';
import { MultiSeries } from '../src/ui/charts/series';
import { ExprError, compile, parse } from '../src/ui/charts/expr';
import type { ExprHost } from '../src/ui/charts/expr';
import { fft, findPeaks, formatHz, peakLabel, spectrum, windowCoefficients } from '../src/ui/charts/fft';
import { DerivedSignal, histogram, summarize, toCsv } from '../src/ui/charts/analysis';

describe('MultiSeries', () => {
  it('records rows, decimates at the source and overwrites the oldest when full', () => {
    const s = new MultiSeries(4, 0.1);
    const c = s.addChannel();
    expect(s.accept(0)).toBe(true);
    for (let k = 0; k < 6; k++) {
      const t = k * 0.1;
      expect(s.accept(t)).toBe(true);
      s.set(c, s.beginRow(t), k * 10);
      expect(s.accept(t + 0.05)).toBe(false); // too close: decimated
    }
    expect(s.length).toBe(4);
    expect(s.timeAt(0)).toBeCloseTo(0.2);
    expect(s.valueAt(c, 3)).toBe(50);
    expect(s.lastTime).toBeCloseTo(0.5);
  });

  it('finds rows by time and resamples onto a uniform grid', () => {
    const s = new MultiSeries(100, 0);
    const c = s.addChannel();
    // non-uniform sampling of v = 2t
    for (const t of [0, 0.3, 0.4, 1, 1.7, 2]) s.set(c, s.beginRow(t), 2 * t);
    expect(s.lowerBound(0.35)).toBe(2);
    expect(s.nearest(1.6)).toBe(4);
    const out = new Float64Array(5);
    expect(s.resampleUniform(c, 0, 2, out)).toBe(true);
    expect(Array.from(out).map((v) => +v.toFixed(6))).toEqual([0, 1, 2, 3, 4]);
  });

  it('late channels read NaN for earlier rows; resize keeps the newest rows', () => {
    const s = new MultiSeries(10, 0);
    const a = s.addChannel();
    s.set(a, s.beginRow(0), 1);
    const b = s.addChannel();
    s.set(a, s.beginRow(1), 2);
    s.set(b, 1, 5);
    expect(Number.isNaN(s.valueAt(b, 0))).toBe(true);
    s.set(a, s.beginRow(2), 3);
    s.resize(2);
    expect(s.length).toBe(2);
    expect(s.timeAt(0)).toBe(1);
    expect(s.valueAt(b, 0)).toBe(5);
    s.removeChannel(a);
    expect(s.channels).toBe(1);
  });
});

/** A tiny host: bodies a and b with a scripted speed and mass. */
function host(vals: Record<string, { speed: number; mass: number }>): ExprHost {
  const arity = (n: string) => (n === 'time0' ? 0 : 1);
  return {
    hasSignal: (n) => ['speed', 'mass', 'time0'].includes(n),
    signalArity: arity,
    time: () => 3,
    signal(name, ref) {
      if (name === 'time0') return () => 7;
      const v = ref ? vals[ref] : undefined;
      if (!v) throw new Error(`No body called "${ref}"`);
      return name === 'speed' ? () => v.speed : () => v.mass;
    },
  };
}

describe('expression evaluator', () => {
  const vals = { a: { speed: 5, mass: 2 }, b: { speed: 3, mass: 1 }, 'My box': { speed: 1, mass: 4 } };
  const ev = (s: string) => compile(s, host(vals)).eval();

  it('evaluates the examples from the spec', () => {
    expect(ev('speed(a) - speed(b)')).toBe(2);
    expect(ev('0.5*mass(a)*speed(a)^2')).toBe(25);
    expect(ev('speed("My box") * 2')).toBe(2);
  });

  it('has correct precedence and associativity', () => {
    expect(ev('2 + 3 * 4')).toBe(14);
    expect(ev('-2^2')).toBe(-4);
    expect(ev('2^3^2')).toBe(512);
    expect(ev('(2 + 3) * 4 % 7')).toBe(6);
    expect(ev('10 - 4 - 3')).toBe(3);
    expect(ev('1e3 / 4')).toBe(250);
    expect(ev('max(1, 5, speed(b)) + clamp(9, 0, 2) + hypot(3, 4)')).toBe(12);
    expect(ev('t + time0() + pi - pi')).toBeCloseTo(10);
    expect(ev('sqrt(16) + abs(-1) + atan2(0, 1)')).toBe(5);
  });

  it('reports errors with a position instead of throwing something obscure', () => {
    const bad = (s: string): ExprError => {
      try {
        compile(s, host(vals));
      } catch (e) {
        return e as ExprError;
      }
      throw new Error(`"${s}" should not compile`);
    };
    expect(bad('speed(zzz)').message).toMatch(/No body called "zzz"/);
    expect(bad('foo(1)').message).toMatch(/Unknown function "foo"/);
    expect(bad('1 +').message).toMatch(/ends early/);
    expect(bad('(1').message).toMatch(/Expected "\)"/);
    expect(bad('speed(a').message).toMatch(/Expected "\)"/);
    expect(bad('speed(1)').message).toMatch(/needs a body/);
    expect(bad('speed()').message).toMatch(/takes one body/);
    expect(bad('a').message).toMatch(/Unknown name/);
    expect(bad('1 $ 2').pos).toBeGreaterThan(0);
    expect(bad('').message).toMatch(/Empty/);
    expect(bad('sin(1,2)').message).toMatch(/one argument/);
  });

  it('is not an eval: code-like input is just a syntax error', () => {
    for (const s of ['process.exit()', 'constructor.constructor("return 1")()', '__proto__', 'a.b', 'alert(1);']) {
      expect(() => compile(s, host(vals))).toThrow(ExprError);
    }
    expect(parse('speed(a)')).toMatchObject({ k: 'call', name: 'speed' });
  });

  it('collects references and signals', () => {
    const c = compile('speed(a) + mass(b)', host(vals));
    expect(c.refs).toEqual(['a', 'b']);
    expect(c.signals).toEqual(['speed', 'mass']);
  });
});

describe('FFT', () => {
  it('matches a naive DFT', () => {
    const n = 16;
    const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1) + i / n);
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    fft(re, im);
    for (let k = 0; k < n; k++) {
      let sr = 0,
        si = 0;
      for (let j = 0; j < n; j++) {
        sr += x[j] * Math.cos((2 * Math.PI * j * k) / n);
        si -= x[j] * Math.sin((2 * Math.PI * j * k) / n);
      }
      expect(re[k]).toBeCloseTo(sr, 9);
      expect(im[k]).toBeCloseTo(si, 9);
    }
    expect(() => fft(new Float64Array(6), new Float64Array(6))).toThrow();
  });

  it('window functions have the textbook shape', () => {
    const w = new Float64Array(9);
    windowCoefficients('hann', w);
    expect(w[0]).toBeCloseTo(0);
    expect(w[4]).toBeCloseTo(1);
    windowCoefficients('hamming', w);
    expect(w[0]).toBeCloseTo(0.08);
    windowCoefficients('blackman', w);
    expect(w[0]).toBeCloseTo(0, 9);
    expect(w[4]).toBeCloseTo(1);
    windowCoefficients('rect', w);
    expect(Array.from(w).every((v) => v === 1)).toBe(true);
  });

  it('a sampled 2 Hz oscillator (64 Hz, 8 s) peaks at 2 Hz with the right amplitude, for every window', () => {
    const fs = 64;
    const n = 8 * fs;
    const x = Float64Array.from({ length: n }, (_, i) => 1.5 * Math.sin((2 * Math.PI * 2 * i) / fs + 0.4) + 10);
    for (const win of ['rect', 'hann', 'hamming', 'blackman'] as const) {
      const sp = spectrum(x, fs, { window: win });
      const peaks = findPeaks(sp);
      expect(peaks.length).toBeGreaterThan(0);
      expect(Math.abs(peaks[0].freq - 2)).toBeLessThanOrEqual(sp.df);
      expect(peaks[0].mag).toBeGreaterThan(1.3);
      expect(peaks[0].mag).toBeLessThan(1.7);
    }
    expect(peakLabel(findPeaks(spectrum(x, fs))[0])).toMatch(/^2\.00 Hz · T 0\.50/);
  });

  it('resolves two tones and does not call the DC offset a peak', () => {
    const fs = 100;
    const x = Float64Array.from(
      { length: 1000 },
      (_, i) => 3 + Math.sin((2 * Math.PI * 5 * i) / fs) + 0.5 * Math.sin((2 * Math.PI * 12.5 * i) / fs),
    );
    const peaks = findPeaks(spectrum(x, fs, { window: 'blackman' }), 3, 0.2);
    expect(peaks.map((p) => Math.round(p.freq * 10) / 10)).toEqual([5, 12.5]);
  });

  it('formats frequencies', () => {
    expect(formatHz(2)).toBe('2.00 Hz');
    expect(formatHz(0.25)).toBe('250 mHz');
    expect(formatHz(1500)).toBe('1.50 kHz');
  });
});

describe('derived signals, statistics, histogram, CSV', () => {
  const sample = (f: (t: number) => number, n = 201, dt = 0.01) => {
    const s = new MultiSeries(n + 5, 0);
    const c = s.addChannel();
    for (let i = 0; i < n; i++) s.set(c, s.beginRow(i * dt), f(i * dt));
    return { s, c };
  };

  it('derivative and integral of a sine', () => {
    const d = new DerivedSignal('derivative');
    const itg = new DerivedSignal('integral');
    let dv = 0,
      iv = 0;
    for (let i = 0; i <= 100; i++) {
      const t = i * 0.01;
      dv = d.step(t, Math.sin(t));
      iv = itg.step(t, Math.sin(t));
    }
    expect(dv).toBeCloseTo(Math.cos(1), 2);
    expect(iv).toBeCloseTo(1 - Math.cos(1), 4);
  });

  it('running rms / mean / min / max', () => {
    const ops = (['rms', 'mean', 'min', 'max'] as const).map((o) => new DerivedSignal(o));
    let last: number[] = [];
    for (let i = 0; i <= 200; i++) {
      const t = i * 0.01;
      last = ops.map((o) => o.step(t, 2 * Math.sin(2 * Math.PI * t)));
    }
    expect(last[0]).toBeCloseTo(Math.SQRT2, 1); // RMS of 2·sin over whole periods
    expect(Math.abs(last[1])).toBeLessThan(0.01);
    expect(last[2]).toBeCloseTo(-2, 2);
    expect(last[3]).toBeCloseTo(2, 2);
  });

  it('summary statistics', () => {
    const { s, c } = sample((t) => 3 * t + 1, 101);
    const st = summarize(s, c)!;
    expect(st.min).toBeCloseTo(1);
    expect(st.max).toBeCloseTo(4);
    expect(st.mean).toBeCloseTo(2.5);
    expect(st.slope).toBeCloseTo(3);
    expect(st.integral).toBeCloseTo(2.5);
    expect(st.last).toBeCloseTo(4);
    expect(summarize(new MultiSeries(4), 0)).toBeNull();
  });

  it('histogram bins every value once', () => {
    const { s, c } = sample((t) => Math.round(t * 100) % 4, 100);
    const h = histogram(s, c, 4);
    expect(h.total).toBe(100);
    expect(Array.from(h.counts).reduce((a, b) => a + b, 0)).toBe(100);
    expect(h.counts[0]).toBe(25);
    expect(h.lo).toBe(0);
    expect(h.width).toBeCloseTo(0.75);
    expect(histogram(s, c, 3, 0, 100, [10, 20]).total).toBe(0);
  });

  it('CSV has a header with units, quotes awkward names and carries markers', () => {
    const s = new MultiSeries(10, 0);
    const a = s.addChannel();
    const b = s.addChannel();
    for (let i = 0; i < 3; i++) {
      const r = s.beginRow(i * 0.5);
      s.set(a, r, i * 1.25);
      if (i > 0) s.set(b, r, -i);
    }
    const csv = toCsv(
      s,
      [
        { name: 'speed(box)', unit: 'm/s', channel: a },
        { name: 'a, "b"', unit: '', channel: b },
      ],
      [{ t: 0.4, text: 'hit' }],
    );
    expect(csv.split('\n')).toEqual([
      'time [s],speed(box) [m/s],"a, ""b""",marker',
      '0,0,,',
      '0.5,1.25,-1,hit',
      '1,2.5,-2,',
      '',
    ]);
  });
});
