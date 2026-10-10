/**
 * Analog input processing, pure and Node-testable: dead zone, response curve, sensitivity, smoothing, and the
 * keyboard-to-analog ramp that lets keys feel like a stick (`AxisState`).
 */
import { clamp } from '../../core/math';

export interface AxisCfg {
  /** Raw magnitudes below this read as 0; the rest is rescaled to 0…1 (no jump at the edge). 0…0.9. */
  deadzone: number;
  /** Output multiplier applied after the curve (the result is clamped to −1…1). */
  sensitivity: number;
  /** Response curve exponent: 1 = linear, 2 = fine control near the centre, <1 = aggressive. */
  expo: number;
  /** Low-pass time constant in seconds applied to analog input (0 = none). */
  smoothing: number;
  invert: boolean;
  /** Keyboard ramp: seconds from 0 to full deflection while a key is held. */
  rise: number;
  /** Keyboard ramp: seconds from full deflection back to 0 after release. */
  fall: number;
  /** Keys: return to 0 on release (a stick that springs back). Off = the deflection stays where it was left. */
  autoCentre: boolean;
}

export const DEFAULT_AXIS: Readonly<AxisCfg> = {
  deadzone: 0.12,
  sensitivity: 1,
  expo: 1.4,
  smoothing: 0.04,
  invert: false,
  rise: 0.25,
  fall: 0.2,
  autoCentre: true,
};

/** Dead zone + curve + sensitivity + inversion of one raw analog reading (−1…1). */
export function shapeAnalog(raw: number, cfg: AxisCfg): number {
  const a = Math.abs(raw);
  const dz = clamp(cfg.deadzone, 0, 0.95);
  if (a <= dz) return 0;
  const n = (a - dz) / (1 - dz);
  const v = Math.pow(n, Math.max(0.1, cfg.expo)) * cfg.sensitivity;
  return clamp(Math.sign(raw) * v * (cfg.invert ? -1 : 1), -1, 1);
}

/** Per-axis running state: the keyboard ramp and the output smoothing. */
export class AxisState {
  /** Keyboard deflection, −1…1. */
  key = 0;
  /** Smoothed analog (pad / touch) value after shaping. */
  analog = 0;

  /** Advance the key ramp toward `dir` (−1, 0 or +1). */
  stepKey(dir: number, dt: number, cfg: AxisCfg): void {
    if (dir !== 0) {
      // Reversing passes through zero twice as fast, like turning a wheel back.
      const rate = (dir * this.key < 0 ? 2 : 1) / Math.max(0.01, cfg.rise);
      this.key = clamp(this.key + dir * rate * dt, -1, 1);
    } else if (cfg.autoCentre && this.key !== 0) {
      const d = dt / Math.max(0.01, cfg.fall);
      this.key = Math.abs(this.key) <= d ? 0 : this.key - Math.sign(this.key) * d;
    }
  }

  /** Smooth an already shaped analog reading. */
  stepAnalog(shaped: number, dt: number, cfg: AxisCfg): void {
    if (cfg.smoothing <= 0) this.analog = shaped;
    else this.analog += (shaped - this.analog) * (1 - Math.exp(-dt / cfg.smoothing));
    if (Math.abs(this.analog) < 1e-4) this.analog = 0;
  }

  get value(): number {
    return clamp(this.key + this.analog, -1, 1);
  }
}
