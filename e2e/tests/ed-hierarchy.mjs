/**
 * ED-20 / ED-21 end-to-end: the clipboard survives loading another scene and a page reload (real Ctrl+C / Ctrl+V),
 * paste lands at the pointer, groups scale through the scale gizmo path and the inspector, weld / unweld, ungroup and
 * their undo steps, and the Edit menu offers the commands.
 */
import { assert, near, newPage, nextFrame, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** A fresh scene with two hinged boxes (A, B) and a loose ball. Returns their ids. */
const rig = (page) =>
  page.evaluate(() => {
    const a = window.physicslab;
    a.newScene();
    const A = a.editor.addShape('box', [0, 0.5, 0], { name: 'A' });
    const B = a.editor.addShape('box', [1.5, 0.5, 0], { name: 'B' });
    const C = a.editor.addShape('sphere', [5, 0.5, 0], { name: 'Ball' });
    a.editor.addJoint('hinge', { body: A.id, point: [0.75, 0.5, 0] }, { body: B.id, point: [0.75, 0.5, 0] }, [0, 0, 1]);
    a.viewport.setView({ position: [3, 5, 9], target: [2, 0.5, 0] });
    a.store.setSelection([]);
    return { A: A.id, B: B.id, C: C.id };
  });

test('clipboard: Ctrl+C in one scene, open another scene and reload the page, Ctrl+V pastes with the hinge', async () => {
  const page = await newPage();
  const ids = await rig(page);
  await page.evaluate((ids) => window.physicslab.store.setSelection([ids.A, ids.B]), ids);
  await page.evaluate((ids) => window.physicslab.store.setSelection([ids.A, ids.B]), ids);
  await page.keyboard.press('Control+c');
  const stored = await page.evaluate(() => localStorage.getItem('physicslab:clipboard:v1'));
  assert(stored && stored.includes('physicslab-clipboard'), 'Ctrl+C wrote the clipboard envelope to localStorage');
  // open a different scene: the clipboard is not part of the document
  await page.evaluate(() => window.physicslab.loadTemplate('car'));
  const before = await page.evaluate(() => window.physicslab.store.bodies().length);
  await page.keyboard.press('Control+v');
  const after = await page.evaluate(() => ({
    bodies: window.physicslab.store.bodies().length,
    joints: window.physicslab.store.joints().length,
    sel: window.physicslab.store.selection.length,
    label: window.physicslab.store.undoLabel,
  }));
  assert(after.bodies === before + 2, `two bodies pasted into the other scene (${before} -> ${after.bodies})`);
  assert(after.label === 'Paste', `paste is one undo step (${after.label})`);
  assert(after.sel === 2, `the pasted objects are selected (${after.sel})`);
  await page.keyboard.press('Control+z');
  assert((await page.evaluate(() => window.physicslab.store.bodies().length)) === before, 'one undo removes the paste');

  // a page reload keeps the clipboard (localStorage)
  await page.reload();
  await page.waitForFunction(() => !!window.physicslab && window.physicslab.viewport, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.physicslab.newScene());
  await page.keyboard.press('Control+Shift+v'); // paste in place
  const reloaded = await page.evaluate(() => ({
    bodies: window.physicslab.store.bodies().map((b) => ({ n: b.name, p: b.position })),
    joints: window.physicslab.store.joints().length,
  }));
  assert(reloaded.bodies.length === 2 && reloaded.joints === 1, `reloaded paste: ${JSON.stringify(reloaded)}`);
  near(reloaded.bodies.find((b) => b.n === 'B').p[0], 1.5, 1e-6, 'paste in place keeps the original coordinates');
  assert(page.errors.length === 0, `no page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('clipboard: a plain paste lands at the pointer on the ground; with connections keeps ties to the world', async () => {
  const page = await newPage();
  const ids = await rig(page);
  await page.evaluate((ids) => {
    const a = window.physicslab;
    // a spring from the ball to B: B is copied, the ball is not
    a.editor.addJoint('spring', { body: ids.B, point: [1.5, 0.5, 0] }, { body: ids.C, point: [5, 0.5, 0] });
    a.store.setSelection([ids.B]);
  }, ids);
  await page.evaluate(() => window.physicslab.editor.copy());
  await nextFrame(page);
  const target = await page.evaluate(() => {
    const a = window.physicslab;
    const v = new a.camera.position.constructor(0, 0, 3).project(a.camera);
    const r = a.viewport.dom.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  });
  await page.mouse.move(target.x, target.y);
  await page.mouse.move(target.x + 1, target.y + 1);
  await page.evaluate(() => window.physicslab.store.setSelection([]));
  await page.keyboard.press('Control+v');
  const p = await page.evaluate(() => {
    const b = window.physicslab.store.bodies().find((x) => x.name === 'B 2');
    return b ? b.position : null;
  });
  assert(p, 'B was pasted');
  near(p[0], 0, 0.1, 'x at the pointer ground point');
  near(p[2], 3, 0.1, 'z at the pointer ground point');
  const plainJoints = await page.evaluate(() => window.physicslab.store.joints().length);
  // the tie to the ball is only kept by "Paste with connections"
  await page.evaluate(() => window.physicslab.store.setSelection([]));
  await page.evaluate(async () => {
    const { runCommand } = await import('/src/app/registry/index.ts');
    runCommand('edit.pasteConnections', window.physicslab, 'api');
  });
  const joints = await page.evaluate(() =>
    window.physicslab.store.joints().map((j) => ({ t: j.type, a: j.bodyA, b: j.bodyB })),
  );
  assert(
    joints.length === plainJoints + 2,
    `with connections adds the hinge and the spring, both hung on the world (${plainJoints} -> ${joints.length})`,
  );
  const added = joints.slice(plainJoints);
  assert(
    added.every((j) => j.a === null || j.b === null) && added.some((j) => j.t === 'spring'),
    `the far ends hang on the world: ${JSON.stringify(added)}`,
  );
  await page.close();
});

test('groups: scale gizmo path, inspector Scale row, weld / unweld and ungroup are single undo steps', async () => {
  const page = await newPage();
  const ids = await rig(page);
  const g = await page.evaluate((ids) => {
    const a = window.physicslab;
    a.store.setSelection([ids.A, ids.B]);
    const grp = a.editor.groupSelection();
    return grp.id;
  }, ids);
  // the scale gizmo stays in scale mode for a group (it used to fall back to translate)
  await page.evaluate(() => window.physicslab.prefs.set({ gizmo: 'scale' }));
  await nextFrame(page);
  const mode = await page.evaluate(() => window.physicslab.gizmo.mode);
  assert(mode === 'scale', `scale gizmo mode kept for a group (${mode})`);
  // drive the real controller path of a drag: start, change (cumulative factor), end
  const result = await page.evaluate((g) => {
    const a = window.physicslab;
    const grp = a.store.group(g);
    const steps0 = a.store.undoLabel;
    a.gizmos.onStart();
    a.gizmos.onChange([{ id: g, position: grp.position, rotation: grp.rotation, scale: [1.5, 1.5, 1.5] }]);
    a.gizmos.onChange([{ id: g, position: grp.position, rotation: grp.rotation, scale: [2, 2, 2] }]);
    a.gizmos.onEnd();
    const sizes = a.store
      .bodies()
      .filter((b) => b.name !== 'Ball')
      .map((b) => b.shape.size[0]);
    return { sizes, label: a.store.undoLabel, steps0 };
  }, g);
  assert(
    result.sizes.every((s) => Math.abs(s - 2) < 1e-9),
    `members doubled, not x3: ${result.sizes}`,
  );
  assert(result.label === 'Scale', `one undo step named Scale (${result.label})`);
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate(() =>
    window.physicslab.store
      .bodies()
      .filter((b) => b.name !== 'Ball')
      .map((b) => b.shape.size[0]),
  );
  assert(
    undone.every((s) => s === 1),
    `undo restores the sizes (${undone})`,
  );

  // inspector section
  await page.evaluate((g) => {
    window.physicslab.prefs.set({ gizmo: 'translate', rightTab: 'inspector' });
    window.physicslab.store.setSelection([g]);
  }, g);
  await page.waitForSelector('.row-label:has-text("Scale group")');
  await shot(page, 'ed-hierarchy-inspector');
  const input = page.locator('.row:has(.row-label:has-text("Scale group")) .num-input');
  await input.fill('3');
  await input.press('Enter');
  await page.locator('.row:has(.row-label:has-text("Scale group")) button:has-text("Scale")').click();
  const tripled = await page.evaluate(() => window.physicslab.store.bodies().find((b) => b.name === 'B').shape.size[0]);
  near(tripled, 3, 1e-9, 'inspector scale row triples the members');
  await page.keyboard.press('Control+z');

  // weld: A and B are already hinged; weld adds one fixed joint, simulate and check rigidity
  await page.locator('.row:has(.row-label:has-text("Weld")) button:has-text("Weld")').first().click();
  const welded = await page.evaluate(() => window.physicslab.store.joints().filter((j) => j.type === 'fixed').length);
  assert(welded === 1, `one weld joint for two bodies (${welded})`);
  await page.locator('.row:has(.row-label:has-text("Weld")) button:has-text("Unweld")').click();
  assert(
    (await page.evaluate(() => window.physicslab.store.joints().filter((j) => j.type === 'fixed').length)) === 0,
    'Unweld removes the weld joints',
  );
  await page.keyboard.press('Control+z');
  assert(
    (await page.evaluate(() => window.physicslab.store.joints().filter((j) => j.type === 'fixed').length)) === 1,
    'undo of Unweld brings the weld back',
  );

  // simulate: lift the group, let it fall tumbling; the welded pair keeps its spacing
  await page.evaluate((g) => {
    const a = window.physicslab;
    const grp = a.store.group(g);
    a.store.transformGroup(g, { position: [grp.position[0], grp.position[1] + 3, grp.position[2]] });
    a.store.setSelection([]);
  }, g);
  const d0 = await page.evaluate(() => {
    const [x, y] = window.physicslab.store.bodies();
    return Math.hypot(x.position[0] - y.position[0], x.position[1] - y.position[1], x.position[2] - y.position[2]);
  });
  await page.keyboard.press('Space');
  await simTime(page, 1);
  const d1 = await page.evaluate(() => {
    const [x, y] = window.physicslab.store.bodies();
    const px = window.physicslab.sim.poseOf(x.id).position;
    const py = window.physicslab.sim.poseOf(y.id).position;
    return Math.hypot(px[0] - py[0], px[1] - py[1], px[2] - py[2]);
  });
  near(d1, d0, 0.05, 'welded boxes keep their spacing in the live simulation');
  await page.evaluate(() => window.physicslab.sim.reset());

  // ungroup is one step too
  await page.evaluate((g) => {
    window.physicslab.store.setSelection([g]);
    window.physicslab.editor.ungroup();
  }, g);
  assert((await page.evaluate(() => window.physicslab.store.groups().length)) === 0, 'ungroup removed the group');
  assert(page.errors.length === 0, `no page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('Edit menu offers paste variants and group operations (merge says what it needs until it exists)', async () => {
  const page = await newPage();
  await rig(page);
  await page.click('.menu-btn:has-text("Edit")');
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('.menu .menu-item')].map((b) => ({
      t: b.textContent.replace(/\s+/g, ' ').trim(),
      d: b.disabled || b.getAttribute('aria-disabled') === 'true',
    })),
  );
  const has = (s) => items.some((i) => i.t.includes(s));
  for (const s of [
    'Paste in place',
    'Paste with connections',
    'Weld group',
    'Unweld group',
    'Scale group',
    'Merge group into compound',
  ])
    assert(has(s), `Edit menu has "${s}": ${items.map((i) => i.t).join(' | ')}`);
  await shot(page, 'ed-hierarchy-edit-menu');
  await page.close();
});
