/**
 * Procedural sound synthesis, as plain maths on `Float32Array`s — no WebAudio, no DOM, no sample files.
 *
 * A sound is a **recipe**: a handful of decaying sinusoidal *modes* (the ringing of a struck object: `a·e^(−t/τ)·sin(2πft)`),
 * *noise layers* shaped by a filter and an envelope (clicks, scrapes, puffs, whooshes) and *grains* (a spray of tiny
 * short modes: glass shattering, gravel). `renderRecipe` turns a recipe into mono samples, deterministically for a
 * seed, so the same key always yields the same sound and the tests can measure the waveform itself: the dominant
 * frequency, how fast it dies away, how loud it is. The engine (`engine.ts`) renders each distinct recipe once into
 * an `AudioBuffer` and plays it with a gain and a playback rate.
 *
 * Modes without a pitch glide or vibrato are rendered with a rotating phasor (one complex multiply per sample, no
 * trigonometry), which keeps the render of a 1.5 s, six-mode metal clang near a millisecond.
 */
import { Rng } from '../core/rng';

export type NoiseColor = 'white' | 'pink' | 'brown';

/** One decaying sinusoid. */
export interface ModeSpec {
  /** Frequency, Hz. */
  freq: number;
  /** Peak amplitude (linear, relative to the other layers). */
  gain: number;
  /** Seconds for the amplitude to fall by 60 dB. */
  t60: number;
  /** Onset, seconds from the start of the sound (default 0). */
  start?: number;
  /** The frequency starts at `freq · from` and settles to `freq` with time constant `time` seconds. */
  glide?: { from: number; time: number };
  /** Frequency modulation: `rate` Hz, `depth` as a fraction of the frequency, dying away with its own `t60`. */
  vibrato?: { rate: number; depth: number; t60: number };
  /** Fade-in, seconds (default 0.4 ms, which avoids a click without softening the strike). */
  attack?: number;
}

/** Filter applied to a noise layer. `freqEnd` sweeps the cutoff exponentially from `freq` over the sound's duration. */
export interface NoiseFilter {
  type: 'lowpass' | 'highpass' | 'bandpass';
  freq: number;
  q?: number;
  freqEnd?: number;
}

export interface NoiseSpec {
  color: NoiseColor;
  gain: number;
  /** Seconds for the envelope to fall by 60 dB after the attack. */
  t60: number;
  attack?: number;
  /** Onset, seconds. */
  start?: number;
  filter?: NoiseFilter;
}

/** A spray of `count` short modes at random times in `[start, start + spread]` and random log-uniform frequencies. */
export interface GrainSpec {
  count: number;
  start?: number;
  spread: number;
  fMin: number;
  fMax: number;
  gain: number;
  /** Seconds to fall 60 dB for one grain (jittered ±40 %). */
  t60: number;
}

export interface Recipe {
  /** Length of the rendered buffer, seconds. */
  duration: number;
  modes?: readonly ModeSpec[];
  noise?: readonly NoiseSpec[];
  grains?: readonly GrainSpec[];
  /** Soft-clip drive (tanh) applied to the mix; 0 / undefined = none. */
  drive?: number;
  /** Peak level after normalising (default 0.9). Normalising makes loudness the player's job, not the recipe's. */
  peak?: number;
}

const TAU = Math.PI * 2;
const LN1000 = Math.log(1000); // 60 dB = a factor of 1000 in amplitude

// -- biquad filter (RBJ cookbook) ------------------------------------------------------------------------------------

