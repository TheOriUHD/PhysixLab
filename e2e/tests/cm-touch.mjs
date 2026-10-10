/**
 * CM-12 touch controls: virtual joysticks / buttons drive the car through the analog-axis pipeline with real
 * multi-touch (CDP Input.dispatchTouchEvent in a touch-emulating context), and the canvas gestures (tap select,
 * second finger cancels, two-finger orbit / pinch / pan, three-finger pan, long-press menu, move-with-two-fingers).
 */
import { appUrl, assert, currentBrowser, near, nextFrame, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** A page in a touch-emulating context (hasTouch + isMobile), same bootstrap as helpers.newPage. */
export async function newTouchPage(query = '', viewport = { width: 1100, height: 650 }) {
  const ctx = await currentBrowser().newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('__e2e_init')) {
        localStorage.clear();
        sessionStorage.setItem('__e2e_init', '1');
      }
    } catch {
      /* ignore */
    }
  });
  await page.goto(`${appUrl()}/?nowelcome${query}`);
  await page.waitForFunction(() => !!window.physicslab && window.physicslab.viewport, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  page.errors = errors;
  page.cdp = await ctx.newCDPSession(page);
  page.fingers = new Map();
  page.closeAll = () => ctx.close();
  return page;
}

/**
 * Multi-touch driver on CDP Input.dispatchTouchEvent: touchStart / touchMove carry every finger that is down,
 * touchEnd carries the finger(s) being lifted.
 */
const pts = (m) => [...m].map(([id, p]) => ({ id, x: p.x, y: p.y, radiusX: 8, radiusY: 8, force: 1 }));
export const down = async (page, id, x, y) => {
  page.fingers.set(id, { x, y });
  await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(page.fingers) });
};
/** Several fingers landing in the same touchStart (a real hand puts them down within a few milliseconds). */
export const downAll = async (page, specs) => {
  for (const [id, x, y] of specs) page.fingers.set(id, { x, y });
  await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(page.fingers) });
};
export const moveTo = async (page, id, x, y) => {
  page.fingers.set(id, { x, y });
  await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(page.fingers) });
};
export const up = async (page, id) => {
  const p = page.fingers.get(id);
  await page.cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: pts(new Map([[id, p]])),
  });
  page.fingers.delete(id);
};
/** A tap with finger 9. */
export const tap = async (page, x, y) => {
  await down(page, 9, x, y);
  await up(page, 9);
};
/** Move several fingers together in `steps` increments. */
export const drag = async (page, ids, dx, dy, steps = 6) => {
  const start = ids.map((id) => ({ id, ...page.fingers.get(id) }));
  for (let i = 1; i <= steps; i++) {
    for (const s of start) page.fingers.set(s.id, { x: s.x + (dx * i) / steps, y: s.y + (dy * i) / steps });
    await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(page.fingers) });
  }
};
const centre = async (page, sel) => {
  const b = await page.locator(sel).first().boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
};

const cameraState = (page) =>
  page.evaluate(() => {
    const a = window.physicslab;
    const c = a.camera.position;
    const t = a.viewport.controls.target;
    return {
      az: Math.atan2(c.x - t.x, c.z - t.z),
      dist: c.distanceTo(t),
      target: [t.x, t.y, t.z],
      pos: [c.x, c.y, c.z],
    };
  });

/** Three well-separated boxes on the ground, camera looking at them. */
async function boxScene(page) {
  const ids = await page.evaluate(() => {
    const a = window.physicslab;
    a.prefs.set({ showLeft: false, showRight: false, showBottom: false, followSelection: false }); // the canvas fills the window; the car template turns following on
    // Software GL needs a second per frame: a long hold time keeps taps from turning into long presses.
    // -- NAV: these gestures predate the one-finger orbit and two-finger pan defaults; they test the selection rectangle and the two-finger orbit
    a.input.update_settings({
      touch: { ...a.input.settings.touch, longPressMs: 9000, twoFingerDrag: 'orbit' },
      nav: { ...a.input.settings.nav, touchOneFinger: 'select' },
    });
    a.store.clear();
    const ids = [];
    for (const x of [-3, 0, 3]) ids.push(a.addShape('box', [x, 0.5, 0]).id);
    a.store.setSelection([]);
    a.viewport.controls.enableDamping = false; // a deterministic camera under slow software GL
    a.viewport.setView({ position: [0, 9, 12], target: [0, 0.5, 0] });
    return ids;
  });
  await settleCamera(page);
  return ids;
}

