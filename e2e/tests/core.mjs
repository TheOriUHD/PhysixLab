/**
 * Core end-to-end tests: boot, editing, simulation, grabbing, joints, vehicles, example scenes,
 * persistence, overlays, live edits, tools, outliner and soft bodies.
 *
 * Every file in e2e/tests/*.mjs exports `tests`, an array of `{ name, fn }`; the runner (e2e/run.mjs)
 * discovers them automatically. `fn` is an async function that drives the app through the helpers in
 * ../helpers.mjs and throws (e.g. via `assert`) to fail; the runner closes every page afterwards.
 */
import { assert, near, newPage, pose, screenOf, shot, simTime, sleep } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('boots with a scene, canvas and no errors', async () => {
  const page = await newPage();
  const info = await page.evaluate(() => ({
    bodies: window.physixlab.store.bodies().length,
    canvas: !!document.querySelector('canvas.viewport-canvas'),
    name: window.physixlab.store.name,
  }));
  assert(info.canvas, 'canvas exists');
  assert(info.bodies > 5, 'default scene has bodies');
  await shot(page, '01-boot');
  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
});

test('add shapes with keyboard + palette, undo / redo', async () => {
  const page = await newPage('&scene=');
  await page.evaluate(() => window.physixlab.newScene());
  await page.waitForTimeout(200);
  await page.click('.viewport-canvas', { position: { x: 700, y: 400 } });
  await page.keyboard.press('1');
  await page.keyboard.press('Enter'); // a number key arms a ghost; Enter places it at the pointer
  await page.keyboard.press('2');
  await page.keyboard.press('Enter');
  await page.dblclick('.tile:has-text("Cylinder")'); // a double-click adds at the view centre at once
  let n = await page.evaluate(() => window.physixlab.store.bodies().length);
  assert(n === 3, `three bodies added (got ${n})`);
  const types = await page.evaluate(() => window.physixlab.store.bodies().map((b) => b.shape.type));
  assert(types.join() === 'box,sphere,cylinder', `shape order ${types}`);
  await page.keyboard.press('Control+z');
  n = await page.evaluate(() => window.physixlab.store.bodies().length);
  assert(n === 2, 'undo removes last shape');
  await page.keyboard.press('Control+Shift+z');
  n = await page.evaluate(() => window.physixlab.store.bodies().length);
  assert(n === 3, 'redo restores it');
  await shot(page, '02-shapes');
});

test('click selects, inspector edits density and undo reverts', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    a.editor.addShape('box', [0, 0.5, 0]);
    a.store.setSelection([]);
  });
  await page.evaluate(() => window.physixlab.viewport.setView({ position: [4, 3, 5], target: [0, 0.5, 0] }));
  await page.waitForTimeout(300);
  const id = await page.evaluate(() => window.physixlab.store.bodies()[0].id);
  const sp = await screenOf(page, id);
  await page.mouse.click(sp.x, sp.y);
  const sel = await page.evaluate(() => window.physixlab.store.selection.slice());
  assert(sel.length === 1 && sel[0] === id, 'clicking the body selects it');
  await page.waitForSelector('.panel.right .section-head:has-text("Physics")');
  // type a new friction value
  const before = await page.evaluate((id) => window.physixlab.store.body(id).material.friction, id);
  const field = page.locator('.panel.right .row:has(.row-label:text-is("Friction")) .num-input:visible');
  await field.fill('0.9');
  await field.press('Enter');
  const after = await page.evaluate((id) => window.physixlab.store.body(id).material.friction, id);
  near(after, 0.9, 1e-6, 'friction edited through the inspector');
  const preset = await page.evaluate((id) => window.physixlab.store.body(id).material.preset, id);
  assert(preset === 'custom', 'editing a property switches the preset to custom');
  await page
    .locator('body')
    .click({ position: { x: 5, y: 5 } })
    .catch(() => {});
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate((id) => window.physixlab.store.body(id).material.friction, id);
  near(undone, before, 1e-6, 'undo restores friction');
  await shot(page, '03-inspector');
});

