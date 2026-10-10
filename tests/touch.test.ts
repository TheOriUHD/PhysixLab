import { describe, expect, it } from 'vitest';
import { emptyPad } from '../src/app/input/gamepad';
import { DEFAULT_INPUT, sanitizeInput } from '../src/app/input/settings';
import {
  FingerSet,
  LongPress,
  TWO_FINGER_DECIDE_PX,
  classifyTwoFinger,
  panShift,
  pinchDistance,
  snapMove,
} from '../src/app/touch/gestures';
import { clearPad, setPadButton, setStick, stickVector } from '../src/app/touch/joystick';
import { DEFAULT_TOUCH, sanitizeTouch } from '../src/app/touch/settings';

describe('finger set', () => {
  it('tracks centroid and spread of several fingers', () => {
    const f = new FingerSet();
    f.down(1, 0, 0);
    f.down(2, 100, 0);
    expect(f.count).toBe(2);
    expect(f.centroid()).toEqual({ x: 50, y: 0 });
    expect(f.spread()).toBeCloseTo(100, 9);
    f.move(2, 200, 0);
    expect(f.spread()).toBeCloseTo(200, 9);
    f.down(3, 100, 300);
    expect(f.centroid().y).toBeCloseTo(100, 9);
    f.up(1);
    f.up(2);
    f.up(3);
    expect(f.count).toBe(0);
    expect(f.spread()).toBe(0);
  });

  it('ignores moves of unknown fingers', () => {
    const f = new FingerSet();
    expect(f.move(9, 1, 1)).toBe(false);
  });
});

describe('two-finger classification', () => {
  it('stays undecided below the threshold, then picks the larger motion', () => {
    expect(classifyTwoFinger(3, 4)).toBe('undecided');
    expect(classifyTwoFinger(TWO_FINGER_DECIDE_PX + 5, 2)).toBe('drag');
    expect(classifyTwoFinger(2, -(TWO_FINGER_DECIDE_PX + 5))).toBe('pinch');
    expect(classifyTwoFinger(30, 31)).toBe('pinch');
  });

  it('classifies a synthetic pinch and a synthetic parallel drag from real finger positions', () => {
    const pinch = new FingerSet();
    pinch.down(1, 100, 100);
    pinch.down(2, 200, 100);
    const c0 = pinch.centroid({ x: 0, y: 0 });
    const s0 = pinch.spread();
    pinch.move(1, 80, 100);
    pinch.move(2, 220, 100);
    const c1 = pinch.centroid();
    expect(classifyTwoFinger(Math.hypot(c1.x - c0.x, c1.y - c0.y), pinch.spread() - s0)).toBe('pinch');

    const drag = new FingerSet();
    drag.down(1, 100, 100);
    drag.down(2, 200, 100);
    const d0 = drag.centroid({ x: 0, y: 0 });
    const t0 = drag.spread();
    drag.move(1, 100, 140);
    drag.move(2, 200, 140);
    const d1 = drag.centroid();
    expect(classifyTwoFinger(Math.hypot(d1.x - d0.x, d1.y - d0.y), drag.spread() - t0)).toBe('drag');
  });
});

describe('long press', () => {
  it('fires after the delay when the finger stays put', () => {
    const lp = new LongPress(500, 10);
    lp.begin(7, 100, 100, 1000);
    expect(lp.fire(1400)).toBe(false);
    expect(lp.move(7, 104, 103)).toBe(true);
    expect(lp.fire(1500)).toBe(true);
    expect(lp.fire(1600)).toBe(false); // consumed
  });

  it('is cancelled by drift beyond the tolerance, by cancel(), and ignores other fingers', () => {
    const lp = new LongPress(500, 10);
    lp.begin(1, 0, 0, 0);
    lp.move(2, 500, 500); // another finger: irrelevant
    expect(lp.armed).toBe(true);
    expect(lp.move(1, 12, 0)).toBe(false);
    expect(lp.fire(1000)).toBe(false);
    lp.begin(1, 0, 0, 0);
    lp.cancel();
    expect(lp.fire(1000)).toBe(false);
  });
});

