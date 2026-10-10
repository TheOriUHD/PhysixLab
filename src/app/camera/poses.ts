/**
 * Camera pose maths for the driven camera modes — pure functions over three.js vectors, no DOM, no scene:
 * the heading of a body, fly-camera stepping, and the first-person, third-person and chase poses. The rig calls
 * them every frame with preallocated outputs (nothing here allocates), and the tests call them with numbers.
 */
import { Euler, Quaternion, Vector3 } from 'three';
import { clamp } from '../../core/math';
import type { ForwardAxis } from './settings';

export interface Pose {
  position: Vector3;
  quaternion: Quaternion;
  fov: number;
}

export const newPose = (): Pose => ({ position: new Vector3(), quaternion: new Quaternion(), fov: 48 });

/** What a body-following camera needs to know about the body. */
export interface Subject {
  position: Vector3;
  quaternion: Quaternion;
  /** World velocity (m/s). */
  velocity: Vector3;
  /** Height of the top of the body above its centre (eye height for first person). */
  top: number;
}

const FORWARD: Record<ForwardAxis, [number, number, number]> = {
  '+x': [1, 0, 0],
  '-x': [-1, 0, 0],
  '+z': [0, 0, 1],
  '-z': [0, 0, -1],
};
/** Yaw about +Y that turns the camera's own forward (−Z) onto each local axis. */
const ALIGN_YAW: Record<ForwardAxis, number> = { '+x': -Math.PI / 2, '-x': Math.PI / 2, '+z': Math.PI, '-z': 0 };

const _v = new Vector3();
const _q = new Quaternion();
const _e = new Euler(0, 0, 0, 'YXZ');

/** Unit direction on the ground plane for heading ψ: ψ = 0 is +Z, ψ = π/2 is +X. */
export const dirOf = (psi: number, out: Vector3): Vector3 => out.set(Math.sin(psi), 0, Math.cos(psi));

/** Heading ψ (see `dirOf`) of a body's forward axis, ignoring tilt. A body pointing straight up/down keeps `fallback`. */
export function headingOf(q: Quaternion, axis: ForwardAxis, fallback = 0): number {
  const [x, y, z] = FORWARD[axis];
  _v.set(x, y, z).applyQuaternion(q);
  return Math.hypot(_v.x, _v.z) < 1e-4 ? fallback : Math.atan2(_v.x, _v.z);
}

/** Shortest signed difference b − a of two angles. */
export const angleDelta = (a: number, b: number): number => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/** Exponential approach factor for a rate (1/s): independent of the frame rate. */
export const smoothing = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

/** Camera orientation looking along heading ψ with pitch θ (up positive): a yaw-pitch quaternion. */
export function lookQuaternion(psi: number, pitch: number, out: Quaternion): Quaternion {
  // The camera looks down −Z; heading ψ points along (sinψ, 0, cosψ), which is −Z turned by ψ + π.
  _e.set(pitch, psi + Math.PI, 0, 'YXZ');
  return out.setFromEuler(_e);
}

// ---- fly -----------------------------------------------------------------------------------------

export interface FlyState {
  position: Vector3;
  yaw: number;
  pitch: number;
  velocity: Vector3;
}

export interface FlyInput {
  /** −1 … 1 along the view direction / to the right / up. */
  forward: number;
  right: number;
  up: number;
  boost: boolean;
}

/** Advance the fly camera: acceleration-smoothed movement along the view direction. */
export function flyStep(s: FlyState, input: FlyInput, speed: number, dt: number): void {
  const v = speed * (input.boost ? 4 : 1);
  lookQuaternion(s.yaw, s.pitch, _q);
  _v.set(input.right, 0, -input.forward).applyQuaternion(_q);
  _v.y += input.up; // up/down are world axes, whatever the pitch
  if (_v.lengthSq() > 1) _v.normalize();
  _v.multiplyScalar(v);
  s.velocity.lerp(_v, smoothing(10, dt));
  s.position.addScaledVector(s.velocity, dt);
}

