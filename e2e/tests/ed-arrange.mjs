/**
 * End-to-end tests of the arrange and pivot tools (ED-10, ED-13): the Arrange panel and its commands on real
 * bodies, one undo step each, the pivot modes through the real gizmo, local space for a multi-selection, the 3D
 * cursor tool, group pivots, the menu and the palette.
 */
import { assert, near, newPage, shot } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const box = (page, pos, size = [1, 1, 1], over = {}) =>
  page.evaluate(
    ([pos, size, over]) => window.physicslab.editor.addShape('box', pos, { shape: { type: 'box', size }, ...over }).id,
    [pos, size, over],
  );
const select = (page, ids) => page.evaluate((ids) => window.physicslab.store.setSelection(ids), ids);
const body = (page, id) =>
  page.evaluate((id) => {
    const b = window.physicslab.store.body(id);
    return { position: [...b.position], rotation: [...b.rotation], size: [...b.shape.size] };
  }, id);
const fresh = async () => {
  const page = await newPage();
  await page.evaluate(() => window.physicslab.newScene());
  return page;
};
const openArrange = async (page) => {
  await page.locator('.tab', { hasText: 'Arrange' }).first().click();
  await page.waitForSelector('.ed-arrange [data-cmd="arrange.stack"]');
};
const press = (page, id) => page.locator(`.ed-arrange [data-cmd="${id}"]`).click();
const undoDepth = (page) => page.evaluate(() => window.physicslab.store.undoLabel);

test('arrange panel: align max X lines up the right edges in ONE undo step', async () => {
  const page = await fresh();
  const a = await box(page, [0, 0.5, 0], [1, 1, 1]);
  const b = await box(page, [5, 0.5, 0], [2, 1, 1]);
  const c = await box(page, [-3, 0.5, 0], [4, 1, 1]);
  await select(page, [a, b, c]);
  await openArrange(page);
  await shot(page, 'ed-arrange-panel');
  await press(page, 'arrange.align.x.max');
  for (const [id, w] of [
    [a, 1],
    [b, 2],
    [c, 4],
  ]) {
    const s = await body(page, id);
    near(s.position[0] + w / 2, 6, 1e-6, `right edge of ${id}`);
  }
  assert((await undoDepth(page)) === 'Align X max', `label ${await undoDepth(page)}`);
  await page.evaluate(() => window.physicslab.store.undo());
  near((await body(page, a)).position[0], 0, 1e-9, 'undo restored a');
  near((await body(page, b)).position[0], 5, 1e-9, 'undo restored b');
  near((await body(page, c)).position[0], -3, 1e-9, 'undo restored c');
  assert(page.errors.length === 0, page.errors.join(' | '));
});

test('arrange panel: distribute even gaps, drop to ground (End), stack with a gap', async () => {
  const page = await fresh();
  const a = await box(page, [0, 3, 0], [1, 1, 1]);
  const b = await box(page, [2, 5, 0], [3, 1, 1]);
  const c = await box(page, [10, 7, 0], [2, 1, 1]);
  await select(page, [a, b, c]);
  await openArrange(page);
  await press(page, 'arrange.distribute.x.gaps');
  const [sa, sb, sc] = [await body(page, a), await body(page, b), await body(page, c)];
  const gap1 = sb.position[0] - 1.5 - (sa.position[0] + 0.5);
  const gap2 = sc.position[0] - 1 - (sb.position[0] + 1.5);
  near(gap1, gap2, 1e-6, 'gaps equal');
  near(gap1, 2.75, 1e-6, 'gap size');

  await page.keyboard.press('End'); // drop to ground
  for (const id of [a, b, c]) near((await body(page, id)).position[1], 0.5, 1e-6, 'resting on the ground');

  const field = page.locator('.ed-arrange section', { hasText: 'Stack' }).locator('.num-input').first();
  await field.fill('0.1');
  await field.press('Enter');
  await press(page, 'arrange.stack');
  const [ta, tb, tc] = [await body(page, a), await body(page, b), await body(page, c)];
  near(tb.position[1] - 0.5, ta.position[1] + 0.5 + 0.1, 1e-6, 'b rests 0.1 above a');
  near(tc.position[1] - 0.5, tb.position[1] + 0.5 + 0.1, 1e-6, 'c rests 0.1 above b');
  near(tb.position[0], ta.position[0], 1e-6, 'centred over the first');
  assert((await undoDepth(page)) === 'Stack', 'stack is one undo step');
  assert(page.errors.length === 0, page.errors.join(' | '));
});

