// -- DT-2: capture options, limits and the frame schedule (pure) --
/**
 * Everything about a capture that can be decided without a browser: which options are allowed, how many output
 * frames there are, at which output time each one lies, and how many fixed physics steps separate two frames.
 * Deterministic capture is driven entirely by this plan, which is why its output does not depend on how fast the
 * machine renders: frame i always shows the world after `totalSteps(i)` steps and the camera at `time(i)`.
 */

export type CaptureFormat = 'webm' | 'mp4' | 'gif';

export interface CaptureOptions {
  format: CaptureFormat;
  /** Output width in pixels; the height follows the viewport's aspect ratio. */
  width: number;
  fps: number;
  /** Seconds of output (for a turntable: the time one full revolution takes). */
  duration: number;
  /** Fixed-timestep capture: pause the live loop and advance the simulation frame by frame. */
  deterministic: boolean;
  /** Orbit the camera through 360° while recording. */
  turntable: boolean;
  /** What a turntable circles: the selection (falls back to the whole scene when nothing is selected) or the scene. */
  turntableTarget: 'selection' | 'scene';
  /** Turntable only: freeze the simulation (otherwise it advances as usual). */
  pauseSim: boolean;
  /** Deterministic only: rebuild the simulation from the scene first, so the capture starts at t = 0. */
  restart: boolean;
}

export const DEFAULT_CAPTURE: CaptureOptions = {
  format: 'webm',
  width: 960,
  fps: 30,
  duration: 5,
  deterministic: false,
  turntable: false,
  turntableTarget: 'selection',
  pauseSim: false,
  restart: true,
};

export const GIF_LIMITS = {
  minFps: 1,
  maxFps: 30,
  maxDuration: 30,
  maxWidth: 960,
  maxFrames: 600,
  /** Frames are held as RGBA while a real-time GIF is captured; this bounds that memory. */
  maxBufferBytes: 256 * 1024 * 1024,
} as const;

export const VIDEO_LIMITS = {
  minFps: 5,
  maxFps: 60,
  maxDuration: 600,
  maxWidth: 3840,
} as const;

export const MIN_WIDTH = 64;
export const MIN_DURATION = 0.5;

/** Output height for a width, keeping the viewport's aspect ratio, rounded to an even number (codecs need it). */
export function outputHeight(width: number, viewportW: number, viewportH: number): number {
  const h = Math.round((width * Math.max(1, viewportH)) / Math.max(1, viewportW));
  return Math.max(2, h + (h % 2));
}

export interface Validation {
  /** Human-readable problems; empty when the options are usable. */
  errors: string[];
  /** The options with numbers rounded to what will actually be used (only meaningful when `errors` is empty). */
  value: CaptureOptions;
  frames: number;
  height: number;
}

/** Check capture options against the limits of their format. Messages say what to change. */
export function validateOptions(o: CaptureOptions, viewportW = 16, viewportH = 9): Validation {
  const errors: string[] = [];
  const num = (v: number, name: string): boolean => {
    if (!Number.isFinite(v)) {
      errors.push(`${name} must be a number.`);
      return false;
    }
    return true;
  };
  const value: CaptureOptions = { ...o, width: Math.round(o.width), fps: Math.round(o.fps) };
  const okW = num(o.width, 'Width'),
    okF = num(o.fps, 'Frame rate'),
    okD = num(o.duration, 'Duration');
  const gif = o.format === 'gif';
  const L = gif ? GIF_LIMITS : VIDEO_LIMITS;
  const what = gif ? 'GIF' : o.format.toUpperCase();
  if (okW) {
    if (value.width < MIN_WIDTH) errors.push(`Width must be at least ${MIN_WIDTH} px.`);
    else if (value.width > L.maxWidth)
      errors.push(
        gif
          ? `GIFs are limited to ${L.maxWidth} px wide (they get very large beyond that). Lower the width or choose WebM/MP4.`
          : `${what} width is limited to ${L.maxWidth} px.`,
      );
  }
  if (okF && (value.fps < L.minFps || value.fps > L.maxFps))
    errors.push(`${what} frame rate must be between ${L.minFps} and ${L.maxFps} fps.`);
  if (okD) {
    if (o.duration < MIN_DURATION) errors.push(`Duration must be at least ${MIN_DURATION} s.`);
    else if (o.duration > L.maxDuration)
      errors.push(
        `${what} duration is limited to ${L.maxDuration} s${gif ? ' (choose WebM/MP4 for longer clips)' : ''}.`,
      );
  }
  const height = outputHeight(Math.max(MIN_WIDTH, value.width || 0), viewportW, viewportH);
  const frames = okF && okD && value.fps > 0 ? Math.max(1, Math.round(value.fps * o.duration)) : 0;
  if (gif && frames > GIF_LIMITS.maxFrames)
    errors.push(
      `A GIF can have at most ${GIF_LIMITS.maxFrames} frames; ${frames} requested. Lower the frame rate or the duration.`,
    );
  if (gif && !o.deterministic && frames * value.width * height * 4 > GIF_LIMITS.maxBufferBytes)
    errors.push(
      `This real-time GIF would need about ${Math.round((frames * value.width * height * 4) / 1048576)} MB of memory. ` +
        `Lower the size, frame rate or duration, or switch on deterministic capture (which encodes as it goes).`,
    );
  if (o.turntable && o.duration < 1) errors.push('A turntable needs at least 1 s for its revolution.');
  return { errors, value, frames, height };
}

export interface PlannedFrame {
  index: number;
  /** Output time in seconds (index / fps). */
  time: number;
  /** Fixed physics steps to run before this frame is rendered. */
  steps: number;
  /** Steps run in total when this frame is rendered. */
  totalSteps: number;
}

export interface FramePlan {
  count: number;
  frames: PlannedFrame[];
  /** Total fixed steps over the whole capture. */
  totalSteps: number;
}

/**
 * The schedule of a capture: `round(fps · duration)` frames at `i / fps`; frame i is rendered after
 * `round(i · physicsHz · timeScale / fps)` fixed steps in total. Rounding the *cumulative* count (not the per-frame
 * count) keeps the long-run rate exact, e.g. 60 Hz physics at 25 fps alternates 2 and 3 steps and never drifts.
 */
export function planFrames(o: { fps: number; duration: number; physicsHz: number; timeScale?: number }): FramePlan {
  const { fps, duration, physicsHz } = o;
  if (!(fps > 0) || !(duration > 0) || !(physicsHz > 0))
    throw new Error('fps, duration and physicsHz must be positive');
  const scale = o.timeScale ?? 1;
  const count = Math.max(1, Math.round(fps * duration));
  const frames: PlannedFrame[] = [];
  let prev = 0;
  for (let i = 0; i < count; i++) {
    const total = Math.round((i * physicsHz * scale) / fps);
    frames.push({ index: i, time: i / fps, steps: total - prev, totalSteps: total });
    prev = total;
  }
  return { count, frames, totalSteps: prev };
}

/**
 * GIF frame delays in hundredths of a second. The delays are cumulative-rounded, so they sum to exactly
 * `round(count · 100 / fps)` and the animation plays at the right average speed even for rates such as 24 fps
 * (4.17 cs per frame).
 */
export function gifDelays(fps: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps));
  return out;
}

/** FNV-1a hash of a frame's bytes, as 8 hex digits: cheap evidence that two captures are identical. */
export function hashBytes(bytes: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
