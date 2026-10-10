/**
 * NAV: platform-aware navigation (trackpad / mouse / touch / keyboard), the input contexts and the controls legend.
 * Trackpad input is synthesised the way browsers deliver it: a pinch is a `wheel` event with ctrlKey and small
 * fractional deltas, a two-finger swipe a burst of two-axis pixel deltas.
 */
import { assert, near, newPage, nextFrame, pose, screenOf, shot, simTime } from '../helpers.mjs';
import { downAll, drag, moveTo, newTouchPage, up } from './cm-touch.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const camState = (page) =>
  page.evaluate(() => {
    const a = window.physicslab;
    const c = a.camera.position;
    const t = a.viewport.controls.target;
    const d = c.distanceTo(t);
    return {
      az: Math.atan2(c.x - t.x, c.z - t.z),
      pol: Math.acos((c.y - t.y) / d),
      dist: d,
      target: [t.x, t.y, t.z],
      pos: [c.x, c.y, c.z],
      ortho: a.camera.ortho,
    };
  });

/** A calm scene: three boxes, a fixed camera, no damping, panels closed so the canvas is large. */
async function scene(page, device = 'trackpad') {
  await page.evaluate((device) => {
    const a = window.physicslab;
    a.prefs.set({ followSelection: false });
    a.store.clear();
    for (const x of [-3, 0, 3]) a.addShape('box', [x, 0.5, 0]);
    a.store.setSelection([]);
    a.viewport.controls.enableDamping = false;
    a.viewport.setView({ position: [0, 6, 12], target: [0, 1, 0] });
    a.input.update_settings({ nav: { ...a.input.settings.nav, device, smooth: false } });
  }, device);
  await settle(page);
}

const settle = async (page) => {
  await page.waitForFunction(() => !window.physicslab.nav.busy, null, { timeout: 20000 });
  for (let i = 0; i < 3; i++) await nextFrame(page);
};

/** Dispatch a wheel event on the canvas; returns whether the page's default (zoom, history swipe …) was prevented. */
const wheel = (page, init) =>
  page.evaluate((init) => {
    const c = window.physicslab.viewport.dom;
    const r = c.getBoundingClientRect();
    const e = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + r.width * (init.fx ?? 0.5),
      clientY: r.top + r.height * (init.fy ?? 0.5),
      ...init,
    });
    return !c.dispatchEvent(e);
  }, init);

/** The screen position (client px) of a world point. */
const project = (page, p) =>
  page.evaluate((p) => {
    const a = window.physicslab;
    a.camera.updateMatrixWorld(true);
    a.camera.updateProjectionMatrix();
    const v = a.camera.position.clone().set(p[0], p[1], p[2]).project(a.camera);
    const r = a.viewport.dom.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }, p);