test('simulation: a dropped box falls, settles on the ground, reset restores it', async () => {
  const page = await newPage();
  const id = await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    return a.editor.addShape('box', [0, 4, 0]).id;
  });
  await page.keyboard.press('Space');
  await simTime(page, 2.2);
  const p = await pose(page, id);
  near(p.position[1], 0.5, 0.06, 'box rests on the ground');
  const mode = await page.evaluate(() => window.physixlab.sim.mode);
  assert(mode === 'running', 'simulation is running');
  await page.keyboard.press('Space');
  assert((await page.evaluate(() => window.physixlab.sim.mode)) === 'paused', 'space pauses');
  const t1 = await page.evaluate(() => window.physixlab.sim.client.stats.simTime);
  await page.click('.tbtn[title^="Advance"]');
  await page.waitForFunction((t) => window.physixlab.sim.client.stats.simTime > t, t1, { timeout: 30000 });
  const t2 = await page.evaluate(() => window.physixlab.sim.client.stats.simTime);
  assert(t2 > t1 && t2 - t1 < 0.05, `single step advances by one fixed step (${t2 - t1})`);
  await page.click('.tbtn[title^="Stop"]');
  const back = await pose(page, id);
  near(back.position[1], 4, 1e-6, 'reset returns to the authored layout');
  assert((await page.evaluate(() => window.physixlab.sim.mode)) === 'edit', 'back to edit mode');
});

test('grabbing and throwing a body while the simulation runs', async () => {
  const page = await newPage();
  const id = await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    const b = a.editor.addShape('sphere', [0, 0.5, 0], { material: { preset: 'rubber', density: 300 } });
    a.viewport.setView({ position: [0, 4, 9], target: [0, 1, 0] });
    return b.id;
  });
  await page.keyboard.press('Space');
  await simTime(page, 0.8);
  await page.waitForTimeout(200);
  const sp = await screenOf(page, id);
  await page.mouse.move(sp.x, sp.y);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) {
    await page.mouse.move(sp.x + i * 14, sp.y - i * 10);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(500);
  const held = await pose(page, id);
  assert(held.position[1] > 1.2, `ball was lifted by the grab (y=${held.position[1].toFixed(2)})`);
  assert(held.position[0] > 0.8, `ball followed the cursor in x (x=${held.position[0].toFixed(2)})`);
  await shot(page, '05-grab');
  await page.mouse.up();
});

test('joint tool: connect two bodies with a hinge and edit its motor', async () => {
  const page = await newPage();
  const ids = await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    const p = a.editor.addShape('box', [-1.3, 1, 0], { bodyType: 'static', name: 'Post' });
    const q = a.editor.addShape('box', [0.4, 1, 0], { name: 'Arm', material: { preset: 'foam', density: 20 } });
    a.store.setSelection([]);
    a.viewport.setView({ position: [0, 2, 8], target: [-0.4, 1, 0] });
    return [p.id, q.id];
  });
  await page.waitForTimeout(300);
  await page.keyboard.press('j');
  const a = await screenOf(page, ids[0]);
  const b = await screenOf(page, ids[1]);
  await page.mouse.click(a.x + 20, a.y);
  await page.mouse.click(b.x, b.y);
  const j = await page.evaluate(() =>
    window.physixlab.store.joints().map((j) => ({ type: j.type, a: j.bodyA, b: j.bodyB })),
  );
  assert(j.length === 1 && j[0].type === 'hinge', `one hinge created (${JSON.stringify(j)})`);
  assert(j[0].a === ids[0] && j[0].b === ids[1], 'joint connects the two clicked bodies');
  const sel = await page.evaluate(() => window.physixlab.store.selection.length);
  assert(sel === 1, 'new joint is selected');
  // enable a velocity motor in the inspector
  await page.waitForSelector('.panel.right .section-head:has-text("Motor")');
  await page.click('.panel.right .seg-btn:has-text("Velocity")');
  const mode = await page.evaluate(() => window.physixlab.store.joints()[0].motor.mode);
  assert(mode === 'velocity', 'motor mode set from the inspector');
  await shot(page, '06-joint');
  // run it: the arm should rotate around the hinge (sample the speed while it swings)
  await page.keyboard.press('Space');
  let fastest = 0;
  for (let i = 0; i < 12; i++) {
    await sleep(100);
    const sp = await page.evaluate(() => {
      const a = window.physixlab;
      const j = a.store.joints()[0];
      const st = a.liveJoint(j.id);
      return st ? Math.abs(st.speed) : 0;
    });
    fastest = Math.max(fastest, sp);
  }
  assert(fastest > 1, `hinge motor turned the arm (peak ${fastest.toFixed(2)} rad/s)`);
});

