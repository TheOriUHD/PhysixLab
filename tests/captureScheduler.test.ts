// -- DT-2 -- capture schedule, option limits and turntable camera path (pure parts).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPTURE,
  GIF_LIMITS,
  VIDEO_LIMITS,
  gifDelays,
  hashBytes,
  outputHeight,
  planFrames,
  validateOptions,
  type CaptureOptions,
} from '../src/app/capture/scheduler';
import { rotateOffsetY, turntableAngle, turntableOffset, turntablePose } from '../src/app/capture/turntable';

describe('planFrames', () => {
  it('has round(fps * duration) frames at exactly i / fps', () => {
    const p = planFrames({ fps: 10, duration: 1, physicsHz: 60 });
    expect(p.count).toBe(10);
    expect(p.frames.map((f) => f.time)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    expect(p.frames[0].steps).toBe(0);
    expect(p.frames.every((f, i) => i === 0 || f.steps === 6)).toBe(true);
    expect(p.totalSteps).toBe(54);
  });

  it('rounds cumulatively so uneven ratios never drift (60 Hz at 25 fps: 2,3,2,3,3 …)', () => {
    const p = planFrames({ fps: 25, duration: 4, physicsHz: 60 });
    expect(p.count).toBe(100);
    // Frame i has run round(i * 2.4) steps in total; the per-frame counts are only 2 or 3.
    p.frames.forEach((f) => expect(f.totalSteps).toBe(Math.round(f.index * 2.4)));
    expect(new Set(p.frames.slice(1).map((f) => f.steps))).toEqual(new Set([2, 3]));
    // Over any 5 frames exactly 12 steps: no drift.
    expect(p.frames[50].totalSteps - p.frames[0].totalSteps).toBe(120);
    expect(p.frames.reduce((s, f) => s + f.steps, 0)).toBe(p.totalSteps);
  });

  it('scales with the time scale and the physics rate', () => {
    expect(planFrames({ fps: 30, duration: 2, physicsHz: 120, timeScale: 0.5 }).frames[30].totalSteps).toBe(60);
    expect(planFrames({ fps: 30, duration: 1, physicsHz: 60, timeScale: 2 }).frames[1].steps).toBe(4);
  });

  it('simulated time of the last frame is (count-1)/fps independent of anything else', () => {
    const p = planFrames({ fps: 15, duration: 3, physicsHz: 240 });
    const last = p.frames[p.count - 1];
    expect(last.totalSteps / 240).toBeCloseTo(last.time, 9);
  });

  it('rejects nonsense', () => {
    expect(() => planFrames({ fps: 0, duration: 1, physicsHz: 60 })).toThrow();
    expect(() => planFrames({ fps: 10, duration: -1, physicsHz: 60 })).toThrow();
  });
});

describe('gifDelays', () => {
  it('sums to the exact duration even when 100/fps is fractional', () => {
    for (const fps of [10, 12, 15, 20, 24, 25, 30]) {
      const d = gifDelays(fps, fps * 3);
      expect(d.reduce((a, b) => a + b, 0)).toBe(300);
      expect(Math.max(...d) - Math.min(...d)).toBeLessThanOrEqual(1);
    }
    expect(gifDelays(10, 3)).toEqual([10, 10, 10]);
    expect(gifDelays(30, 3)).toEqual([3, 4, 3]);
  });
});

describe('validateOptions', () => {
  const gif: CaptureOptions = { ...DEFAULT_CAPTURE, format: 'gif', width: 640, fps: 10, duration: 2 };

  it('accepts sane options and reports the frame count and height', () => {
    const v = validateOptions(gif, 1600, 900);
    expect(v.errors).toEqual([]);
    expect(v.frames).toBe(20);
    expect(v.height).toBe(360);
  });

  it('gives clear messages for each limit', () => {
    expect(validateOptions({ ...gif, width: 1920 }).errors[0]).toMatch(/limited to 960 px/);
    expect(validateOptions({ ...gif, fps: 60 }).errors[0]).toMatch(/between 1 and 30 fps/);
    expect(validateOptions({ ...gif, duration: 31 }).errors[0]).toMatch(/limited to 30 s/);
    expect(validateOptions({ ...gif, duration: 0.1 }).errors[0]).toMatch(/at least/);
    expect(validateOptions({ ...gif, width: 10 }).errors[0]).toMatch(/at least 64/);
    expect(validateOptions({ ...gif, fps: Number.NaN }).errors[0]).toMatch(/must be a number/);
    // Too many frames: 30 fps * 30 s = 900 > 600.
    expect(validateOptions({ ...gif, fps: 30, duration: 30, deterministic: true }).errors.join(' ')).toMatch(
      /at most 600 frames/,
    );
  });

  it('bounds the memory of a real-time GIF but not of a deterministic one', () => {
    const big = { ...gif, width: 960, fps: 30, duration: 20, deterministic: false }; // 600 frames x 960x540
    expect(validateOptions(big, 1600, 900).errors.join(' ')).toMatch(/MB of memory/);
    expect(validateOptions({ ...big, deterministic: true }, 1600, 900).errors).toEqual([]);
    expect(GIF_LIMITS.maxFrames).toBe(600);
  });

  it('applies the video limits to WebM and MP4', () => {
    const v: CaptureOptions = { ...DEFAULT_CAPTURE, format: 'webm', width: 1920, fps: 30, duration: 10 };
    expect(validateOptions(v).errors).toEqual([]);
    expect(validateOptions({ ...v, fps: 120 }).errors[0]).toMatch(/WEBM frame rate/);
    expect(validateOptions({ ...v, format: 'mp4', width: VIDEO_LIMITS.maxWidth + 2 }).errors[0]).toMatch(/MP4 width/);
  });

  it('needs at least a second for a turntable', () => {
    expect(validateOptions({ ...gif, turntable: true, duration: 0.5 }).errors.join(' ')).toMatch(/turntable/);
  });
});

describe('outputHeight', () => {
  it('keeps the aspect ratio and is even', () => {
    expect(outputHeight(640, 1600, 900)).toBe(360);
    expect(outputHeight(333, 1000, 1000) % 2).toBe(0);
  });
});

describe('hashBytes', () => {
  it('is stable and sensitive to a one-bit change', () => {
    const a = Uint8Array.from([1, 2, 3, 4]);
    expect(hashBytes(a)).toBe(hashBytes(Uint8Array.from([1, 2, 3, 4])));
    expect(hashBytes(a)).not.toBe(hashBytes(Uint8Array.from([1, 2, 3, 5])));
    expect(hashBytes(new Uint8Array(0))).toBe('811c9dc5');
  });
});

describe('turntable path', () => {
  it('covers exactly 360 degrees, starting at the current view, and closes the loop', () => {
    const n = 36;
    expect(turntableAngle(0, n)).toBe(0);
    expect(turntableAngle(n, n)).toBeCloseTo(2 * Math.PI, 12);
    expect(turntableAngle(9, n)).toBeCloseTo(Math.PI / 2, 12);
    expect(turntableAngle(9, n, -1)).toBeCloseTo(-Math.PI / 2, 12);
    const offset: [number, number, number] = [4, 3, 2];
    const first = turntablePose([1, 1, 1], offset, turntableAngle(0, n));
    expect(first.position).toEqual([5, 4, 3]);
    const closed = turntablePose([1, 1, 1], offset, turntableAngle(n, n));
    closed.position.forEach((v, i) => expect(v).toBeCloseTo(first.position[i], 9));
  });

  it('keeps distance to the target and the height constant on every frame', () => {
    const offset: [number, number, number] = [6, 2.5, -1];
    const target: [number, number, number] = [0.5, 1, -2];
    const d0 = Math.hypot(...offset);
    for (let i = 0; i < 60; i++) {
      const p = turntablePose(target, offset, turntableAngle(i, 60));
      const o = [p.position[0] - target[0], p.position[1] - target[1], p.position[2] - target[2]];
      expect(Math.hypot(o[0], o[1], o[2])).toBeCloseTo(d0, 9);
      expect(o[1]).toBeCloseTo(offset[1], 12);
      expect(p.target).toEqual(target);
    }
  });

  it('turns the offset a quarter-turn per quarter of the frames (counter-clockwise seen from above)', () => {
    const r = rotateOffsetY([1, 0, 0], Math.PI / 2);
    expect(r[0]).toBeCloseTo(0, 12);
    expect(r[2]).toBeCloseTo(-1, 12);
  });

  it('turntableOffset keeps the direction, fits the radius and lifts a camera below the horizon', () => {
    const o = turntableOffset([3, 3, 0], 1, 50);
    expect(o[0] / o[1]).toBeCloseTo(1, 9);
    expect(Math.hypot(...o)).toBeCloseTo(Math.max(2.2, (1 / Math.tan((25 * Math.PI) / 180)) * 1.35), 9);
    const low = turntableOffset([5, -2, 0], 2, 50);
    expect(low[1]).toBeGreaterThan(0);
    expect(Math.hypot(...low)).toBeGreaterThan(2.2);
    const straightDown = turntableOffset([0, 1, 0], 2, 50);
    expect(Number.isFinite(straightDown[2])).toBe(true);
  });
});
