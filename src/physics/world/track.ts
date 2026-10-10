/**
 * Trajectory tracks: the poses of the moving bodies sampled during a run, for ghosts and run comparison (TM-5).
 *
 * A track samples every `every` fixed steps (about 30 per simulated second to start with); when it outgrows its
 * memory cap it keeps every other sample and doubles `every`. Finished runs outlive their world in a small
 * module-level stash, so the next run can ask for "the previous run" even though its world was rebuilt.
 */
import type { WorldState } from './state';

export const TRACK_STRIDE = 7; // x y z qx qy qz qw

export interface TrackData {
  name: string;
  /** Bodies in the order of the sample records. */
  ids: string[];
  /** Fixed steps between samples, and the simulation rate they were taken at. */
  every: number;
  hz: number;
  /** Step of the first sample. */
  first: number;
  count: number;
  /** `count × ids.length × TRACK_STRIDE` floats. */
  data: Float32Array;
  /** Simulated seconds covered. */
  duration: number;
}

const MAX_TRACK_FLOATS = 6_000_000; // 24 MB

export class TrackSampler {
  ids: string[] = [];
  private data = new Float32Array(0);
  count = 0;
  every = 0;
  first = 0;
  hz = 60;
  private started = false;

  clear(): void {
    this.ids = [];
    this.data = new Float32Array(0);
    this.count = 0;
    this.every = 0;
    this.first = 0;
    this.started = false;
  }

  sample(s: WorldState): void {
    if (!this.started) {
      this.started = true;
      this.ids = s.order.filter((r) => r.def.bodyType !== 'static' && !r.ephemeral).map((r) => r.id);
      this.hz = s.settings.physicsHz;
      this.every = Math.max(1, Math.round(this.hz / 30));
      this.first = s.stepCount;
      this.data = new Float32Array(this.ids.length * TRACK_STRIDE * 256);
      this.count = 0;
    }
    if (this.ids.length === 0) return;
    if ((s.stepCount - this.first) % this.every !== 0) return;
    const k = (s.stepCount - this.first) / this.every;
    if (k !== this.count) return; // a gap (the world was edited oddly): wait for the next aligned sample
    const row = this.ids.length * TRACK_STRIDE;
    if ((this.count + 1) * row > this.data.length) {
      const grown = new Float32Array(Math.max(this.data.length * 2, row * 256));
      grown.set(this.data);
      this.data = grown;
    }
    let o = this.count * row;
    for (const id of this.ids) {
      const r = s.bodies.get(id);
      if (r) {
        const t = r.rb.translation();
        const q = r.rb.rotation();
        this.data[o] = t.x;
        this.data[o + 1] = t.y;
        this.data[o + 2] = t.z;
        this.data[o + 3] = q.x;
        this.data[o + 4] = q.y;
        this.data[o + 5] = q.z;
        this.data[o + 6] = q.w;
      } else if (this.count > 0) {
        // the body is gone: hold its last pose
        this.data.copyWithin(o, o - row, o - row + TRACK_STRIDE);
        // (copyWithin above copies from the same body's slot of the previous row)
      }
      o += TRACK_STRIDE;
    }
    this.count++;
    if (this.count * row > MAX_TRACK_FLOATS) this.decimate();
  }

  private decimate(): void {
    const row = this.ids.length * TRACK_STRIDE;
    const keep = Math.ceil(this.count / 2);
    for (let i = 1; i < keep; i++) this.data.copyWithin(i * row, i * 2 * row, i * 2 * row + row);
    this.count = keep;
    this.every *= 2;
  }

  truncateAfter(step: number): void {
    if (!this.started || this.every === 0) return;
    const n = Math.floor((step - this.first) / this.every) + 1;
    this.count = Math.max(0, Math.min(this.count, n));
  }

  /** A copy of the current track (null when nothing useful was sampled). */
  export(name: string): TrackData | null {
    if (!this.started || this.count < 2 || this.ids.length === 0) return null;
    const row = this.ids.length * TRACK_STRIDE;
    return {
      name,
      ids: [...this.ids],
      every: this.every,
      hz: this.hz,
      first: this.first,
      count: this.count,
      data: this.data.slice(0, this.count * row),
      duration: ((this.count - 1) * this.every) / this.hz,
    };
  }
}

// ---- finished runs ---------------------------------------------------------------------------

const MAX_RUNS = 8;
const stash: TrackData[] = [];
let runCounter = 0;

/** Keep the track of a world that is going away so a later world can show it as a ghost. */
export function stashTrack(sampler: TrackSampler): void {
  runCounter++;
  const t = sampler.export(`Run ${runCounter}`);
  if (!t || t.duration < 0.5) return;
  stash.push(t);
  while (stash.length > MAX_RUNS) stash.shift();
}

export function stashedRuns(): readonly TrackData[] {
  return stash;
}

export function clearStashedRuns(): void {
  stash.length = 0;
  runCounter = 0;
}