test('drive the car with the keyboard (motors bound to W/A/S/D)', async () => {
  const page = await newPage('&scene=car');
  const id = await page.evaluate(() => window.physixlab.store.bodies().find((b) => b.name === 'Chassis').id);
  await page.keyboard.press('Space');
  await simTime(page, 1.2);
  const p0 = await pose(page, id);
  await page.keyboard.down('KeyW');
  await simTime(page, 3.4);
  await page.keyboard.up('KeyW');
  const p1 = await pose(page, id);
  assert(p1.position[0] - p0.position[0] > 3, `car drove forward (${(p1.position[0] - p0.position[0]).toFixed(1)} m)`);
  await shot(page, '07-car');
});

test('example scenes load from the Scenes tab and simulate', async () => {
  const page = await newPage();
  await page.click('.tab:has-text("Scenes")');
  await page.click('.card:has-text("Newton")');
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => ({
    name: window.physixlab.store.name,
    bodies: window.physixlab.store.bodies().length,
    joints: window.physixlab.store.joints().length,
  }));
  assert(/Newton/.test(info.name) && info.bodies >= 5 && info.joints >= 10, `cradle loaded ${JSON.stringify(info)}`);
  await page.keyboard.press('Space');
  await simTime(page, 1.5);
  const e = await page.evaluate(() => window.physixlab.sim.client.stats.energy);
  assert(e.kinetic > 1 && e.potential > 1, 'telemetry reports kinetic and potential energy');
  await shot(page, '08-cradle');
});

test('save → export → import round trip and share link', async () => {
  const page = await newPage();
  const res = await page.evaluate(async () => {
    const a = window.physixlab;
    a.loadTemplate('jenga');
    const before = a.store.toDocument();
    const url = await a.persistence.shareLink();
    const { Persistence } = await import('/src/app/persistence.ts');
    const back = await Persistence.fromHash(new URL(url).hash);
    return { n0: before.entities.length, n1: back ? back.entities.length : -1, name: back?.name, urlLen: url.length };
  });
  assert(res.n0 === res.n1 && res.n0 > 40, `share link restores all entities (${res.n0} vs ${res.n1})`);
  assert(res.urlLen < 20000, `share link is reasonably small (${res.urlLen})`);
});

