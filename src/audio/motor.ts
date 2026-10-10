/**
 * Engine and motor sound (FX-13): how the speed (rpm) and load of a motorised joint or an engine component become
 * the parameters of a small synthesiser — two oscillators, a resonant low-pass filter, a noise layer and an
 * amplitude modulator.
 *
 * Four kinds of voice share that structure and differ in how the numbers are mapped:
 *
 *   - **combustion** — a pulse train at the firing frequency (`rpm/60 × 3`, a six-cylinder), an octave-up partner
 *     slightly detuned (the beating of an uneven idle), a low-pass that opens with load and revs, exhaust hiss;
 *   - **electric** — a resonant whine whose pitch climbs with speed (sub-linearly, so a fast motor does not squeal),
 *     a fifth above it, and the hum of the windings that grows with load;
 *   - **rotor** — blade-pass chop (noise amplitude-modulated at `rpm/60 × 2`, deep at low rpm, blurring into a buzz
 *     as it speeds up) over a turbine drone, for propellers and rotors;
 *   - **jet** — a roar: broad noise that opens up and gets louder with thrust, on a low rumble.
 *
 * Everything is a pure function (`motorParams`), tested for monotonicity (pitch up with rpm, brighter and louder with
 * load, silent when stopped). The engine's `MotorVoice` applies the parameters to real nodes; the harmonic
 * recipes of the oscillators come from `pulseHarmonics`.
 */
import { clamp, clamp01, smoothstep } from './mapping';

export type MotorKind = 'combustion' | 'electric' | 'rotor' | 'jet';

export const MOTOR_KINDS: readonly MotorKind[] = ['combustion', 'electric', 'rotor', 'jet'];

/** The rpm at which each kind is at full speed (the scale of `rpmNorm`). */
export const RATED_RPM: Record<MotorKind, number> = { combustion: 7000, electric: 3000, rotor: 1200, jet: 100 };

export interface MotorParams {
  /** Frequency of the first and second oscillator, Hz, and their loudness. */
  f1: number;
  f2: number;
  g1: number;
  g2: number;
  /** Resonant low-pass over the oscillators. */
  cutoff: number;
  q: number;
  /** Noise layer: loudness and band-pass centre. */
  noiseGain: number;
  noiseCutoff: number;
  /** Amplitude modulation of the noise (blade pass): rate Hz and depth 0 … 1. */
  lfoRate: number;
  lfoDepth: number;
  /** Overall loudness, 0 … 1. */
  gain: number;
}

export const newMotorParams = (): MotorParams => ({
  f1: 50,
  f2: 100,
  g1: 0,
  g2: 0,
  cutoff: 400,
  q: 1,
  noiseGain: 0,
  noiseCutoff: 500,
  lfoRate: 0,
  lfoDepth: 0,
  gain: 0,
});

/** Below this overall loudness a motor voice is not worth a place. */
export const MOTOR_AUDIBLE = 0.01;

/**
 * Motor parameters for `rpm` (absolute) and `load` 0 … 1 (0 = freewheeling, 1 = straining at its limit). For a `jet`
 * the rpm is ignored and `load` is the thrust fraction.
 */
export function motorParams(kind: MotorKind, rpmIn: number, loadIn: number, out: MotorParams): MotorParams {
  const rpm = Math.abs(Number.isFinite(rpmIn) ? rpmIn : 0);
  const load = clamp01(Number.isFinite(loadIn) ? loadIn : 0);
  const n = clamp01(rpm / RATED_RPM[kind]);
  switch (kind) {
    case 'combustion': {
      const f = Math.max(8, (rpm / 60) * 3);
      out.f1 = f;
      out.f2 = f * 2 * 1.007;
      out.g1 = 1;
      out.g2 = 0.25 + 0.5 * load;
      out.cutoff = clamp(180 + (700 + 4200 * load) * Math.pow(n, 0.9), 120, 6000);
      out.q = 1.1 + 2 * load * n;
      out.noiseGain = 0.12 + 0.35 * load * n;
      out.noiseCutoff = 400 + 2500 * n;
      out.lfoRate = 0;
      out.lfoDepth = 0;
      out.gain = smoothstep(30, 300, rpm) * (0.28 + 0.55 * load) * (0.7 + 0.3 * n);
      break;
    }
    case 'electric': {
      const f = 150 * Math.pow(1 + rpm / 120, 0.75);
      out.f1 = Math.min(3000, f);
      out.f2 = out.f1 * 1.5;
      out.g1 = 1;
      out.g2 = 0.35;
      out.cutoff = 800 + 3500 * load + 1500 * n;
      out.q = 2;
      out.noiseGain = 0.05 + 0.12 * load;
      out.noiseCutoff = 2500 + 3000 * n;
      out.lfoRate = 0;
      out.lfoDepth = 0;
      out.gain = smoothstep(2, 60, rpm) * (0.15 + 0.5 * load);
      break;
    }
    case 'rotor': {
      const bladePass = (rpm / 60) * 2;
      out.f1 = 55 + 80 * n;
      out.f2 = out.f1 * 2;
      out.g1 = 0.25;
      out.g2 = 0.1;
      out.cutoff = 500 + 2400 * n * (0.5 + load);
      out.q = 0.8;
      out.noiseGain = 0.5 + 0.5 * load;
      out.noiseCutoff = 700 + 2200 * n;
      out.lfoRate = bladePass;
      out.lfoDepth = 0.75 * (1 - smoothstep(25, 90, bladePass));
      out.gain = smoothstep(20, 200, rpm) * (0.2 + 0.6 * load);
      break;
    }
    case 'jet': {
      out.f1 = 70 + 40 * load;
      out.f2 = out.f1 * 1.5;
      out.g1 = 0.35;
      out.g2 = 0;
      out.cutoff = 450 + 4800 * load;
      out.q = 0.7;
      out.noiseGain = 1;
      out.noiseCutoff = 500 + 5500 * load;
      out.lfoRate = 0;
      out.lfoDepth = 0;
      out.gain = smoothstep(0.02, 0.2, load) * (0.15 + 0.7 * load);
      break;
    }
  }
  return out;
}

/**
 * Cosine-series coefficients of a pulse train of duty `duty`: harmonic `n` has amplitude `2·sin(nπ·duty)/(nπ)`. A
 * narrow pulse is rich in harmonics, which is what an engine's firing sounds like before the exhaust shapes it. The
 * array starts with the (zero) DC term, as `PeriodicWave` wants.
 */
export function pulseHarmonics(count: number, duty: number): { real: Float32Array; imag: Float32Array } {
  const real = new Float32Array(count + 1);
  const imag = new Float32Array(count + 1);
  const d = clamp(duty, 0.02, 0.5);
  for (let n = 1; n <= count; n++) real[n] = (2 * Math.sin(n * Math.PI * d)) / (n * Math.PI);
  return { real, imag };
}

/** The motor kind a component or joint maps to when nobody registered anything specific. */
export function defaultMotorKind(componentType: string | null): MotorKind {
  switch (componentType) {
    case 'engine':
      return 'combustion';
    case 'rotor':
    case 'propeller':
      return 'rotor';
    case 'jet':
    case 'thruster':
      return 'jet';
    default:
      return 'electric';
  }
}
