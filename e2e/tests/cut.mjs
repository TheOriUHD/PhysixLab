/**
 * ED-41 end-to-end: the Cut tool is activated with its shortcut, a line is dragged across a selected box in the
 * viewport, the box becomes two chunks, and one Ctrl+Z restores the original.
 */
import { assert, near, newPage, nextFrame, screenOf } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const bodies = (page) =>
  page.evaluate(() =>
    window.physixlab.store.bodies().map((b) => ({ id: b.id, type: b.shape.type, size: b.shape.size, p: b.position })),
  );

test('cut tool: drag a line across a box -> two chunks; Ctrl+Z restores it in one step', async () => {
  const page = await newPage();
  const id = await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    const b = a.editor.addShape('box', [0, 1, 0], { name: 'Slab' });
    a.viewport.setView({ position: [0, 4, 9], target: [0, 1, 0] });
    a.store.setSelection([b.id]);
    return b.id;
  });
  assert((await bodies(page)).length === 1, 'one body to start with');

  // the tool is registered and the shortcut K selects it
  await page.locator('.viewport-canvas').focus();
  await page.keyboard.press('k');
  const tool = await page.evaluate(() => window.physixlab.prefs.value.tool);
  assert(tool === 'cut', `K activates the cut tool (got ${tool})`);

  // a too-short drag only explains itself
  const c = await screenOf(page, id);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 3, c.y + 3);
  await page.mouse.up();
  assert((await bodies(page)).length === 1, 'a tiny drag does not cut');

  // a vertical line through the centre
  await nextFrame(page);
  await page.mouse.move(c.x, c.y - 160);
  await page.mouse.down();
  await page.mouse.move(c.x, c.y - 20, { steps: 4 });
  assert((await page.locator('.cut-line').count()) === 1, 'the cut line is drawn while dragging');
  await page.mouse.move(c.x, c.y + 160, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  assert((await page.locator('.cut-line').count()) === 0, 'the overlay is removed on release');

  const after = await bodies(page);
  assert(after.length === 2, `the box became two bodies (got ${after.length})`);
  assert(
    after.every((b) => b.type === 'chunk'),
    'both pieces are convex chunks',
  );
  near(after[0].p[0] + after[1].p[0], 0, 0.05, 'the pieces sit symmetrically about the cut');
  assert(Math.abs(after[0].p[0] - after[1].p[0]) > 0.3, 'the pieces are apart along x');
  assert((await page.evaluate(() => window.physixlab.store.selection.length)) === 2, 'both halves are selected');

  await page.keyboard.press('Control+z');
  const restored = await bodies(page);
  assert(restored.length === 1 && restored[0].id === id, 'Ctrl+Z restores the original box in one step');
  assert(page.errors.length === 0, `no page errors: ${page.errors.join('; ')}`);
  await page.close();
});
