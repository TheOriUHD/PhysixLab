/**
 * Spectrum analysis for the chart widgets (DOM-free): radix-2 FFT, window functions, a single-sided amplitude
 * spectrum and peak detection with parabolic interpolation and labels.
 */
export type WindowKind = 'rect' | 'hann' | 'hamming' | 'blackman';
export const WINDOWS: readonly { id: WindowKind; label: string }[] = [
  { id: 'rect', label: 'Rectangular' },
  { id: 'hann', label: 'Hann' },
  { id: 'hamming', label: 'Hamming' },
  { id: 'blackman', label: 'Blackman' },
];

export const isPow2 = (n: number): boolean => n >= 1 && (n & (n - 1)) === 0;
export const nextPow2 = (n: number): number => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

/** In-place iterative radix-2 FFT. `re` and `im` must have the same power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (!isPow2(n) || im.length !== n) throw new Error('fft: length must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Fill `out` with window coefficients of length `out.length` (periodic-symmetric: uses N-1 in the denominator). */
export function windowCoefficients(kind: WindowKind, out: Float64Array): void {
  const n = out.length;
  const d = Math.max(1, n - 1);
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / d;
    switch (kind) {
      case 'hann':
        out[i] = 0.5 - 0.5 * Math.cos(x);
        break;
      case 'hamming':
        out[i] = 0.54 - 0.46 * Math.cos(x);
        break;
      case 'blackman':
        out[i] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
        break;
      default:
        out[i] = 1;
    }
  }
}

export interface Spectrum {
  /** Frequencies of the bins, Hz (0 … fs/2). */
  freq: Float64Array;
  /** Amplitude per bin, in the units of the signal (a sine of amplitude A peaks near A). */
  mag: Float64Array;
  /** Bin spacing, Hz (fs / padded length). */
  df: number;
  /** Sample rate, Hz. */
  fs: number;
}

export interface SpectrumOptions {
  window?: WindowKind;
  /** Subtract the mean first (default true) so the DC bin does not swamp the plot. */
  detrend?: boolean;
  /** Zero-pad to this length (power of two, >= samples). Default: next power of two. */
  size?: number;
}

/**
 * Single-sided amplitude spectrum of uniformly sampled `samples` at `fs` Hz. The window's coherent gain is divided
 * out, so a sinusoid of amplitude A reads about A at its frequency (exactly A when it falls on a bin).
 */
export function spectrum(samples: ArrayLike<number>, fs: number, opts: SpectrumOptions = {}): Spectrum {
  const n = samples.length;
  if (n < 2 || !(fs > 0)) throw new Error('spectrum: need at least 2 samples and a positive sample rate');
  const size = Math.max(nextPow2(n), opts.size && isPow2(opts.size) ? opts.size : 1);
  const win = new Float64Array(n);
  windowCoefficients(opts.window ?? 'hann', win);
  let mean = 0;
  if (opts.detrend !== false) {
    for (let i = 0; i < n; i++) mean += samples[i];
    mean /= n;
  }
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let gain = 0;
  for (let i = 0; i < n; i++) {
    re[i] = (samples[i] - mean) * win[i];
    gain += win[i];
  }
  fft(re, im);
  const bins = size / 2 + 1;
  const freq = new Float64Array(bins);
  const mag = new Float64Array(bins);
  const df = fs / size;
  for (let k = 0; k < bins; k++) {
    freq[k] = k * df;
    const a = Math.hypot(re[k], im[k]) / gain;
    mag[k] = k === 0 || k === size / 2 ? a : 2 * a;
  }
  return { freq, mag, df, fs };
}

export interface Peak {
  /** Interpolated frequency, Hz. */
  freq: number;
  /** Interpolated amplitude. */
  mag: number;
  bin: number;
}

/**
 * Local maxima of the spectrum above `threshold` (fraction of the largest peak, default 0.1), strongest first, with
 * parabolic interpolation of frequency and amplitude. `minSeparation` (Hz) drops weaker peaks near a stronger one.
 */
export function findPeaks(sp: Spectrum, max = 5, threshold = 0.1, minSeparation = 0): Peak[] {
  const { mag, df } = sp;
  let top = 0;
  for (let k = 1; k < mag.length; k++) if (mag[k] > top) top = mag[k];
  if (top <= 0) return [];
  const cand: Peak[] = [];
  for (let k = 1; k < mag.length - 1; k++) {
    const m = mag[k];
    if (m < threshold * top || m < mag[k - 1] || m <= mag[k + 1]) continue;
    const a = mag[k - 1];
    const c = mag[k + 1];
    const den = a - 2 * m + c;
    const off = den !== 0 ? (0.5 * (a - c)) / den : 0;
    cand.push({ freq: (k + off) * df, mag: m - 0.25 * (a - c) * off, bin: k });
  }
  cand.sort((p, q) => q.mag - p.mag);
  const out: Peak[] = [];
  for (const p of cand) {
    if (out.length >= max) break;
    if (minSeparation > 0 && out.some((o) => Math.abs(o.freq - p.freq) < minSeparation)) continue;
    out.push(p);
  }
  return out;
}

/** "2.00 Hz" / "125 mHz" / "1.20 kHz" */
export function formatHz(f: number): string {
  const a = Math.abs(f);
  if (a >= 1000) return `${(f / 1000).toFixed(2)} kHz`;
  if (a >= 1) return `${f.toFixed(a >= 100 ? 1 : 2)} Hz`;
  return `${(f * 1000).toFixed(a >= 0.1 ? 0 : 1)} mHz`;
}

/** Peak label with the period, e.g. "2.00 Hz (T 0.500 s)". */
export function peakLabel(p: Peak): string {
  const T = p.freq > 0 ? 1 / p.freq : Infinity;
  return `${formatHz(p.freq)}${Number.isFinite(T) ? ` · T ${T >= 100 ? T.toFixed(0) : T.toPrecision(3)} s` : ''}`;
}
