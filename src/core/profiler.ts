/**
 * A tiny frame profiler: `performance.now()` marks that add up into a handful of sections per frame, kept in
 * preallocated ring buffers (no allocation per frame, so it can stay on all the time).
 *
 * Usage, once per frame:
 *
 *   profiler.begin();            // start of the frame
 *   …work…;  profiler.mark(PHYSICS);   // the time since the previous mark is credited to PHYSICS
 *   …work…;  profiler.mark(RENDER);
 *   profiler.end();              // closes the frame and pushes it into the rings
 *
 * The time between two `begin()` calls is the frame interval; whatever the marks did not cover is idle time
 * (waiting for the next animation frame). The numbers are CPU time on the main thread: the GPU runs asynchronously
 * and is not measured, so `render` is the time spent issuing draw calls, not the time the GPU needs.
 */

/** Section ids (indices into the ring buffers). */
export const PHYSICS = 0;
export const SCENE = 1;
export const UI = 2;
export const RENDER = 3;
export const OTHER = 4;

export const SECTION_COUNT = 5;

export interface SectionInfo {
  id: number;
  key: string;
  label: string;
  /** Design-token-independent chart colour (the legend and graph share it). */
  color: string;
  hint: string;
}

export const SECTIONS: readonly SectionInfo[] = [
  { id: PHYSICS, key: 'physics', label: 'Physics', color: '#3ddcff', hint: 'Handing a tick to the physics worker' },
  { id: SCENE, key: 'scene', label: 'Scene', color: '#5be3a1', hint: 'Applying poses, overlays, effects and labels' },
  { id: UI, key: 'ui', label: 'UI', color: '#b18cff', hint: 'Panels, charts and other frame listeners' },
  { id: RENDER, key: 'render', label: 'Render', color: '#ffb347', hint: 'Issuing the draw calls (CPU side)' },
  { id: OTHER, key: 'other', label: 'Other', color: '#627086', hint: 'Camera, controls and bookkeeping' },
];

export interface SectionStats {
  avg: number;
  max: number;
  last: number;
}

export class Profiler {
  readonly capacity: number;
  /** One ring per section (milliseconds), plus the frame interval. */
  readonly rings: Float64Array[];
  readonly interval: Float64Array;
  /** Number of frames recorded so far (the rings hold the last `min(frames, capacity)`). */
  frames = 0;
  /** Index the next frame is written to. */
  head = 0;
  /** When false, `begin`/`mark`/`end` return immediately (a switch for tests and for apps that do not want it). */
  enabled = true;

  private readonly acc = new Float64Array(SECTION_COUNT);
  private last = 0;
  private lastBegin = 0;
  private open = false;
  private readonly clock: () => number;

  constructor(capacity = 240, clock: () => number = () => performance.now()) {
    this.capacity = capacity;
    this.clock = clock;
    this.rings = Array.from({ length: SECTION_COUNT }, () => new Float64Array(capacity));
    this.interval = new Float64Array(capacity);
  }

  begin(): void {
    if (!this.enabled) return;
    const t = this.clock();
    this.interval[this.head] = this.frames > 0 ? t - this.lastBegin : 0;
    this.lastBegin = t;
    this.last = t;
    this.acc.fill(0);
    this.open = true;
  }

  /** Credit the time since the previous mark (or `begin`) to `section`. */
  mark(section: number): void {
    if (!this.open) return;
    const t = this.clock();
    this.acc[section] += t - this.last;
    this.last = t;
  }

  end(): void {
    if (!this.open) return;
    this.open = false;
    for (let s = 0; s < SECTION_COUNT; s++) this.rings[s]![this.head] = this.acc[s]!;
    this.head = (this.head + 1) % this.capacity;
    this.frames++;
  }

  /** Number of valid samples in the rings. */
  get count(): number {
    return Math.min(this.frames, this.capacity);
  }

  /** Index (into the rings) of the i-th most recent sample; i = 0 is the newest. */
  indexOfRecent(i: number): number {
    return (this.head - 1 - i + this.capacity * 2) % this.capacity;
  }

  /** Average / max / last of a section over the last `window` samples (all of them by default). */
  stats(section: number, window = this.capacity): SectionStats {
    const n = Math.min(this.count, window);
    if (!n) return { avg: 0, max: 0, last: 0 };
    const ring = this.rings[section]!;
    let sum = 0;
    let max = 0;
    for (let i = 0; i < n; i++) {
      const v = ring[this.indexOfRecent(i)]!;
      sum += v;
      if (v > max) max = v;
    }
    return { avg: sum / n, max, last: ring[this.indexOfRecent(0)]! };
  }

  /** The same for the frame interval (the first frame's zero interval is ignored). */
  intervalStats(window = this.capacity): SectionStats {
    const n = Math.min(this.count, window);
    let sum = 0;
    let max = 0;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const v = this.interval[this.indexOfRecent(i)]!;
      if (v <= 0) continue;
      sum += v;
      k++;
      if (v > max) max = v;
    }
    return { avg: k ? sum / k : 0, max, last: n ? this.interval[this.indexOfRecent(0)]! : 0 };
  }

  reset(): void {
    this.frames = 0;
    this.head = 0;
    this.open = false;
    for (const r of this.rings) r.fill(0);
    this.interval.fill(0);
  }
}

/** The application's profiler (the frame loop and the viewport mark into it; the Profiler panel reads it). */
export const profiler = new Profiler();
