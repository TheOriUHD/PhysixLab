/** UI-1 dockable panels: drag between regions, tabs, splits, floating windows, maximise, presets, persistence. */
import { assert, newPage, shot } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const tabsOf = async (page, sel) => (await page.locator(`${sel} .tab`).allTextContents()).map((t) => t.trim());
const centre = async (page, sel) => {
  const b = await page.locator(sel).first().boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
};
const drag = async (page, from, to, steps = 12) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 4, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
};

test('dock: dragging a tab to another region moves the panel, and the layout survives a reload', async () => {
  const page = await newPage();
  assert((await tabsOf(page, '.panel.right')).includes('Outliner'), 'outliner starts on the right');
  const from = await centre(page, '.panel.right .tab:has-text("Outliner")');
  const to = await centre(page, '.panel.left .dock-ghead');
  await drag(page, from, to);
  assert(
    (await tabsOf(page, '.panel.left')).includes('Outliner'),
    `outliner now on the left: ${await tabsOf(page, '.panel.left')}`,
  );
  assert(!(await tabsOf(page, '.panel.right')).includes('Outliner'), 'and gone from the right');
  assert((await page.locator('.panel.left .tab.on').textContent()).trim() === 'Outliner', 'it is the visible tab');
  assert(await page.locator('.panel.left .outliner').isVisible(), 'its content shows in the left region');
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForFunction(() => !!window.physicslab);
  assert((await tabsOf(page, '.panel.left')).includes('Outliner'), 'layout restored after a reload');
  await page.evaluate(async () =>
    (await import('/src/app/registry/index.ts')).runCommand('layout.reset', window.physicslab, 'api'),
  );
  assert((await tabsOf(page, '.panel.right')).includes('Outliner'), 'Reset layout puts it back');
  assert(page.errors.length === 0, page.errors.join(' | '));
  await page.close();
});

test('dock: dropping on a group edge splits it; a panel pops out as a floating window that can be moved, resized and docked back', async () => {
  const page = await newPage();
  const g = await centre(page, '.panel.right .dock-group');
  const box = g.box;
  const from = await centre(page, '.panel.right .tab:has-text("World")');
  await drag(page, from, { x: box.x + box.width / 2, y: box.y + box.height - 12 });
  const groups = await page.locator('.panel.right .dock-group').count();
  assert(groups === 2, `right region split into two groups (${groups})`);
  assert(
    (await page.locator('.panel.right .dock-group').nth(1).locator('.tab').allTextContents()).join().includes('World'),
    'World in the second group',
  );

  // Float the outliner through the command (keyboard route), then move and resize it with the mouse.
  await page.evaluate(async () =>
    (await import('/src/app/registry/index.ts')).runCommand('panel.outliner.float', window.physicslab, 'api'),
  );
  const win = page.locator('.dock-float-layer .dock-group');
  assert((await win.count()) === 1, 'one floating window');
  const b0 = await win.boundingBox();
  const head = await centre(page, '.dock-float-layer .dock-ghead');
  await page.mouse.move(b0.x + b0.width - 60, head.y);
  await page.mouse.down();
  await page.mouse.move(b0.x + b0.width - 60 - 200, head.y + 90, { steps: 6 });
  await page.mouse.up();
  const b1 = await win.boundingBox();
  assert(
    Math.abs(b1.x - (b0.x - 200)) < 3 && Math.abs(b1.y - (b0.y + 90)) < 3,
    `window moved (${b0.x},${b0.y}) → (${b1.x},${b1.y})`,
  );
  const corner = { x: b1.x + b1.width - 3, y: b1.y + b1.height - 3 };
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x + 80, corner.y + 60, { steps: 5 });
  await page.mouse.up();
  const b2 = await win.boundingBox();
  assert(
    b2.width > b1.width + 60 && b2.height > b1.height + 40,
    `window resized (${b1.width}x${b1.height} → ${b2.width}x${b2.height})`,
  );
  assert(await win.locator('.outliner').isVisible(), 'the outliner content lives in the window');
  await shot(page, 'dock-float');

  // Maximise / restore with the group button, then dock back.
  await win.locator('button[title="Maximise"]').click();
  const mb = await win.boundingBox();
  assert(mb.width >= 1590 && mb.y >= 40, `maximised fills the workspace (${mb.width}x${mb.height})`);
  await page.keyboard.press('Escape');
  assert((await win.boundingBox()).width < 1000, 'Escape restores');
  await win.locator('button[title="Dock back"]').click();
  assert((await page.locator('.dock-float-layer .dock-group').count()) === 0, 'floating window gone');
  assert((await tabsOf(page, '.panel.right')).includes('Outliner'), 'outliner docked back home');
  assert(page.errors.length === 0, page.errors.join(' | '));
  await page.close();
});

test('dock: layout presets and saved layouts', async () => {
  const page = await newPage();
  const run = (id) =>
    page.evaluate(
      async (id) => (await import('/src/app/registry/index.ts')).runCommand(id, window.physicslab, 'api'),
      id,
    );
  await run('layout.preset.present');
  const p = await page.evaluate(() => window.physicslab.prefs.value);
  assert(!p.showLeft && !p.showRight && !p.showBottom, 'Present hides every dock');
  await run('layout.preset.analyse');
  assert(await page.locator('.dock').isVisible(), 'Analyse shows the bottom dock');
  assert((await page.locator('.dock').boundingBox()).height > 280, 'and makes it tall');
  await page.evaluate(() => {
    const d = window.physicslab;
    d.prefs.set({ showRight: true });
  });
  await run('layout.preset.build');
  assert((await page.locator('.panel.right .dock-group').count()) === 2, 'Build puts the outliner in its own group');
  await page.evaluate(async () => {
    const m = await import('/src/ui/dock/dockManager.ts');
    m.getDock(window.physicslab).saveCurrent('Mine');
  });
  await run('layout.reset');
  assert((await page.locator('.panel.right .dock-group').count()) === 1, 'reset: one group');
  await page.evaluate(async () => {
    const m = await import('/src/ui/dock/dockManager.ts');
    m.getDock(window.physicslab).applySaved('Mine');
  });
  assert((await page.locator('.panel.right .dock-group').count()) === 2, 'the saved layout comes back');
  assert(page.errors.length === 0, page.errors.join(' | '));
  await page.close();
});
