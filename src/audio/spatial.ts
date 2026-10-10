/**
 * 3D spatialisation relative to the camera, as pure maths: where a sound sits in the stereo field, how much quieter
 * it is for being far away, how much duller (air absorbs the highs, a listener's head shades what is behind), and
 * the Doppler shift of a moving source or listener.
 *
 * The listener is the camera: position from its world matrix, orientation from its right / up / forward axes, velocity
 * from how far it moved since the last frame. A source is a point (and optionally a velocity). `spatialize` writes a
 * `SpatialResult` that the engine applies with a stereo panner, a gain and a low-pass filter per voice:
 *
 *     gain    inverse-distance law beyond a reference distance, fading to silence at the maximum distance
 *     pan     −1 (left) … +1 (right), the sine of the azimuth, collapsing to centre for a source at the listener
 *     cutoff  low-pass cutoff in Hz: distance (air absorption) and "behind the camera"
 *     rate    Doppler ratio (1 = none), softened by the Doppler amount and clamped to a musical range
 *
 * This is deliberately the simple, deterministic model rather than the browser's `PannerNode` (HRTF): it costs a
 * tenth as much per voice, adds the air and head cues a plain equal-power pan lacks, and is unit-tested numerically.
 */
import { clamp, clamp01, smoothstep } from './mapping';

export interface Listener {
  x: number;
  y: number;
  z: number;
  /** Unit forward / up / right vectors. */
  fx: number;
  fy: number;
  fz: number;
  ux: number;
  uy: number;
  uz: number;
  rx: number;
  ry: number;
  rz: number;
  /** Velocity, m/s (for Doppler). */
  vx: number;
  vy: number;
  vz: number;
}

export function newListener(): Listener {
  return { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0, rx: 1, ry: 0, rz: 0, vx: 0, vy: 0, vz: 0 };
}

/** Set a listener's pose from a column-major 4×4 world matrix (three.js `matrixWorld.elements`) of a camera looking down −Z. */
export function listenerFromMatrix(e: ArrayLike<number>, out: Listener): Listener {
  out.x = e[12];
  out.y = e[13];
  out.z = e[14];
  out.rx = e[0];
  out.ry = e[1];
  out.rz = e[2];
  out.ux = e[4];
  out.uy = e[5];
  out.uz = e[6];
  out.fx = -e[8];
  out.fy = -e[9];
  out.fz = -e[10];
  return out;
}

export interface SpatialModel {
  /** Within this distance a source is at full level, metres. */
  refDistance: number;
  /** How fast the level falls beyond it (1 = inverse distance). */
  rolloff: number;
  /** Silent from here on, metres. */
  maxDistance: number;
  /** Speed of sound, m/s. */
  speedOfSound: number;
}

export const DEFAULT_SPATIAL_MODEL: SpatialModel = { refDistance: 4, rolloff: 1, maxDistance: 320, speedOfSound: 343 };

export interface SpatialResult {
  gain: number;
  pan: number;
  cutoff: number;
  distance: number;
  rate: number;
}

export const newSpatialResult = (): SpatialResult => ({ gain: 1, pan: 0, cutoff: 20000, distance: 0, rate: 1 });

/** Level at `distance` for the model: 1 up to the reference distance, inverse-distance beyond, fading out at the end. */
export function distanceGain(distance: number, m: SpatialModel = DEFAULT_SPATIAL_MODEL): number {
  if (distance <= m.refDistance) return 1;
  const g = m.refDistance / (m.refDistance + m.rolloff * (distance - m.refDistance));
  const fadeStart = m.maxDistance * 0.8;
  return distance >= m.maxDistance
    ? 0
    : distance > fadeStart
      ? g * (1 - (distance - fadeStart) / (m.maxDistance - fadeStart))
      : g;
}

/** Everything about a source relative to the listener. Writes into and returns `out` (no allocation). */
export function spatialize(
  l: Listener,
  sx: number,
  sy: number,
  sz: number,
  out: SpatialResult,
  model: SpatialModel = DEFAULT_SPATIAL_MODEL,
  /** Source velocity and the Doppler amount 0 … 1 (0 = off). */
  svx = 0,
  svy = 0,
  svz = 0,
  dopplerAmount = 0,
): SpatialResult {
  const dx = sx - l.x;
  const dy = sy - l.y;
  const dz = sz - l.z;
  const d = Math.hypot(dx, dy, dz);
  out.distance = d;
  out.gain = distanceGain(d, model);
  if (d < 1e-6) {
    out.pan = 0;
    out.cutoff = 20000;
    out.rate = 1;
    return out;
  }
  const nx = dx / d;
  const ny = dy / d;
  const nz = dz / d;
  // Azimuth: sine of the angle from straight ahead; a source at the listener (< 1 m) has no direction.
  out.pan = clamp((nx * l.rx + ny * l.ry + nz * l.rz) * smoothstep(0.15, 1.2, d), -1, 1);
  const front = nx * l.fx + ny * l.fy + nz * l.fz; // +1 straight ahead, −1 behind
  const air = 20000 / (1 + d / 70);
  const head = 0.55 + 0.45 * clamp01((front + 1) / 2);
  out.cutoff = clamp(air * head, 1200, 20000);
  if (dopplerAmount > 0) {
    const vl = l.vx * nx + l.vy * ny + l.vz * nz; // listener towards the source
    const vs = svx * nx + svy * ny + svz * nz; // source away from the listener
    const c = model.speedOfSound;
    const ratio = clamp((c + vl) / Math.max(40, c + vs), 0.8, 1.25);
    out.rate = Math.pow(ratio, clamp01(dopplerAmount));
  } else out.rate = 1;
  return out;
}

/** What the engine uses when spatialisation is off: centred, full level, nothing filtered. */
export function flatSpatial(out: SpatialResult): SpatialResult {
  out.gain = 1;
  out.pan = 0;
  out.cutoff = 20000;
  out.distance = 0;
  out.rate = 1;
  return out;
}