/** Mouse look: yaw follows the drag, pitch is limited to just short of straight up / down. */
export function lookBy(s: { yaw: number; pitch: number }, dx: number, dy: number, sens = 0.0035): void {
  s.yaw -= dx * sens;
  s.pitch = clamp(s.pitch - dy * sens, -1.5, 1.5);
}

// ---- first person --------------------------------------------------------------------------------

export function firstPersonPose(
  subject: Subject,
  axis: ForwardAxis,
  look: { yaw: number; pitch: number },
  fov: number,
  out: Pose,
): Pose {
  // Eye: a little below the top of the body, in the body's own frame so a rolling or flipping body shows it.
  _v.set(0, subject.top * 0.8, 0).applyQuaternion(subject.quaternion);
  out.position.copy(subject.position).add(_v);
  _q.setFromAxisAngle(_v.set(0, 1, 0), ALIGN_YAW[axis]);
  out.quaternion.copy(subject.quaternion).multiply(_q);
  _e.set(look.pitch, look.yaw, 0, 'YXZ');
  out.quaternion.multiply(_q.setFromEuler(_e));
  out.fov = fov;
  return out;
}

// ---- third person (spring arm) -------------------------------------------------------------------

export interface FollowState {
  position: Vector3;
  /** Heading of the arm (camera is behind this heading). */
  psi: number;
  /** User-driven offsets from the subject's heading / the arm's pitch. */
  yawOffset: number;
  pitch: number;
  /** Current arm length after collision shortening. */
  arm: number;
  initialised: boolean;
  /** Chase only: 0 → normal, 1 → looking back. */
  behind: number;
}

export const newFollow = (): FollowState => ({
  position: new Vector3(),
  psi: 0,
  yawOffset: 0,
  pitch: 0.28,
  arm: 6,
  initialised: false,
  behind: 0,
});

export interface ArmProbe {
  /** Distance from `from` along `dir` to the first obstacle within `max`, or `max` if the way is clear. */
  (from: Vector3, dir: Vector3, max: number): number;
}

const _pivot = new Vector3();
const _dir = new Vector3();
const _want = new Vector3();

/** Third-person camera: behind the subject's heading, `distance` away and `height` above, shortened by obstacles. */
export function thirdPersonPose(
  s: FollowState,
  subject: Subject,
  axis: ForwardAxis,
  cfg: { distance: number; height: number },
  probe: ArmProbe | null,
  fov: number,
  dt: number,
  out: Pose,
): Pose {
  const heading = headingOf(subject.quaternion, axis, s.psi);
  if (!s.initialised) {
    s.psi = heading;
    s.arm = cfg.distance;
    s.initialised = true;
  }
  // The arm swings behind the subject's heading with a lag; the user's mouse offset stays on top of it.
  s.psi += angleDelta(s.psi, heading) * smoothing(2.5, dt);
  const az = s.psi + s.yawOffset;
  _pivot.copy(subject.position);
  _pivot.y += Math.max(0.4, subject.top * 0.9);
  const pitch = Math.atan2(cfg.height - subject.top * 0.9, cfg.distance) + (s.pitch - 0.28);
  const horizontal = Math.cos(pitch);
  _dir.set(-Math.sin(az) * horizontal, Math.sin(pitch), -Math.cos(az) * horizontal); // from the pivot toward the camera
  const full = Math.hypot(cfg.distance, cfg.height);
  let reach = full;
  if (probe) reach = Math.min(full, Math.max(0.5, probe(_pivot, _dir, full) - 0.25));
  // Obstacles pull the arm in at once; clear space lets it out slowly (no popping).
  s.arm = reach < s.arm ? reach : s.arm + (reach - s.arm) * smoothing(3, dt);
  _want.copy(_pivot).addScaledVector(_dir, s.arm);
  _want.y = Math.max(0.25, _want.y);
  s.position.lerp(_want, s.position.lengthSq() === 0 ? 1 : smoothing(14, dt));
  out.position.copy(s.position);
  aimAt(out.position, _pivot, out.quaternion);
  out.fov = fov;
  return out;
}