/** Wait until the camera has stopped moving (tweens, resize-driven reframing) for a few frames. */
export async function settleCamera(page) {
  let last = '';
  let same = 0;
  for (let i = 0; i < 80 && same < 3; i++) {
    await nextFrame(page);
    const now = await page.evaluate(() => {
      const a = window.physicslab;
      return JSON.stringify([a.camera.position.toArray(), a.viewport.controls.target.toArray()]);
    });
    same = now === last ? same + 1 : 0;
    last = now;
  }
}

/** Client position of a body's document position (the body view may still be easing into place). */
const screenOf = async (page, id) => {
  await nextFrame(page);
  return page.evaluate((id) => {
    const a = window.physicslab;
    const [x, y, z] = a.store.body(id).position;
    a.camera.updateMatrixWorld(true);
    a.camera.matrixWorldInverse.copy(a.camera.matrixWorld).invert();
    const p = a.camera.position.clone().set(x, y, z).project(a.camera);
    const r = a.viewport.dom.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }, id);
};
/** Wait for a page-side condition (input events are handled a frame or more after the driver returns). */
const waitFor = (page, fn, arg, msg) =>
  page.waitForFunction(fn, arg, { timeout: 20000 }).catch(() => {
    throw new Error(`assertion failed: ${msg}`);
  });
const holdTime = (page, ms) =>
  page.evaluate((ms) => {
    const a = window.physicslab;
    a.input.update_settings({ touch: { ...a.input.settings.touch, longPressMs: ms } });
  }, ms);
const sel = (page) => page.evaluate(() => [...window.physicslab.store.selection]);
const posOf = (page, id) => page.evaluate((id) => window.physicslab.store.body(id).position, id);

test('touch: overlay joysticks + RT button drive the car through the analog axes (multi-touch, release resets)', async () => {
  const page = await newTouchPage('&scene=car');
  assert(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches), 'context is coarse-pointer');
  // Hidden until the simulation runs (auto mode), then shown.
  assert(await page.locator('.tc-overlay').isHidden(), 'overlay hidden in edit mode');
  await page.evaluate(() => window.physicslab.sim.toggle());
  await page.waitForSelector('.tc-overlay:not([hidden])');
  await shot(page, 'cm-touch-overlay-car');
  const rt = await centre(page, '.tc-btn-RT');
  const ls = await centre(page, '.tc-stick[data-stick="L"]');
  assert(rt.w >= 44 && rt.h >= 44, `RT button is ${rt.w}x${rt.h}`);
  const before = await page.evaluate(() => {
    const a = window.physicslab;
    const c = a.store.bodies().find((b) => /chassis|body/i.test(b.name)) ?? a.store.bodies()[0];
    return a.sim.poseOf(c.id)?.position;
  });
  await downAll(page, [
    [1, rt.x, rt.y],
    [2, ls.x - 44, ls.y],
  ]);
  const pad = await page.evaluate(() => {
    const h = window.physicslab.input;
    return { RT: h.touch.RT, south: h.touch.buttons.RT, LX: h.touch.LX, active: h.touchActive };
  });
  assert(pad.RT === 1 && pad.south && pad.active, `RT pressed: ${JSON.stringify(pad)}`);
  assert(pad.LX < -0.5 && pad.LX > -1.0001, `left stick LX ${pad.LX}`);
  await simTime(page, 2.5);
  const axes = await page.evaluate(() => ({ ...window.physicslab.sim.client.axes }));
  assert(axes.drive > 0.9, `drive axis ${JSON.stringify(axes)}`);
  assert(axes.steer > 0.2, `steer axis (stick left = +) ${JSON.stringify(axes)}`);
  const after = await page.evaluate(() => {
    const a = window.physicslab;
    const c = a.store.bodies().find((b) => /chassis|body/i.test(b.name)) ?? a.store.bodies()[0];
    return a.sim.poseOf(c.id)?.position;
  });
  assert(Math.hypot(after[0] - before[0], after[2] - before[2]) > 1.5, `car moved ${before} -> ${after}`);
  await shot(page, 'cm-touch-driving');
  // lift the stick finger only: the button keeps driving
  await up(page, 2);
  const mid = await page.evaluate(() => ({ ...window.physicslab.input.touch, b: window.physicslab.input.touchActive }));
  assert(mid.LX === 0 && mid.RT === 1 && mid.b, `stick released, button held: ${JSON.stringify(mid)}`);
  await up(page, 1);
  const end = await page.evaluate(() => {
    const t = window.physicslab.input.touch;
    return {
      LX: t.LX,
      LY: t.LY,
      RT: t.RT,
      any: Object.values(t.buttons).some(Boolean),
      active: window.physicslab.input.touchActive,
    };
  });
  assert(end.LX === 0 && end.RT === 0 && !end.any && !end.active, `released: ${JSON.stringify(end)}`);
  await page.waitForFunction(
    () => !window.physicslab.sim.client.axes.drive && !window.physicslab.sim.client.axes.steer,
    null,
    {
      timeout: 8000,
    },
  );
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.closeAll();
});

