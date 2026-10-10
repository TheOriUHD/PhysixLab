/**
 * End-to-end tests of the joint tool (JT-21) and the joint handles (JT-20) with real mouse input: anchors placed on
 * the exact picked surface point, snapping to a face centre / corner with its marker and label, the options bar,
 * chain mode (three bodies, one undo step) and dragging the anchor / axis handles of a selected joint.
 */
import { assert, near, newPage, nextFrame, shot } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** Client-space position of a world point (waits for a fresh frame so the camera is current). */
const screenPoint = async (page, world) => {
  await nextFrame(page);
  return page.evaluate((w) => {
    const a = window.physicslab;
    const v = new a.camera.position.constructor(...w).project(a.camera);
    const r = a.viewport.dom.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }, world);
};

/** Three 1 m crates in a row, camera above them; returns their ids. */
const setup = async (page) =>
  page.evaluate(() => {
    const a = window.physicslab;
    a.newScene();
    const ids = [-3, 0, 3].map((x, i) => a.editor.addShape('box', [x, 0.5, 0], { name: `Crate ${i + 1}`, bodyType: 'static' }).id);
    a.viewport.setView({ position: [0, 7, 7], target: [0, 0.5, 0] });
    a.store.setSelection([]);
    a.prefs.set({ jointType: 'hinge', jointAxis: 'auto', jointLimit: 'off', jointSnap: false, jointChain: false });
    return ids;
  });

const click = async (page, world) => {
  const p = await screenPoint(page, world);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(60);
};

const joints = (page) => page.evaluate(() => window.physicslab.store.all().filter((e) => e.kind === 'joint'));

test('joint tool: anchors sit on the exact picked surface point, axis from the face normal, options bar shown', async () => {
  const page = await newPage();
  const ids = await setup(page);
  await page.evaluate(() => window.physicslab.setTool('joint'));
  await page.waitForTimeout(100);
  assert(await page.isVisible('.joint-options'), 'options bar is visible with the joint tool');
  assert((await page.locator('.joint-options select').first().inputValue()) === 'hinge', 'type select shows hinge');
  await click(page, [-3 + 0.3, 1, 0.2]);
  await click(page, [0 - 0.2, 1, -0.25]);
  const js = await joints(page);
  assert(js.length === 1, `one joint created (${js.length})`);
  const j = js[0];
  assert(j.bodyA === ids[0] && j.bodyB === ids[1], 'joint connects crate 1 and crate 2');
  near(j.anchorA[0], 0.3, 0.06, 'anchor A x on the picked point');
  near(j.anchorA[1], 0.5, 0.02, 'anchor A y on the top face');
  near(j.anchorA[2], 0.2, 0.06, 'anchor A z on the picked point');
  assert(j.axis[1] > 0.99, `axis follows the top face normal (${j.axis})`);
  assert(await page.evaluate(() => window.physicslab.prefs.value.tool === 'select'), 'tool returns to select');
  await shot(page, 'jointtool-placed');
  await page.close();
});

test('joint tool: snaps to a face centre and a corner, shows the marker and its label', async () => {
  const page = await newPage();
  const ids = await setup(page);
  await page.evaluate(() => {
    const a = window.physicslab;
    a.prefs.set({ jointSnap: true, jointType: 'spring' });
    a.setTool('joint');
  });
  // near the middle of crate 2's top face (about 6 px off): the anchor lands on the face centre
  const near1 = await screenPoint(page, [0.04, 1, 0.03]);
  await page.mouse.move(near1.x, near1.y);
  await page.waitForTimeout(150);
  const label = await page.evaluate(() => document.querySelector('.v-label.joint-snap')?.textContent ?? '');
  assert(label === 'Face centre', `snap label says Face centre (${label})`);
  await shot(page, 'jointtool-snap-face');
  await page.mouse.click(near1.x, near1.y);
  // second click near a top corner of crate 3
  const corner = await screenPoint(page, [3 + 0.46, 1, 0.46]);
  await page.mouse.move(corner.x - 3, corner.y + 2);
  await page.waitForTimeout(150);
  const label2 = await page.evaluate(() => document.querySelector('.v-label.joint-snap')?.textContent ?? '');
  assert(label2 === 'Vertex', `snap label says Vertex (${label2})`);
  await shot(page, 'jointtool-snap-corner');
  await page.mouse.click(corner.x - 3, corner.y + 2);
  const js = await joints(page);
  assert(js.length === 1, 'spring created');
  const j = js[0];
  assert(j.bodyA === ids[1] && j.bodyB === ids[2], 'joint connects crate 2 and crate 3');
  near(j.anchorA[0], 0, 1e-6, 'anchor A x = face centre');
  near(j.anchorA[1], 0.5, 1e-6, 'anchor A y = face centre');
  near(j.anchorA[2], 0, 1e-6, 'anchor A z = face centre');
  near(Math.abs(j.anchorB[0]), 0.5, 1e-6, 'anchor B x = corner');
  near(j.anchorB[1], 0.5, 1e-6, 'anchor B y = corner');
  near(Math.abs(j.anchorB[2]), 0.5, 1e-6, 'anchor B z = corner');
  await page.close();
});

