/**
 * JT-B end-to-end tests: joint breakage in the real UI (inspector fields, presets, break event + toast, load-ratio
 * colouring on the gizmo, reset restoring the joint).
 */
import { assert, newPage, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function hangingWeld(page, massDensity) {
  return page.evaluate((density) => {
    const a = window.physixlab;
    a.newScene();
    const ceiling = a.editor.addShape('box', [0, 6, 0], { bodyType: 'static', name: 'Ceiling' });
    const block = a.editor.addShape('box', [0, 4.5, 0], {
      name: 'Block',
      material: { preset: 'custom', density },
      linearDamping: 0,
    });
    const j = a.editor.addJoint(
      'fixed',
      { body: ceiling.id, point: [0, 5.5, 0] },
      { body: block.id, point: [0, 5.5, 0] },
    );
    a.store.setSelection([j.id]);
    a.viewport.setView({ position: [0, 5, 9], target: [0, 5, 0] });
    return { joint: j.id, block: block.id };
  }, massDensity);
}

test('breakage: inspector presets set thresholds, an overloaded weld breaks with a toast, reset restores it', async () => {
  const page = await newPage();
  const { joint, block } = await hangingWeld(page, 50); // 50 kg/m³ × 1 m³ ≈ 50 kg
  await page.waitForSelector('.panel.right .section-head:has-text("Breakage")');
  await page.click('.panel.right .section-head:has-text("Breakage")');
  await page.locator('.panel.right').getByText('Breaks under load').click();
  const spec = await page.evaluate((id) => window.physixlab.store.joint(id).breakage, joint);
  assert(spec && spec.force > 0, `breakage enabled with a default threshold (${JSON.stringify(spec)})`);
  await page.click('.panel.right .chip:has-text("Fragile")');
  const frag = await page.evaluate((id) => window.physixlab.store.joint(id).breakage, joint);
  // fragile = 3× the weight of the block (≈ 1.5 kN); the weld carries 1× weight, so it holds
  assert(frag.force > 1000 && frag.force < 2000, `fragile preset scales with the connected mass (${frag.force})`);
  await page.click('.panel.right .chip:has-text("Tough")');
  const tough = await page.evaluate((id) => window.physixlab.store.joint(id).breakage, joint);
  assert(tough.force > frag.force * 5, `tough preset is much stronger (${tough.force} vs ${frag.force})`);
  await shot(page, 'jt-breakage-inspector');
  // a threshold below the weight breaks it
  await page.evaluate((id) => {
    const a = window.physixlab;
    a.store.update(id, { breakage: { ...a.store.joint(id).breakage, force: 100 } }, 'test');
    a.sim.play();
  }, joint);
  await simTime(page, 0.5);
  const broken = await page.evaluate((id) => window.physixlab.sim.client.broken.has(id), joint);
  assert(broken, 'the weld broke once the block loaded it above 100 N');
  const fell = await page.evaluate((id) => window.physixlab.sim.poseOf(id).position[1], block);
  assert(fell < 4.4, `the block fell after the weld broke (y = ${fell})`);
  const toast = await page.locator('.toast, .toasts').allTextContents();
  assert(toast.join(' ').includes('broke'), `a break toast was shown (${toast.join('|')})`);
  // Reset (stop) restores the joint
  await page.evaluate((id) => {
    const a = window.physixlab;
    a.sim.reset();
    a.store.update(id, { breakage: { ...a.store.joint(id).breakage, force: 5000 } }, 'test');
    a.sim.play();
  }, joint);
  await simTime(page, 0.3);
  const brokenAfter = await page.evaluate((id) => window.physixlab.sim.client.broken.has(id), joint);
  assert(!brokenAfter, 'after a reset the weld exists again and holds under a higher threshold');
});

test('breakage: stress overlay colours a loaded joint and the live readout shows the transmitted load', async () => {
  const page = await newPage();
  const { joint } = await hangingWeld(page, 100); // ≈ 100 kg → 981 N
  await page.evaluate((id) => {
    const a = window.physixlab;
    a.store.update(
      id,
      { breakage: { force: 1500, torque: 0, fatigue: { enabled: false, start: 0.6, life: 2 } } },
      'test',
    );
    a.sim.play();
  }, joint);
  await simTime(page, 1);
  await page.waitForSelector('.panel.right .section-head:has-text("Breakage")');
  const live = await page.evaluate((id) => window.physixlab.liveJoint(id), joint);
  assert(live.load > 900 && live.load < 1060, `live load ≈ m·g (${live.load})`);
  assert(live.ratio > 0.6 && live.ratio < 0.72, `ratio = load / threshold (${live.ratio})`);
  const color = await page.evaluate((id) => {
    const v = window.physixlab.joints.views.get(id);
    return v.mats[0].color.getHexString();
  }, joint);
  assert(color !== 'ff4d4d' && color.length === 6, `gizmo carries a load colour (${color})`);
  await shot(page, 'jt-breakage-live');
});

test('collision layers: rename in the World tab, matrix switches a pair off, body dropdown + accepted layers', async () => {
  const page = await newPage();
  const ids = await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    const plat = a.editor.addShape('box', [0, 2, 0], { bodyType: 'static', name: 'Platform', size: [6, 0.4, 6] });
    const ball = a.editor.addShape('sphere', [0, 5, 0], { name: 'Ball' });
    a.store.setSelection([ball.id]);
    return { plat: plat.id, ball: ball.id };
  });
  // body inspector: layer dropdown + accepted-layer chips
  await page.locator('.panel.right .section-head:has-text("Collision filter")').click();
  await page.locator('.panel.right select').first().waitFor();
  await page.evaluate((id) => {
    const a = window.physixlab;
    a.store.update(id, { collision: { group: 1, mask: 0xffff } }, 'test');
  }, ids.ball);
  const chipsOn = await page.locator('.panel.right .mask-grid .chip.on').count();
  assert(chipsOn === 16, `all 16 layers accepted by default (${chipsOn})`);
  await page.locator('.panel.right .mask-grid .chip').nth(5).click();
  const mask = await page.evaluate((id) => window.physixlab.store.body(id).collision.mask, ids.ball);
  assert((mask & (1 << 5)) === 0 && (mask & 1) === 1, `chip toggles one accepted layer (${mask.toString(2)})`);
  // World tab: rename layer 1, switch the pair (1, 0) off, platform is layer 0 so the ball falls through to the ground
  await page.click('.tab:has-text("World"), [role=tab]:has-text("World")');
  await page.locator('.panel .section-head:has-text("Collision layers")').first().click();
  const input = page.locator('.layer-name').nth(1);
  await input.fill('Props');
  await input.press('Enter');
  const name = await page.evaluate(() => window.physixlab.store.settings.layers?.names[1]);
  assert(name === 'Props', `layer renamed (${name})`);
  await page.evaluate(() => {
    // the platform is layer 0; the ball (layer 1) must not collide with it
    window.physixlab.store.updateSettings({}, 'noop');
  });
  await page.locator('.layer-cell[data-a="1"][data-b="0"]').uncheck();
  const m0 = await page.evaluate(() => window.physixlab.store.settings.layers.matrix.slice(0, 2));
  assert((m0[0] & 2) === 0 && (m0[1] & 1) === 0, `matrix pair switched off symmetrically (${m0})`);
  await shot(page, 'jt-layers-world');
  await page.evaluate((id) => {
    const a = window.physixlab;
    a.store.update(id, { collision: { group: 1, mask: 0xffff } }, 'test');
    a.sim.play();
  }, ids.ball);
  await simTime(page, 1.5);
  const y = await page.evaluate((id) => window.physixlab.sim.poseOf(id).position[1], ids.ball);
  assert(y < 1, `the ball passed through the platform and rests on the ground (y = ${y})`);
});