test('arrange: drop onto surface rests on a body below; randomise is seeded and re-rolls', async () => {
  const page = await fresh();
  await box(page, [0, 0.5, 0], [4, 1, 4], { bodyType: 'static' });
  const top = await box(page, [0.5, 6, 0], [1, 1, 1]);
  await select(page, [top]);
  await page.evaluate(() => document.querySelector('body').focus());
  await page.keyboard.press('Shift+End');
  near((await body(page, top)).position[1], 1.5, 1e-6, 'standing on the 1 m slab');

  await openArrange(page);
  const r = () => body(page, top);
  const base = await r();
  await page.locator('.ed-arrange section', { hasText: 'Randomise' }).locator('.section-head').click();
  await press(page, 'arrange.randomise');
  const once = await r();
  assert(JSON.stringify(once.position) !== JSON.stringify(base.position), 'randomise moved it');
  await page.evaluate(() => window.physicslab.store.undo());
  await press(page, 'arrange.randomise');
  assert(JSON.stringify((await r()).position) === JSON.stringify(once.position), 'same seed, same result');
  await press(page, 'arrange.reroll');
  const rerolled = await r();
  assert(JSON.stringify(rerolled.position) !== JSON.stringify(once.position), 're-roll picks a new result');
  // Re-roll replaced the previous randomise: one undo returns to the un-randomised pose.
  await page.evaluate(() => window.physicslab.store.undo());
  near((await r()).position[0], base.position[0], 1e-9, 'one undo back to the start');
  assert(page.errors.length === 0, page.errors.join(' | '));
});

test('pivot: modes through the real gizmo (centre, 3D cursor, individual origins)', async () => {
  const page = await fresh();
  const a = await box(page, [0, 0.5, 0]);
  const b = await box(page, [4, 0.5, 0]);
  await select(page, [a, b]);
  await page.evaluate(() => window.physicslab.setGizmo('rotate'));
  const turn = (deg) =>
    page.evaluate((deg) => {
      const g = window.physicslab.gizmo;
      g.beginDrag();
      const half = (deg * Math.PI) / 360;
      g.pivot.quaternion.set(0, Math.sin(half), 0, Math.cos(half)).multiply(g.startPivot.q);
      g.onChange();
      g.endDrag();
    }, deg);

  // Selection centre (default): the pair swaps sides.
  await turn(180);
  near((await body(page, a)).position[0], 4, 1e-6, 'a swapped');
  near((await body(page, b)).position[0], 0, 1e-6, 'b swapped');
  await page.evaluate(() => window.physicslab.store.undo());

  // Individual origins: nobody moves, both turn.
  await page.evaluate(() => window.physicslab.prefs.set({ pivotMode: 'origins' }));
  await turn(90);
  const sa = await body(page, a);
  near(sa.position[0], 0, 1e-6, 'a stays');
  near(Math.abs(sa.rotation[1]), Math.SQRT1_2, 1e-6, 'a turned 90 deg about Y');
  await page.evaluate(() => window.physicslab.store.undo());

  // 3D cursor at (2, 0, 0): a goes to (4,..), b to (0,..) after a half turn.
  await page.evaluate(() => window.physicslab.prefs.set({ pivotMode: 'cursor' }));
  const cursor = await page.evaluate(() => window.physicslab.viewport.scene.getObjectByName('3d-cursor'));
  assert(cursor !== null, 'cursor marker exists');
  await turn(180); // cursor is still at the origin: a (0,0.5,0) stays, b goes to (-4, .., 0)
  near((await body(page, a)).position[0], 0, 1e-6, 'a is at the cursor, stays');
  near((await body(page, b)).position[0], -4, 1e-6, 'b orbited the origin');
  assert(page.errors.length === 0, page.errors.join(' | '));
});

test('pivot: local gizmo space follows the active object for a multi-selection', async () => {
  const page = await fresh();
  const a = await box(page, [0, 0.5, 0]);
  const half = Math.SQRT1_2;
  const b = await box(page, [3, 0.5, 0], [1, 1, 1], { rotation: [0, half, 0, half] });
  await select(page, [a, b]);
  await page.evaluate(() => window.physicslab.prefs.set({ space: 'local' }));
  const q = await page.evaluate(() => window.physicslab.gizmo.pivot.quaternion.toArray());
  near(Math.abs(q[1]), half, 1e-6, 'handle takes the active (last selected) object frame');
  await page.evaluate(() => window.physicslab.prefs.set({ space: 'world' }));
  const q2 = await page.evaluate(() => window.physicslab.gizmo.pivot.quaternion.toArray());
  near(q2[3], 1, 1e-9, 'world space: identity');
  assert(page.errors.length === 0, page.errors.join(' | '));
});