test('touch: both sticks, the right stick axis and a button at once; buttons produce pad key codes', async () => {
  const page = await newTouchPage('&scene=car');
  await page.evaluate(() => {
    const a = window.physicslab;
    a.input.update_settings({
      touchControls: 'on',
      profile: 'general',
      touch: { ...a.input.settings.touch, buttons: ['South', 'East', 'RB'] },
    });
    a.sim.toggle();
  });
  await page.waitForSelector('.tc-btn-South');
  const l = await centre(page, '.tc-stick[data-stick="L"]');
  const r = await centre(page, '.tc-stick[data-stick="R"]');
  const a = await centre(page, '.tc-btn-South');
  await downAll(page, [
    [1, l.x + 40, l.y - 20],
    [2, r.x - 30, r.y + 30],
    [3, a.x, a.y],
  ]);
  await simTime(page, 1);
  const st = await page.evaluate(() => {
    const a = window.physicslab;
    return { t: { ...a.input.touch, buttons: undefined }, keys: [...a.sim.keys], axes: { ...a.sim.client.axes } };
  });
  assert(st.t.LX > 0.4 && st.t.LY > 0.1, `L stick ${JSON.stringify(st.t)}`);
  assert(st.t.RX < -0.3 && st.t.RY < -0.3, `R stick (down = negative) ${JSON.stringify(st.t)}`);
  assert(st.keys.includes('PadSouth'), `pad key code: ${st.keys}`);
  assert(st.axes.moveX > 0.2 && st.axes.lookX < -0.1, `general profile axes ${JSON.stringify(st.axes)}`);
  await up(page, 3);
  await up(page, 2);
  await up(page, 1);
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.closeAll();
});

test('touch: tap selects, tap on empty space deselects, a second finger cancels a marquee and a drag-move', async () => {
  const page = await newTouchPage();
  const [a, b] = (await boxScene(page)).slice(0, 2);
  const pa = await screenOf(page, a);
  await tap(page, pa.x, pa.y);
  await waitFor(page, (id) => window.physicslab.store.selection.join() === id, a, 'tap selects the box');
  // tap on empty sky deselects
  await tap(page, 1000, 330);
  await waitFor(page, () => window.physicslab.store.selection.length === 0, null, 'tap on empty space deselects');

  // marquee + second finger: nothing is selected, the marquee disappears
  await page.evaluate((id) => window.physicslab.store.setSelection([id]), b);
  await down(page, 1, 200, 400);
  await drag(page, [1], 120, 80, 4);
  await waitFor(
    page,
    () =>
      document.querySelector('.marquee')
        ? getComputedStyle(document.querySelector('.marquee')).display === 'block'
        : false,
    null,
    'marquee visible with one finger',
  );
  await down(page, 2, 800, 500);
  await waitFor(
    page,
    () => getComputedStyle(document.querySelector('.marquee')).display === 'none',
    null,
    'second finger hides the marquee',
  );
  await up(page, 2);
  await up(page, 1);
  await nextFrame(page);
  await nextFrame(page);
  assert((await sel(page)).join() === b, `selection untouched by the cancelled marquee: ${await sel(page)}`);

  // drag-move + second finger: the object returns to where it was and no undo step is left
  const startPos = await posOf(page, a);
  // an undo step and a redo step exist before the drag, so a leftover entry of either kind would show
  await page.evaluate(() => {
    const st = window.physicslab.store;
    const id = st.bodies()[0].id;
    st.update(id, { name: 'one' }, 'Rename one');
    st.update(id, { name: 'two' }, 'Rename two');
    st.undo();
  });
  const hist = () => page.evaluate(() => [window.physicslab.store.undoDepth, window.physicslab.store.redoLabel]);
  const before = await hist();
  const p = await screenOf(page, a);
  await down(page, 1, p.x, p.y);
  await drag(page, [1], 60, 40, 5);
  await waitFor(
    page,
    ([id, x, z]) => {
      const q = window.physicslab.store.body(id).position;
      return Math.hypot(q[0] - x, q[2] - z) > 0.3;
    },
    [a, startPos[0], startPos[2]],
    'drag-move moves the box with one finger',
  );
  await down(page, 2, 900, 500);
  await waitFor(
    page,
    ([id, x, z]) => {
      const q = window.physicslab.store.body(id).position;
      return Math.hypot(q[0] - x, q[2] - z) < 1e-6;
    },
    [a, startPos[0], startPos[2]],
    'a second finger puts the box back',
  );
  await up(page, 2);
  await drag(page, [1], 40, 0, 3); // the remaining finger does nothing now
  await nextFrame(page);
  await nextFrame(page);
  const still = await posOf(page, a);
  near(still[0], startPos[0], 1e-6, 'remaining finger does not move it');
  await up(page, 1);
  await nextFrame(page);
  const after = await hist();
  assert(
    after[0] === before[0] && after[1] === before[1] && after[1] === 'Rename two',
    `cancelled drag leaves no undo step and keeps the redo history: ${before} -> ${after}`,
  );
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.closeAll();
});

