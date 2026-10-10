import { describe, expect, it } from 'vitest';
import { emptyPad } from '../src/app/input/gamepad';
import { DEFAULT_INPUT, sanitizeInput } from '../src/app/input/settings';
import {
  FingerSet,
  LongPress,
  TWO_FINGER_DECIDE_PX,
  classifyTwoFinger,
  orthoPixel,
  panShift,
  perspectivePixel,
  pinchDistance,
  pinchZoom,
  snapMove,
} from '../src/app/touch/gestures';
import { clearPad, setPadButton, setStick, stickVector } from '../src/app/touch/joystick';
import { DEFAULT_TOUCH, sanitizeTouch } from '../src/app/touch/settings';
import { createBody } from '../src/model/factory';
import { SceneStore } from '../src/model/store';
import { enterNarrow, leaveNarrow, parsePanels, sheetToKeep } from '../src/ui/mobile/sheets';

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

  it('reports how much of the hold time is left, so an early timer can re-arm', () => {
    const lp = new LongPress(500, 10);
    expect(lp.remaining(0)).toBe(-1);
    lp.begin(1, 0, 0, 1000);
    expect(lp.remaining(1200)).toBe(300);
    expect(lp.fire(1200)).toBe(false);
    expect(lp.armed).toBe(true); // still armed: the caller waits the remaining 300 ms
    expect(lp.remaining(1600)).toBe(0);
    expect(lp.fire(1600)).toBe(true);
    expect(lp.remaining(1700)).toBe(-1);
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
    const px = perspectivePixel(10, 90, 1000);
    expect(px).toBeCloseTo(0.02, 12);
    const s = panShift(100, 0, px, [1, 0, 0], [0, 1, 0]);
    expect(s[0]).toBeCloseTo(-2, 9);
    expect(s[1]).toBeCloseTo(0, 9);
    const t = panShift(0, 50, px, [1, 0, 0], [0, 1, 0]);
    expect(t[1]).toBeCloseTo(1, 9);
    // Rotated camera: right = +z
    const u = panShift(50, 0, px, [0, 0, 1], [0, 1, 0]);
    expect(u[2]).toBeCloseTo(-1, 9);
  });

  it('orthographic pan follows the zoom, not the distance', () => {
    // 12 m visible at zoom 1 over 600 px = 0.02 m per pixel; zoomed 2x it halves.
    expect(orthoPixel(12, 1, 600)).toBeCloseTo(0.02, 12);
    expect(orthoPixel(12, 2, 600)).toBeCloseTo(0.01, 12);
    const s = panShift(100, 0, orthoPixel(12, 2, 600), [1, 0, 0], [0, 1, 0]);
    expect(s[0]).toBeCloseTo(-1, 12);
    // an output array is reused, not reallocated
    const out: [number, number, number] = [9, 9, 9];
    expect(panShift(0, 0, 1, [1, 0, 0], [0, 1, 0], out)).toBe(out);
    expect(out).toEqual([0, 0, 0]);
  });

  it('pinch zoom multiplies an orthographic zoom and clamps', () => {
    expect(pinchZoom(2, 1.5, 0.1, 50)).toBeCloseTo(3, 12);
    expect(pinchZoom(2, 100, 0.1, 50)).toBe(50);
    expect(pinchZoom(2, 0.001, 0.1, 50)).toBe(0.1);
    expect(pinchZoom(2, NaN, 0.1, 50)).toBe(2);
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
    // sanitising never hands out the shared default object (or its buttons array) for callers to mutate
    for (const raw of [undefined, 'junk', {}, { touch: {} }]) {
      const t = sanitizeInput(raw).touch;
      expect(t).toEqual(DEFAULT_TOUCH);
      expect(t).not.toBe(DEFAULT_TOUCH);
      expect(t.buttons).not.toBe(DEFAULT_TOUCH.buttons);
    }
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

describe('abandoning an edit group (a drag cancelled by a second finger)', () => {
  const box = (x: number) => createBody({ name: 'b', shape: { type: 'box' }, position: [x, 0.5, 0] });

  it('restores the document and leaves neither an undo nor a redo step', () => {
    const store = new SceneStore();
    const a = box(0);
    store.add([a], 'Add');
    store.update(a.id, { name: 'renamed' }, 'Rename');
    store.undo(); // a redo entry exists before the drag
    expect(store.canRedo).toBe(true);
    const undoDepth = store.undoDepth;
    store.begin('Move');
    store.update(a.id, { position: [4, 0.5, 0] });
    store.update(a.id, { position: [5, 0.5, 0] });
    expect(store.body(a.id)!.position[0]).toBe(5);
    store.cancelBatch();
    expect(store.body(a.id)!.position[0]).toBe(0);
    expect(store.undoDepth).toBe(undoDepth);
    expect(store.redoLabel).toBe('Rename'); // the user's redo history is untouched
    // a later edit still groups and undoes normally
    store.begin('Move');
    store.update(a.id, { position: [2, 0.5, 0] });
    store.end();
    expect(store.undo()).toBe('Move');
    expect(store.body(a.id)!.position[0]).toBe(0);
  });

  it('is a no-op outside a group and closes a nested group like end()', () => {
    const store = new SceneStore();
    const a = box(0);
    store.add([a], 'Add');
    store.cancelBatch();
    expect(store.size).toBe(1);
    store.begin('outer');
    store.begin('inner');
    store.update(a.id, { name: 'x' });
    store.cancelBatch(); // nested: just closes the inner group
    store.end();
    expect(store.body(a.id)!.name).toBe('x');
    expect(store.undoLabel).toBe('outer');
  });
});

describe('mobile sheet rules', () => {
  const all = { showLeft: true, showRight: true, showBottom: true };

  it('remembers the desktop arrangement once and closes everything while narrow', () => {
    const first = enterNarrow(all, null);
    expect(first.stash).toEqual(all);
    expect(first.panels).toEqual({ showLeft: false, showRight: false, showBottom: false });
    // a reload while still narrow: the preferences hold the closed sheets, the stash survives
    const again = enterNarrow(first.panels, first.stash);
    expect(again.stash).toEqual(all);
    // widening brings the desktop back; with no stash nothing changes
    expect(leaveNarrow(again.stash)).toEqual(all);
    expect(leaveNarrow(null)).toBeNull();
    // the stash is a copy
    expect(enterNarrow(all, null).stash).not.toBe(all);
  });

  it('keeps only the newest of several open sheets', () => {
    const none = { left: false, right: false, bottom: false };
    expect(sheetToKeep([], none)).toBeNull();
    expect(sheetToKeep(['left'], none)).toBeNull();
    expect(sheetToKeep(['left', 'right'], { ...none, left: true })).toBe('right');
    expect(sheetToKeep(['left', 'bottom'], { ...none, bottom: true })).toBe('left');
    expect(sheetToKeep(['left', 'right', 'bottom'], { left: true, right: true, bottom: true })).toBe('bottom');
  });

  it('parses stored panels defensively', () => {
    expect(parsePanels(null)).toBeNull();
    expect(parsePanels('x')).toBeNull();
    expect(parsePanels({})).toEqual(all);
    expect(parsePanels({ showLeft: false, showBottom: 0 })).toEqual({
      showLeft: false,
      showRight: true,
      showBottom: true,
    });
  });
});
