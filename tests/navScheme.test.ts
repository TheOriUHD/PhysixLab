import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { DualCamera } from '../src/render/dualCamera';
import {
  GAIN,
  OPEN_LIMITS,
  dragToAngles,
  dragVerb,
  keyIntent,
  leftButtonMapping,
  orbitBy,
  panByPixels,
  takeShare,
  viewKeyPreset,
  wheelIntent,
  zoomBy,
  type Mods,
} from '../src/app/input/navScheme';
import { DEFAULT_NAV, NAV_PRESETS, sanitizeNav } from '../src/app/input/navSettings';
import { DEFAULT_INPUT, sanitizeInput } from '../src/app/input/settings';

const none: Mods = { shift: false, alt: false, ctrl: false, meta: false };
const ev = (deltaX: number, deltaY: number) => ({ deltaX, deltaY, deltaMode: 0 });

describe('wheel → camera intent', () => {
  it('a trackpad pinch zooms; spreading the fingers (negative delta) zooms in', () => {
    const i = wheelIntent('trackpad', 'pinch', ev(0, -5), { ...none, ctrl: true }, DEFAULT_NAV);
    expect(i.verb).toBe('zoom');
    expect(i.y).toBeCloseTo(-5 * GAIN.pinch);
    expect(i.y).toBeLessThan(0);
  });

  it('a two-finger swipe orbits by default, in the direction the fingers move', () => {
    const i = wheelIntent('trackpad', 'trackpad', ev(-12, 8), none, DEFAULT_NAV);
    expect(i).toMatchObject({ verb: 'orbit', x: 12, y: -8 });
  });

  it('Shift or Cmd + swipe pans; the swipe setting swaps the two; Option + swipe zooms', () => {
    expect(wheelIntent('trackpad', 'trackpad', ev(-12, 8), { ...none, shift: true }, DEFAULT_NAV).verb).toBe('pan');
    expect(wheelIntent('trackpad', 'trackpad', ev(-12, 8), { ...none, meta: true }, DEFAULT_NAV).verb).toBe('pan');
    const pan = { ...DEFAULT_NAV, swipe: 'pan' as const };
    expect(wheelIntent('trackpad', 'trackpad', ev(-12, 8), none, pan).verb).toBe('pan');
    expect(wheelIntent('trackpad', 'trackpad', ev(-12, 8), { ...none, shift: true }, pan).verb).toBe('orbit');
    const z = wheelIntent('trackpad', 'trackpad', ev(0, 20), { ...none, alt: true }, DEFAULT_NAV);
    expect(z.verb).toBe('zoom');
    expect(z.y).toBeGreaterThan(0);
  });

  it('a mouse wheel zooms in whole steps (scroll down = out); Shift + wheel pans sideways', () => {
    const down = wheelIntent('mouse', 'mouse', ev(0, 100), none, DEFAULT_NAV);
    expect(down.verb).toBe('zoom');
    expect(down.y).toBeCloseTo(100 * GAIN.notch);
    const up = wheelIntent('mouse', 'mouse', ev(0, -100), none, DEFAULT_NAV);
    expect(up.y).toBeCloseTo(-100 * GAIN.notch);
    // a tiny macOS mouse tick still moves the view by at least half a notch
    expect(wheelIntent('mouse', 'mouse', ev(0, 4), none, DEFAULT_NAV).y).toBeCloseTo(40 * GAIN.notch);
    expect(wheelIntent('mouse', 'mouse', ev(0, 100), { ...none, shift: true }, DEFAULT_NAV).verb).toBe('pan');
    expect(wheelIntent('mouse', 'mouse', ev(0, 0), none, DEFAULT_NAV).verb).toBe('none');
  });

  it('line-mode deltas (Firefox) are scaled to pixels', () => {
    const i = wheelIntent('trackpad', 'trackpad', { deltaX: 0, deltaY: 1, deltaMode: 1 }, none, DEFAULT_NAV);
    expect(i.y).toBe(-16);
  });
});

describe('pointer drags → camera verb', () => {
  const base = { ...none, button: 0, pointerType: 'mouse' };
  it('right-drag orbits, middle-drag pans, a modifier flips them', () => {
    expect(dragVerb('mouse', { ...base, button: 2 })).toBe('orbit');
    expect(dragVerb('mouse', { ...base, button: 1 })).toBe('pan');
    expect(dragVerb('mouse', { ...base, button: 2, shift: true })).toBe('pan');
    expect(dragVerb('mouse', { ...base, button: 1, shift: true })).toBe('orbit');
  });

  it('a plain left drag belongs to the tools; Alt / Option orbits; Space or Alt + Shift pans', () => {
    expect(dragVerb('trackpad', base)).toBeNull();
    expect(dragVerb('trackpad', { ...base, alt: true })).toBe('orbit');
    expect(dragVerb('trackpad', { ...base, space: true })).toBe('pan');
    expect(dragVerb('trackpad', { ...base, alt: true, shift: true })).toBe('pan');
    expect(dragVerb('trackpad', { ...base, alt: true, meta: true })).toBe('pan');
  });

  it('touch pointers are left to the touch controller', () => {
    expect(dragVerb('touch', { ...base, pointerType: 'touch', alt: true })).toBeNull();
  });

  it('chooses the left-button mapping so the orbit controls’ own shift/ctrl/cmd flip gives the wanted verb', () => {
    expect(leftButtonMapping('orbit', none)).toBe('rotate');
    expect(leftButtonMapping('pan', none)).toBe('pan');
    expect(leftButtonMapping('pan', { shift: true, ctrl: false, meta: false })).toBe('rotate'); // flipped to pan by the controls
    expect(leftButtonMapping('orbit', { shift: false, ctrl: false, meta: true })).toBe('pan');
    expect(leftButtonMapping(null, none)).toBeNull();
  });
});