test('overlays, colour modes and trails render without errors while simulating', async () => {
  const page = await newPage('&scene=billiards');
  await page.evaluate(() => {
    const a = window.physixlab;
    a.prefs.set({ colorMode: 'speed' });
    a.prefs.setOverlay({ velocity: true, force: true, contacts: true, com: true, trails: 'all' });
  });
  await page.keyboard.press('Space');
  await simTime(page, 2);
  await shot(page, '09-overlays');
  const live = await page.evaluate(() => {
    const a = window.physixlab;
    return { tr: a.overlays.options.trails, frames: a.sim.client.frameNo };
  });
  assert(live.frames > 3 && live.tr === 'all', 'frames are flowing with overlays enabled');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('live edits while running: change gravity and add a body', async () => {
  const page = await newPage();
  const id = await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    return a.editor.addShape('sphere', [0, 6, 0]).id;
  });
  await page.evaluate(() => window.physixlab.store.updateSettings({ gravity: [0, 0, 0] }));
  await page.keyboard.press('Space');
  await simTime(page, 1);
  const hovering = await pose(page, id);
  near(hovering.position[1], 6, 0.05, 'zero gravity: the sphere does not fall');
  await page.evaluate(() => window.physixlab.store.updateSettings({ gravity: [0, -9.81, 0] }));
  await simTime(page, 2);
  const falling = await pose(page, id);
  assert(falling.position[1] < 5.2, 'gravity switched on live');
  const added = await page.evaluate(() => {
    const a = window.physixlab;
    return a.editor.addShape('box', [2, 3, 0]).id;
  });
  await simTime(page, 3.2);
  const nb = await pose(page, added);
  assert(nb && nb.position[1] < 2.6, 'a body added during the simulation joins it');
  await page.keyboard.press('Shift+Space');
  const gone = await page.evaluate(() => window.physixlab.store.bodies().length);
  assert(gone === 2, 'both bodies remain in the document after reset');
});

test('measure tool, blast and projectile tools', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    a.editor.addShape('box', [0, 0.5, 0]);
    a.viewport.setView({ position: [0, 3, 8], target: [0, 0.5, 0] });
  });
  await page.keyboard.press('m');
  await page.mouse.click(700, 500);
  await page.mouse.click(900, 500);
  const m = await page.evaluate(() => {
    const a = window.physixlab;
    return a.measure && a.measure.b ? a.measure.a.distanceTo(a.measure.b) : -1;
  });
  assert(m > 0.3, `measured a distance (${m})`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Space');
  await simTime(page, 0.4);
  await page.keyboard.press('t');
  await page.mouse.click(700, 450);
  await page.waitForTimeout(300);
  const eph = await page.evaluate(() => window.physixlab.sim.ephemeral.size);
  assert(eph === 1, 'a projectile was spawned');
  await page.keyboard.press('b');
  await page.mouse.click(800, 520);
  await page.keyboard.press('Shift+Space');
  const after = await page.evaluate(() => ({
    eph: window.physixlab.sim.ephemeral.size,
    bodies: window.physixlab.store.bodies().length,
  }));
  assert(after.eph === 0 && after.bodies === 1, 'projectiles vanish on reset; the document is untouched');
});

test('outliner, rename, lock/hide and delete', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    a.editor.addShape('box', [0, 0.5, 0], { name: 'Alpha' });
    a.editor.addShape('sphere', [2, 0.5, 0], { name: 'Beta' });
    a.store.setSelection([]);
  });
  await page.click('.tab:has-text("Outliner")');
  assert((await page.locator('.o-item').count()) === 2, 'two outliner rows');
  await page.locator('.o-item:has-text("Beta")').click();
  assert((await page.evaluate(() => window.physixlab.store.selectedBodies()[0].name)) === 'Beta', 'row click selects');
  await page.keyboard.press('h');
  assert(
    (await page.evaluate(() => window.physixlab.store.bodies().find((b) => b.name === 'Beta').hidden)) === true,
    'H hides',
  );
  await page.keyboard.press('Delete');
  assert((await page.evaluate(() => window.physixlab.store.bodies().length)) === 1, 'Delete removes the selection');
  await page.keyboard.press('Control+z');
  assert((await page.evaluate(() => window.physixlab.store.bodies().length)) === 2, 'undo brings it back');
});