test('touch: two-finger drag orbits, pinch zooms, three-finger drag pans', async () => {
  const page = await newTouchPage();
  await boxScene(page);
  await nextFrame(page);
  const c0 = await cameraState(page);
  // orbit: two fingers moving together horizontally
  await downAll(page, [
    [1, 450, 300],
    [2, 650, 300],
  ]);
  await drag(page, [1, 2], 160, 0, 8);
  await up(page, 2);
  await up(page, 1);
  await page.waitForTimeout(500);
  const c1 = await cameraState(page);
  assert(Math.abs(c1.az - c0.az) > 0.15, `orbited: azimuth ${c0.az} -> ${c1.az}`);
  near(c1.dist, c0.dist, c0.dist * 0.08, 'orbit keeps the distance');
  // pinch out = zoom in
  await downAll(page, [
    [1, 500, 320],
    [2, 600, 320],
  ]);
  for (let i = 1; i <= 8; i++) {
    await moveTo(page, 1, 500 - i * 20, 320);
    await moveTo(page, 2, 600 + i * 20, 320);
  }
  await up(page, 2);
  await up(page, 1);
  await page.waitForTimeout(500);
  const c2 = await cameraState(page);
  assert(c2.dist < c1.dist * 0.8, `pinch out zoomed in: ${c1.dist} -> ${c2.dist}`);
  // pinch in = zoom out
  await downAll(page, [
    [1, 300, 320],
    [2, 800, 320],
  ]);
  for (let i = 1; i <= 8; i++) {
    await moveTo(page, 1, 300 + i * 25, 320);
    await moveTo(page, 2, 800 - i * 25, 320);
  }
  await up(page, 2);
  await up(page, 1);
  await page.waitForTimeout(500);
  const c3 = await cameraState(page);
  assert(c3.dist > c2.dist * 1.2, `pinch in zoomed out: ${c2.dist} -> ${c3.dist}`);
  // three fingers pan: target moves, distance and orientation stay
  await downAll(page, [
    [1, 400, 300],
    [2, 500, 300],
    [3, 600, 300],
  ]);
  await drag(page, [1, 2, 3], 120, 0, 8);
  await up(page, 3);
  await up(page, 2);
  await up(page, 1);
  await page.waitForTimeout(300);
  const c4 = await cameraState(page);
  const shift = Math.hypot(c4.target[0] - c3.target[0], c4.target[1] - c3.target[1], c4.target[2] - c3.target[2]);
  assert(shift > 0.5, `three-finger pan moved the target by ${shift}`);
  near(c4.dist, c3.dist, c3.dist * 0.05, 'pan keeps the distance');
  near(c4.az, c3.az, 0.05, 'pan keeps the azimuth');
  await shot(page, 'cm-touch-after-gestures');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.closeAll();
});

