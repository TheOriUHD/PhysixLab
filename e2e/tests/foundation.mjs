/**
 * Foundation end-to-end tests: the shape registry driving the palette, shortcuts and inspector, loading
 * old (v1) and damaged scene files, compound bodies, per-body physics fields and the asset store.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, near, newPage, root, screenOf, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const fixture = (name) => readFileSync(join(root, 'tests', 'fixtures', name));

test('shape registry: palette, number keys and the prism inspector come from the registry', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physicslab.newScene());
  const reg = await page.evaluate(async () => {
    const { listShapes } = await import('/src/model/shapeRegistry.ts');
    return listShapes().map((d) => ({ id: d.id, label: d.label }));
  });
  assert(reg.length === 8, `eight built-in shapes registered (${reg.length})`);
  const tiles = await page.locator('.panel.left .tiles').first().locator('.tile').allTextContents();
  assert(
    tiles.map((t) => t.trim()).join() === reg.map((d) => d.label).join(),
    `palette tiles follow the registry: ${tiles.join()}`,
  );
  // the number keys address the registry order (7 = prism)
  await page.click('.viewport-canvas', { position: { x: 700, y: 400 } });
  await page.keyboard.press('7');
  const prism = await page.evaluate(() => {
    const b = window.physicslab.store.bodies()[0];
    return { type: b.shape.type, params: b.shape.params, id: b.id };
  });
  assert(
    prism.type === 'prism' && prism.params.sides === 6,
    `key 7 adds a prism with default sides ${JSON.stringify(prism)}`,
  );
  // the inspector shows the registry's parameter schema for it
  await page.waitForSelector('.panel.right .row:has(.row-label:text-is("Sides"))');
  const sides = page.locator('.panel.right .row:has(.row-label:text-is("Sides")) .num-input:visible');
  await sides.fill('9');
  await sides.press('Enter');
  const after = await page.evaluate((id) => window.physicslab.store.body(id).shape.params.sides, prism.id);
  assert(after === 9, `sides edited through the generated field (got ${after})`);
  // the rendered mesh follows: a 9-sided prism has more vertices than a 6-sided one
  const verts = await page.evaluate(
    (id) => window.physicslab.bodies.get(id).mesh.geometry.getAttribute('position').count,
    prism.id,
  );
  assert(verts > 60, `prism mesh rebuilt for 9 sides (${verts} vertices)`);
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate((id) => window.physicslab.store.body(id).shape.params.sides, prism.id);
  assert(undone === 6, `undo restores the parameter (got ${undone})`);
  await shot(page, 'fb-prism-inspector');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('scene files: a v1 file upgrades on import and a damaged one is repaired with a warning', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physicslab.newScene());
  // 1. the scene written by the first release
  await page.setInputFiles('input[type=file]', {
    name: 'legacy.json',
    mimeType: 'application/json',
    buffer: fixture('scene-v1.json'),
  });
  await page.waitForFunction(() => window.physicslab.store.name === 'Legacy kitchen sink', null, { timeout: 10000 });
  const legacy = await page.evaluate(() => {
    const d = window.physicslab.store.toDocument();
    const pent = d.entities.find((e) => e.name === 'Pentagon');
    return {
      version: d.version,
      assets: d.assets,
      sides: pent.shape.params.sides,
      legacy: 'sides' in pent.shape,
      gravity: d.settings.gravity,
    };
  });
  assert(legacy.version === 2 && Object.keys(legacy.assets).length === 0, `upgraded to v2 ${JSON.stringify(legacy)}`);
  assert(legacy.sides === 5 && !legacy.legacy, 'prism side count moved into shape.params');
  near(legacy.gravity[1], -3.7, 1e-9, 'authored gravity survives');
  // it simulates
  await page.keyboard.press('Space');
  await simTime(page, 0.5);
  await page.keyboard.press('Space');
  await page.click('.tbtn[title^="Stop"]');
  // 2. a file naming a shape this build does not have
  const broken = JSON.parse(fixture('scene-v1.json').toString());
  broken.name = 'From the future';
  broken.entities[0].shape = { type: 'tesseract', size: [2, 2, 2] };
  await page.evaluate(() => window.physicslab.store.update(window.physicslab.store.bodies()[0].id, { name: 'dirty' }));
  await page.setInputFiles('input[type=file]', {
    name: 'odd.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(broken)),
  });
  await page.waitForSelector('.modal button:has-text("Replace scene")');
  await page.click('.modal button:has-text("Replace scene")');
  await page.waitForFunction(() => window.physicslab.store.name === 'From the future', null, { timeout: 10000 });
  const toast = await page.locator('.toast.warn').first().textContent();
  assert(/Unknown shape "tesseract"/.test(toast ?? ''), `a warning explains the repair: ${toast}`);
  const type = await page.evaluate(() => window.physicslab.store.bodies()[0].shape.type);
  assert(type === 'box', `unknown shape became a box (${type})`);
  // 3. a newer file is refused with a message that says what to do
  const future = JSON.parse(fixture('scene-v1.json').toString());
  future.version = 99;
  await page.setInputFiles('input[type=file]', {
    name: 'future.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(future)),
  });
  await page.waitForSelector('.toast.error');
  const err = await page.locator('.toast.error').first().textContent();
  assert(/newer version of PhysicsLab/.test(err ?? ''), `newer format rejected clearly: ${err}`);
  assert(
    (await page.evaluate(() => window.physicslab.store.name)) === 'From the future',
    'the open scene is untouched',
  );
  await shot(page, 'fb-import-warnings');
});
