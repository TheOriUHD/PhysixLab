/**
 * End-to-end tests of the user prefab library (ED-22): save the selection as a prefab from the command palette,
 * the "My prefabs" tile with its thumbnail, insert (one undo step), persistence across a reload, parametric
 * values at insert time, and export / import of a prefab pack in a fresh browser context.
 */
import { assert, newPage, shot } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const runCommand = async (page, text) => {
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette .palette-input');
  await page.fill('.palette-input', text);
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
};

const count = (page) => page.evaluate(() => window.physicslab.store.all().length);

const addTwoBoxes = (page) =>
  page.evaluate(() => {
    const a = window.physicslab;
    const b1 = a.addShape('box', [2, 0.5, 2]);
    const b2 = a.addShape('box', [4, 0.5, 2]);
    a.store.setSelection([b1.id, b2.id]);
  });

const saveSelection = async (page, name, tags) => {
  await runCommand(page, 'Save selection as prefab');
  await page.waitForSelector('.modal input.plain');
  const inputs = page.locator('.modal input.plain');
  await inputs.nth(0).fill(name);
  await inputs.nth(1).fill(tags);
  await page.click('.modal .btn.primary');
  await page.waitForSelector('.modal', { state: 'detached' });
};

const openMyPrefabs = async (page) => {
  await runCommand(page, 'Show My prefabs');
  await page.waitForSelector('.ed-pf-panel');
};

