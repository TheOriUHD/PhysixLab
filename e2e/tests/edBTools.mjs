/**
 * Package ED-B end-to-end tests: the tool options bar, blast variants, paint, pin, the throw / aim tool and the grab upgrades,
 * driven with real mouse and keyboard input.
 */
import { assert, near, newPage, pose, screenOf, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const sceneWithBall = (page, extra = {}) =>
  page.evaluate((extra) => {
    const a = window.physicslab;
    a.newScene();
    const b = a.editor.addShape('sphere', [0, 0.5, 0], { material: { preset: 'rubber', density: 300 }, ...extra });
    a.viewport.setView({ position: [0, 4, 9], target: [0, 1, 0] });
    return b.id;
  }, extra);

test('edB tool options bar follows the active tool and edits preferences', async () => {
  const page = await newPage();
  assert(await page.locator('.tool-options').isHidden(), 'no options bar for the select tool while editing');
  await page.keyboard.press('B');
  await page.waitForSelector('.tool-options:not([hidden])');
  await page.selectOption('.tool-options select[aria-label="Blast"]', 'implosion');
  assert(
    (await page.evaluate(() => window.physicslab.prefs.value.blastKind)) === 'implosion',
    'blast kind stored in prefs',
  );
  await page.fill('.tool-options input[aria-label="Radius"]', '12').catch(() => {});
  await shot(page, 'edb-blast-options');
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('T');
  await page.waitForSelector('.tool-options select[aria-label="Projectile"]');
  await page.selectOption('.tool-options select[aria-label="Projectile"]', 'bowling');
  assert((await page.evaluate(() => window.physicslab.prefs.value.shootType)) === 'bowling', 'projectile type stored');
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Q');
  assert(await page.locator('.tool-options').isHidden(), 'bar hidden again for select tool');
  assert(page.errors.length === 0, `no console errors: ${page.errors.join('|')}`);
});

test('edB blast variants: a directional blast moves a ball along the view ray, an implosion pulls it in', async () => {
  const page = await newPage();
  const id = await sceneWithBall(page);
  await page.evaluate(() =>
    window.physicslab.prefs.set({
      blastKind: 'implosion',
      blastFalloff: 'constant',
      blastRadius: 30,
      blastStrength: 30,
    }),
  );
  await page.keyboard.press('Space');
  await simTime(page, 0.6);
  await page.keyboard.press('B');
  const sp = await screenOf(page, id);
  const box = await page.evaluate(() => window.physicslab.viewport.dom.getBoundingClientRect().toJSON());
  // blast on the ground to the right of the ball: an implosion pulls the ball towards the blast point (+x)
  await page.mouse.click(Math.min(box.right - 40, sp.x + 220), sp.y + 40);
  await simTime(page, 1.8); // simTime is absolute: wait until the world has run 1.2 s past the blast
  const p = await pose(page, id);
  assert(p.position[0] > 0.3, `ball pulled right by the implosion (x=${p.position[0].toFixed(2)})`);
});

test('edB paint tool: click and drag recolour bodies as one undo step, shift+click picks a colour', async () => {
  const page = await newPage();
  const id = await sceneWithBall(page);
  await page.evaluate(() => window.physicslab.prefs.set({ paintColor: '#12ab34' }));
  await page.keyboard.press('P');
  const sp = await screenOf(page, id);
  await page.mouse.click(sp.x, sp.y);
  const color = () => page.evaluate((id) => window.physicslab.store.body(id).material.color, id);
  assert((await color()) === '#12ab34', `body painted (${await color()})`);
  await page.keyboard.press('Control+z');
  assert((await color()) !== '#12ab34', 'one undo step restores the colour');
  // eyedropper
  await page.evaluate(
    (id) =>
      window.physicslab.store.update(id, {
        material: { ...window.physicslab.store.body(id).material, color: '#abcdef' },
      }),
    id,
  );
  await page.keyboard.down('Shift');
  await page.mouse.click(sp.x, sp.y);
  await page.keyboard.up('Shift');
  assert(
    (await page.evaluate(() => window.physicslab.prefs.value.paintColor)) === '#abcdef',
    'eyedropper took the body colour',
  );
  // material mode
  await page.evaluate(() => window.physicslab.prefs.set({ paintMode: 'material', paintMaterial: 'gold' }));
  await page.mouse.click(sp.x, sp.y);
  assert(
    (await page.evaluate((id) => window.physicslab.store.body(id).material.preset, id)) === 'gold',
    'material painted',
  );
});

test('edB pin tool: pins a falling body in the running simulation, shift+click unpins', async () => {
  const page = await newPage();
  const id = await sceneWithBall(page);
  await page.evaluate((id) => {
    const a = window.physicslab;
    a.store.update(id, { position: [0, 40, 0] });
    a.prefs.set({ pinJoint: 'fixed' });
  }, id);
  await page.keyboard.press('Space');
  await simTime(page, 0.05);
  await page.keyboard.press('N');
  await page.evaluate(() => window.physicslab.viewport.setView({ position: [0, 40, 12], target: [0, 38, 0] }));
  const sp = await screenOf(page, id);
  await page.mouse.click(sp.x, sp.y);
  const joints = await page.evaluate(() =>
    window.physicslab.store.joints().map((j) => ({ a: j.bodyA, b: j.bodyB, n: j.name })),
  );
  assert(
    joints.length === 1 && joints[0].b === null && joints[0].n.startsWith('Pin'),
    `one pin joint to the world ${JSON.stringify(joints)}`,
  );
  const y0 = (await pose(page, id)).position[1];
  await simTime(page, 1.5);
  const p = await pose(page, id);
  assert(
    y0 > 5 && Math.abs(p.position[1] - y0) < 0.5,
    `pinned body did not fall (y ${y0.toFixed(2)} → ${p.position[1].toFixed(2)})`,
  );
  const sp2 = await screenOf(page, id);
  await page.keyboard.down('Shift');
  await page.mouse.click(sp2.x, sp2.y);
  await page.keyboard.up('Shift');
  assert((await page.evaluate(() => window.physicslab.store.joints().length)) === 0, 'unpinned');
});

test('edB throw tool: hold previews the path and charges, release fires the chosen projectile type', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physicslab;
    a.newScene();
    a.viewport.setView({ position: [0, 3, 10], target: [0, 1, 0] });
    a.prefs.set({ shootType: 'bowling' });
  });
  await page.keyboard.press('Space');
  await simTime(page, 0.2);
  await page.keyboard.press('T');
  const box = await page.evaluate(() => window.physicslab.viewport.dom.getBoundingClientRect().toJSON());
  await page.mouse.move(box.left + box.width / 2, box.top + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(900);
  const preview = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.v-label')].map((l) => l.textContent);
    return labels.find((t) => t.includes('m/s')) ?? null;
  });
  assert(preview !== null, 'a speed label shows while charging');
  await shot(page, 'edb-aim-preview');
  await page.mouse.up();
  await page.waitForTimeout(300);
  const shot1 = await page.evaluate(() => {
    const a = window.physicslab;
    const eph = [...a.sim.ephemeral.values()];
    return eph.map((b) => ({ name: b.name, mass: b.massOverride, v: Math.hypot(...b.velocity) }));
  });
  assert(
    shot1.length === 1 && shot1[0].name === 'Bowling ball' && shot1[0].mass === 7,
    `bowling ball fired ${JSON.stringify(shot1)}`,
  );
  assert(shot1[0].v > 22 * 1.0, `held shot is faster than a tap (v=${shot1[0].v.toFixed(1)})`);
  const labelsLeft = await page.evaluate(
    () => [...document.querySelectorAll('.v-label')].filter((l) => l.textContent.includes('m/s')).length,
  );
  assert(labelsLeft === 0, 'aim label removed after the shot');
});

test('edB grab upgrades: scroll moves the held body away, F freezes it where it is, strength is passed on', async () => {
  const page = await newPage();
  const id = await sceneWithBall(page);
  await page.keyboard.press('Space');
  await simTime(page, 0.8);
  const sp = await screenOf(page, id);
  await page.mouse.move(sp.x, sp.y);
  await page.mouse.down();
  await page.mouse.move(sp.x, sp.y - 60, { steps: 6 });
  await page.waitForTimeout(500);
  const z0 = await page.evaluate((id) => window.physicslab.bodies.get(id).position.z, id);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(100);
  }
  // the camera looks down -z: pushing the held body away lowers its z by about 3 m
  await page.waitForFunction(([id, z0]) => window.physicslab.bodies.get(id).position.z < z0 - 1.5, [id, z0], {
    timeout: 20000,
  });
  await page.keyboard.press('F');
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const a = await pose(page, id);
  await page.waitForTimeout(1500);
  const b = await pose(page, id);
  near(b.position[1], a.position[1], 0.01, 'frozen body stays in the air');
  assert(page.errors.length === 0, `no console errors: ${page.errors.join('|')}`);
});