test('soft bodies: add from the palette, edit in the inspector, simulate and grab', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    a.viewport.setView({ position: [0, 3, 7], target: [0, 1, 0] });
  });
  await page.dblclick('.tile:has-text("Jelly")');
  const soft = await page.evaluate(() =>
    window.physixlab.store.softs().map((s) => ({ id: s.id, type: s.type, pos: s.position })),
  );
  assert(soft.length === 1 && soft[0].type === 'jelly', 'jelly added from the palette');
  await page.evaluate((id) => {
    const a = window.physixlab;
    a.store.updateMany([[id, { position: [0, 2.2, 0] }]]);
    a.store.setSelection([id]);
  }, soft[0].id);
  await page.waitForSelector('.panel.right .section-head:has-text("Soft body")');
  const field = page.locator('.panel.right .row:has(.row-label:text-is("Mass")) .num-input:visible').first();
  await field.fill('12');
  await field.press('Enter');
  const mass = await page.evaluate((id) => window.physixlab.store.soft(id).mass, soft[0].id);
  near(mass, 12, 1e-6, 'soft-body mass edited in the inspector');
  await shot(page, '10-soft-inspector');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (window.physixlab.sim.client.stats?.simTime ?? 0) > 1.6, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const top = () =>
    page.evaluate((id) => {
      const p = window.physixlab.sim.client.softOf(id);
      let hi = -1e9;
      for (let i = 1; i < p.length; i += 3) hi = Math.max(hi, p[i]);
      return hi;
    }, soft[0].id);
  const rest = await top();
  assert(rest < 1.2, `jelly settled on the ground (top at ${rest.toFixed(2)} m)`);
  // grab the jelly by its centre and drag it upward
  const sp = await page.evaluate((id) => {
    const a = window.physixlab;
    const p = a.sim.client.softOf(id);
    let x = 0,
      y = 0,
      z = 0;
    const n = p.length / 3;
    for (let i = 0; i < p.length; i += 3) {
      x += p[i];
      y += p[i + 1];
      z += p[i + 2];
    }
    const v = new a.camera.position.constructor(x / n, y / n + 0.3, z / n).project(a.camera);
    const r = a.viewport.dom.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }, soft[0].id);
  await page.mouse.move(sp.x, sp.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(sp.x, sp.y - i * 18);
    await page.waitForTimeout(60);
  }
  let lifted = await top();
  for (let i = 0; i < 40 && lifted < rest + 0.5; i++) {
    await sleep(150);
    lifted = await top();
  }
  assert(lifted > rest + 0.4, `dragging stretched / lifted the jelly (top ${rest.toFixed(2)} → ${lifted.toFixed(2)})`);
  await shot(page, '11-soft-grab');
  await page.mouse.up();
  await page.keyboard.press('Shift+Space');
  assert(
    (await page.evaluate(() => window.physixlab.store.softs().length)) === 1,
    'the soft body is still in the document after reset',
  );
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('soft-body scenes (jelly, cloth, tearing banner) render and simulate', async () => {
  const page = await newPage();
  for (const id of ['jelly', 'cloth', 'banner']) {
    await page.evaluate((id) => {
      window.physixlab.sim.reset();
      window.physixlab.loadTemplate(id);
    }, id);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => (window.physixlab.sim.client.stats?.simTime ?? 0) > 1.2, null, {
      timeout: 60000,
    });
    const parts = await page.evaluate(() => window.physixlab.sim.client.stats.particles);
    assert(parts > 300, `${id}: soft particles are simulated (${parts})`);
    await shot(page, `12-${id}`);
    await page.keyboard.press('Shift+Space');
  }
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('every example scene loads and runs for a moment without errors', async () => {
  const page = await newPage();
  const ids = await page.evaluate(async () =>
    (await import('/src/model/content/index.ts')).listTemplates().map((t) => t.id),
  );
  for (const id of ids) {
    await page.evaluate((id) => {
      window.physixlab.sim.reset();
      window.physixlab.loadTemplate(id);
    }, id);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => (window.physixlab.sim.client.stats?.simTime ?? 0) > 0.25, null, {
      timeout: 30000,
    });
    await page.keyboard.press('Shift+Space');
  }
  assert(page.errors.length === 0, `no errors across ${ids.length} scenes: ${page.errors.slice(0, 3).join(' | ')}`);
});
