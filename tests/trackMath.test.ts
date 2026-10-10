import { describe, expect, it } from 'vitest';
import { compareTracks, samplePose, thinTrack, trackDuration } from '../src/app/trackMath';
import type { TrackData } from '../src/physics/timelineTypes';

/** One body moving along +x at `speed` m/s, sampled at 10 Hz. */
function line(speed: number, ids = ['a'], seconds = 2): TrackData {
  const count = seconds * 10 + 1;
  const data = new Float32Array(count * ids.length * 7);
  for (let i = 0; i < count; i++)
    ids.forEach((_, b) => {
      const o = (i * ids.length + b) * 7;
      data[o] = speed * (i / 10);
      data[o + 1] = b;
      data[o + 6] = 1;
    });
  return { name: 'line', ids, every: 6, hz: 60, first: 0, count, data, duration: seconds };
}

describe('track math', () => {
  it('interpolates poses between samples', () => {
    const t = line(2);
    const p = new Float64Array(7);
    samplePose(t, 0, 0.55, p);
    expect(p[0]).toBeCloseTo(1.1, 5);
    samplePose(t, 0, 99, p); // past the end holds the last pose
    expect(p[0]).toBeCloseTo(4, 5);
    expect(trackDuration(t)).toBeCloseTo(2, 9);
  });

  it('measures the distance between two runs over time', () => {
    const c = compareTracks(line(2), line(3), 21)!;
    expect(c.shared).toBe(1);
    expect(c.t.length).toBe(21);
    expect(c.mean[0]).toBeCloseTo(0, 9);
    expect(c.mean[20]).toBeCloseTo(2, 5); // 6 m vs 4 m after 2 s
    expect(c.peak.t).toBeCloseTo(2, 9);
    expect(c.peak.distance).toBeCloseTo(2, 5);
  });

  it('only compares the bodies both runs have, and says nothing for disjoint runs', () => {
    const a = line(1, ['a', 'b']);
    const b = line(1, ['b', 'c']);
    expect(compareTracks(a, b)!.shared).toBe(1);
    expect(compareTracks(line(1, ['a']), line(1, ['z']))).toBeNull();
  });

  it('thins a track to fit a size cap', () => {
    const t = line(1, ['a', 'b'], 20);
    const small = thinTrack(t, 100);
    expect(small.data.length).toBeLessThanOrEqual(100 + 14);
    expect(small.every).toBeGreaterThan(t.every);
    expect(small.duration).toBeGreaterThan(15); // a thinned track loses at most a few samples at the end
  });
});