test('nav: a trackpad pinch (ctrl + wheel) zooms towards the cursor and never zooms the page', async () => {
  const page = await newPage();
  await scene(page);
  const c0 = await camState(page);
  // the point of the target plane under the cursor at (75 %, 35 %)
  const fx = 0.75;
  const fy = 0.35;
  const p = await page.evaluate(
    ([fx, fy]) => {
      const a = window.physicslab;
      a.camera.updateMatrixWorld(true);
      const r = a.viewport.dom.getBoundingClientRect();
      const ndc = a.camera.position.clone().set(fx * 2 - 1, -(fy * 2 - 1), 0.5);
      ndc.unproject(a.camera);
      const dir = ndc.sub(a.camera.position).normalize();
      const f = a.camera.getWorldDirection(a.camera.position.clone());
      const t = a.viewport.controls.target;
      const d = a.camera.position.distanceTo(t);
      const P = a.camera.position.clone().addScaledVector(dir, d / dir.dot(f));
      void r;
      return [P.x, P.y, P.z];
    },
    [fx, fy],
  );
  const before = await project(page, p);
  let prevented = true;
  for (let i = 0; i < 6; i++) prevented = (await wheel(page, { deltaY: -8.5, ctrlKey: true, fx, fy })) && prevented;
  assert(prevented, 'the pinch is preventDefault-ed (no page zoom)');
  await settle(page);
  const c1 = await camState(page);
  assert(c1.dist < c0.dist * 0.7, `pinch out zoomed in: ${c0.dist} -> ${c1.dist}`);
  const after = await project(page, p);
  near(after.x, before.x, 2, 'the point under the cursor stays under it (x)');
  near(after.y, before.y, 2, 'the point under the cursor stays under it (y)');
  near(c1.az, c0.az, 0.02, 'zooming does not turn the view');
  // pinch in zooms out again
  for (let i = 0; i < 6; i++) await wheel(page, { deltaY: 8.5, ctrlKey: true, fx, fy });
  await settle(page);
  const c2 = await camState(page);
  assert(c2.dist > c1.dist * 1.4, `pinch in zoomed out: ${c1.dist} -> ${c2.dist}`);
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

test('nav: a two-finger swipe orbits, Shift pans, Option zooms; the setting swaps orbit and pan', async () => {
  const page = await newPage();
  await scene(page);
  const c0 = await camState(page);
  // swipe: fingers move left → the scene follows them
  let prevented = true;
  for (let i = 0; i < 8; i++) prevented = (await wheel(page, { deltaX: -14.5, deltaY: 1.25 })) && prevented;
  assert(prevented, 'swipes are preventDefault-ed (no history swipe, no scrolling)');
  await settle(page);
  const c1 = await camState(page);
  assert(Math.abs(c1.az - c0.az) > 0.3, `swipe orbited: azimuth ${c0.az} -> ${c1.az}`);
  near(c1.dist, c0.dist, c0.dist * 0.01, 'orbit keeps the distance');
  near(c1.target[0], c0.target[0], 1e-6, 'orbit keeps the target');
  // shift + swipe pans
  for (let i = 0; i < 8; i++) await wheel(page, { deltaX: -14.5, deltaY: 6.25, shiftKey: true });
  await settle(page);
  const c2 = await camState(page);
  const moved = Math.hypot(c2.target[0] - c1.target[0], c2.target[1] - c1.target[1], c2.target[2] - c1.target[2]);
  assert(moved > 0.8, `shift + swipe panned the target by ${moved}`);
  near(c2.az, c1.az, 0.01, 'pan keeps the azimuth');
  near(c2.dist, c1.dist, 1e-6, 'pan keeps the distance');
  // cmd + swipe pans as well
  const t2 = c2.target.slice();
  for (let i = 0; i < 4; i++) await wheel(page, { deltaX: 10.5, deltaY: 0.5, metaKey: true });
  await settle(page);
  const c3 = await camState(page);
  assert(Math.hypot(c3.target[0] - t2[0], c3.target[2] - t2[2]) > 0.3, 'cmd + swipe pans');
  // option + swipe zooms
  for (let i = 0; i < 5; i++) await wheel(page, { deltaX: 0.5, deltaY: -12.5, altKey: true });
  await settle(page);
  const c4 = await camState(page);
  assert(c4.dist < c3.dist * 0.8, `option + swipe zoomed in: ${c3.dist} -> ${c4.dist}`);
  // swap: the swipe pans, shift orbits
  await page.evaluate(() => {
    const a = window.physicslab;
    a.input.update_settings({ nav: { ...a.input.settings.nav, swipe: 'pan' } });
  });
  for (let i = 0; i < 6; i++) await wheel(page, { deltaX: -12.5, deltaY: 0.5 });
  await settle(page);
  const c5 = await camState(page);
  near(c5.az, c4.az, 0.01, 'with swipe = pan a plain swipe does not orbit');
  assert(Math.hypot(c5.target[0] - c4.target[0], c5.target[2] - c4.target[2]) > 0.3, 'a plain swipe pans');
  for (let i = 0; i < 6; i++) await wheel(page, { deltaX: -12.5, deltaY: 0.5, shiftKey: true });
  await settle(page);
  const c6 = await camState(page);
  assert(Math.abs(c6.az - c5.az) > 0.2, 'shift + swipe orbits when swipe = pan');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

test('nav: the pointing device is detected from the wheel events, overridable, and a mouse wheel zooms', async () => {
  const page = await newPage();
  await scene(page, 'auto');
  const dev = () => page.evaluate(() => window.physicslab.nav.device);
  assert((await dev()) === 'mouse', 'Linux starts as a mouse');
  // a finger glides: bursts of two-axis fractional deltas
  for (let i = 0; i < 10; i++) {
    await wheel(page, { deltaX: 1.5 + i * 0.1, deltaY: 6.25 - i * 0.2 });
    await page.waitForTimeout(8);
  }
  assert((await dev()) === 'trackpad', `a swipe burst reads as a trackpad (${await dev()})`);
  // a classic wheel: isolated whole notches
  const c0 = await camState(page);
  for (let i = 0; i < 4; i++) {
    await wheel(page, { deltaY: 100, wheelDeltaY: -120 });
    await page.waitForTimeout(180);
  }
  assert((await dev()) === 'mouse', `isolated notches read as a mouse (${await dev()})`);
  await settle(page);
  const c1 = await camState(page);
  assert(c1.dist > c0.dist * 1.2, `a mouse wheel zooms out: ${c0.dist} -> ${c1.dist}`);
  // the override wins
  await page.evaluate(() => {
    const a = window.physicslab;
    a.input.update_settings({ nav: { ...a.input.settings.nav, device: 'trackpad' } });
  });
  assert((await dev()) === 'trackpad', 'override: trackpad');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

test('nav: keyboard navigation — arrows orbit, shift pans, +/- zoom, Option+7 top view, Home frames all', async () => {
  const page = await newPage();
  await scene(page, 'mouse');
  await page.evaluate(() => window.physicslab.viewport.dom.focus());
  const c0 = await camState(page);
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(500);
  await page.keyboard.up('ArrowLeft');
  await settle(page);
  const c1 = await camState(page);
  assert(Math.abs(c1.az - c0.az) > 0.25, `ArrowLeft orbits: ${c0.az} -> ${c1.az}`);
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(350);
  await page.keyboard.up('ArrowUp');
  await settle(page);
  const c2 = await camState(page);
  assert(Math.abs(c2.pol - c1.pol) > 0.1, `ArrowUp tilts: ${c1.pol} -> ${c2.pol}`);
  await page.keyboard.down('Shift');
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(400);
  await page.keyboard.up('ArrowRight');
  await page.keyboard.up('Shift');
  await settle(page);
  const c3 = await camState(page);
  assert(Math.hypot(c3.target[0] - c2.target[0], c3.target[2] - c2.target[2]) > 0.5, 'Shift + arrow pans');
  near(c3.az, c2.az, 0.01, 'pan keeps the azimuth');
  await page.keyboard.down('Equal');
  await page.waitForTimeout(400);
  await page.keyboard.up('Equal');
  await settle(page);
  const c4 = await camState(page);
  assert(c4.dist < c3.dist * 0.8, `+ zooms in: ${c3.dist} -> ${c4.dist}`);
  await page.keyboard.down('Minus');
  await page.waitForTimeout(500);
  await page.keyboard.up('Minus');
  await settle(page);
  const c5 = await camState(page);
  assert(c5.dist > c4.dist * 1.2, `- zooms out: ${c4.dist} -> ${c5.dist}`);
  // laptop-friendly view shortcut: Alt + 7 = top (orthographic)
  await page.keyboard.down('Alt');
  await page.keyboard.press('Digit7');
  await page.keyboard.up('Alt');
  await page.waitForFunction(() => window.physicslab.cameraRig.preset === 'top', null, { timeout: 10000 });
  assert((await camState(page)).ortho, 'Alt + 7 shows the orthographic top view');
  assert((await page.evaluate(() => window.physicslab.store.bodies().length)) === 3, 'Alt + digit did not add a shape');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

test('nav: with a selection plain arrows still nudge it, Option + arrows orbit; a selected scene keeps its camera', async () => {
  const page = await newPage();
  await scene(page, 'mouse');
  const id = await page.evaluate(() => {
    const a = window.physicslab;
    const b = a.store.bodies()[1];
    a.store.setSelection([b.id]);
    a.viewport.dom.focus();
    return b.id;
  });
  const x0 = await page.evaluate((id) => window.physicslab.store.body(id).position.slice(), id);
  const c0 = await camState(page);
  await page.keyboard.press('ArrowRight');
  await nextFrame(page);
  const x1 = await page.evaluate((id) => window.physicslab.store.body(id).position.slice(), id);
  assert(Math.hypot(x1[0] - x0[0], x1[2] - x0[2]) > 0.05, 'a plain arrow nudges the selected body');
  near((await camState(page)).az, c0.az, 0.001, 'and does not orbit');
  await page.keyboard.down('Alt');
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(400);
  await page.keyboard.up('ArrowLeft');
  await page.keyboard.up('Alt');
  await settle(page);
  assert(Math.abs((await camState(page)).az - c0.az) > 0.2, 'Option / Alt + arrow orbits even with a selection');
  const x2 = await page.evaluate((id) => window.physicslab.store.body(id).position.slice(), id);
  near(x2[0], x1[0], 1e-6, 'Alt + arrow does not nudge');
  await page.close();
});

test('nav: Option + drag orbits, Space + drag pans, a plain drag on empty space still draws a selection box, a Space tap still plays', async () => {
  const page = await newPage();
  await scene(page, 'trackpad');
  const r = await page.evaluate(() => {
    const b = window.physicslab.viewport.dom.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
  const sx = r.x + r.w * 0.5;
  const sy = r.y + r.h * 0.22;
  const c0 = await camState(page);
  // option + drag
  await page.mouse.move(sx, sy);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(sx + i * 18, sy + i * 2);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await settle(page);
  const c1 = await camState(page);
  assert(Math.abs(c1.az - c0.az) > 0.25, `Alt + drag orbits: ${c0.az} -> ${c1.az}`);
  assert((await page.evaluate(() => window.physicslab.store.selection.length)) === 0, 'and selects nothing');
  // space + drag
  await page.mouse.move(sx, sy);
  await page.keyboard.down('Space');
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(sx + i * 15, sy + i * 3);
  await page.mouse.up();
  await page.keyboard.up('Space');
  await settle(page);
  const c2 = await camState(page);
  assert(Math.hypot(c2.target[0] - c1.target[0], c2.target[2] - c1.target[2]) > 0.5, 'Space + drag pans');
  near(c2.az, c1.az, 0.01, 'pan keeps the azimuth');
  assert(!(await page.evaluate(() => window.physicslab.sim.active)), 'Space used as a pan modifier does not start the simulation');
  // a plain drag draws the rectangle and leaves the camera alone
  await page.mouse.move(sx - 300, sy);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(sx - 300 + i * 30, sy + i * 20);
  const box = await page.evaluate(() => getComputedStyle(document.querySelector('.marquee')).display);
  await page.mouse.up();
  assert(box === 'block', 'a plain drag on empty space draws the selection rectangle');
  near((await camState(page)).az, c2.az, 1e-6, 'and does not move the camera');
  // a tap on Space still plays
  await page.mouse.move(sx, sy);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.physicslab.sim.active, null, { timeout: 5000 });
  await page.keyboard.press('Space');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

const ballScene = (page) =>
  page.evaluate(() => {
    const a = window.physicslab;
    a.newScene();
    const b = a.editor.addShape('sphere', [0, 0.5, 0], { material: { preset: 'rubber', density: 300 } });
    a.viewport.setView({ position: [0, 4, 9], target: [0, 1, 0] });
    window.__wheels = 0;
    window.addEventListener('wheel', () => window.__wheels++, true);
    return b.id;
  });

const yawOf = (q) => (2 * Math.atan2(q[1], q[3]) * 180) / Math.PI;

test('nav: holding a body — push / pull with W S ↑ ↓, turn with Q E A D in 15° steps, freeze with F — no wheel needed', async () => {
  const page = await newPage();
  const id = await ballScene(page);
  await page.keyboard.press('Space');
  await simTime(page, 0.8);
  const sp = await screenOf(page, id);
  await page.mouse.move(sp.x, sp.y);
  await page.mouse.down();
  await page.mouse.move(sp.x, sp.y - 60, { steps: 6 });
  await page.waitForTimeout(500);
  assert((await page.evaluate(() => window.physicslab.contexts.current)) === 'grab', 'the context is grab while holding');
  const z0 = await page.evaluate((id) => window.physicslab.bodies.get(id).position.z, id);
  const zOf = (id) => page.evaluate((id) => window.physicslab.bodies.get(id).position.z, id);
  // hold a key for a moment (the target moves at a speed that scales with the distance), then let the spring catch up
  const tap = async (code, ms) => {
    await page.keyboard.down(code);
    await page.waitForTimeout(ms);
    await page.keyboard.up(code);
  };
  const settleZ = (id, test, msg) =>
    page.waitForFunction(([id, src]) => new Function('z', `return ${src}`)(window.physicslab.bodies.get(id).position.z), [id, test], { timeout: 25000 }).catch(() => {
      throw new Error(`assertion failed: ${msg}`);
    });
  await tap('KeyW', 350);
  await settleZ(id, `z < ${z0 - 1.2}`, `W pushes the held body away (from z ${z0.toFixed(2)})`);
  const z1 = await zOf(id);
  await tap('ArrowDown', 350);
  await settleZ(id, `z > ${z1 + 1}`, `Arrow Down pulls it back (from z ${z1.toFixed(2)})`);
  const z2 = await zOf(id);
  // [ and ] too
  await tap('BracketRight', 350);
  await settleZ(id, `z < ${z2 - 1}`, `] pushes it away (from z ${z2.toFixed(2)})`);
  // 15 degree steps
  const yaw0 = yawOf((await pose(page, id)).rotation);
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(200);
  const yaw1 = yawOf((await pose(page, id)).rotation);
  near(Math.abs(yaw1 - yaw0), 15, 4, `E turns 15° (${yaw0.toFixed(1)} -> ${yaw1.toFixed(1)})`);
  await page.keyboard.press('KeyQ');
  await page.waitForTimeout(200);
  const yaw2 = yawOf((await pose(page, id)).rotation);
  near(yaw2, yaw0, 4, 'Q turns it back');
  await page.keyboard.press('Shift+KeyD');
  await page.waitForTimeout(200);
  const yaw3 = yawOf((await pose(page, id)).rotation);
  near(Math.abs(yaw3 - yaw2), 5, 3, `Shift + D is a fine 5° step (${yaw2.toFixed(1)} -> ${yaw3.toFixed(1)})`);
  await shot(page, 'nav-grab-legend');
  // F freezes it where it is
  await page.keyboard.press('KeyF');
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const a = await pose(page, id);
  await page.waitForTimeout(1200);
  const b = await pose(page, id);
  near(b.position[1], a.position[1], 0.01, 'frozen body stays in the air');
  assert((await page.evaluate(() => window.__wheels)) === 0, 'no wheel event was needed');
  assert((await page.evaluate(() => window.physicslab.contexts.current)) === 'simulating', 'back to the simulating context');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

test('nav: the controls legend names the context, lists what works now, and says what does not', async () => {
  const page = await newPage('&scene=powertrain-car');
  await page.evaluate(() => {
    const a = window.physicslab;
    a.prefs.set({ followSelection: false });
    a.store.setSelection([]);
  });
  const ctx = () => page.evaluate(() => document.querySelector('.ctl-legend')?.dataset.ctx);
  assert((await ctx()) === 'edit', 'edit context at start');
  assert((await page.locator('.ctl-pill .ctl-ctx').innerText()) === 'Edit', 'the pill names it');
  await page.click('.ctl-pill');
  await page.waitForSelector('.ctl-body:not([hidden]) .ctl-row');
  const editText = await page.locator('.ctl-body').innerText();
  assert(/Move gizmo/.test(editText) && /Orbit/.test(editText), `edit legend lists the tools and the camera: ${editText}`);
  await shot(page, 'nav-legend-edit');
  // simulating the powertrain car: Q W E R belong to the car
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.physicslab.sim.active, null, { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('.ctl-legend')?.dataset.ctx === 'simulating');
  assert((await page.locator('.ctl-pill .ctl-ctx').innerText()) === 'Simulating', 'the pill follows the simulation');
  await page.waitForSelector('.ctl-row[data-id="tool.KeyQ"].off');
  const why = await page.locator('.ctl-row[data-id="tool.KeyQ"] .ctl-why').innerText();
  assert(/unavailable/.test(why) && /scene uses/.test(why), `Q says why it is unavailable: ${why}`);
  const scene = await page.locator('.ctl-sec[data-sec="scene"]').innerText();
  assert(/Throttle/.test(scene) && /Brake/.test(scene), `the scene's controls are listed: ${scene}`);
  // a pressed key lights its row
  await page.keyboard.down('KeyW');
  await page.waitForSelector('.ctl-sec[data-sec="scene"] .ctl-row.down');
  await shot(page, 'nav-legend-simulating');
  await page.keyboard.up('KeyW');
  await page.waitForFunction(() => !document.querySelector('.ctl-sec[data-sec="scene"] .ctl-row.down'));
  // the fly camera
  await page.evaluate(() => window.physicslab.cameraRig.setMode('fly'));
  await page.waitForFunction(() => document.querySelector('.ctl-legend')?.dataset.ctx === 'fly');
  assert(/Fly camera/.test(await page.locator('.ctl-pill .ctl-ctx').innerText()), 'fly pill');
  assert(/the fly camera uses this key/.test(await page.locator('.ctl-body').innerText()), 'scene keys used by the camera are named');
  await shot(page, 'nav-legend-fly');
  // collapse
  await page.click('.ctl-pill');
  await page.waitForSelector('.ctl-body[hidden]', { state: 'attached' });
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

test('nav: Q and E work where the legend says they do — tools in the editor, the car’s gearbox while simulating, up / down in the fly camera, turning a held body', async () => {
  const page = await newPage('&scene=powertrain-car');
  await page.evaluate(() => {
    const a = window.physicslab;
    a.prefs.set({ followSelection: false });
    a.store.setSelection([]);
    a.viewport.dom.focus();
  });
  const gizmo = () => page.evaluate(() => window.physicslab.prefs.value.gizmo);
  // edit: E = rotate gizmo, Q = select
  await page.keyboard.press('KeyE');
  assert((await gizmo()) === 'rotate', 'E selects the rotate gizmo in the editor');
  await page.keyboard.press('KeyQ');
  assert((await gizmo()) === 'none', 'Q selects the select tool in the editor');
  await page.keyboard.press('KeyW');
  assert((await gizmo()) === 'translate', 'W: move gizmo');
  // simulating the powertrain car: Q / E / W are the car's and leave the gizmo alone
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.physicslab.sim.active, null, { timeout: 5000 });
  await page.waitForFunction(() => window.physicslab.contexts.current === 'simulating');
  await page.keyboard.down('KeyE');
  await page.waitForFunction(() => window.physicslab.sim.keys.has('KeyE'), null, { timeout: 10000 }).catch(() => {
    throw new Error('assertion failed: E reaches the simulation (gear up)');
  });
  assert((await gizmo()) === 'translate', 'and does not switch the gizmo while simulating');
  await page.keyboard.up('KeyE');
  await page.keyboard.press('KeyQ');
  assert((await gizmo()) === 'translate', 'Q does not select the select tool while simulating');
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.physicslab.sim.keys.has('KeyW'), null, { timeout: 10000 }).catch(() => {
    throw new Error('assertion failed: W reaches the engine');
  });
  await page.keyboard.up('KeyW');
  await page.keyboard.press('Space'); // pause
  // fly camera: E up, Q down
  await page.evaluate(() => window.physicslab.cameraRig.setMode('fly'));
  await page.waitForFunction(() => window.physicslab.contexts.current === 'fly');
  await page.waitForTimeout(500);
  const y0 = await page.evaluate(() => window.physicslab.camera.position.y);
  await page.keyboard.down('KeyE');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyE');
  const y1 = await page.evaluate(() => window.physicslab.camera.position.y);
  assert(y1 > y0 + 0.5, `E flies up (${y0.toFixed(2)} -> ${y1.toFixed(2)})`);
  await page.keyboard.down('KeyQ');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyQ');
  const y2 = await page.evaluate(() => window.physicslab.camera.position.y);
  assert(y2 < y1 - 0.5, `Q flies down (${y1.toFixed(2)} -> ${y2.toFixed(2)})`);
  assert((await gizmo()) === 'translate', 'the gizmo was left alone in the fly camera');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

test('nav: touch — one finger orbits on empty space, two fingers pan, a pinch zooms, a twist turns the view, a double-tap focuses', async () => {
  const page = await newTouchPage();
  await page.evaluate(() => {
    const a = window.physicslab;
    a.prefs.set({ showLeft: false, showRight: false, showBottom: false, followSelection: false });
    a.input.update_settings({ touch: { ...a.input.settings.touch, longPressMs: 9000 }, nav: { ...a.input.settings.nav, smooth: false } });
    a.store.clear();
    for (const x of [-3, 0, 3]) a.addShape('box', [x, 0.5, 0]);
    a.store.setSelection([]);
    a.viewport.controls.enableDamping = false;
    a.viewport.setView({ position: [0, 9, 12], target: [0, 0.5, 0] });
  });
  await settle(page);
  const c0 = await camState(page);
  // one finger on empty space orbits (no selection rectangle)
  await downAllOne(page, 1, 700, 150);
  await drag(page, [1], 160, 10, 8);
  const marquee = await page.evaluate(() => getComputedStyle(document.querySelector('.marquee')).display);
  await up(page, 1);
  await settle(page);
  const c1 = await camState(page);
  assert(Math.abs(c1.az - c0.az) > 0.2, `one finger orbits: ${c0.az} -> ${c1.az}`);
  assert(marquee === 'none', 'no selection rectangle on touch');
  // two fingers drag = pan
  await downAll(page, [[1, 450, 300], [2, 650, 300]]);
  await drag(page, [1, 2], 160, 0, 8);
  await up(page, 2);
  await up(page, 1);
  await page.waitForTimeout(400);
  await settle(page);
  const c2 = await camState(page);
  assert(Math.hypot(c2.target[0] - c1.target[0], c2.target[2] - c1.target[2]) > 0.4, 'two fingers pan the view');
  near(c2.az, c1.az, 0.05, 'pan keeps the azimuth');
  // twist: the fingers turn about their centre
  await downAll(page, [[1, 500, 320], [2, 700, 320]]);
  for (let i = 1; i <= 8; i++) {
    const a = (i / 8) * 0.9;
    await moveTo(page, 1, 600 - Math.cos(a) * 100, 320 - Math.sin(a) * 100);
    await moveTo(page, 2, 600 + Math.cos(a) * 100, 320 + Math.sin(a) * 100);
  }
  await up(page, 2);
  await up(page, 1);
  await page.waitForTimeout(400);
  await settle(page);
  const c3 = await camState(page);
  assert(Math.abs(c3.az - c2.az) > 0.3, `a twist turns the view: ${c2.az} -> ${c3.az}`);
  // pinch zooms
  await downAll(page, [[1, 500, 320], [2, 600, 320]]);
  for (let i = 1; i <= 8; i++) {
    await moveTo(page, 1, 500 - i * 20, 320);
    await moveTo(page, 2, 600 + i * 20, 320);
  }
  await up(page, 2);
  await up(page, 1);
  await page.waitForTimeout(400);
  await settle(page);
  const c4 = await camState(page);
  assert(c4.dist < c3.dist * 0.8, `pinch out zooms in: ${c3.dist} -> ${c4.dist}`);
  // double-tap on a box selects and frames it
  const id = await page.evaluate(() => window.physicslab.store.bodies()[2].id);
  const p = await screenOf(page, id);
  const target0 = (await camState(page)).target;
  for (let i = 0; i < 2; i++) {
    await downAllOne(page, 9, p.x, p.y);
    await up(page, 9);
    await page.waitForTimeout(60);
  }
  await page.waitForFunction((id) => window.physicslab.store.selection.includes(id), id, { timeout: 5000 });
  await page.waitForTimeout(800);
  await settle(page);
  const c5 = await camState(page);
  assert(Math.hypot(c5.target[0] - target0[0], c5.target[2] - target0[2]) > 0.5, 'double-tap focuses the object');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.closeAll();
});

async function downAllOne(page, id, x, y) {
  await downAll(page, [[id, x, y]]);
}
