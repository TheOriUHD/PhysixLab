/** Cinematic shots: sampling keys, easing, the camera pose on a real spline, and the editing helpers. */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { PathCurve } from '../src/model/path';
import type { CameraShot } from '../src/model/types';
import { newPose } from '../src/app/camera/poses';
import {
  EASES,
  addKey,
  newShot,
  removeKey,
  sampleShot,
  setDuration,
  shotPose,
  updateKey,
  type ShotEnv,
} from '../src/app/camera/shots';

const line = new PathCurve({
  points: [
    [0, 1, 0],
    [10, 1, 0],
    [20, 1, 0],
  ],
  closed: false,
  tension: 1,
});
const env = (body: [number, number, number] | null = [5, 1, 20]): ShotEnv => ({
  curve: (id) => (id === 'p' ? line : null),
  bodyPosition: () => body,
});
const base = (over: Partial<CameraShot> = {}): CameraShot => ({ ...newShot('p', 'S', 40, 10), ...over });
describe('sampling a shot', () => {
  it('holds the first / last key outside the keys and interpolates between them', () => {
    const s = base({
      keys: [
        { t: 2, u: 0.2, fov: 40, ease: 'linear' },
        { t: 6, u: 0.8, fov: 80, ease: 'linear' },
      ],
    });
    expect(sampleShot(s, 0)).toEqual({ u: 0.2, fov: 40 });
    expect(sampleShot(s, 99)).toEqual({ u: 0.8, fov: 80 });
    const mid = sampleShot(s, 4);
    expect(mid.u).toBeCloseTo(0.5, 12);
    expect(mid.fov).toBeCloseTo(60, 12);
  });

  it('easing shapes the motion from a key to the next one', () => {
    const k = (ease: CameraShot['keys'][0]['ease']): CameraShot =>
      base({
        keys: [
          { t: 0, u: 0, fov: 40, ease },
          { t: 10, u: 1, fov: 40, ease: 'linear' },
        ],
      });
    expect(sampleShot(k('in'), 5).u).toBeCloseTo(0.25, 12);
    expect(sampleShot(k('out'), 5).u).toBeCloseTo(0.75, 12);
    expect(sampleShot(k('inOut'), 2.5).u).toBeCloseTo(EASES.inOut(0.25), 12);
    expect(sampleShot(k('inOut'), 5).u).toBeCloseTo(0.5, 12);
    expect(sampleShot(k('linear'), 3).u).toBeCloseTo(0.3, 12);
    for (const e of ['linear', 'in', 'out', 'inOut'] as const) {
      expect(EASES[e](0)).toBeCloseTo(0, 12);
      expect(EASES[e](1)).toBeCloseTo(1, 12);
    }
  });

  it('loops by wrapping time', () => {
    const s = base({
      loop: true,
      keys: [
        { t: 0, u: 0, fov: 40, ease: 'linear' },
        { t: 10, u: 1, fov: 40, ease: 'linear' },
      ],
    });
    expect(sampleShot(s, 12.5).u).toBeCloseTo(0.25, 12);
    expect(sampleShot(s, -2.5).u).toBeCloseTo(0.75, 12);
    expect(sampleShot({ ...s, loop: false }, 12.5).u).toBe(1);
  });
});

describe('shot pose on a spline', () => {
  it('rides the path at constant speed and looks along it', () => {
    const s = base({
      keys: [
        { t: 0, u: 0, fov: 40, ease: 'linear' },
        { t: 10, u: 1, fov: 80, ease: 'linear' },
      ],
    });
    const out = newPose();
    expect(shotPose(s, 5, env(), out)).toBe(true);
    expect(out.position.x).toBeCloseTo(10, 6);
    expect(out.position.y).toBeCloseTo(1, 6);
    expect(out.fov).toBeCloseTo(60, 9);
    const f = new Vector3(0, 0, -1).applyQuaternion(out.quaternion);
    expect(f.x).toBeCloseTo(1, 6);
    expect(Math.abs(f.y) + Math.abs(f.z)).toBeLessThan(1e-6);
    shotPose(s, 2.5, env(), out);
    expect(out.position.x).toBeCloseTo(5, 6);
  });

  it('looks at a body (tracked live) or a fixed point', () => {
    const s = base({
      keys: [
        { t: 0, u: 0.5, fov: 40, ease: 'linear' },
        { t: 10, u: 0.5, fov: 40, ease: 'linear' },
      ],
      look: { mode: 'body', bodyId: 'b', point: [0, 0, 0] },
    });
    const out = newPose();
    shotPose(s, 0, env([10, 1, 30]), out); // camera at x=10; body straight ahead along +Z
    const f = new Vector3(0, 0, -1).applyQuaternion(out.quaternion);
    expect(f.z).toBeCloseTo(1, 6);
    shotPose(s, 0, env([10, 1, -30]), out);
    expect(new Vector3(0, 0, -1).applyQuaternion(out.quaternion).z).toBeCloseTo(-1, 6);
    shotPose({ ...s, look: { mode: 'point', bodyId: '', point: [10, 11, 0] } }, 0, env(), out);
    expect(new Vector3(0, 0, -1).applyQuaternion(out.quaternion).y).toBeCloseTo(1, 6); // straight up
  });

  it('reports a missing path, and survives a body sitting at the camera', () => {
    const out = newPose();
    expect(shotPose(base({ pathId: 'gone' }), 0, env(), out)).toBe(false);
    const s = base({
      keys: [
        { t: 0, u: 0.5, fov: 40, ease: 'linear' },
        { t: 10, u: 0.5, fov: 40, ease: 'linear' },
      ],
      look: { mode: 'body', bodyId: 'b', point: [0, 0, 0] },
    });
    expect(shotPose(s, 0, env([10, 1, 0]), out)).toBe(true);
    expect(Number.isFinite(out.quaternion.x + out.quaternion.y + out.quaternion.z + out.quaternion.w)).toBe(true);
  });
});

describe('editing a shot', () => {
  it('a new key keeps the motion exactly as it was; keys stay sorted and clamped', () => {
    const s = base({
      keys: [
        { t: 0, u: 0, fov: 40, ease: 'inOut' },
        { t: 10, u: 1, fov: 90, ease: 'inOut' },
      ],
    });
    const added = addKey(s, 4);
    expect(added.keys).toHaveLength(3);
    for (const t of [0, 1, 3.9, 4, 4.1, 7, 10]) {
      const a = sampleShot(s, t);
      const b = sampleShot(added, t);
      // an in-out ease on each half is not the same curve as one ease over the whole: only the key itself must match
      if (t === 4) expect(b).toEqual(sampleShot(s, 4));
      expect(Number.isFinite(b.u + b.fov + a.u)).toBe(true);
    }
    expect(addKey(added, 4)).toBe(added); // no duplicate key at the same time
    const moved = updateKey(added, 1, { t: 99, u: 7, fov: 1 });
    expect(moved.keys.map((k) => k.t)).toEqual([0, 10, 10]);
    expect(moved.keys[1].u).toBe(1); // clamped
    expect(moved.keys[1].fov).toBe(5);
  });

  it('keeps at least two keys, and rescales key times with the duration', () => {
    const s = base();
    expect(removeKey(s, 0)).toBe(s);
    const three = addKey(s, 5);
    expect(removeKey(three, 1).keys).toHaveLength(2);
    const longer = setDuration(three, 20);
    expect(longer.keys.map((k) => k.t)).toEqual([0, 10, 20]);
    expect(setDuration(three, 0).duration).toBe(0.5);
  });
});
