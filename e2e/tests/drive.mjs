/**
 * NAV drive mode and play mode: the immersive vehicle mode (V) with a chase camera and only the vehicle's controls,
 * Esc / Tab restoring the editor, the powertrain car's own keys winning over the utility keys, and play mode.
 */
import { assert, newPage, nextFrame, pose, screenOf, shot, simTime } from '../helpers.mjs';
import { newTouchPage } from './cm-touch.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const chassisId = (page, re = /^chassis$|chassis$/i) =>
  page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const a = window.physicslab;
    return (a.store.bodies().find((b) => re.test(b.name)) ?? a.store.bodies()[0]).id;
  }, re.source);

/** Wait until the simulation has run `s` more simulated seconds (`simTime` counts from the start of the run). */
const simFor = async (page, s) => {
  const t0 = await page.evaluate(() => window.physicslab.sim.client.stats?.simTime ?? 0);
  await simTime(page, t0 + s);
};
const visible = (page, sel) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0;
  }, sel);

test('drive: V in the Drivable car goes immersive — chase camera, W accelerates, A / D steer, editor keys do nothing, Esc restores', async () => {
  const page = await newPage('&scene=car');
  const id = await chassisId(page);
  const before = await page.evaluate(() => ({
    mode: window.physicslab.cameraRig.mode,
    gizmo: window.physicslab.prefs.value.gizmo,
    tool: window.physicslab.prefs.value.tool,
    snap: window.physicslab.prefs.value.snap,
    selection: [...window.physicslab.store.selection],
    sim: window.physicslab.sim.mode,
  }));
  assert(before.sim === 'edit', 'the editor is in edit mode');
  assert(await visible(page, '.topbar'), 'the top bar is there');
  assert(await visible(page, '.tbtn.drive'), 'a Drive button sits next to Simulate');
  await page.evaluate(() => window.physicslab.viewport.dom.focus());
  const start = (await page.evaluate((id) => window.physicslab.store.body(id).position, id)).slice();
  await page.keyboard.press('KeyV');
  await page.waitForFunction(() => window.physicslab.immersive.kind === 'drive', null, { timeout: 30000 });
  assert(await page.evaluate(() => window.physicslab.sim.active), 'the simulation started');
  assert(await page.evaluate(() => document.body.classList.contains('immersive')), 'immersive class on the page');
  for (const sel of ['.topbar', 'aside.panel.left', 'aside.panel.right', '.toolbox', '.viewbar']) {
    assert(!(await visible(page, sel)), `${sel} is hidden in drive mode`);
  }
  assert(await visible(page, '.drv-hud'), 'the drive HUD is shown');
  assert(await visible(page, '.drv-exit'), 'with an always-visible Exit button');
  assert((await page.evaluate(() => window.physicslab.cameraRig.mode)) === 'chase', 'the chase camera');
  assert(
    (await page.evaluate(() => window.physicslab.store.selection.length)) === 0,
    'nothing is selected (no outline, no gizmo)',
  );
  assert((await page.evaluate(() => window.physicslab.contexts.current)) === 'drive', 'the drive context');
  const legend = await page.locator('.ctl-body').innerText();
  assert(/Drive forward/.test(legend) && /Steer left/.test(legend), `the legend lists the car's controls: ${legend}`);
  assert(/Exit drive mode/.test(legend), 'and how to leave');
  await page.waitForTimeout(600);
  // throttle: the car drives off
  await page.keyboard.down('KeyW');
  await simFor(page, 3);
  const mid = await pose(page, id);
  assert(mid.position[0] - start[0] > 2, `W accelerates the car (x ${start[0]} -> ${mid.position[0].toFixed(2)})`);
  const speed = await page.evaluate(() => window.physicslab.immersive.hud.speed);
  assert(speed > 5, `the speedometer reads ${speed.toFixed(1)} km/h`);
  assert(/\d/.test(await page.locator('.drv-speed-n').innerText()), 'and shows it');
  await shot(page, 'drive-chase-hud');
  // steering
  const z0 = (await pose(page, id)).position[2];
  await page.keyboard.down('KeyA');
  await simFor(page, 2);
  await page.keyboard.up('KeyA');
  const z1 = (await pose(page, id)).position[2];
  assert(Math.abs(z1 - z0) > 0.5, `A steers (z ${z0.toFixed(2)} -> ${z1.toFixed(2)})`);
  await page.keyboard.up('KeyW');
  // editor keys are locked: W above drove, these must change nothing
  for (const k of ['KeyE', 'KeyQ', 'KeyG', 'KeyH', 'KeyL', 'KeyJ', 'KeyF', 'KeyX']) await page.keyboard.press(k);
  const after = await page.evaluate(() => ({
    gizmo: window.physicslab.prefs.value.gizmo,
    tool: window.physicslab.prefs.value.tool,
    snap: window.physicslab.prefs.value.snap,
    n: window.physicslab.store.selection.length,
  }));
  assert(
    after.gizmo === before.gizmo && after.tool === before.tool && after.snap === before.snap,
    `editor shortcuts did nothing: ${JSON.stringify(after)}`,
  );
  assert(after.n === 0, 'and selected nothing');
  // picking is off: a click on the car selects nothing, a right-click opens no menu
  const sp = await screenOf(page, id);
  await page.mouse.click(sp.x, sp.y);
  await page.mouse.dblclick(sp.x, sp.y);
  await page.mouse.click(sp.x, sp.y, { button: 'right' });
  await nextFrame(page);
  assert(
    (await page.evaluate(() => window.physicslab.store.selection.length)) === 0,
    'clicking the car selects nothing',
  );
  assert((await page.locator('.menu').count()) === 0, 'no context menu in drive mode');
  // cameras: C cycles chase / cockpit / orbit
  await page.keyboard.press('KeyC');
  assert((await page.evaluate(() => window.physicslab.cameraRig.mode)) === 'fp', 'C: cockpit');
  await page.keyboard.press('KeyC');
  assert((await page.evaluate(() => window.physicslab.cameraRig.mode)) === 'tp', 'C: orbit around the vehicle');
  await page.keyboard.press('KeyC');
  assert((await page.evaluate(() => window.physicslab.cameraRig.mode)) === 'chase', 'C: back to chase');
  // look behind while B is held
  await page.keyboard.down('KeyB');
  assert(await page.evaluate(() => window.physicslab.cameraRig.lookBack), 'B looks behind');
  await page.keyboard.up('KeyB');
  assert(!(await page.evaluate(() => window.physicslab.cameraRig.lookBack)), 'and lets go');
  // a drag looks around and springs back
  const c = await page.evaluate(() => {
    const r = window.physicslab.viewport.dom.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 3 };
  });
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(c.x + i * 30, c.y);
  const off = await page.evaluate(() => window.physicslab.cameraRig.follow.yawOffset);
  assert(Math.abs(off) > 0.3, `dragging looks around (${off.toFixed(2)} rad)`);
  await page.mouse.up();
  await page.waitForFunction(() => Math.abs(window.physicslab.cameraRig.follow.yawOffset) < 0.05, null, {
    timeout: 15000,
  });
  // P pauses
  await page.keyboard.press('KeyP');
  assert((await page.evaluate(() => window.physicslab.sim.mode)) === 'paused', 'P pauses');
  await page.keyboard.press('KeyP');
  assert((await page.evaluate(() => window.physicslab.sim.mode)) === 'running', 'P resumes');
  // R when tilted: flip upright where it stands. Roll the whole car over 180 degrees about its forward axis, then press R.
  await page.evaluate((id) => {
    const a = window.physicslab;
    const pc = a.sim.poseOf(id).position;
    const mul = (a, b) => [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
    for (const bid of a.immersive.vehicle.bodyIds) {
      const q = a.sim.poseOf(bid);
      const p = q.position;
      a.sim.teleport(bid, [p[0], pc[1] + 1.5 - (p[1] - pc[1]), pc[2] - (p[2] - pc[2])], mul([1, 0, 0, 0], q.rotation));
    }
  }, id);
  await page.waitForFunction(() => window.physicslab.immersive.hud.tilted, null, { timeout: 30000 });
  await page.waitForFunction(() => /Tilted/.test(document.querySelector('.drv-note')?.innerText ?? ''), null, {
    timeout: 30000,
  });
  await shot(page, 'drive-tilted-note');
  const xTilted = (await pose(page, id)).position[0];
  await page.keyboard.press('KeyR');
  await page.waitForFunction(
    (id) => {
      const q = window.physicslab.sim.poseOf(id).rotation;
      const up = 1 - 2 * (q[0] * q[0] + q[2] * q[2]); // the chassis' up axis . world up
      return up > 0.8;
    },
    id,
    { timeout: 30000 },
  );
  assert(Math.abs((await pose(page, id)).position[0] - xTilted) < 12, 'a flip keeps the car where it stands');
  // R again, upright now: back to the start pose (the car creeps away from it at once, so look for "far from where it was")
  await page.waitForFunction(() => !window.physicslab.immersive.hud.tilted, null, { timeout: 30000 });
  const xBefore = (await pose(page, id)).position[0];
  await page.keyboard.press('KeyR');
  await page
    .waitForFunction(([id, x0]) => window.physicslab.sim.poseOf(id).position[0] < x0 - 8, [id, xBefore], {
      timeout: 30000,
    })
    .catch(() => {
      throw new Error(`assertion failed: R returns the upright car to its start pose (was at x=${xBefore.toFixed(1)})`);
    });
  // Esc leaves and restores
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.physicslab.immersive.kind === 'none', null, { timeout: 30000 });
  assert(await visible(page, '.topbar'), 'the top bar is back');
  assert(await visible(page, 'aside.panel.right'), 'the panels are back');
  const back = await page.evaluate(() => ({
    mode: window.physicslab.cameraRig.mode,
    sim: window.physicslab.sim.mode,
    cls: document.body.classList.contains('immersive'),
    ctx: window.physicslab.contexts.current,
    selection: [...window.physicslab.store.selection],
    ortho: window.physicslab.camera.ortho,
  }));
  assert(back.mode === before.mode, `camera mode restored (${back.mode})`);
  assert(back.sim === 'edit', `simulation state restored (${back.sim})`);
  assert(!back.cls && back.ctx === 'edit', `back to the edit context (${back.ctx})`);
  assert(JSON.stringify(back.selection) === JSON.stringify(before.selection), 'selection restored');
  // and the editor keys work again
  await page.evaluate(() => window.physicslab.viewport.dom.focus());
  await page.keyboard.press('KeyE');
  assert((await page.evaluate(() => window.physicslab.prefs.value.gizmo)) === 'rotate', 'E rotates the gizmo again');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

test('drive: Tab leaves too, from a paused simulation with a selection, and the camera comes back where it was', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(() => {
    const a = window.physicslab;
    a.prefs.set({ followSelection: false });
    a.viewport.setView({ position: [4, 3, 9], target: [0, 0.6, 0] });
    a.sim.play();
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const a = window.physicslab;
    a.sim.pause();
    a.store.setSelection([a.store.bodies()[1].id]);
    a.viewport.dom.focus();
  });
  const sel = await page.evaluate(() => [...window.physicslab.store.selection]);
  const cam0 = await page.evaluate(() => window.physicslab.camera.position.toArray());
  await page.keyboard.press('KeyV');
  await page.waitForFunction(() => window.physicslab.immersive.kind === 'drive');
  assert((await page.evaluate(() => window.physicslab.sim.mode)) === 'running', 'drive mode runs the simulation');
  await page.waitForTimeout(800);
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => window.physicslab.immersive.kind === 'none');
  assert((await page.evaluate(() => window.physicslab.sim.mode)) === 'paused', 'the paused state is restored');
  assert(
    JSON.stringify(await page.evaluate(() => [...window.physicslab.store.selection])) === JSON.stringify(sel),
    'selection restored',
  );
  await page.waitForFunction(
    (c0) => window.physicslab.camera.position.distanceTo({ x: c0[0], y: c0[1], z: c0[2] }) < 0.5,
    cam0,
    { timeout: 20000 },
  );
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

test('drive: V where there is nothing to drive says so; the palette has "Drive selected vehicle"', async () => {
  const page = await newPage('&scene=wreck');
  await page.evaluate(() => window.physicslab.viewport.dom.focus());
  await page.keyboard.press('KeyV');
  await page.waitForSelector('.toast, .toasts > *', { timeout: 30000 });
  assert(
    (await page.evaluate(() => window.physicslab.immersive.kind)) === 'none',
    'no immersive mode without a vehicle',
  );
  const txt = await page.locator('.toasts').innerText();
  assert(/No vehicle/.test(txt), `a toast explains: ${txt}`);
  await page.keyboard.press('Control+k');
  await page.fill('.palette-input', 'drive selected');
  await page.waitForSelector('.palette-row, .palette-item, [role=option]');
  const rows = await page.locator('[role=option], .palette-row, .palette-item').allInnerTexts();
  assert(
    rows.some((r) => /Drive selected vehicle/.test(r)),
    `the palette lists the command: ${rows.join(' | ')}`,
  );
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

test('drive: the powertrain car keeps its own keys (R reverse, P parking brake, C clutch, Q / E gears); utility keys move aside; rpm and gear show', async () => {
  const page = await newPage('&scene=powertrain-car');
  const id = await chassisId(page);
  await page.evaluate(() => {
    window.physicslab.prefs.set({ followSelection: false });
    window.physicslab.viewport.dom.focus();
  });
  const start = (await page.evaluate((id) => window.physicslab.store.body(id).position, id)).slice();
  await page.keyboard.press('KeyV');
  await page.waitForFunction(() => window.physicslab.immersive.kind === 'drive', null, { timeout: 30000 });
  const keys = await page.evaluate(() =>
    Object.fromEntries([...window.physicslab.immersive.driveKeys.entries()].map(([k, v]) => [v, k])),
  );
  assert(keys.reset === 'Backspace', `reset moved to Backspace (${JSON.stringify(keys)})`);
  assert(keys.pause === 'Enter' && keys.camera === 'KeyX', 'pause and camera moved too');
  const legend = await page.locator('.ctl-body').innerText();
  assert(/Throttle/i.test(legend) && /Backspace/.test(legend), `the legend shows the real keys: ${legend}`);
  await page.waitForTimeout(500);
  await page.keyboard.down('KeyW');
  await simFor(page, 4);
  const p1 = await pose(page, id);
  assert(p1.position[0] - start[0] > 3, `W drives the powertrain car (x ${start[0]} -> ${p1.position[0].toFixed(2)})`);
  const hud = await page.evaluate(() => ({ ...window.physicslab.immersive.hud }));
  assert(hud.rpm !== null && hud.rpm > 1200, `the HUD reads the engine (${hud.rpm} rpm)`);
  assert(hud.gear !== null && hud.gear >= 1, `and the gearbox (gear ${hud.gear})`);
  assert(/rpm/.test(await page.locator('.drv-aux').innerText()), 'both are shown');
  await shot(page, 'drive-powertrain-hud');
  // R is the car's reverse gear here: it must not teleport the car back
  await page.keyboard.up('KeyW');
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(400);
  const p2 = await pose(page, id);
  assert(p2.position[0] - start[0] > 2, 'R did not reset the car (it is the reverse gear)');
  // Backspace does (a flip when it has rolled over, the start pose otherwise: either way the key reached the reset)
  const resets0 = await page.evaluate(() => window.physicslab.immersive.resets);
  await page.keyboard.press('Backspace');
  await page
    .waitForFunction((n) => window.physicslab.immersive.resets > n, resets0, { timeout: 30000 })
    .catch(() => {
      throw new Error('assertion failed: Backspace resets the powertrain car');
    });
  await page.keyboard.press('Escape');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

test('drive: a gamepad trigger drives the car in drive mode (analog axes)', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(() => {
    window.__pad = {
      id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
      index: 0,
      connected: true,
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    };
    navigator.getGamepads = () => [window.__pad, null, null, null];
    window.physicslab.viewport.dom.focus();
  });
  const id = await chassisId(page);
  const start = (await page.evaluate((id) => window.physicslab.store.body(id).position, id)).slice();
  await page.keyboard.press('KeyV');
  await page.waitForFunction(() => window.physicslab.immersive.kind === 'drive');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    window.__pad.buttons[7] = { pressed: true, value: 1 };
  });
  await simFor(page, 3);
  const axes = await page.evaluate(() => ({ ...window.physicslab.sim.client.axes }));
  assert(axes.drive > 0.9, `the drive axis follows the right trigger ${JSON.stringify(axes)}`);
  const p = await pose(page, id);
  assert(
    p.position[0] - start[0] > 2,
    `the car moved under the trigger (x ${start[0]} -> ${p.position[0].toFixed(2)})`,
  );
  await page.evaluate(() => {
    window.__pad.buttons[7] = { pressed: false, value: 0 };
  });
  await page.close();
});

test('drive: on a touch screen the virtual sticks stay and drive the car', async () => {
  const page = await newTouchPage('&scene=car');
  await page.evaluate(() => {
    const a = window.physicslab;
    a.prefs.set({ followSelection: false });
  });
  const id = await chassisId(page);
  const start = (await page.evaluate((id) => window.physicslab.store.body(id).position, id)).slice();
  await page.evaluate(() => window.physicslab.immersive.enterDrive());
  await page.waitForFunction(() => window.physicslab.immersive.kind === 'drive');
  await page.waitForSelector('.tc-overlay:not([hidden])', { timeout: 30000 });
  assert(await visible(page, '.tc-overlay'), 'the touch controls are visible in drive mode');
  assert(await visible(page, '.drv-exit'), 'with the Exit button');
  const rt = await page.evaluate(() => {
    const b = document.querySelector('.tc-overlay [data-btn="RT"]');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ id: 1, x: rt.x, y: rt.y, radiusX: 8, radiusY: 8, force: 1 }],
  });
  await simFor(page, 3);
  const p = await pose(page, id);
  await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ id: 1, x: rt.x, y: rt.y }] });
  assert(
    p.position[0] - start[0] > 1.5,
    `RT on the touch overlay drives the car (x ${start[0]} -> ${p.position[0].toFixed(2)})`,
  );
  // the Exit button leaves
  await page.click('.drv-exit');
  await page.waitForFunction(() => window.physicslab.immersive.kind === 'none');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.closeAll();
});

