/**
 * End-to-end tests for the joint inspector of package JT-A: the type picker with diagrams and one-step conversion
 * (JT-9), the type-specific sections, re-zeroing the reference pose, copying settings and mirroring joints (JT-22).
 */
import { assert, near, newPage, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** Load a scene of two bodies per requested joint type; resolves to { type: jointId }. */
const scene = (page, types) =>
  page.evaluate(async (types) => {
    const { Builder } = await import('/src/model/builder.ts');
    const b = new Builder('JT-A ui');
    const ids = {};
    types.forEach((t, i) => {
      const x = i * 3 - 3;
      const a = b.body(`A ${t}`, 'box', [0.6, 0.6, 0.6], [x, 2, 0], { bodyType: 'static' });
      const c = b.body(`B ${t}`, 'cylinder', [0.6, 0.3, 0.6], [x + 1, 2, 0], {});
      ids[t] = b.joint(t, a, c, [x + 0.5, 2, 0], [0, 0, 1]).id;
    });
    window.physicslab.newScene();
    window.physicslab.store.load(b.done());
    return ids;
  }, types);

const select = (page, id) => page.evaluate((id) => window.physicslab.store.setSelection([id]), id);

test('joint picker: grouped types with diagrams; converting keeps the bodies and is one undo step (JT-9)', async () => {
  const page = await newPage();
  const ids = await scene(page, ['hinge']);
  await select(page, ids.hinge);
  await page.click('.panel.right button:has-text("Change type")');
  const info = await page.evaluate(() => ({
    groups: [...document.querySelectorAll('.jt-picker .jt-group')].map((e) => e.textContent),
    tiles: document.querySelectorAll('.jt-picker .jt-tile').length,
    svgs: document.querySelectorAll('.jt-picker .jt-tile svg').length,
    current: document.querySelector('.jt-picker .jt-tile.current')?.dataset.type,
  }));
  assert(info.groups.length === 6 && info.groups[0] === 'Rigid & flexible', `groups ${JSON.stringify(info.groups)}`);
  assert(info.tiles === 16 && info.svgs === 16, `16 tiles with a diagram each (${info.tiles} / ${info.svgs})`);
  assert(info.current === 'hinge', 'the current type is highlighted');
  const before = await page.evaluate((id) => {
    const a = window.physicslab;
    const j = a.store.joint(id);
    a.store.update(id, { limit: { enabled: true, min: -1, max: 1 } }, 'limit');
    return { a: j.bodyA, b: j.bodyB, anchor: j.anchorA, depth: a.store.undoLabel };
  }, ids.hinge);
  await page.click('.jt-picker .jt-tile[data-type="slider"]');
  const after = await page.evaluate((id) => {
    const j = window.physicslab.store.joint(id);
    return { type: j.type, a: j.bodyA, b: j.bodyB, anchor: j.anchorA, limit: j.limit };
  }, ids.hinge);
  assert(after.type === 'slider', 'converted to a slider');
  assert(after.a === before.a && after.b === before.b, 'bodies kept');
  assert(JSON.stringify(after.anchor) === JSON.stringify(before.anchor), 'anchor kept');
  assert(after.limit.enabled, 'the limit switch is kept');
  await page.waitForSelector('.panel.right .section-head:has-text("Limits")');
  await page.evaluate(() => window.physicslab.store.undo());
  const back = await page.evaluate((id) => window.physicslab.store.joint(id).type, ids.hinge);
  assert(back === 'hinge', 'one undo returns to the hinge');
  assert(page.errors.length === 0, `no console errors: ${page.errors.join('; ')}`);
});

test('joint picker: coupling types are disabled with a reason when an end is the world', async () => {
  const page = await newPage();
  const ids = await scene(page, ['ball']);
  await page.evaluate((id) => window.physicslab.store.update(id, { bodyA: null }, 'world'), ids.ball);
  await select(page, ids.ball);
  await page.click('.panel.right button:has-text("Change type")');
  const gear = await page.evaluate(() => {
    const t = document.querySelector('.jt-picker .jt-tile[data-type="gear"]');
    return { disabled: t.disabled, title: t.title };
  });
  assert(gear.disabled && /two bodies/.test(gear.title), `gear disabled with a reason (${JSON.stringify(gear)})`);
});

test('inspector sections: every new type shows its own section and edits through undo', async () => {
  const page = await newPage();
  const types = ['conetwist', 'sixdof', 'universal', 'pulley', 'gear', 'belt', 'rack', 'screw', 'winch', 'softweld'];
  const ids = await scene(page, types);
  const heading = {
    conetwist: 'Cone & twist limits',
    sixdof: 'Six degrees of freedom',
    universal: 'Universal joint',
    pulley: 'Pulley',
    gear: 'Gear pair',
    belt: 'Belt / chain drive',
    rack: 'Rack & pinion',
    screw: 'Screw',
    winch: 'Winch',
    softweld: 'Soft weld',
  };
  for (const t of types) {
    await select(page, ids[t]);
    await page.waitForSelector(`.panel.right .section-head:has-text("${heading[t]}")`, { timeout: 5000 });
    const hasBRow = await page.evaluate(() => /Anchor B/.test(document.querySelector('.panel.right').textContent));
    const independent = ['pulley', 'gear', 'belt', 'rack', 'winch'].includes(t);
    assert(hasBRow === independent, `${t}: Anchor B row ${independent ? 'shown' : 'hidden'}`);
  }
  // cone-twist: swing angle in degrees
  await select(page, ids.conetwist);
  const swing = page.locator('.panel.right .row:has-text("Swing cone") input.num-input');
  await swing.fill('60');
  await swing.press('Enter');
  const rad = await page.evaluate((id) => window.physicslab.store.joint(id).params.swing, ids.conetwist);
  near(rad, Math.PI / 3, 1e-6, 'swing cone stored in radians');
  // 6-DOF: switching an axis to limited reveals its fields
  await select(page, ids.sixdof);
  await page.locator('.dof-card[data-axis="0"] .seg-btn:has-text("Limited")').click();
  const mode = await page.evaluate((id) => window.physicslab.store.joint(id).params.dof[0].mode, ids.sixdof);
  assert(mode === 'limited', '6-DOF X axis limited');
  assert(await page.locator('.dof-card[data-axis="0"] .dof-grid').isVisible(), 'limit fields visible');
  // gear: ratio edit is one undo step
  await select(page, ids.gear);
  const ratio = page.locator('.panel.right .row:has-text("Ratio") input.num-input').first();
  await ratio.fill('3');
  await ratio.press('Enter');
  assert(
    (await page.evaluate((id) => window.physicslab.store.joint(id).params.ratio, ids.gear)) === 3,
    'gear ratio set',
  );
  await page.evaluate(() => window.physicslab.store.undo());
  assert(
    (await page.evaluate((id) => window.physicslab.store.joint(id).params.ratio, ids.gear)) === 1,
    'undo restores',
  );
  assert(page.errors.length === 0, `no console errors: ${page.errors.join('; ')}`);
});

test('re-zero: the live angle becomes the new zero and a locked reference refuses (JT-22)', async () => {
  const page = await newPage();
  const ids = await scene(page, ['hinge']);
  await page.evaluate((id) => {
    const a = window.physicslab;
    a.store.update(id, { axis: [0, 0, 1], anchorA: [0.5, 0, 0] }, 'axis');
    a.store.update(
      id,
      { motor: { ...a.store.joint(id).motor, mode: 'velocity', targetVelocity: 2, maxForce: 500, damping: 100 } },
      'motor',
    );
  }, ids.hinge);
  await select(page, ids.hinge);
  await page.keyboard.press('Space');
  await simTime(page, 0.6);
  await page.waitForSelector('.panel.right button:has-text("Re-zero reference pose")');
  const r = await page.evaluate(async (id) => {
    const a = window.physicslab;
    const live = a.liveJoint(id).value;
    document
      .querySelector('.panel.right')
      .querySelectorAll('button')
      .forEach((b) => {
        if (b.textContent.includes('Re-zero')) b.click();
      });
    return { live, off: a.store.joint(id).params.refOffset };
  }, ids.hinge);
  assert(Math.abs(r.live) > 0.1, `the hinge has turned (${r.live})`);
  near(r.off, -r.live, 0.6, 'refOffset is minus the live value (the hinge keeps turning while the click happens)');
  await page.locator('.panel.right label.switch:has-text("Lock reference pose")').click();
  const locked = await page.evaluate((id) => window.physicslab.store.joint(id).params.refLocked, ids.hinge);
  assert(locked, 'reference locked');
  assert(
    await page.locator('.panel.right button:has-text("Re-zero reference pose")').isDisabled(),
    're-zero is disabled while locked',
  );
});

test('copy settings and mirror: commands act on the selection in one undo step (JT-22)', async () => {
  const page = await newPage();
  const ids = await scene(page, ['hinge', 'hinge']);
  void ids;
  const out = await page.evaluate(async () => {
    const a = window.physicslab;
    const { runCommand } = await import('/src/app/registry/commands.ts');
    const [j1, j2] = a.store.joints();
    a.store.update(j1.id, { limit: { enabled: true, min: -0.5, max: 0.7 } }, 'limit');
    a.store.setSelection([j1.id, j2.id]);
    runCommand('joint.copySettings', a);
    const copied = a.store.joint(j2.id).limit;
    a.store.undo();
    const undone = a.store.joint(j2.id).limit;
    // mirror body + joint across x = 0
    const arm = a.store.bodies().find((b) => b.name === 'B hinge');
    const hinge = a.store.joints()[0];
    const before = a.store.all().length;
    a.store.setSelection([hinge.bodyA, hinge.bodyB, hinge.id]);
    runCommand('joint.mirror', a);
    const after = a.store.all();
    const mirrored = after.filter((e) => /mirrored/.test(e.name));
    const joint = mirrored.find((e) => e.kind === 'joint');
    const body = mirrored.find((e) => e.kind === 'body' && e.name.startsWith('B'));
    return {
      copied,
      undone,
      added: after.length - before,
      armX: arm.position[0],
      mirrorX: body.position[0],
      joint: joint && { a: joint.bodyA, b: joint.bodyB },
      bodies: mirrored.filter((e) => e.kind === 'body').map((b) => b.id),
    };
  });
  assert(out.copied.enabled && out.copied.max === 0.7, 'limits copied to the other joint');
  assert(!out.undone.enabled, 'one undo reverts the copy');
  assert(out.added === 3, `two bodies and a joint mirrored (${out.added})`);
  near(out.mirrorX, -out.armX, 1e-9, 'mirrored body sits across x = 0');
  assert(
    out.joint && out.bodies.includes(out.joint.a) && out.bodies.includes(out.joint.b),
    'mirrored joint joins the copies',
  );
  assert(page.errors.length === 0, `no console errors: ${page.errors.join('; ')}`);
});