test('pivot: rotate about an arbitrary axis dialog; 3D cursor tool places the cursor on a surface', async () => {
  const page = await fresh();
  const a = await box(page, [2, 0.5, 0]);
  await select(page, [a]);
  await page.evaluate(() => window.physicslab.prefs.set({ pivotMode: 'cursor' }));
  // Place the cursor with the tool: click the ground in front of the camera.
  await page.keyboard.press('Shift+O');
  assert((await page.evaluate(() => window.physicslab.prefs.value.tool)) === 'cursor3d', 'tool active');
  const box0 = await page.locator('.viewport-canvas').boundingBox();
  await page.mouse.click(box0.x + box0.width * 0.5, box0.y + box0.height * 0.8);
  const pos = await page.evaluate(() =>
    window.physicslab.viewport.scene.getObjectByName('3d-cursor').position.toArray(),
  );
  near(pos[1], 0, 1e-6, 'cursor on the ground');
  assert((await page.evaluate(() => window.physicslab.prefs.value.tool)) === 'select', 'back to select');

  // Rotate 180 deg about a custom vertical axis through the cursor: the box ends up mirrored through the cursor.
  await openArrange(page);
  await select(page, [a]);
  await press(page, 'pivot.rotateAxis');
  await page.waitForSelector('.modal');
  await shot(page, 'ed-arrange-rotate-dialog');
  await page.locator('.modal .seg-btn', { hasText: 'Custom' }).click();
  const fields = page.locator('.modal .vec3 .num-input');
  await fields.nth(0).fill('0');
  await fields.nth(0).press('Enter');
  await fields.nth(1).fill('2');
  await fields.nth(1).press('Enter');
  await fields.nth(2).fill('0');
  await fields.nth(2).press('Enter');
  const angle = page.locator('.modal .row', { hasText: 'Angle' }).locator('.num-input');
  await angle.fill('180');
  await angle.press('Enter');
  await page.locator('.modal [data-action="apply"]').click();
  const s = await body(page, a);
  near(s.position[0], 2 * pos[0] - 2, 1e-4, 'mirrored through the cursor in X');
  near(s.position[2], 2 * pos[2], 1e-4, 'mirrored through the cursor in Z');
  assert((await undoDepth(page)) === 'Rotate about axis', 'one undo step');
  assert(page.errors.length === 0, page.errors.join(' | '));
});

test('pivot: custom group pivot keeps members, menu and palette list the arrange commands', async () => {
  const page = await fresh();
  const a = await box(page, [2, 1, 0], [2, 2, 2]);
  const b = await box(page, [4, 1, 0], [2, 2, 2]);
  await select(page, [a, b]);
  const gid = await page.evaluate(() => window.physicslab.editor.groupSelection().id);
  await openArrange(page);
  await select(page, [gid]);
  await press(page, 'pivot.group.bottom');
  const g = await page.evaluate((id) => [...window.physicslab.store.group(id).position], gid);
  near(g[0], 3, 1e-6, 'pivot x');
  near(g[1], 0, 1e-6, 'pivot at the bottom');
  near((await body(page, a)).position[0], 2, 1e-9, 'members untouched');

  // The Arrange menu is in the menu bar and the palette finds the commands.
  await page
    .locator('button', { hasText: /^Edit$/ })
    .first()
    .click();
  const items = await page.locator('.menu .menu-item, .menu button').allTextContents();
  assert(
    items.some((t) => t.includes('Drop to ground')),
    `menu lists drop to ground: ${items.slice(0, 5)}`,
  );
  assert(
    items.some((t) => t.includes('Rotate about axis')),
    'menu lists rotate about axis',
  );
  await shot(page, 'ed-arrange-menu');
  await page.keyboard.press('Escape');
  await select(page, [gid]);
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette .palette-input');
  await page.locator('.palette-input').fill('drop onto');
  await shot(page, 'ed-arrange-palette');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.palette-item .palette-label')].some((e) =>
      /Drop onto surface/i.test(e.textContent),
    ),
  );
  const labels = await page.locator('.palette-item .palette-label').allTextContents();
  assert(
    labels.some((l) => /Drop onto surface/i.test(l)),
    `palette: ${labels}`,
  );
  assert(page.errors.length === 0, page.errors.join(' | '));
});
