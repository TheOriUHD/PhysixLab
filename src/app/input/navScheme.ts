/**
 * The navigation schemes as data and maths, free of the DOM so they can be tested in Node:
 *
 *   wheelIntent    a wheel event (mouse notch, trackpad swipe or pinch) → orbit / pan / zoom
 *   dragVerb       which verb a pointer drag does for the held buttons and modifiers
 *   keyIntent      arrow / + / − keys → orbit / pan / zoom
 *   orbitBy, panByPixels, zoomBy   the camera moves themselves (zoom towards the cursor, perspective and orthographic)
 *
 * Principle: everything is doable on a trackpad alone, with modifiers held — nothing needs a button held while scrolling.
 *
 *   Trackpad   two-finger swipe orbits (setting: pans) · Shift / Cmd + swipe does the other · pinch zooms towards the
 *              cursor · Alt / Option + swipe zooms · Option + drag orbits · Space + drag pans
 *   Mouse      right-drag orbits · middle-drag pans · wheel zooms towards the cursor · Shift + wheel pans
 *   Touch      handled by the touch controller (one finger orbits, two fingers pan / pinch / twist)
 *   Keyboard   arrows orbit · Shift + arrows pan · + / − zoom (every scheme)
 */
import { MathUtils, Spherical, Vector3 } from 'three';
import type { DualCamera } from '../../render/dualCamera';
import type { NavSettings } from './navSettings';
import type { PointerKind, WheelKind } from './platform';

export type NavVerb = 'orbit' | 'pan' | 'zoom';

export interface Mods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

/**
 * What an input asks for. `orbit` / `pan`: `x`, `y` are drag-equivalent pixels (the way a hand dragging the scene
 * would move: right = positive x, down = positive y). `zoom`: `y` is the natural log of the distance scale (negative
 * zooms in), `x` is unused.
 */
export interface Intent {
  verb: NavVerb | 'none';
  x: number;
  y: number;
}

const NONE: Intent = { verb: 'none', x: 0, y: 0 };

/** Gains: how much one unit of input moves the view. */
export const GAIN = {
  /** ln(scale) per pinch delta unit (Chrome reports a pinch as small fractional `deltaY`). */
  pinch: 0.012,
  /** ln(scale) per pixel of a mouse notch (a 100 px notch is a 10 % step). */
  notch: 0.001,
  /** ln(scale) per pixel of Alt + swipe. */
  swipeZoom: 0.006,
  /** Pan / orbit keys: drag-equivalent pixels per second. */
  keyOrbit: 280,
  keyPan: 420,
  /** Keys: ln(scale) per second. */
  keyZoom: 1.25,
};

const unitOf = (deltaMode: number): number => (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);

/** A mouse wheel notch is at least half a notch, at most a fast spin's worth, whatever the platform reports. */
const notch = (dy: number): number => Math.sign(dy) * MathUtils.clamp(Math.abs(dy), 40, 240);

export interface WheelEventLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
}

/**
 * What a wheel event does. `kind` is the classifier's verdict, `device` the scheme in force. The amounts are raw
 * (speed multipliers and inversions are applied where the move is executed), only `s.swipe` decides the verb.
 */
export function wheelIntent(
  device: PointerKind,
  kind: WheelKind,
  e: WheelEventLike,
  mods: Mods,
  s: Pick<NavSettings, 'swipe'>,
): Intent {
  const u = unitOf(e.deltaMode);
  const dx = e.deltaX * u;
  const dy = e.deltaY * u;
  if (kind === 'pinch') {
    // Ctrl + wheel from a mouse comes in whole notches; a trackpad pinch in small fractions.
    const ln = device === 'mouse' && Math.abs(dy) >= 50 ? notch(dy) * GAIN.notch : dy * GAIN.pinch;
    return { verb: 'zoom', x: 0, y: ln };
  }
  if (dx === 0 && dy === 0) return NONE;
  if (device !== 'trackpad') {
    // Mouse (and anything that is not a trackpad): the wheel zooms, Shift + wheel pans sideways.
    if (mods.shift) {
      const h = dx !== 0 ? dx : dy;
      return { verb: 'pan', x: -h * 0.6, y: 0 };
    }
    if (dy === 0) return { verb: 'pan', x: -dx * 0.6, y: 0 };
    return { verb: 'zoom', x: 0, y: notch(dy) * GAIN.notch };
  }
  // Trackpad two-finger swipe.
  if (mods.alt) return { verb: 'zoom', x: 0, y: dy * GAIN.swipeZoom };
  const swapped = mods.shift || mods.meta;
  const verb: NavVerb = (s.swipe === 'orbit') !== swapped ? 'orbit' : 'pan';
  return { verb, x: -dx, y: -dy };
}

