/**
 * End-to-end tests for zones, races and the world bounds (ZN): adding zones from the Add tab and the palette, the
 * volumes drawn in the viewport (and how they are picked), the Zone component in the inspector, a race run in the real
 * worker with the board, the Zones tab and the events API, kill / launch / teleport / spawn zones, and the World
 * bounds section.
 */
import { assert, near, newPage, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const blur = (page) => page.evaluate(() => document.activeElement?.blur());

/** An empty scene with a ground, camera looking down the +x axis from the side. */
async function emptyScene(page, over = {}) {
  await page.evaluate((over) => {
    const a = window.physicslab;
    a.newScene();
    if (over.settings) a.store.updateSettings(over.settings);
    a.viewport.setView({ position: [18, 12, 22], target: [18, 0, 0] });
  }, over);
}

test('zones: the Add tab adds zones as coloured volumes, selected, in one undo step each', async () => {
  const page = await newPage();
  await emptyScene(page);
  await page.click('.panel.left .tab:has-text("Add")');
  await page.waitForSelector('.zone-tiles .tile[data-zone="checkpoint"]');
  const tiles = await page.locator('.zone-tiles .tile').count();
  assert(tiles === 15, `one tile per action: ${tiles}`);
  await page.click('.zone-tiles .tile[data-zone="checkpoint"]');
  await page.click('.zone-tiles .tile[data-zone="checkpoint"]');
  await page.click('.zone-tiles .tile[data-zone="finish"]');
  const made = await page.evaluate(() =>
    window.physicslab.store
      .bodies()
      .map((b) => [
        b.name,
        b.ghost,
        b.bodyType,
        b.components[0]?.type,
        b.components[0]?.params.action,
        b.components[0]?.params.index,
      ]),
  );
  assert(
    JSON.stringify(made) ===
      JSON.stringify([
        ['Checkpoint 1', true, 'static', 'zone', 'checkpoint', 1],
        ['Checkpoint 2', true, 'static', 'zone', 'checkpoint', 2],
        ['Finish line', true, 'static', 'zone', 'finish', 1],
      ]),
    `ghost static zone bodies, numbered in order: ${JSON.stringify(made)}`,
  );
  const sel = await page.evaluate(() => window.physicslab.store.selection.length);
  assert(sel === 1, 'the new zone is selected');
  // volumes are decorated (outline + tint) and captioned
  await page.waitForFunction(() => window.physicslab.zoneViews.volumeCount === 3);
  await page.waitForSelector('.v-label.zone-label');
  const captions = await page.locator('.v-label.zone-label').allTextContents();
  assert(captions.includes('Checkpoint 2') && captions.includes('Finish line'), `captions: ${captions}`);
  await shot(page, 'zn-add-zones');
  // undo removes just the last one
  await page.evaluate(() => window.physicslab.store.undo());
  assert((await page.evaluate(() => window.physicslab.store.bodies().length)) === 2, 'undo removed one zone');
  assert(errors(page) === 0, `no console errors: ${page.errors}`);
});

const errors = (page) => page.errors.length;

test('zones: the inspector shows the Zone component with action-specific fields and a warning for a solid body', async () => {
  const page = await newPage();
  await emptyScene(page);
  const id = await page.evaluate(() => window.physicslab.zones.add('launch', [18, 0, 0]).id);
  await page.waitForSelector('.panel.right .comp[data-type="zone"]');
  const card = page.locator('.panel.right .comp[data-type="zone"]');
  const labels = await card.locator('.comp-row:visible .row-label').allTextContents();
  assert(
    labels.includes('Action') && labels.includes('Launch') && labels.includes('Launch as'),
    `launch fields: ${labels}`,
  );
  assert(!labels.includes('Checkpoint no.') && !labels.includes('Target body'), 'fields of other actions are hidden');
  await card.locator('.comp-row:has(.row-label:text-is("Action")) select').selectOption('teleport');
  const after = await card.locator('.comp-row:visible .row-label').allTextContents();
  assert(
    after.includes('Target body') && after.includes('Arrive') && !after.includes('Launch as'),
    `teleport fields: ${after}`,
  );
  await card.locator('.comp-row:has(.row-label:text-is("Action")) select').selectOption('toggle');
  await page.waitForTimeout(100);
  const opts = await card.locator('.comp-row:has(.row-label:text-is("Component")) option').allTextContents();
  assert(
    opts.includes('Every component') && opts.includes('Constant force') && opts.includes('Zone'),
    `component list follows the registry: ${opts}`,
  );
  // a zone body that is not a ghost explains what to do
  await page.evaluate((id) => window.physicslab.store.update(id, { ghost: false }), id);
  await page.waitForTimeout(150);
  const warn = await card.locator('.comp-warn').first().textContent();
  assert(/Ghost/.test(warn ?? ''), `warning for a solid zone body: ${warn}`);
  await shot(page, 'zn-inspector');
  assert(errors(page) === 0, `no console errors: ${page.errors}`);
});

test('zones: a ray that also hits a solid body picks the body, not the zone volume around it', async () => {
  const page = await newPage();
  await emptyScene(page);
  const ids = await page.evaluate(() => {
    const a = window.physicslab;
    const z = a.zones.add('none', [18, 0, 0]);
    const crate = a.editor.addShape('box', [18, 0.5, 0], { name: 'Crate' });
    a.store.setSelection([]);
    return { z: z.id, crate: crate.id };
  });
  await page.waitForFunction(() => window.physicslab.zoneViews.volumeCount === 1);
  await blur(page);
  const pickAt = (id, dy = 0) =>
    page.evaluate(
      async ({ id, dy }) => {
        const a = window.physicslab;
        await new Promise((r) => requestAnimationFrame(() => r()));
        const v = a.bodies.get(id);
        const p = v.position.clone();
        p.y += dy;
        p.project(a.camera);
        const r = a.viewport.dom.getBoundingClientRect();
        const ev = { clientX: r.left + ((p.x + 1) / 2) * r.width, clientY: r.top + ((1 - p.y) / 2) * r.height };
        return a.pickEntity(ev)?.entityId ?? null;
      },
      { id, dy },
    );
  assert((await pickAt(ids.crate)) === ids.crate, 'the crate inside the zone is picked');
  // a point of the zone volume with nothing solid behind it picks the zone
  const hit = await page.evaluate(async (zid) => {
    const a = window.physicslab;
    await new Promise((r) => requestAnimationFrame(() => r()));
    const v = a.bodies.get(zid);
    const p = v.position.clone();
    p.y += 1.2; // upper part of the volume, above the crate
    p.project(a.camera);
    const r = a.viewport.dom.getBoundingClientRect();
    return (
      a.pickEntity({ clientX: r.left + ((p.x + 1) / 2) * r.width, clientY: r.top + ((1 - p.y) / 2) * r.height })
        ?.entityId ?? null
    );
  }, ids.z);
  assert(hit === ids.z, `the zone is picked where nothing solid is in the way: ${hit}`);
  assert(errors(page) === 0, `no console errors: ${page.errors}`);
});