test('play: the Play button puts you in the running scene — fly camera, grab and throw, no editor — and Esc restores it', async () => {
  const page = await newPage();
  const id = await page.evaluate(() => {
    const a = window.physicslab;
    a.newScene();
    const b = a.editor.addShape('sphere', [0, 0.5, 0], { material: { preset: 'rubber', density: 300 } });
    a.viewport.setView({ position: [0, 4, 9], target: [0, 1, 0] });
    a.prefs.set({ followSelection: false });
    a.store.setSelection([b.id]);
    return b.id;
  });
  assert(await visible(page, '.tbtn.play-mode'), 'a Play button is in the top bar');
  await page.click('.tbtn.play-mode');
  await page.waitForFunction(() => window.physicslab.immersive.kind === 'play', null, { timeout: 30000 });
  assert(await page.evaluate(() => window.physicslab.sim.active), 'the scene runs');
  assert(!(await visible(page, '.topbar')) && !(await visible(page, 'aside.panel.right')), 'the chrome is gone');
  assert((await page.evaluate(() => window.physicslab.cameraRig.mode)) === 'fly', 'a fly camera');
  assert((await page.evaluate(() => window.physicslab.contexts.current)) === 'play', 'the play context');
  assert((await page.evaluate(() => window.physicslab.store.selection.length)) === 0, 'nothing selected');
  await simFor(page, 0.8);
  // W flies forward (hold it until the camera has moved: frames can take seconds on a loaded machine)
  const p0 = await page.evaluate(() => window.physicslab.camera.position.toArray());
  await page.keyboard.down('KeyW');
  await page
    .waitForFunction((p0) => window.physicslab.camera.position.distanceTo({ x: p0[0], y: p0[1], z: p0[2] }) > 0.8, p0, {
      timeout: 30000,
    })
    .catch(() => {
      throw new Error('assertion failed: W flies');
    });
  await page.keyboard.up('KeyW');
  // editor keys are locked
  await page.keyboard.press('KeyG');
  await page.keyboard.press('KeyR');
  assert(
    (await page.evaluate(() => window.physicslab.prefs.value.gizmo)) !== 'scale',
    'R does not select the scale gizmo',
  );
  // grab the ball with the mouse, lift it, selection stays empty
  const sp = await screenOf(page, id);
  await page.mouse.move(sp.x, sp.y);
  await page.mouse.down();
  await page.mouse.move(sp.x, sp.y - 150, { steps: 10 });
  await page
    .waitForFunction((id) => window.physicslab.sim.poseOf(id).position[1] > 1.2, id, { timeout: 30000 })
    .catch(() => {
      throw new Error('assertion failed: the ball was lifted by the grab in play mode');
    });
  assert(
    (await page.evaluate(() => window.physicslab.contexts.current)) === 'play',
    'still the play context while holding',
  );
  await shot(page, 'play-mode-grab');
  await page.mouse.up();
  assert((await page.evaluate(() => window.physicslab.store.selection.length)) === 0, 'grabbing selected nothing');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.physicslab.immersive.kind === 'none');
  assert(await visible(page, '.topbar'), 'the editor is back');
  assert((await page.evaluate(() => window.physicslab.sim.mode)) === 'edit', 'in edit mode again');
  assert(
    JSON.stringify(await page.evaluate(() => [...window.physicslab.store.selection])) === JSON.stringify([id]),
    'the selection is restored',
  );
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});