describe('keyboard navigation', () => {
  it('arrows orbit, Shift + arrows pan, + / − zoom', () => {
    expect(keyIntent('ArrowLeft', none, false)).toMatchObject({ verb: 'orbit', x: GAIN.keyOrbit });
    expect(keyIntent('ArrowUp', none, false)).toMatchObject({ verb: 'orbit', y: GAIN.keyOrbit });
    expect(keyIntent('ArrowRight', { ...none, shift: true }, false)).toMatchObject({ verb: 'pan', x: -GAIN.keyPan });
    expect(keyIntent('Equal', none, false)?.y).toBeLessThan(0);
    expect(keyIntent('NumpadSubtract', none, false)?.y).toBeGreaterThan(0);
  });

  it('plain arrows nudge a selection; Alt / Option + arrows always navigate; Ctrl/Cmd combos never do', () => {
    expect(keyIntent('ArrowLeft', none, true)).toBeNull();
    expect(keyIntent('ArrowLeft', { ...none, alt: true }, true)?.verb).toBe('orbit');
    expect(keyIntent('Equal', { ...none, ctrl: true }, false)).toBeNull();
    expect(keyIntent('KeyW', none, false)).toBeNull();
  });

  it('Option + digit picks the orthographic views a laptop has no numpad for', () => {
    expect(viewKeyPreset('Digit1')).toBe('front');
    expect(viewKeyPreset('Digit3')).toBe('right');
    expect(viewKeyPreset('Digit7')).toBe('top');
    expect(viewKeyPreset('Digit9')).toBe('iso');
    expect(viewKeyPreset('Digit5')).toBe('projection');
    expect(viewKeyPreset('Digit2')).toBeNull();
  });
});

function cam(): { cam: DualCamera; target: Vector3 } {
  const c = new DualCamera(48, 16 / 9, 0.05, 2000);
  c.position.set(0, 4, 10);
  const target = new Vector3(0, 1, 0);
  c.lookAt(target);
  c.updateMatrixWorld(true);
  return { cam: c, target };
}