test('prefabs: save selection, tile with thumbnail, insert is one undo step, survives a reload', async () => {
  const page = await newPage();
  await addTwoBoxes(page);
  const base = await count(page);
  await saveSelection(page, 'E2E pair', 'test, pair');
  await openMyPrefabs(page);
  const tile = page.locator('.ed-pf-tile[data-name="E2E pair"]');
  await tile.waitFor();
  const src = await tile.locator('img').getAttribute('src');
  assert(src && src.startsWith('data:image/'), `thumbnail is an image data URL (${(src ?? '').slice(0, 30)})`);
  assert(src.length > 200, 'thumbnail has content');
  assert((await tile.locator('.chip-tag').allTextContents()).join(',').includes('pair'), 'tags are shown');

  // Insert by clicking the tile: two new bodies, selected, ONE undo step.
  await page.evaluate(() => window.physicslab.store.setSelection([]));
  await tile.locator('.ed-pf-main').click();
  await page.waitForFunction((n) => window.physicslab.store.all().length === n + 2, base);
  const sel = await page.evaluate(() => {
    const s = window.physicslab.store;
    return { selected: s.selection.length, names: s.selection.map((id) => s.get(id).name) };
  });
  assert(sel.selected === 2, `inserted objects are selected (${sel.selected})`);
  assert(new Set(sel.names).size === 2, 'names are unique');
  await shot(page, 'ed-prefabs-panel');
  await page.evaluate(() => window.physicslab.store.undo());
  assert((await count(page)) === base, 'one undo removes the whole insertion');
  await page.evaluate(() => window.physicslab.store.redo());
  assert((await count(page)) === base + 2, 'redo restores it');

  // The library is persisted: reload the page (same browser context, same storage).
  await page.reload();
  await page.waitForFunction(() => !!window.physicslab && window.physicslab.viewport, null, { timeout: 30000 });
  await openMyPrefabs(page);
  await page.locator('.ed-pf-tile[data-name="E2E pair"]').waitFor({ timeout: 10000 });
  assert(page.errors.length === 0, `no page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('prefabs: a number variable drives the size at insert time', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physicslab;
    const b = a.addShape('box', [0, 0.5, 0]);
    a.store.setSelection([b.id]);
  });
  await saveSelection(page, 'Scalable box', '');
  await openMyPrefabs(page);
  const tile = page.locator('.ed-pf-tile[data-name="Scalable box"]');
  await tile.waitFor();

  // Edit: add a variable bound to the scale of everything.
  await tile.locator('.ed-pf-more').click({ force: true });
  await page.click('.menu-item:has-text("Rename, tags, variables")');
  await page.waitForSelector('.ed-pf-edit');
  await page.click('.ed-pf-head .btn:has-text("Add variable")');
  await page.waitForSelector('.ed-pf-card[data-variable="0"]');
  await page.click('.modal-foot .btn.primary');
  await page.waitForSelector('.modal', { state: 'detached' });

  // Insert with values: scale 2.
  const before = await page.evaluate(() => window.physicslab.store.bodies().length);
  await tile.locator('.ed-pf-more').click({ force: true });
  await page.click('.menu-item:has-text("Insert with values")');
  await page.waitForSelector('.ed-pf-pair .ed-pf-num');
  await page.fill('.ed-pf-pair .ed-pf-num', '2');
  await page.click('.modal-foot .btn.primary');
  await page.waitForFunction((n) => window.physicslab.store.bodies().length === n + 1, before);
  const size = await page.evaluate(() => {
    const s = window.physicslab.store;
    return s.get(s.selection[0]).shape.size;
  });
  assert(Math.abs(size[0] - 2) < 1e-6 && Math.abs(size[1] - 2) < 1e-6, `scaled to 2 m (${size})`);
  await page.close();
});

test('prefabs: dragging a tile into the viewport drops it on the surface under the pointer', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physicslab;
    const b = a.addShape('box', [0, 0.5, 0]);
    a.store.setSelection([b.id]);
  });
  await saveSelection(page, 'Dropped box', '');
  await openMyPrefabs(page);
  const tile = page.locator('.ed-pf-tile[data-name="Dropped box"]');
  await tile.waitFor();
  assert((await tile.locator('.ed-pf-main').getAttribute('draggable')) === 'true', 'tile is draggable');
  const id = await tile.getAttribute('data-prefab');
  const before = await count(page);
  const at = await page.evaluate(() => {
    const r = window.physicslab.viewport.dom.getBoundingClientRect();
    return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.85 };
  });
  await page.evaluate(
    ({ id, at }) => {
      const dom = window.physicslab.viewport.dom;
      const dt = new DataTransfer();
      dt.setData('text/x-physicslab-user-prefab', id);
      const init = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: at.x, clientY: at.y };
      dom.dispatchEvent(new DragEvent('dragover', init));
      dom.dispatchEvent(new DragEvent('drop', init));
    },
    { id, at },
  );
  await page.waitForFunction((n) => window.physicslab.store.all().length === n + 1, before);
  const y = await page.evaluate(() => {
    const s = window.physicslab.store;
    return s.get(s.selection[0]).position[1];
  });
  assert(y > 0.3 && y < 1.2, `dropped onto a surface, not floating or sunk (y = ${y})`);
  await page.close();
});

test('prefabs: export a pack and import it in a fresh browser context', async () => {
  const page = await newPage();
  await addTwoBoxes(page);
  await saveSelection(page, 'Packed pair', 'pack');
  await runCommand(page, 'Export prefab pack');
  await page.waitForSelector('.ed-pf-checks');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.modal-foot .btn.primary')]);
  const text = await new Promise((resolve, reject) => {
    download.createReadStream().then((stream) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    }, reject);
  });
  const pack = JSON.parse(text);
  assert(pack.format === 'physicslab-prefab-pack' && pack.prefabs.length === 1, 'pack format');
  await page.close();

  // A new page = a new browser context = empty storage.
  const fresh = await newPage();
  await openMyPrefabs(fresh);
  assert((await fresh.locator('.ed-pf-tile').count()) === 0, 'the fresh browser has no prefabs');
  assert(await fresh.locator('.ed-pf-empty').isVisible(), 'empty state with instructions is shown');
  const [chooser] = await Promise.all([fresh.waitForEvent('filechooser'), runCommand(fresh, 'Import prefab pack')]);
  await chooser.setFiles({ name: 'pack.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await fresh.locator('.ed-pf-tile[data-name="Packed pair"]').waitFor({ timeout: 10000 });

  // A hostile file is rejected with a message and nothing is added.
  const [chooser2] = await Promise.all([fresh.waitForEvent('filechooser'), runCommand(fresh, 'Import prefab pack')]);
  await chooser2.setFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"nope"}') });
  await fresh.waitForSelector('.toast:has-text("not a PhysicsLab prefab pack")', { timeout: 10000 });
  assert((await fresh.locator('.ed-pf-tile').count()) === 1, 'bad pack adds nothing');
  await fresh.close();
});
