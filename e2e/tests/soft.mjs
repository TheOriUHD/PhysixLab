/**
 * SF end-to-end tests: the attach tool (a cable hangs a box), the cutting tool (a hanging cloth is cut by dragging)
 * and the rope tool (a rope between a body and the ground), all driven through real mouse input.
 */
import { assert, newPage, nextFrame, shot, simTime } from '../helpers.mjs';

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

const click = async (page, world) => {
  const p = await screenPoint(page, world);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(150);
};

const setup = (page, build) =>
  page.evaluate((src) => {
    const a = window.physicslab;
    a.newScene();
    a.viewport.setView({ position: [0, 3.5, 10], target: [0, 3, 0] });
    a.store.setSelection([]);
    return new Function('a', `return (${src})(a)`)(a);
  }, build.toString());

test('soft attach: a cable pinned at the top hangs a box fastened with two real tool clicks', async () => {
  const page = await newPage();
  const ids = await setup(page, (a) => {
    // vertical cable, top end pinned in space, bottom end at y = 2.5
    const cable = a.editor.addSoft('cable', [0, 4, 0], {
      size: [3, 0, 0],
      rotation: [0, 0, -Math.SQRT1_2, Math.SQRT1_2],
      resolution: 16,
      pin: 'one-end',
    });
    const box = a.editor.addShape('box', [0, 2.2, 0], {
      shape: { type: 'box', size: [0.6, 0.6, 0.6] },
      material: { preset: 'custom', density: 30, friction: 0.5, restitution: 0.1, color: '#5c9dff' },
    });
    a.store.setSelection([]);
    return { cable: cable.id, box: box.id };
  });
  await page.evaluate(() => window.physicslab.setTool('softattach'));
  await page.waitForTimeout(100);
  const hint = await page.evaluate(() => document.body.innerText);
  assert(/click the point of the cloth/i.test(hint), 'the first-step hint is shown');
  await click(page, [0, 2.75, 0]); // the cable, just above the box
  const hint2 = await page.evaluate(() => document.body.innerText);
  assert(/rigid body/i.test(hint2), 'the second-step hint is shown');
  await shot(page, 'sf-attach-pending');
  await click(page, [0, 2.2, 0]); // the box
  const att = await page.evaluate((id) => window.physicslab.store.soft(id).attachments, ids.cable);
  assert(
    att.length === 1 && att[0].body === ids.box && att[0].kind === 'region',
    `one attachment (${JSON.stringify(att)})`,
  );
  assert(att[0].offset[1] > 0.2 && att[0].offset[1] < 0.6, `offset is body-local above the box (${att[0].offset})`);
  const tool = await page.evaluate(() => window.physicslab.prefs.value.tool);
  assert(tool === 'select', 'the tool returns to select');
  // one undo step
  await page.evaluate(() => window.physicslab.store.undo());
  const none = await page.evaluate((id) => window.physicslab.store.soft(id).attachments.length, ids.cable);
  assert(none === 0, 'a single undo removes the attachment');
  await page.evaluate(() => window.physicslab.store.redo());
  await page.evaluate(() => window.physicslab.sim.play());
  await simTime(page, 2);
  const y = await page.evaluate((id) => window.physicslab.sim.poseOf(id).position[1], ids.box);
  assert(y > 1.8, `the box hangs from the cable instead of falling to the ground (y = ${y})`);
  await shot(page, 'sf-attach-hanging');
  await page.close();
});

test('soft cut: dragging the cut tool across a hanging cloth tears it into pieces', async () => {
  const page = await newPage();
  const id = await setup(page, (a) => {
    const cloth = a.editor.addSoft('cloth', [0, 4, 0], {
      size: [2.4, 0, 2.4],
      resolution: 14,
      rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
      pin: 'edge',
    });
    a.store.setSelection([]);
    return cloth.id;
  });
  await page.evaluate(() => window.physicslab.setTool('softcut'));
  // not simulating: an honest hint, and a drag does nothing
  const idleHint = await page.evaluate(() => document.body.innerText);
  assert(/Press\s+Space to start the simulation, then drag across the cloth to cut it/i.test(idleHint), 'idle hint');
  await page.evaluate(() => window.physicslab.sim.play());
  await simTime(page, 0.6);
  const count = () =>
    page.evaluate((id) => window.physicslab.sim.client.softLayout.find((l) => l.id === id)?.count ?? 0, id);
  const before = await count();
  assert(before > 0, 'cloth particles are live');
  const a = await screenPoint(page, [-1.8, 3.2, 0]);
  const b = await screenPoint(page, [1.8, 3.2, 0]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  const overlay = await page.evaluate(() => !!document.querySelector('.sf-cut-line'));
  assert(overlay, 'the overlay line is drawn while dragging');
  await shot(page, 'sf-cut-drag');
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(
    ([id, n]) => (window.physicslab.sim.client.softLayout.find((l) => l.id === id)?.count ?? 0) > n,
    [id, before],
    { timeout: 20000 },
  );
  const after = await count();
  assert(after > before, `the cut duplicated particles along the seam (${before} -> ${after})`);
  assert(await page.evaluate(() => !document.querySelector('.sf-cut-line')), 'the overlay is removed on release');
  await simTime(page, 1.8);
  await shot(page, 'sf-cut-after');
  await page.close();
});

test('soft rope: two clicks (box, ground) add the links and joints as one undo step', async () => {
  const page = await newPage();
  const { box } = await setup(page, (a) => {
    const box = a.editor.addShape('box', [0, 3, 0], {
      bodyType: 'static',
      shape: { type: 'box', size: [1, 1, 1] },
    });
    a.store.setSelection([]);
    return { box: box.id };
  });
  const n0 = await page.evaluate(() => [
    window.physicslab.store.bodies().length,
    window.physicslab.store.joints().length,
  ]);
  await page.evaluate(() => window.physicslab.setTool('softrope'));
  await click(page, [0, 3, 0.5]); // the front face of the box (z = 0.5)
  await shot(page, 'sf-rope-pending');
  await page.mouse.move(700, 800);
  const g = await screenPoint(page, [0, 0, 1.5]);
  await page.mouse.click(g.x, g.y);
  await page.waitForTimeout(200);
  const n1 = await page.evaluate(() => [
    window.physicslab.store.bodies().length,
    window.physicslab.store.joints().length,
  ]);
  const links = n1[0] - n0[0];
  assert(links >= 4 && links <= 40, `rope links were added (${links})`);
  assert(n1[1] - n0[1] === links + 1, `links-1 joints plus the two ends (${n1[1] - n0[1]} for ${links} links)`);
  const first = await page.evaluate(
    (box) => window.physicslab.store.joints().filter((j) => j.bodyA === box || j.bodyB === box).length,
    box,
  );
  assert(first === 1, 'one rope end is fastened to the box');
  await shot(page, 'sf-rope-made');
  await page.evaluate(() => window.physicslab.store.undo());
  const n2 = await page.evaluate(() => [
    window.physicslab.store.bodies().length,
    window.physicslab.store.joints().length,
  ]);
  assert(n2[0] === n0[0] && n2[1] === n0[1], 'a single undo removes the whole rope');
  await page.close();
});