export interface DragEventLike extends Mods {
  /** 0 primary, 1 middle, 2 secondary. */
  button: number;
  pointerType?: string;
  /** Is Space held (the pan modifier)? */
  space?: boolean;
}

/**
 * The camera verb a pointer drag performs, or null when the drag belongs to the active tool (selection, move …).
 * Left-drag only navigates with a modifier, so the tools keep the plain left button.
 */
export function dragVerb(_device: PointerKind, e: DragEventLike): NavVerb | null {
  if (e.pointerType === 'touch') return null; // the touch controller owns fingers
  const flip = e.shift || e.ctrl || e.meta; // OrbitControls' own convention for right / middle drags
  if (e.button === 2) return flip ? 'pan' : 'orbit';
  if (e.button === 1) return flip ? 'orbit' : 'pan';
  if (e.button !== 0) return null;
  if (e.alt) return e.shift || e.meta || e.space ? 'pan' : 'orbit';
  if (e.space) return 'pan';
  return null;
}

/**
 * OrbitControls flips rotate ↔ pan when Shift / Ctrl / Cmd is down. To get `verb` for a left-button drag whatever the
 * modifiers, the button mapping handed to it is the opposite one when a flipping modifier is held.
 */
export function leftButtonMapping(
  verb: NavVerb | null,
  e: Pick<Mods, 'shift' | 'ctrl' | 'meta'>,
): 'rotate' | 'pan' | null {
  if (!verb || verb === 'zoom') return null;
  const flip = e.shift || e.ctrl || e.meta;
  return (verb === 'orbit') !== flip ? 'rotate' : 'pan';
}

/**
 * What a held navigation key asks for, per second. `nudgeOwnsArrows` is true when plain arrow keys belong to the
 * "nudge the selection" command (edit mode with a selection); Alt / Option + arrows always navigate.
 */
export function keyIntent(code: string, mods: Mods, nudgeOwnsArrows: boolean): Intent | null {
  if (mods.ctrl || mods.meta) return null; // browser zoom, shortcuts
  const arrow = /^Arrow(Left|Right|Up|Down)$/.exec(code);
  if (arrow) {
    if (nudgeOwnsArrows && !mods.alt) return null;
    const dx = arrow[1] === 'Left' ? 1 : arrow[1] === 'Right' ? -1 : 0;
    const dy = arrow[1] === 'Up' ? 1 : arrow[1] === 'Down' ? -1 : 0;
    const pan = mods.shift;
    const g = pan ? GAIN.keyPan : GAIN.keyOrbit;
    return { verb: pan ? 'pan' : 'orbit', x: dx * g, y: dy * g };
  }
  if (code === 'Equal' || code === 'NumpadAdd' || code === 'PageUp') return { verb: 'zoom', x: 0, y: -GAIN.keyZoom };
  if (code === 'Minus' || code === 'NumpadSubtract' || code === 'PageDown')
    return { verb: 'zoom', x: 0, y: GAIN.keyZoom };
  return null;
}

/** The orthographic view shortcut of Alt / Option + a digit (laptops have no numpad). */
export function viewKeyPreset(code: string): 'front' | 'right' | 'top' | 'iso' | 'projection' | null {
  switch (code) {
    case 'Digit1':
      return 'front';
    case 'Digit3':
      return 'right';
    case 'Digit7':
      return 'top';
    case 'Digit9':
      return 'iso';
    case 'Digit5':
      return 'projection';
    default:
      return null;
  }
}

// ---- smoothing -----------------------------------------------------------------------------------------------------

/** The share of a pending camera move to apply this frame: all of it without smoothing, an exponential glide with. */
export function takeShare(smooth: boolean, dt: number, rate = 16): number {
  return smooth ? 1 - Math.exp(-Math.max(0, dt) * rate) : 1;
}

// ---- camera maths --------------------------------------------------------------------------------------------------

/** What the orbit controls allow right now (a camera mode may restrict them). */
export interface NavLimits {
  enableRotate: boolean;
  enablePan: boolean;
  enableZoom: boolean;
  minPolarAngle: number;
  maxPolarAngle: number;
  minDistance: number;
  maxDistance: number;
  minZoom: number;
  maxZoom: number;
  zoomToCursor: boolean;
}

export const OPEN_LIMITS: NavLimits = {
  enableRotate: true,
  enablePan: true,
  enableZoom: true,
  minPolarAngle: 0,
  maxPolarAngle: Math.PI * 0.499,
  minDistance: 0.4,
  maxDistance: 400,
  minZoom: 0.01,
  maxZoom: 100,
  zoomToCursor: true,
};