export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  set(type: NoiseFilter['type'], freq: number, q: number, sampleRate: number): void {
    const f = Math.min(sampleRate * 0.45, Math.max(10, freq));
    const w = (TAU * f) / sampleRate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(0.05, q));
    const a0 = 1 + alpha;
    let b0: number, b1: number, b2: number;
    switch (type) {
      case 'lowpass':
        b0 = (1 - cos) / 2;
        b1 = 1 - cos;
        b2 = (1 - cos) / 2;
        break;
      case 'highpass':
        b0 = (1 + cos) / 2;
        b1 = -(1 + cos);
        b2 = (1 + cos) / 2;
        break;
      case 'bandpass':
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        break;
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

// -- noise ---------------------------------------------------------------------------------------------------------------

/** Stateful coloured-noise generator: white, pink (−3 dB/octave, Kellet's filter) or brown (−6 dB/octave). */
export class NoiseSource {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private b3 = 0;
  private b4 = 0;
  private b5 = 0;
  private b6 = 0;
  private brown = 0;

  constructor(
    private readonly rng: Rng,
    private readonly color: NoiseColor,
  ) {}

  next(): number {
    const w = this.rng.next() * 2 - 1;
    switch (this.color) {
      case 'white':
        return w;
      case 'pink': {
        this.b0 = 0.99886 * this.b0 + w * 0.0555179;
        this.b1 = 0.99332 * this.b1 + w * 0.0750759;
        this.b2 = 0.969 * this.b2 + w * 0.153852;
        this.b3 = 0.8665 * this.b3 + w * 0.3104856;
        this.b4 = 0.55 * this.b4 + w * 0.5329522;
        this.b5 = -0.7616 * this.b5 - w * 0.016898;
        const out = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + w * 0.5362;
        this.b6 = w * 0.115926;
        return out * 0.11;
      }
      case 'brown':
        this.brown = (this.brown + 0.02 * w) / 1.02;
        return this.brown * 3.5;
    }
  }
}

/**
 * Seamless loop of coloured noise: the tail is cross-faded into the head, so the loop point is continuous. Used for
 * the sustained layers (rolling, wind, engines), which play it from a random offset through filters.
 */
export function renderNoiseLoop(color: NoiseColor, seconds: number, sampleRate: number, seed: number): Float32Array {
  const fade = Math.floor(sampleRate * 0.25);
  const n = Math.floor(seconds * sampleRate);
  const rng = new Rng(seed);
  const src = new NoiseSource(rng, color);
  const raw = new Float32Array(n + fade);
  // Let the colouring filters settle before the first sample we keep.
  for (let i = 0; i < 2048; i++) src.next();
  for (let i = 0; i < raw.length; i++) raw[i] = src.next();
  const out = new Float32Array(n);
  out.set(raw.subarray(0, n));
  // Blend the extra tail (raw[n .. n + fade)) over the head with equal-power weights.
  for (let i = 0; i < fade; i++) {
    const t = (i + 0.5) / fade;
    out[i] = raw[i] * Math.sin((t * Math.PI) / 2) + raw[n + i] * Math.cos((t * Math.PI) / 2);
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const k = peak > 0 ? 0.9 / peak : 1;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

// -- the renderer ----------------------------------------------------------------------------------------------------

/** Flatten grains into plain modes (so a grain is rendered exactly like any other mode). */
function expandGrains(grains: readonly GrainSpec[], rng: Rng): ModeSpec[] {
  const out: ModeSpec[] = [];
  for (const g of grains) {
    const lo = Math.log(g.fMin);
    const hi = Math.log(g.fMax);
    for (let i = 0; i < g.count; i++) {
      const u = rng.next();
      // Bias the onsets towards the start (the first fragments fall first): u² piles up near zero.
      const start = (g.start ?? 0) + g.spread * u * u;
      out.push({
        freq: Math.exp(lo + (hi - lo) * rng.next()),
        gain: g.gain * (0.35 + 0.65 * rng.next()),
        t60: g.t60 * (0.6 + 0.8 * rng.next()),
        start,
        attack: 0.0002,
      });
    }
  }
  return out;
}

/**
 * Render a recipe to mono samples at `sampleRate`, deterministically for `seed`. The result is normalised to the
 * recipe's `peak` (default 0.9) and ends with a short fade so a clipped tail never clicks.
 */
export function renderRecipe(recipe: Recipe, sampleRate: number, seed: number): Float32Array {
  const n = Math.max(8, Math.floor(recipe.duration * sampleRate));
  const out = new Float32Array(n);
  const rng = new Rng(seed);

  const modes: ModeSpec[] = [...(recipe.modes ?? [])];
  if (recipe.grains?.length) modes.push(...expandGrains(recipe.grains, rng));

  for (const m of modes) {
    if (m.gain === 0 || m.freq <= 0) continue;
    const s0 = Math.floor((m.start ?? 0) * sampleRate);
    if (s0 >= n) continue;
    const decay = Math.exp(-LN1000 / Math.max(1, m.t60 * sampleRate));
    const na = Math.max(1, Math.floor((m.attack ?? 0.0004) * sampleRate));
    // Stop once the mode is 80 dB down: nothing audible is left, and the loop ends early.
    const last = Math.min(n, s0 + Math.floor((m.t60 * sampleRate * 80) / 60));
    if (!m.glide && !m.vibrato) {
      if (m.freq >= sampleRate * 0.45) continue;
      const w = (TAU * m.freq) / sampleRate;
      const c = Math.cos(w);
      const s = Math.sin(w);
      let re = 1;
      let im = 0;
      let env = m.gain;
      for (let i = s0; i < last; i++) {
        const k = i - s0;
        out[i] += im * env * (k < na ? k / na : 1);
        const r = re * c - im * s;
        im = re * s + im * c;
        re = r;
        env *= decay;
      }
    } else {
      let phase = 0;
      let env = m.gain;
      const g = m.glide;
      const v = m.vibrato;
      const gk = g ? Math.exp(-1 / Math.max(1, g.time * sampleRate)) : 0;
      let gl = g ? g.from : 1;
      const vdecay = v ? Math.exp(-LN1000 / Math.max(1, v.t60 * sampleRate)) : 0;
      let vdepth = v ? v.depth : 0;
      for (let i = s0; i < last; i++) {
        const k = i - s0;
        // The glide multiplier relaxes from `from` towards 1.
        const f = m.freq * gl * (1 + (v ? vdepth * Math.sin((TAU * v.rate * k) / sampleRate) : 0));
        if (f < sampleRate * 0.45) {
          phase += (TAU * f) / sampleRate;
          out[i] += Math.sin(phase) * env * (k < na ? k / na : 1);
        }
        env *= decay;
        if (g) gl = 1 + (gl - 1) * gk;
        if (v) vdepth *= vdecay;
      }
    }
  }

  for (const nz of recipe.noise ?? []) {
    if (nz.gain === 0) continue;
    const s0 = Math.floor((nz.start ?? 0) * sampleRate);
    if (s0 >= n) continue;
    const src = new NoiseSource(rng, nz.color);
    // Warm the colouring filter up so a pink / brown layer does not start from silence.
    for (let i = 0; i < 256; i++) src.next();
    const decay = Math.exp(-LN1000 / Math.max(1, nz.t60 * sampleRate));
    const na = Math.max(1, Math.floor((nz.attack ?? 0.0006) * sampleRate));
    const last = Math.min(n, s0 + Math.floor((nz.t60 * sampleRate * 80) / 60) + na);
    const f = nz.filter;
    const filt = f ? new Biquad() : null;
    const q = f?.q ?? 0.707;
    if (filt && f) filt.set(f.type, f.freq, q, sampleRate);
    const sweep = !!f && f.freqEnd !== undefined && f.freqEnd > 0 && f.freqEnd !== f.freq;
    const span = Math.max(1, last - s0);
    let env = nz.gain;
    for (let i = s0; i < last; i++) {
      const k = i - s0;
      if (sweep && filt && f && (k & 15) === 0)
        filt.set(f.type, f.freq * Math.pow((f.freqEnd as number) / f.freq, k / span), q, sampleRate);
      let x = src.next();
      if (filt) x = filt.process(x);
      out[i] += x * env * (k < na ? k / na : 1);
      env *= decay;
    }
  }

  if (recipe.drive && recipe.drive > 0) {
    const d = recipe.drive;
    const norm = Math.tanh(d);
    for (let i = 0; i < n; i++) out[i] = Math.tanh(d * out[i]) / norm;
  }

  // Normalise, then fade the last 4 ms.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const k = peak > 1e-9 ? (recipe.peak ?? 0.9) / peak : 0;
  const fade = Math.min(n, Math.floor(0.004 * sampleRate));
  for (let i = 0; i < n; i++) out[i] *= k;
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
  return out;
}

// -- measurements (used by the tests and the e2e checks of rendered sounds) -------------------------------------------

/** Root-mean-square level of a buffer. */
export function rms(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

/**
 * Time, seconds, after which the short-time level (5 ms windows) has dropped 40 dB below its peak and stays there:
 * a robust "how long does it ring" for tests.
 */
export function ringTime(x: ArrayLike<number>, sampleRate: number, dropDb = 40): number {
  const win = Math.max(1, Math.floor(sampleRate * 0.005));
  const levels: number[] = [];
  for (let i = 0; i + win <= x.length; i += win) {
    let s = 0;
    for (let j = 0; j < win; j++) s += x[i + j] * x[i + j];
    levels.push(Math.sqrt(s / win));
  }
  const peak = Math.max(...levels, 1e-12);
  const floor = peak * Math.pow(10, -dropDb / 20);
  let last = 0;
  for (let i = 0; i < levels.length; i++) if (levels[i] > floor) last = i;
  return ((last + 1) * win) / sampleRate;
}

/** Magnitude spectrum by a radix-2 FFT over the first `size` samples (zero padded); returns bins 0 … size/2. */
export function spectrum(x: ArrayLike<number>, size = 8192): Float64Array {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const n = Math.min(size, x.length);
  for (let i = 0; i < n; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((TAU * i) / Math.max(1, n - 1))); // Hann
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= size; len <<= 1) {
    const ang = -TAU / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < size; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  const mag = new Float64Array(size / 2 + 1);
  for (let i = 0; i < mag.length; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

/** Frequency, Hz, of the strongest spectral peak between `lo` and `hi` (parabolic interpolation). */
export function dominantFrequency(x: ArrayLike<number>, sampleRate: number, lo = 20, hi = 20000, size = 8192): number {
  const mag = spectrum(x, size);
  const bin = (f: number) => Math.round((f * size) / sampleRate);
  const a = Math.max(1, bin(lo));
  const b = Math.min(mag.length - 2, bin(hi));
  let best = a;
  for (let i = a; i <= b; i++) if (mag[i] > mag[best]) best = i;
  const l = mag[best - 1];
  const c = mag[best];
  const r = mag[best + 1];
  const denom = l - 2 * c + r;
  const shift = Math.abs(denom) > 1e-12 ? (0.5 * (l - r)) / denom : 0;
  return ((best + shift) * sampleRate) / size;
}

/** Spectral centroid, Hz: the "brightness" of a sound. */
export function spectralCentroid(x: ArrayLike<number>, sampleRate: number, size = 8192): number {
  const mag = spectrum(x, size);
  let num = 0;
  let den = 0;
  for (let i = 1; i < mag.length; i++) {
    num += mag[i] * i;
    den += mag[i];
  }
  return den > 0 ? ((num / den) * sampleRate) / size : 0;
}
