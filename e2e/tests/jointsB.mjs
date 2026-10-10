/**
 * JT-B end-to-end tests: joint breakage in the real UI (inspector fields, presets, break event + toast, load-ratio
 * colouring on the gizmo, reset restoring the joint).
 */
import { assert, newPage, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function hangingWeld(page, massDensity) {
  return page.evaluate((density) => {
    const a = window.physicslab;
    a.newScene();
    const ceiling = a.editor.addShape('box', [0, 6, 0], { bodyType: 'static', name: 'Ceiling' });
    const block = a.editor.addShape('box', [0, 4.5, 0], {
      name: 'Block',
      material: { preset: 'custom', density },
      linearDamping: 0,
    });
    const j = a.editor.addJoint('fixed', { body: ceiling.id, point: [0, 5.5, 0] }, { body: block.id, point: [0, 5.5, 0] });
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
  const spec = await page.evaluate((id) => window.physicslab.store.joint(id).breakage, joint);
  assert(spec && spec.force > 0, `breakage enabled with a default threshold (${JSON.stringify(spec)})`);
  await page.click('.panel.right .chip:has-text("Fragile")');
  const frag = await page.evaluate((id) => window.physicslab.store.joint(id).breakage, joint);
  // fragile = 3× the weight of the block (≈ 1.5 kN); the weld carries 1× weight, so it holds
  assert(frag.force > 1000 && frag.force < 2000, `fragile preset scales with the connected mass (${frag.force})`);
  await page.click('.panel.right .chip:has-text("Tough")');
  const tough = await page.evaluate((id) => window.physicslab.store.joint(id).breakage, joint);
  assert(tough.force > frag.force * 5, `tough preset is much stronger (${tough.force} vs ${frag.force})`);
  await shot(page, 'jt-breakage-inspector');
  // a threshold below the weight breaks it
  await page.evaluate((id) => {
    const a = window.physicslab;
    a.store.update(id, { breakage: { ...a.store.joint(id).breakage, force: 100 } }, 'test');
    a.sim.play();
  }, joint);
  await simTime(page, 0.5);
  const broken = await page.evaluate((id) => window.physicslab.sim.client.broken.has(id), joint);
  assert(broken, 'the weld broke once the block loaded it above 100 N');
  const fell = await page.evaluate((id) => window.physicslab.sim.poseOf(id).position[1], block);
  assert(fell < 4.4, `the block fell after the weld broke (y = ${fell})`);
  const toast = await page.locator('.toast, .toasts').allTextContents();
  assert(toast.join(' ').includes('broke'), `a break toast was shown (${toast.join('|')})`);
  // Reset (stop) restores the joint
  await page.evaluate((id) => {
    const a = window.physicslab;
    a.sim.reset();
    a.store.update(id, { breakage: { ...a.store.joint(id).breakage, force: 5000 } }, 'test');
    a.sim.play();
  }, joint);
  await simTime(page, 0.3);
  const brokenAfter = await page.evaluate((id) => window.physicslab.sim.client.broken.has(id), joint);
  assert(!brokenAfter, 'after a reset the weld exists again and holds under a higher threshold');
});

test('breakage: stress overlay colours a loaded joint and the live readout shows the transmitted load', async () => {
  const page = await newPage();
  const { joint } = await hangingWeld(page, 100); // ≈ 100 kg → 981 N
  await page.evaluate((id) => {
    const a = window.physicslab;
    a.store.update(id, { breakage: { force: 1500, torque: 0, fatigue: { enabled: false, start: 0.6, life: 2 } } }, 'test');
    a.sim.play();
  }, joint);
  await simTime(page, 1);
  await page.waitForSelector('.panel.right .section-head:has-text("Breakage")');
  const live = await page.evaluate((id) => window.physicslab.liveJoint(id), joint);
  assert(live.load > 900 && live.load < 1060, `live load ≈ m·g (${live.load})`);
  assert(live.ratio > 0.6 && live.ratio < 0.72, `ratio = load / threshold (${live.ratio})`);
  const color = await page.evaluate((id) => {
    const v = window.physicslab.joints.views.get(id);
    return v.mats[0].color.getHexString();
  }, joint);
  assert(color !== 'ff4d4d' && color.length === 6, `gizmo carries a load colour (${color})`);
  await shot(page, 'jt-breakage-live');
});