const EPS = 1e-4;
const _off = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _fwd = new Vector3();
const _ray = new Vector3();
const _p = new Vector3();
const _sph = new Spherical();

/** Turn the camera around the target by azimuth / polar angles (radians). Returns false when nothing changed. */
export function orbitBy(cam: DualCamera, target: Vector3, dAz: number, dPol: number, lim: NavLimits): boolean {
  if (!lim.enableRotate || (dAz === 0 && dPol === 0)) return false;
  _off.copy(cam.position).sub(target);
  if (_off.lengthSq() < 1e-12) return false;
  _sph.setFromVector3(_off);
  _sph.theta += dAz;
  _sph.phi = MathUtils.clamp(
    _sph.phi + dPol,
    Math.max(lim.minPolarAngle, EPS),
    Math.min(lim.maxPolarAngle, Math.PI - EPS),
  );
  _sph.makeSafe();
  _off.setFromSpherical(_sph);
  cam.position.copy(target).add(_off);
  cam.lookAt(target);
  return true;
}

/** A drag of (x, y) pixels in a view `heightPx` tall → the angles OrbitControls would use (one view height = 360°). */
export function dragToAngles(x: number, y: number, heightPx: number, s: NavSettings): [number, number] {
  const k = (2 * Math.PI) / Math.max(1, heightPx);
  return [-x * k * s.orbitSpeed * (s.invertOrbitX ? -1 : 1), -y * k * s.orbitSpeed * (s.invertOrbitY ? -1 : 1)];
}

/** Slide camera and target together as if the scene were dragged by (x, y) pixels in a view `heightPx` tall. */
export function panByPixels(
  cam: DualCamera,
  target: Vector3,
  x: number,
  y: number,
  heightPx: number,
  lim: NavLimits,
): boolean {
  if (!lim.enablePan || (x === 0 && y === 0)) return false;
  const perPixel = cam.ortho
    ? cam.orthoSize / Math.max(1e-6, cam.zoom) / Math.max(1, heightPx)
    : (2 * cam.position.distanceTo(target) * Math.tan(MathUtils.degToRad(cam.fov / 2))) / Math.max(1, heightPx);
  _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
  _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
  _off
    .set(0, 0, 0)
    .addScaledVector(_right, -x * perPixel)
    .addScaledVector(_up, y * perPixel);
  cam.position.add(_off);
  target.add(_off);
  return true;
}

/**
 * Zoom by `ln` (natural log of the distance scale; negative = closer). With a cursor position in normalised device
 * coordinates (−1 … 1) the point under the cursor stays under it: camera and target are scaled about that point.
 */
export function zoomBy(
  cam: DualCamera,
  target: Vector3,
  ln: number,
  cursor: { x: number; y: number } | null,
  lim: NavLimits,
): boolean {
  if (!lim.enableZoom || ln === 0) return false;
  if (cam.ortho) {
    const z0 = cam.zoom;
    const z1 = MathUtils.clamp(z0 / Math.exp(ln), lim.minZoom, lim.maxZoom);
    if (z1 === z0) return false;
    if (cursor && lim.zoomToCursor) {
      const halfH = cam.orthoSize / 2;
      const halfW = halfH * cam.aspect;
      _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
      _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
      const k = 1 / z0 - 1 / z1;
      _off
        .set(0, 0, 0)
        .addScaledVector(_right, cursor.x * halfW * k)
        .addScaledVector(_up, cursor.y * halfH * k);
      cam.position.add(_off);
      target.add(_off);
    }
    cam.zoom = z1;
    cam.updateProjectionMatrix();
    return true;
  }
  _off.copy(cam.position).sub(target);
  const d = _off.length();
  if (d < 1e-9) return false;
  const d1 = MathUtils.clamp(d * Math.exp(ln), lim.minDistance, lim.maxDistance);
  if (Math.abs(d1 - d) < 1e-9) return false;
  const s = d1 / d;
  if (cursor && lim.zoomToCursor) {
    // The ray through the cursor meets the plane through the target (facing the camera) at P: scale about P.
    const t = Math.tan(MathUtils.degToRad(cam.fov / 2));
    _ray.set(cursor.x * t * cam.aspect, cursor.y * t, -1).applyQuaternion(cam.quaternion);
    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const along = _ray.dot(_fwd);
    if (along > 1e-6) {
      _p.copy(cam.position).addScaledVector(_ray, d / along);
      _off.copy(cam.position).sub(_p).multiplyScalar(s);
      cam.position.copy(_p).add(_off);
      target.sub(_p).multiplyScalar(s).add(_p);
      return true;
    }
  }
  cam.position.copy(target).addScaledVector(_off, s);
  return true;
}