test('touch: long-press opens the context menu without select-dragging; a short press does not', async () => {
  const page = await newTouchPage();
  const [a] = await boxScene(page);
  const p = await screenOf(page, a);
  const start = await posOf(page, a);
  // short press + release = tap, no menu
  await down(page, 1, p.x, p.y);
  await page.waitForTimeout(150);
  await up(page, 1);
  assert((await page.locator('.menu').count()) === 0, 'no menu after a tap');
  await tap(page, 1000, 330); // deselect with a real tap
  await page.waitForFunction(() => !window.physicslab.gizmo.controls.object, null, { timeout: 15000 });
  // long press
  await holdTime(page, 900);
  await down(page, 1, p.x, p.y);
  await page.waitForSelector('.menu', { timeout: 15000 });
  assert((await sel(page)).join() === a, `long-press selected the object under the finger: ${await sel(page)} vs ${a}`);
  await shot(page, 'cm-touch-longpress-menu');
  // moving afterwards must not drag the object
  await drag(page, [1], 70, 30, 4);
  await up(page, 1);
  const end = await posOf(page, a);
  near(end[0], start[0], 1e-6, 'no drag after long-press (x)');
  near(end[2], start[2], 1e-6, 'no drag after long-press (z)');
  assert((await page.locator('.menu').count()) === 1, 'menu stays open after lifting the finger');
  await page.keyboard.press('Escape');
  // drifting beyond the tolerance cancels the long press
  await holdTime(page, 2500);
  await down(page, 1, p.x, p.y);
  await drag(page, [1], 40, 0, 2);
  await page.waitForTimeout(3500);
  assert((await page.locator('.menu').count()) === 0, 'a moving finger never opens the menu');
  await up(page, 1);
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.closeAll();
});

test('touch: "move selection with two fingers" moves the selection (one undo step), pinch still zooms, off by default', async () => {
  const page = await newTouchPage();
  const [a, b] = await boxScene(page);
  assert(!(await page.evaluate(() => window.physicslab.input.settings.touch.moveWithTwoFingers)), 'off by default');
  await page.evaluate((id) => window.physicslab.store.setSelection([id]), a);
  const start = await posOf(page, a);
  const other = await posOf(page, b);
  const cam0 = await cameraState(page);
  // default: two fingers orbit, the box stays
  await downAll(page, [
    [1, 700, 480],
    [2, 900, 480],
  ]);
  await drag(page, [1, 2], 140, 0, 6);
  await up(page, 2);
  await up(page, 1);
  await page.waitForTimeout(400);
  const camOrbit = await cameraState(page);
  assert(Math.abs(camOrbit.az - cam0.az) > 0.1, 'default two-finger drag orbits');
  const unmoved = await posOf(page, a);
  near(unmoved[0], start[0], 1e-6, 'selection not moved by default');
  // turn the mode on, reset the view
  await page.evaluate(() => {
    const app = window.physicslab;
    app.input.update_settings({ touch: { ...app.input.settings.touch, moveWithTwoFingers: true } });
    // plain grid snapping: the other boxes must not pull the moved one onto their corners
    app.prefs.set({ snapVertex: false, snapSurface: false });
    app.viewport.setView({ position: [0, 9, 12], target: [0, 0.5, 0] });
  });
  await page.waitForFunction(() => window.physicslab.camera.position.distanceTo({ x: 0, y: 9, z: 12 }) < 0.05, null, {
    timeout: 20000,
  });
  await nextFrame(page);
  const camBefore = await cameraState(page);
  const pa = await screenOf(page, a);
  await downAll(page, [
    [1, pa.x - 250, pa.y - 100],
    [2, pa.x - 170, pa.y - 100],
  ]);
  await drag(page, [1, 2], 90, 0, 6);
  await up(page, 2);
  await up(page, 1);
  const moved = await posOf(page, a);
  assert(moved[0] > start[0] + 0.5, `two-finger drag moved the selected box in +x: ${start} -> ${moved}`);
  near(moved[1], start[1], 1e-6, 'stays on its height');
  const otherNow = await posOf(page, b);
  near(otherNow[0], other[0], 1e-6, 'unselected box untouched');
  const camAfter = await cameraState(page);
  near(camAfter.az, camBefore.az, 0.02, 'camera did not orbit while moving');
  // one undo step brings it back
  await page.evaluate(() => window.physicslab.store.undo());
  const undone = await posOf(page, a);
  near(undone[0], start[0], 1e-6, 'one undo restores the position');
  // pinch in this mode zooms the camera
  await downAll(page, [
    [1, 700, 480],
    [2, 800, 480],
  ]);
  for (let i = 1; i <= 8; i++) {
    await moveTo(page, 1, 700 - i * 20, 480);
    await moveTo(page, 2, 800 + i * 20, 480);
  }
  await up(page, 2);
  await up(page, 1);
  await page.waitForTimeout(300);
  const zoomed = await cameraState(page);
  assert(zoomed.dist < camAfter.dist * 0.85, `pinch zooms in move mode: ${camAfter.dist} -> ${zoomed.dist}`);
  const stay = await posOf(page, a);
  near(stay[0], start[0], 1e-6, 'pinch did not move the selection');
  // nothing selected: two fingers orbit again
  await page.evaluate(() => window.physicslab.store.setSelection([]));
  const o0 = await cameraState(page);
  await downAll(page, [
    [1, 450, 300],
    [2, 650, 300],
  ]);
  await drag(page, [1, 2], 160, 0, 8);
  await up(page, 2);
  await up(page, 1);
  await page.waitForTimeout(400);
  const o1 = await cameraState(page);
  assert(Math.abs(o1.az - o0.az) > 0.1, 'with nothing selected two fingers orbit');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.closeAll();
});

