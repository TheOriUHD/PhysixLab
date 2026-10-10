/**
 * ED-12 / ED-11 in the real UI: the Array panel (preview, apply, one undo step, linked arrays re-edited in the
 * Inspector) and mirror / symmetry commands.
 */
import { assert, newPage, shot } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const addBox = (page, x) =>
  page.evaluate((px) => {
    const b = window.physicslab.addShape('box', [px, 0.5, 0]);
    window.physicslab.store.setSelection([b.id]);
    return b.id;
  }, x);
const bodies = (page) => page.evaluate(() => window.physicslab.store.bodies().length);
const xs = (page) =>
  page.evaluate(() =>
    window.physicslab.store
      .bodies()
      .map((b) => b.position[0])
      .sort((a, b) => a - b),
  );

test('array panel: preview appears, Apply makes N bodies, one undo removes them', async () => {
  const page = await newPage();
  const base = (await bodies(page)) + 1;
  await addBox(page, 0);
  await page.keyboard.press('Shift+Y');
  await page.waitForSelector('[data-action="apply-array"]');
  await page.waitForFunction(
    () => {
      const o = window.physicslab.viewport.helpers.getObjectByName('array-preview');
      return !!o && o.visible;
    },
    null,
    { timeout: 8000 },
  );
  await shot(page, 'ed-array-preview');
  assert((await bodies(page)) === base, 'preview creates nothing');
  await page.click('[data-action="apply-array"]');
  await page.waitForFunction((n) => window.physicslab.store.bodies().length === n + 4, base, { timeout: 60000 });
  await page.evaluate(() => window.physicslab.store.undo());
  assert((await bodies(page)) === base, 'one undo removes the whole array');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

test('linked array: the group holds the definition and the Inspector shows its parameters', async () => {
  const page = await newPage();
  const base = (await bodies(page)) + 1;
  await addBox(page, 0);
  await page.keyboard.press('Shift+Y');
  await page.waitForSelector('[data-action="apply-array"]');
  await page.click('.seg-btn[data-value="linked"]');
  await page.click('[data-action="apply-array"]');
  await page.waitForFunction(() => window.physicslab.store.groups().some((g) => g.array));
  assert((await bodies(page)) === base + 4, 'original + 4 copies');
  await page.evaluate(() => {
    const g = window.physicslab.store.groups().find((x) => x.array);
    window.physicslab.store.setSelection([g.id]);
    window.physicslab.prefs.set({ rightTab: 'inspector' });
  });
  await page.waitForSelector('.ed-array-form');
  await shot(page, 'ed-array-linked');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

test('mirror copy through the palette, symmetry mode follows edits in one undo step', async () => {
  const page = await newPage();
  const before = await bodies(page);
  const id = await addBox(page, 2);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Mirror copy about X');
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => window.physicslab.store.bodies().length === n + 2, before);
  const m = await xs(page);
  assert(m.some((v) => Math.abs(v + 2) < 1e-6) && m.some((v) => Math.abs(v - 2) < 1e-6), `mirrored x ${m}`);
  await page.evaluate(() => window.physicslab.store.setSelection([]));
  await page.click('.viewport-canvas', { position: { x: 700, y: 120 } });
  await page.keyboard.press('y');
  await page.evaluate((i) => window.physicslab.store.update(i, { position: [3, 0.5, 0] }, 'Move'), id);
  const after = await xs(page);
  assert(
    after.some((v) => Math.abs(v + 3) < 1e-6),
    `partner followed ${after}`,
  );
  await shot(page, 'ed-symmetry');
  await page.evaluate(() => window.physicslab.store.undo());
  const back = await xs(page);
  assert(
    back.some((v) => Math.abs(v + 2) < 1e-6) &&
      back.some((v) => Math.abs(v - 2) < 1e-6) &&
      !back.some((v) => Math.abs(v - 3) < 1e-6),
    `one undo reverts both ${back}`,
  );
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});
