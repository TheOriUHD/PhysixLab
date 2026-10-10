/** Pure helpers for trajectory tracks (TM-5): sampling a pose at a time, and the distance between two runs. */
import type { TrackData } from '../physics/timelineTypes';

const STRIDE = 7;

/** Pose of body `index` of the track at simulation time `t` (seconds since the track's first sample), interpolated. */
export function samplePose(track: TrackData, index: number, t: number, out: Float64Array): void {
  const dt = track.every / track.hz;
  const f = Math.min(Math.max(t / dt, 0), track.count - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(track.count - 1, i0 + 1);
  const a = f - i0;
  const row = track.ids.length * STRIDE;
  const o0 = i0 * row + index * STRIDE;
  const o1 = i1 * row + index * STRIDE;
  const d = track.data;
  for (let k = 0; k < 3; k++) out[k] = d[o0 + k] + (d[o1 + k] - d[o0 + k]) * a;
  // nlerp of the quaternions, taking the short way round
  let dot = 0;
  for (let k = 3; k < 7; k++) dot += d[o0 + k] * d[o1 + k];
  const sgn = dot < 0 ? -1 : 1;
  let n = 0;
  for (let k = 3; k < 7; k++) {
    out[k] = d[o0 + k] * (1 - a) + sgn * d[o1 + k] * a;
    n += out[k] * out[k];
  }
  n = Math.sqrt(n) || 1;
  for (let k = 3; k < 7; k++) out[k] /= n;
}

/** Simulated time of the first sample is 0: tracks of different runs line up by elapsed time. */
export function trackDuration(track: TrackData): number {
  return ((track.count - 1) * track.every) / track.hz;
}

export interface Comparison {
  /** Time axis, seconds. */
  t: number[];
  /** Mean and largest distance over the bodies both runs have, metres. */
  mean: number[];
  max: number[];
  /** Per body: its distance at each time. */
  perBody: Map<string, number[]>;
  /** The time at which the runs are furthest apart, and how far. */
  peak: { t: number; distance: number };
  shared: number;
}

/** Distance between two runs over time (up to `points` samples across the shorter run). */
export function compareTracks(a: TrackData, b: TrackData, points = 240): Comparison | null {
  const idsB = new Map(b.ids.map((id, i) => [id, i]));
  const pairs: [string, number, number][] = [];
  a.ids.forEach((id, i) => {
    const j = idsB.get(id);
    if (j !== undefined) pairs.push([id, i, j]);
  });
  if (!pairs.length) return null;
  const end = Math.min(trackDuration(a), trackDuration(b));
  if (end <= 0) return null;
  const n = Math.max(2, Math.min(points, Math.floor(end * 60) + 1));
  const pa = new Float64Array(7);
  const pb = new Float64Array(7);
  const cmp: Comparison = {
    t: [],
    mean: [],
    max: [],
    perBody: new Map(pairs.map((p) => [p[0], []])),
    peak: { t: 0, distance: 0 },
    shared: pairs.length,
  };
  for (let k = 0; k < n; k++) {
    const t = (k / (n - 1)) * end;
    let sum = 0;
    let mx = 0;
    for (const [id, i, j] of pairs) {
      samplePose(a, i, t, pa);
      samplePose(b, j, t, pb);
      const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
      cmp.perBody.get(id)!.push(d);
      sum += d;
      if (d > mx) mx = d;
    }
    cmp.t.push(t);
    cmp.mean.push(sum / pairs.length);
    cmp.max.push(mx);
    if (mx > cmp.peak.distance) cmp.peak = { t, distance: mx };
  }
  return cmp;
}

// ---- storing a track (the personal best) ------------------------------------------------------

export interface StoredTrack {
  name: string;
  ids: string[];
  every: number;
  hz: number;
  first: number;
  count: number;
  data: string; // base64 of the Float32 samples
  duration: number;
}

/** Keep every `k`-th sample so the stored copy stays small. */
export function thinTrack(t: TrackData, maxFloats: number): TrackData {
  const row = t.ids.length * STRIDE;
  let k = 1;
  while (Math.ceil(t.count / k) * row > maxFloats) k++;
  if (k === 1) return t;
  const count = Math.ceil(t.count / k);
  const data = new Float32Array(count * row);
  for (let i = 0; i < count; i++) data.set(t.data.subarray(i * k * row, (i * k + 1) * row), i * row);
  return { ...t, every: t.every * k, count, data, duration: ((count - 1) * t.every * k) / t.hz };
}