// ---- chase (velocity aligned) --------------------------------------------------------------------

const _hv = new Vector3();

/** Chase camera: behind the direction of travel, widening the lens with speed; `behind` (0…1) swings it in front. */
export function chasePose(
  s: FollowState,
  subject: Subject,
  axis: ForwardAxis,
  cfg: { distance: number; height: number },
  lookBack: boolean,
  fov: number,
  dt: number,
  out: Pose,
): Pose {
  _hv.copy(subject.velocity);
  _hv.y = 0;
  const speed = _hv.length();
  if (!s.initialised) {
    s.psi = headingOf(subject.quaternion, axis, 0);
    s.initialised = true;
    s.position.copy(subject.position);
    s.position.y += cfg.height;
  }
  // Slow: follow the body's nose. Fast: follow where it is going. Blend in between so a stop does not spin the view.
  const travel = speed > 0.2 ? Math.atan2(_hv.x, _hv.z) : s.psi;
  const nose = headingOf(subject.quaternion, axis, s.psi);
  const k = clamp((speed - 1) / 5, 0, 1);
  const target = nose + angleDelta(nose, travel) * k;
  s.psi += angleDelta(s.psi, target) * smoothing(3.2, dt);
  s.behind += ((lookBack ? 1 : 0) - s.behind) * smoothing(7, dt);
  const az = s.psi + s.yawOffset + s.behind * Math.PI;
  dirOf(az, _dir);
  _want.copy(subject.position).addScaledVector(_dir, -cfg.distance);
  _want.y = Math.max(0.3, subject.position.y + cfg.height);
  s.position.lerp(_want, smoothing(9, dt));
  out.position.copy(s.position);
  _pivot.copy(subject.position);
  _pivot.y += Math.max(0.5, subject.top * 0.8);
  aimAt(out.position, _pivot, out.quaternion);
  out.fov = fov + clamp(speed * 0.35, 0, 14);
  return out;
}

/** Orientation looking from `eye` toward `target` with +Y up. */
export function aimAt(eye: Vector3, target: Vector3, out: Quaternion): Quaternion {
  _dir.subVectors(target, eye);
  if (_dir.lengthSq() < 1e-12) return out;
  const psi = Math.atan2(_dir.x, _dir.z);
  const pitch = Math.atan2(_dir.y, Math.hypot(_dir.x, _dir.z));
  return lookQuaternion(psi, pitch, out);
}

/** Smooth 0…1 easing (ease-in-out cubic). */
export const easeInOut = (k: number): number => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

// ---- mounted (dashcam, drone) ---------------------------------------------------------------------

/**
 * A camera fixed to a body: `offset` is in the body's own frame turned so that its −Z is the forward axis (x right,
 * y up, z back), `yaw` / `pitch` turn the view from there (degrees, yaw to the left).
 */
export function mountPose(
  subject: Subject,
  axis: ForwardAxis,
  offset: readonly [number, number, number],
  yawDeg: number,
  pitchDeg: number,
  fov: number,
  out: Pose,
): Pose {
  _q.setFromAxisAngle(_v.set(0, 1, 0), ALIGN_YAW[axis]);
  out.quaternion.copy(subject.quaternion).multiply(_q);
  _v.set(offset[0], offset[1], offset[2]).applyQuaternion(out.quaternion);
  out.position.copy(subject.position).add(_v);
  _e.set((pitchDeg * Math.PI) / 180, (yawDeg * Math.PI) / 180, 0, 'YXZ');
  out.quaternion.multiply(_q.setFromEuler(_e));
  out.fov = fov;
  return out;
}

/** Straight down from `height` metres above the subject, screen-up = −Z. */
export function topDownPose(subject: Subject, height: number, fov: number, out: Pose): Pose {
  out.position.copy(subject.position);
  out.position.y += height;
  lookQuaternion(Math.PI, -Math.PI / 2, out.quaternion);
  out.fov = fov;
  return out;
}