describe('camera moves', () => {
  it('orbiting keeps the distance to the target and keeps looking at it', () => {
    const { cam: c, target } = cam();
    const d0 = c.position.distanceTo(target);
    expect(orbitBy(c, target, 0.6, 0.1, OPEN_LIMITS)).toBe(true);
    expect(c.position.distanceTo(target)).toBeCloseTo(d0, 6);
    const f = new Vector3(0, 0, -1).applyQuaternion(c.quaternion);
    const toTarget = target.clone().sub(c.position).normalize();
    expect(f.dot(toTarget)).toBeCloseTo(1, 5);
  });

  it('a drag to the right turns the view the way a hand dragging the scene would, and never past the poles', () => {
    const { cam: c, target } = cam();
    const [az] = dragToAngles(100, 0, 800, DEFAULT_NAV);
    expect(az).toBeLessThan(0); // camera swings to the left, the scene follows the hand to the right
    const x0 = c.position.x;
    orbitBy(c, target, az, 0, OPEN_LIMITS);
    expect(c.position.x).toBeLessThan(x0);
    orbitBy(c, target, 0, -50, OPEN_LIMITS);
    expect(c.position.y - target.y).toBeGreaterThan(0);
    orbitBy(c, target, 0, 50, OPEN_LIMITS);
    expect(c.position.y).toBeGreaterThan(0); // maxPolarAngle keeps it above the ground
    const inverted = dragToAngles(100, 0, 800, { ...DEFAULT_NAV, invertOrbitX: true, orbitSpeed: 2 });
    expect(inverted[0]).toBeCloseTo(-az * 2, 6);
  });

  it('respects a locked rotation (top-down mode)', () => {
    const { cam: c, target } = cam();
    const p = c.position.clone();
    expect(orbitBy(c, target, 1, 1, { ...OPEN_LIMITS, enableRotate: false })).toBe(false);
    expect(c.position.distanceTo(p)).toBe(0);
  });

  it('panning slides camera and target together by the same vector', () => {
    const { cam: c, target } = cam();
    const p0 = c.position.clone();
    const t0 = target.clone();
    expect(panByPixels(c, target, 100, 0, 800, OPEN_LIMITS)).toBe(true);
    const dp = c.position.clone().sub(p0);
    const dt = target.clone().sub(t0);
    expect(dp.distanceTo(dt)).toBeLessThan(1e-9);
    expect(dp.x).toBeLessThan(0); // dragging right moves the scene right = the camera left
    expect(c.position.distanceTo(target)).toBeCloseTo(p0.distanceTo(t0), 9);
  });

  it('zoom changes the distance by exp(ln) within the limits', () => {
    const { cam: c, target } = cam();
    const d0 = c.position.distanceTo(target);
    zoomBy(c, target, Math.log(0.5), null, OPEN_LIMITS);
    expect(c.position.distanceTo(target)).toBeCloseTo(d0 * 0.5, 6);
    zoomBy(c, target, -20, null, OPEN_LIMITS);
    expect(c.position.distanceTo(target)).toBeCloseTo(OPEN_LIMITS.minDistance, 6);
    zoomBy(c, target, 20, null, OPEN_LIMITS);
    expect(c.position.distanceTo(target)).toBeCloseTo(OPEN_LIMITS.maxDistance, 6);
  });

  it('zoom towards the cursor keeps the point under the cursor where it was on screen', () => {
    const { cam: c, target } = cam();
    // the point on the target plane under the cursor at ndc (0.5, -0.3)
    const ndc = { x: 0.5, y: -0.3 };
    const project = (p: Vector3): { x: number; y: number } => {
      c.updateMatrixWorld(true);
      c.updateProjectionMatrix();
      const v = p.clone().project(c);
      return { x: v.x, y: v.y };
    };
    const t = Math.tan((c.fov * Math.PI) / 360);
    const ray = new Vector3(ndc.x * t * c.aspect, ndc.y * t, -1).applyQuaternion(c.quaternion);
    const f = new Vector3(0, 0, -1).applyQuaternion(c.quaternion);
    const d = c.position.distanceTo(target);
    const p = c.position.clone().addScaledVector(ray, d / ray.dot(f));
    const before = project(p);
    expect(before.x).toBeCloseTo(0.5, 5);
    zoomBy(c, target, Math.log(0.6), ndc, OPEN_LIMITS);
    const after = project(p);
    expect(after.x).toBeCloseTo(before.x, 5);
    expect(after.y).toBeCloseTo(before.y, 5);
    expect(c.position.distanceTo(target)).toBeCloseTo(d * 0.6, 6);
    // without zoom-to-cursor the target stays
    const { cam: c2, target: t2 } = cam();
    const t20 = t2.clone();
    zoomBy(c2, t2, Math.log(0.6), ndc, { ...OPEN_LIMITS, zoomToCursor: false });
    expect(t2.distanceTo(t20)).toBe(0);
  });

  it('orthographic zoom towards the cursor keeps the world point under it', () => {
    const { cam: c, target } = cam();
    c.ortho = true;
    c.orthoSize = 12;
    c.updateProjectionMatrix();
    const ndc = { x: -0.4, y: 0.25 };
    const world = (): Vector3 => {
      c.updateMatrixWorld(true);
      return new Vector3(ndc.x, ndc.y, 0).unproject(c);
    };
    const w0 = world();
    zoomBy(c, target, Math.log(0.5), ndc, OPEN_LIMITS);
    expect(c.zoom).toBeCloseTo(2, 6);
    const w1 = world();
    // the same ray, so the point on the view plane through the camera is the same
    const f = new Vector3(0, 0, -1).applyQuaternion(c.quaternion);
    expect(w1.clone().sub(w0).sub(f.multiplyScalar(w1.clone().sub(w0).dot(f))).length()).toBeLessThan(1e-6);
  });

  it('smoothing applies a share of the pending move; without it, all of it', () => {
    expect(takeShare(false, 0.016)).toBe(1);
    const s = takeShare(true, 0.016);
    expect(s).toBeGreaterThan(0.1);
    expect(s).toBeLessThan(0.5);
    expect(takeShare(true, 1)).toBeGreaterThan(0.99);
  });
});

describe('navigation settings', () => {
  it('sanitise to valid values and survive a round trip through the input settings', () => {
    expect(sanitizeNav(undefined)).toEqual(DEFAULT_NAV);
    const odd = sanitizeNav({ device: 'laser', swipe: 'pan', orbitSpeed: 99, panSpeed: -3, invertZoom: 'yes', touchOneFinger: 'select' });
    expect(odd).toMatchObject({ device: 'auto', swipe: 'pan', orbitSpeed: 3, panSpeed: 0.25, invertZoom: false, touchOneFinger: 'select' });
    expect(DEFAULT_INPUT.nav).toEqual(DEFAULT_NAV);
    const stored = sanitizeInput({ nav: { device: 'trackpad', swipe: 'pan' } });
    expect(stored.nav).toMatchObject({ device: 'trackpad', swipe: 'pan' });
  });

  it('every preset produces valid settings', () => {
    for (const p of NAV_PRESETS) {
      const n = sanitizeNav({ ...DEFAULT_NAV, ...p.patch });
      expect(n.device).toBe(p.patch.device ?? 'auto');
    }
    expect(NAV_PRESETS.map((p) => p.id)).toEqual(expect.arrayContaining(['auto', 'mouse', 'trackpad', 'touch']));
  });
});
