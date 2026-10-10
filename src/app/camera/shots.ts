/**
 * Cinematic shots: a camera on a rail. A shot names a path entity (the spline), and a list of keys that say where on
 * the path the camera is at each time, with which lens, and how the motion eases into the next key. Everything here
 * is pure (the path and the look-at body are looked up through `ShotEnv`), so it runs in Node tests.
 */
import { Quaternion, Vector3 } from 'three';
import type { Vec3 } from '../../core/math';
import { clamp } from '../../core/math';
import { uid } from '../../model/factory';
import type { PathCurve } from '../../model/path';
import type { CameraShot, ShotEase, ShotKey } from '../../model/types';
import { aimAt, easeInOut, type Pose } from './poses';

export const EASES: Record<ShotEase, (k: number) => number> = {
  linear: (k) => k,
  in: (k) => k * k,
  out: (k) => 1 - (1 - k) * (1 - k),
  inOut: easeInOut,
};

export interface ShotEnv {
  /** The world-space curve of a path entity, or null if there is no such path. */
  curve(pathId: string): PathCurve | null;
  /** The world position of a body (live pose while simulating), or null. */
  bodyPosition(id: string): Vec3 | null;
}

/** Position along the path (0…1) and lens at time `t` (seconds; clamped to the shot, or wrapped when it loops). */
export function sampleShot(shot: CameraShot, t: number): { u: number; fov: number } {
  const keys = shot.keys;
  const d = shot.duration;
  const time = shot.loop && d > 0 ? ((t % d) + d) % d : clamp(t, 0, d);
  if (time <= keys[0].t) return { u: keys[0].u, fov: keys[0].fov };
  const last = keys[keys.length - 1];
  if (time >= last.t) return { u: last.u, fov: last.fov };
  let i = 0;
  while (i < keys.length - 2 && time >= keys[i + 1].t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const span = Math.max(1e-9, b.t - a.t);
  const k = EASES[a.ease]((time - a.t) / span);
  return { u: a.u + (b.u - a.u) * k, fov: a.fov + (b.fov - a.fov) * k };
}

const _p = new Vector3();
const _t = new Vector3();
const _tan = new Vector3();
const _look = new Vector3();
const _q = new Quaternion();

/** The camera pose of a shot at time `t`; false when the shot's path is missing. */
export function shotPose(shot: CameraShot, t: number, env: ShotEnv, out: Pose): boolean {
  const curve = env.curve(shot.pathId);
  if (!curve || curve.length <= 0) return false;
  const { u, fov } = sampleShot(shot, t);
  const s = u * curve.length;
  const pos = curve.positionAtDistance(s);
  const tan = curve.tangentAtDistance(s);
  out.position.set(pos[0], pos[1], pos[2]);
  out.fov = fov;
  _tan.set(tan[0], tan[1], tan[2]);
  if (_tan.lengthSq() < 1e-12) _tan.set(0, 0, -1);
  _tan.normalize();
  let target: Vec3 | null = null;
  if (shot.look.mode === 'body') target = env.bodyPosition(shot.look.bodyId);
  else if (shot.look.mode === 'point') target = shot.look.point;
  if (target) _look.set(target[0], target[1], target[2]);
  else _look.copy(out.position).addScaledVector(_tan, 10);
  // Looking straight at the camera's own position (a body at the camera) would have no direction: keep the last one.
  if (_look.distanceToSquared(out.position) < 1e-8) _look.copy(out.position).addScaledVector(_tan, 10);
  _p.copy(out.position);
  _t.copy(_look);
  aimAt(_p, _t, _q);
  out.quaternion.copy(_q);
  return true;
}

// ---- editing (pure, returns new shots) ----------------------------------------------------------------

export function newShot(pathId: string, name: string, fov = 48, duration = 8): CameraShot {
  return {
    id: uid('cs'),
    name,
    pathId,
    duration,
    loop: false,
    keys: [
      { t: 0, u: 0, fov, ease: 'inOut' },
      { t: duration, u: 1, fov, ease: 'inOut' },
    ],
    look: { mode: 'tangent', bodyId: '', point: [0, 1, 0] },
  };
}

const sortKeys = (keys: ShotKey[]): ShotKey[] => keys.slice().sort((a, b) => a.t - b.t);

/** Insert a key at time `t` holding the shot's current position and lens there (so adding a key changes nothing). */
export function addKey(shot: CameraShot, t: number): CameraShot {
  const time = clamp(t, 0, shot.duration);
  const { u, fov } = sampleShot({ ...shot, loop: false }, time);
  const same = shot.keys.findIndex((k) => Math.abs(k.t - time) < 1e-3);
  if (same >= 0) return shot;
  return { ...shot, keys: sortKeys([...shot.keys, { t: time, u, fov, ease: 'inOut' }]) };
}

export function updateKey(shot: CameraShot, index: number, patch: Partial<ShotKey>): CameraShot {
  const keys = shot.keys.map((k, i) =>
    i === index
      ? {
          t: clamp(patch.t ?? k.t, 0, shot.duration),
          u: clamp(patch.u ?? k.u, 0, 1),
          fov: clamp(patch.fov ?? k.fov, 5, 120),
          ease: patch.ease ?? k.ease,
        }
      : k,
  );
  return { ...shot, keys: sortKeys(keys) };
}

/** Remove a key; a shot keeps at least a start and an end. */
export function removeKey(shot: CameraShot, index: number): CameraShot {
  if (shot.keys.length <= 2) return shot;
  return { ...shot, keys: shot.keys.filter((_, i) => i !== index) };
}

/** Change the duration, scaling the key times with it so the motion keeps its shape. */
export function setDuration(shot: CameraShot, duration: number): CameraShot {
  const d = clamp(duration, 0.5, 3600);
  const f = d / shot.duration;
  return { ...shot, duration: d, keys: shot.keys.map((k) => ({ ...k, t: k.t * f })) };
}