describe('camera maths', () => {
  it('pans the camera so the scene follows the fingers (analytic)', () => {
    // 90° vertical fov at distance 10 over a 1000 px tall view → 20 m / 1000 px = 0.02 m per pixel.
    const s = panShift(100, 0, 10, 90, 1000, [1, 0, 0], [0, 1, 0]);
    expect(s[0]).toBeCloseTo(-2, 9);
    expect(s[1]).toBeCloseTo(0, 9);
    const t = panShift(0, 50, 10, 90, 1000, [1, 0, 0], [0, 1, 0]);
    expect(t[1]).toBeCloseTo(1, 9);
    // Rotated camera: right = +z
    const u = panShift(50, 0, 10, 90, 1000, [0, 0, 1], [0, 1, 0]);
    expect(u[2]).toBeCloseTo(-1, 9);
  });

  it('pinch scales the distance inversely and clamps', () => {
    expect(pinchDistance(10, 2, 0.4, 400)).toBeCloseTo(5, 9);
    expect(pinchDistance(10, 0.5, 0.4, 400)).toBeCloseTo(20, 9);
    expect(pinchDistance(10, 1000, 0.4, 400)).toBe(0.4);
    expect(pinchDistance(10, 0.0001, 0.4, 400)).toBe(400);
    expect(pinchDistance(10, NaN, 0.4, 400)).toBe(10);
  });

  it('snapMove lands the primary object on the grid and leaves y alone', () => {
    const d = snapMove([0.3, 1, 0.1], [0.4, 0, 0.6], 0.5);
    expect(0.3 + d[0]).toBeCloseTo(0.5, 9);
    expect(0.1 + d[2]).toBeCloseTo(0.5, 9);
    expect(d[1]).toBe(0);
    expect(snapMove([0, 0, 0], [0.37, 0, 0.2], 0)).toEqual([0.37, 0, 0.2]);
  });
});

describe('virtual joystick', () => {
  it('maps offsets to a unit-clamped vector with y up positive', () => {
    const v = stickVector(100, 100, 150, 100, 50);
    expect(v.x).toBeCloseTo(1, 9);
    expect(v.y).toBeCloseTo(0, 9);
    const up = stickVector(100, 100, 100, 70, 60);
    expect(up.y).toBeCloseTo(0.5, 9);
    expect(up.thumbY).toBeCloseTo(-30, 9);
    const far = stickVector(100, 100, 400, 500, 50);
    expect(Math.hypot(far.x, far.y)).toBeCloseTo(1, 9);
    expect(far.mag).toBe(1);
    expect(far.y).toBeLessThan(0);
    const mid = stickVector(100, 100, 100, 100, 50);
    expect(mid.x === 0 && mid.y === 0 && mid.mag === 0).toBe(true);
  });

  it('writes sticks and buttons into a pad and releases them', () => {
    const pad = emptyPad();
    setStick(pad, 'L', 0.5, -0.25);
    setStick(pad, 'R', -1, 1);
    setPadButton(pad, 'RT', true);
    setPadButton(pad, 'South', true);
    expect(pad.LX).toBe(0.5);
    expect(pad.LY).toBe(-0.25);
    expect(pad.RX).toBe(-1);
    expect(pad.RT).toBe(1);
    expect(pad.buttons.RT).toBe(true);
    expect(pad.buttons.South).toBe(true);
    setPadButton(pad, 'RT', false);
    expect(pad.RT).toBe(0);
    clearPad(pad);
    expect(pad).toEqual(emptyPad());
  });
});

describe('touch settings', () => {
  it('defaults and clamps', () => {
    expect(sanitizeTouch(undefined)).toEqual(DEFAULT_TOUCH);
    const s = sanitizeTouch({ size: 99, opacity: -4, leftHanded: true, sticks: 'left', twoFingerDrag: 'pan' });
    expect(s.size).toBe(1.6);
    expect(s.opacity).toBe(0.25);
    expect(s.leftHanded).toBe(true);
    expect(s.sticks).toBe('left');
    expect(s.twoFingerDrag).toBe('pan');
    expect(sanitizeTouch({ longPressMs: 5 }).longPressMs).toBe(200);
    expect(sanitizeTouch({ longPressMs: 750.4 }).longPressMs).toBe(750);
    expect(sanitizeTouch({ longPressMs: 'x' }).longPressMs).toBe(DEFAULT_TOUCH.longPressMs);
  });

  it('keeps only known, unique buttons and drops junk', () => {
    const s = sanitizeTouch({ buttons: ['South', 'South', 'Bogus', 3, 'RT'], sticks: 'sideways', size: 'big' });
    expect(s.buttons).toEqual(['South', 'RT']);
    expect(s.sticks).toBe('both');
    expect(s.size).toBe(DEFAULT_TOUCH.size);
    expect(sanitizeTouch({ buttons: 'nope' }).buttons).toEqual(DEFAULT_TOUCH.buttons);
  });

  it('is part of the input settings and survives sanitising and old blobs without it', () => {
    expect(DEFAULT_INPUT.touch).toEqual(DEFAULT_TOUCH);
    const old = sanitizeInput({ profile: 'plane', touchControls: 'on' });
    expect(old.touch).toEqual(DEFAULT_TOUCH);
    expect(old.touchControls).toBe('on');
    const custom = sanitizeInput({ touch: { moveWithTwoFingers: true, buttons: ['East'] } });
    expect(custom.touch.moveWithTwoFingers).toBe(true);
    expect(custom.touch.buttons).toEqual(['East']);
    // idempotent
    expect(sanitizeInput(custom)).toEqual(custom);
  });
});