test('touch settings: choose buttons, sticks, size and left-handed layout; saved and applied to the overlay', async () => {
  const page = await newTouchPage('&scene=car');
  await page.evaluate(() => window.physicslab.input.update_settings({ touchControls: 'on' }));
  await page.waitForSelector('.tc-overlay:not([hidden])');
  // touch-friendly hit areas: bigger gizmo handles on a touch device, every control at least 44 px
  assert(
    (await page.evaluate(() => window.physicslab.gizmo.controls.size)) > 0.85,
    'gizmo handles are enlarged on touch devices',
  );
  for (const sel of ['.tc-btn-LT', '.tc-btn-RT', '.tc-btn-South', '.tc-btn-East']) {
    const b = await centre(page, sel);
    assert(b.w >= 44 && b.h >= 44, `${sel} is ${b.w}x${b.h}`);
  }
  // default: left zone on the left
  const leftZoneX = async () => (await centre(page, '.tc-zone[data-zone="left"]')).x;
  assert((await leftZoneX()) < 550, 'left stick on the left');
  await page.keyboard.press('Control+k');
  await page.fill('.palette-input', 'keyboard gamepad');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.input-modal .kb-row');
  await page.click('.input-modal [data-tab="touch"]');
  await page.waitForSelector('.touch-tab .tc-choice');
  await shot(page, 'cm-touch-settings');
  await page.click('.touch-tab .tc-choice [data-btn="West"]');
  await page.click('.touch-tab .tc-choice [data-btn="South"]');
  const cfg = await page.evaluate(() => window.physicslab.input.settings.touch);
  assert(cfg.buttons.includes('West') && !cfg.buttons.includes('South'), `buttons ${cfg.buttons}`);
  assert(
    (await page.locator('.tc-btn-West').count()) === 1 && (await page.locator('.tc-btn-South').count()) === 0,
    'overlay follows',
  );
  // left-handed
  await page.locator('.touch-tab .row', { hasText: 'Left-handed' }).locator('.switch').click();
  assert((await page.evaluate(() => window.physicslab.input.settings.touch.leftHanded)) === true, 'left-handed saved');
  await page.click('.input-modal .modal-close, .modal-close').catch(() => page.keyboard.press('Escape'));
  await page.waitForTimeout(200);
  assert((await leftZoneX()) > 550, 'left-handed puts the left stick on the right');
  // sticks: none
  await page.evaluate(() => {
    const a = window.physicslab;
    a.input.update_settings({ touch: { ...a.input.settings.touch, sticks: 'right', size: 1.4 } });
  });
  assert((await page.locator('.tc-stick').count()) === 1, 'only the right stick');
  const stick = await centre(page, '.tc-stick');
  near(stick.w, 128 * 1.4, 1, 'size scales the stick');
  // persisted through the prefs store
  const stored = await page.evaluate(() => JSON.stringify(window.physicslab.prefs.value.input.touch));
  assert(stored.includes('"leftHanded":true') && stored.includes('"sticks":"right"'), stored);
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.closeAll();
});
