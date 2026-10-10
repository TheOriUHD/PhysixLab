/** UI-2 quick-properties bar + floating inspector that follows the selection; UI-3 Simple / Advanced mode. */
import { assert, newPage, shot } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const run = (page, id) =>
  page.evaluate(
    async (id) => (await import('/src/app/registry/index.ts')).runCommand(id, window.physixlab, 'api'),
    id,
  );

test('quickbar: the quick-properties bar edits the selected body (undoable) and follows the selection', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(() => {
    const a = window.physixlab;
    a.store.setSelection([a.store.bodies()[0].id]);
  });
  const bar = page.locator('.quickbar');
  assert(await bar.isVisible(), 'the bar shows for a selection');
  const id = await page.evaluate(() => window.physixlab.store.selection[0]);
  // Mass.
  await bar.locator('.qb-mass input').fill('42');
  await bar.locator('.qb-mass input').press('Enter');
  assert(
    (await page.evaluate((id) => window.physixlab.store.get(id).massOverride, id)) === 42,
    'mass override written',
  );
  // Lock.
  await bar.locator('button[title^="Lock"]').click();
  assert(await page.evaluate((id) => window.physixlab.store.get(id).locked, id), 'locked');
  // Material.
  await bar.locator('.qb-mat select').selectOption('wood');
  assert((await page.evaluate((id) => window.physixlab.store.get(id).material.preset, id)) === 'wood', 'material set');
  // Undo reverts the material.
  await page.evaluate(() => window.physixlab.editor.undo?.() ?? window.physixlab.store.undo());
  assert((await page.evaluate((id) => window.physixlab.store.get(id).material.preset, id)) !== 'wood', 'undo works');
  // Hidden when nothing is selected, and switchable off.
  await page.evaluate(() => window.physixlab.store.setSelection([]));
  assert(!(await bar.isVisible()), 'no selection: no bar');
  await page.evaluate(() => window.physixlab.store.setSelection([window.physixlab.store.bodies()[1].id]));
  await run(page, 'ui.quickbar');
  assert(!(await bar.isVisible()), 'command switches the bar off');
  assert(page.errors.length === 0, page.errors.join(' | '));
  await page.close();
});

test('floating inspector follows the selection until pinned', async () => {
  const page = await newPage('&scene=car');
  const bodies = await page.evaluate(() => window.physixlab.store.bodies().map((b) => b.id));
  const leftmost = await page.evaluate(() => {
    const app = window.physixlab;
    let best = null;
    let bx = 2;
    for (const b of app.store.bodies()) {
      const v = app.bodies.get(b.id);
      if (!v) continue;
      const p = v.position.clone().project(app.camera);
      if (p.x < bx) {
        bx = p.x;
        best = b.id;
      }
    }
    return best;
  });
  await page.evaluate((id) => window.physixlab.store.setSelection([id]), leftmost);
  await run(page, 'ui.inspector.float');
  const win = page.locator('.dock-float-layer .dock-group');
  assert((await win.count()) === 1 && (await win.locator('.panel-body').count()) > 0, 'inspector floats');
  await page.waitForTimeout(3000);
  const a = await win.boundingBox();
  // Select a wheel (a body on the other side of the screen): the window glides to it.
  const far = await page.evaluate(() => {
    const app = window.physixlab;
    let best = null;
    let bx = -1;
    for (const b of app.store.bodies()) {
      const v = app.bodies.get(b.id);
      if (!v) continue;
      const p = v.position.clone().project(app.camera);
      if (p.x > bx) {
        bx = p.x;
        best = b.id;
      }
    }
    return best;
  });
  await page.evaluate((id) => window.physixlab.store.setSelection([id]), far);
  await page.waitForTimeout(4000);
  const b = await win.boundingBox();
  assert(
    Math.abs(b.x - a.x) > 5 || Math.abs(b.y - a.y) > 5,
    `window moved to the new selection (${a.x},${a.y}) → (${b.x},${b.y})`,
  );
  // Pin: it stays when the selection changes.
  await win.locator('button[title^="Following"]').click();
  const b2 = await win.boundingBox();
  await page.evaluate((id) => window.physixlab.store.setSelection([id]), bodies[0]);
  await page.waitForTimeout(900);
  const c = await win.boundingBox();
  const pinnedNow = await page.evaluate(async () =>
    (await import('/src/ui/dock/dockManager.ts')).getDock(window.physixlab).isPinned('inspector'),
  );
  assert(pinnedNow, 'the pin button pins');
  assert(
    Math.abs(c.x - b2.x) < 2 && Math.abs(c.y - b2.y) < 2,
    `pinned window stays put (${b.x},${b.y}) → (${c.x},${c.y})`,
  );
  await shot(page, 'dock-float-inspector');
  assert(page.errors.length === 0, page.errors.join(' | '));
  await page.close();
});

test('Simple mode hides advanced inspector sections and persists; Advanced shows them again', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(() => {
    const a = window.physixlab;
    a.store.setSelection([a.store.bodies()[0].id]);
  });
  const comp = page.locator('.panel.right section.section[data-sid="components"]');
  assert(await comp.isVisible(), 'Components visible in Advanced mode');
  await run(page, 'ui.mode.simple');
  assert(!(await comp.isVisible()), 'Components hidden in Simple mode');
  assert((await page.locator('#app.ui-simple').count()) === 1, 'class on #app');
  const labels = (await page.locator('.panel.right .row-label').allTextContents()).join('|');
  assert(/Air slow-down/.test(labels) && !/Lin\. damping/.test(labels), `friendlier labels: ${labels}`);
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForFunction(() => !!window.physixlab);
  assert((await page.locator('#app.ui-simple').count()) === 1, 'mode survives a reload');
  await run(page, 'ui.mode.advanced');
  await page.evaluate(() => {
    const a = window.physixlab;
    a.store.setSelection([a.store.bodies()[0].id]);
  });
  assert(await comp.isVisible(), 'Components back in Advanced mode');
  assert(page.errors.length === 0, page.errors.join(' | '));
  await page.close();
});