test('one-way platform, COM handle and wake-all from the UI', async () => {
  const page = await newPage();
  const ids = await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    const plat = a.editor.addShape('box', [0, 2, 0], { bodyType: 'static', name: 'Platform', size: [6, 0.4, 6] });
    const ball = a.editor.addShape('sphere', [0, 0.5, 0], { name: 'Ball', velocity: [0, 9, 0] });
    a.store.setSelection([plat.id]);
    return { plat: plat.id, ball: ball.id };
  });
  await page.locator('.panel.right .section-head:has-text("Collision filter")').click();
  await page.locator('.panel.right').getByText('One-way platform').click();
  const ow = await page.evaluate((id) => window.physixlab.store.body(id).oneWay, ids.plat);
  assert(Array.isArray(ow) && ow[1] === 1, `one-way platform enabled facing up (${ow})`);
  await shot(page, 'jt-oneway');
  await page.evaluate(() => window.physixlab.sim.play());
  await simTime(page, 3);
  const y = await page.evaluate((id) => window.physixlab.sim.poseOf(id).position[1], ids.ball);
  assert(y > 2.3, `the ball came up through the platform and rests on it (y = ${y})`);
  await page.evaluate(() => window.physixlab.sim.reset());
  // centre of mass: enable the override and start the viewport handle
  await page.evaluate((id) => window.physixlab.store.setSelection([id]), ids.ball);
  await page.locator('.panel.right .section-head:has-text("Mass properties")').click();
  await page.locator('.panel.right').getByText('Override centre of mass').click();
  await page.locator('.panel.right button:has-text("Edit in viewport")').click();
  const on = await page.evaluate(() => window.physixlab.gizmos.com.bodyId);
  assert(on === ids.ball, 'the COM handle is active for the selected body');
  await page.evaluate((id) => {
    const a = window.physixlab;
    // drag the handle programmatically through the same path the gizmo uses
    a.gizmos.com.apply({ id: id + '@com', position: [0, 0.2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  }, ids.ball);
  const com = await page.evaluate((id) => window.physixlab.store.body(id).comOverride, ids.ball);
  assert(Math.abs(com[1] + 0.3) < 0.02, `dragging the handle writes comOverride in the local frame (${com})`);
  await shot(page, 'jt-com-handle');
  // wake all
  await page.evaluate(() => window.physixlab.sim.play());
  await page.locator('.panel.right .section-head:has-text("Sleep")').click();
  const dis = await page.locator('.panel.right button:has-text("Wake all bodies")').isEnabled();
  assert(dis, 'wake-all is enabled while simulating');
  await page.locator('.panel.right button:has-text("Wake all bodies")').click();
});