test('joint tool: chain mode joins three bodies in sequence and undoes as one step', async () => {
  const page = await newPage();
  const ids = await setup(page);
  await page.evaluate(() => {
    const a = window.physicslab;
    a.prefs.set({ jointChain: true, jointType: 'hinge', jointSnap: true });
    a.setTool('joint');
  });
  await page.waitForTimeout(100);
  const pressed = await page.getAttribute('.joint-options button[aria-label^="Chain mode"]', 'aria-pressed');
  assert(pressed === 'true', 'the Chain toggle is pressed');
  const undoBefore = await page.evaluate(() => window.physicslab.store.undoDepth);
  await click(page, [-3, 1, 0]);
  await click(page, [0, 1, 0]);
  await page.mouse.move(100, 300);
  await click(page, [3, 1, 0]);
  const mid = await page.evaluate(() => window.physicslab.prefs.value.tool);
  assert(mid === 'joint', 'the tool stays active while chaining');
  const rubber = await screenPoint(page, [3, 3, 1]);
  await page.mouse.move(rubber.x, rubber.y);
  await page.waitForTimeout(100);
  await shot(page, 'jointtool-chain');
  await page.keyboard.press('Enter');
  const js = await joints(page);
  assert(js.length === 2, `two joints in the chain (${js.length})`);
  assert(js[0].bodyA === ids[0] && js[0].bodyB === ids[1] && js[1].bodyA === ids[1] && js[1].bodyB === ids[2], 'joints follow the click order');
  const depth = await page.evaluate(() => window.physicslab.store.undoDepth);
  assert(depth === undoBefore + 1, `the chain is one undo step (${undoBefore} -> ${depth})`);
  assert((await page.evaluate(() => window.physicslab.prefs.value.tool)) === 'select', 'Enter ends the chain and returns to select');
  await page.evaluate(() => window.physicslab.store.undo());
  assert((await joints(page)).length === 0, 'one undo removes the whole chain');
  await page.close();
});

test('joint handles: dragging the anchor handle and the axis handle edits the joint, one undo step each', async () => {
  const page = await newPage();
  const ids = await setup(page);
  const id = await page.evaluate(([a, b]) => {
    const w = window.physicslab;
    const j = w.editor.addJoint('hinge', { body: a, point: [-3, 1, 0] }, { body: b, point: [0, 1, 0] }, [0, 1, 0]);
    w.store.setSelection([j.id]);
    return j.id;
  }, [ids[0], ids[1]]);
  await page.waitForTimeout(150);
  await shot(page, 'jointhandles-selected');
  // --- anchor: drag the handle at the anchor (world -3, 1, 0) to the top face of crate 1, off-centre
  const a0 = await screenPoint(page, [-3, 1, 0]);
  const dest = await screenPoint(page, [-3 + 0.35, 1, 0.3]);
  const depth0 = await page.evaluate(() => window.physicslab.store.undoDepth);
  await page.mouse.move(a0.x, a0.y);
  await page.waitForTimeout(80);
  assert(await page.evaluate(() => window.physicslab.viewport.dom.classList.contains('joint-handle-hover')), 'handle shows the grab cursor on hover');
  await page.mouse.down();
  await page.mouse.move((a0.x + dest.x) / 2, (a0.y + dest.y) / 2, { steps: 3 });
  await page.mouse.move(dest.x, dest.y, { steps: 3 });
  await page.mouse.up();
  let j = (await joints(page))[0];
  near(j.anchorA[0], 0.35, 0.08, 'anchor A x followed the handle');
  near(j.anchorA[2], 0.3, 0.08, 'anchor A z followed the handle');
  near(j.anchorA[1], 0.5, 0.02, 'anchor A stays on the surface');
  assert((await page.evaluate(() => window.physicslab.store.undoDepth)) === depth0 + 1, 'anchor drag is one undo step');
  assert(await page.evaluate((id) => window.physicslab.store.selection[0] === id, id), 'selection unchanged by the handle drag');
  await shot(page, 'jointhandles-anchor-moved');
  // --- axis: the tip handle is 96 px from the anchor along the axis; drag it toward world +X
  const geo = await page.evaluate(() => {
    const w = window.physicslab;
    const cam = w.camera;
    const a = w.store.joint(w.store.selection[0]);
    const body = w.sim.poseOf(a.bodyA);
    const anchor = new cam.position.constructor(...a.anchorA).add(new cam.position.constructor(...body.position));
    const mpp = (2 * cam.position.distanceTo(anchor) * Math.tan((cam.fov * Math.PI) / 360)) / w.viewport.dom.clientHeight;
    return { anchor: anchor.toArray(), len: 96 * mpp };
  });
  const tip = await screenPoint(page, [geo.anchor[0], geo.anchor[1] + geo.len, geo.anchor[2]]);
  const toX = await screenPoint(page, [geo.anchor[0] + geo.len, geo.anchor[1], geo.anchor[2]]);
  await page.mouse.move(tip.x, tip.y);
  await page.waitForTimeout(80);
  const depth1 = await page.evaluate(() => window.physicslab.store.undoDepth);
  await page.mouse.down();
  await page.mouse.move((tip.x + toX.x) / 2, (tip.y + toX.y) / 2, { steps: 4 });
  await page.mouse.move(toX.x, toX.y, { steps: 4 });
  await shot(page, 'jointhandles-axis-drag');
  await page.mouse.up();
  j = (await joints(page))[0];
  assert(Math.abs(Math.hypot(...j.axis) - 1) < 1e-6, 'axis stays a unit vector');
  assert(j.axis[0] > 0.95, `axis turned toward world +X (${j.axis.map((v) => v.toFixed(2))})`);
  assert((await page.evaluate(() => window.physicslab.store.undoDepth)) === depth1 + 1, 'axis drag is one undo step');
  // the handles hide while simulating
  await page.evaluate(() => window.physicslab.sim.play());
  await page.waitForTimeout(200);
  const hiddenInSim = await page.evaluate(() => {
    const g = window.physicslab.viewport.helpers.children.find((c) => c.isGroup && c.children.length === 6);
    return !g || !g.visible;
  });
  assert(hiddenInSim, 'handles are hidden while the simulation runs');
  assert(page.errors.length === 0, `no page errors: ${page.errors.join(' | ')}`);
  await page.close();
});
