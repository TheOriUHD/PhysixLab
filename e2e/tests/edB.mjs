/**
 * ED-B: undo history panel, kind-aware right-click menu with submenus, Shift+A add menu.
 */
import { assert, newPage, screenOf, shot, sleep } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const wait = (page, sel) =>
  page.waitForSelector(sel, { timeout: 15000 }).catch(() => {
    throw new Error(`timed out waiting for ${sel}`);
  });
const emptyScene = async (page) => {
  await page.evaluate(() => window.physicslab.newScene());
  await sleep(300);
};
const bodyCount = (page) => page.evaluate(() => window.physicslab.store.bodies().length);

test('edB history panel lists commands and a click restores the earlier state', async () => {
  const page = await newPage();
  await emptyScene(page);
  await page.evaluate(() => {
    window.physicslab.editor.addShape('box', [0, 0.5, 0]);
    window.physicslab.editor.addShape('sphere', [3, 0.5, 0]);
  });
  await page.click('.panel.right .tab:has-text("History")');
  await wait(page, '.hist-row');
  const labels = await page.locator('.hist-row .hist-label').allTextContents();
  assert(labels.join('|') === 'Start|Add Box|Add Sphere', `rows: ${labels}`);
  assert((await page.locator('.hist-row.current .hist-label').textContent()) === 'Add Sphere', 'current row marked');
  await shot(page, 'edB-history');
  await page.locator('.hist-row', { hasText: 'Add Box' }).click();
  assert((await bodyCount(page)) === 1, 'jumped back to one body');
  await wait(page, '.hist-branch');
  const redo = await page.locator('.hist-row.redo .hist-label').allTextContents();
  assert(redo.join() === 'Add Sphere', `redo branch ${redo}`);
  await shot(page, 'edB-history-branch');
  await page.locator('.hist-row', { hasText: 'Add Sphere' }).click();
  assert((await bodyCount(page)) === 2, 'jumped forward again');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

test('edB right-click: body menu has Delete and a Material submenu, empty space has Add', async () => {
  const page = await newPage();
  await emptyScene(page);
  const id = await page.evaluate(() => window.physicslab.editor.addShape('box', [0, 0.5, 0]).id);
  await page.evaluate(() => window.physicslab.store.setSelection([]));
  const sp = await screenOf(page, id);
  await page.mouse.click(sp.x, sp.y, { button: 'right' });
  await wait(page, '.menu');
  const items = await page.locator('.menu .menu-item').allTextContents();
  assert(
    items.some((t) => t.includes('Delete')),
    `Delete in ${items}`,
  );
  assert(
    items.some((t) => t.includes('Material')),
    `Material in ${items}`,
  );
  await shot(page, 'edB-context-body');
  await page.locator('.menu .menu-item', { hasText: 'Material' }).click();
  await wait(page, '.menu .menu-back');
  await page.locator('.menu .menu-item', { hasText: 'Steel' }).click();
  const preset = await page.evaluate((id) => window.physicslab.store.body(id).material.preset, id);
  assert(preset === 'steel', `material applied: ${preset}`);
  assert(!(await page.$('.menu')), 'menu closed after choosing');

  // empty space
  await page.mouse.click(1000, 300, { button: 'right' });
  await wait(page, '.menu');
  const sel = await page.evaluate(() => window.physicslab.store.selection.length);
  assert(sel === 0, 'right-clicking nothing leaves nothing selected');
  const empty = await page.locator('.menu .menu-item').allTextContents();
  assert(
    empty.some((t) => t.trim().startsWith('Add')),
    `Add in ${empty}`,
  );
  assert(!empty.some((t) => t.includes('Delete')), 'no Delete without selection');
  await page.locator('.menu .menu-item', { hasText: 'Add' }).first().click();
  await wait(page, '.menu .menu-back');
  await shot(page, 'edB-context-add');
  await page.keyboard.press('Escape');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

test('edB Shift+A opens the add menu, typing "sph" + Enter adds a sphere', async () => {
  const page = await newPage();
  await emptyScene(page);
  await page.mouse.move(800, 450);
  await page.keyboard.press('Shift+A');
  await wait(page, '.addmenu .addmenu-search');
  const focused = await page.evaluate(() => document.activeElement?.classList.contains('addmenu-search'));
  assert(focused, 'search is focused');
  await shot(page, 'edB-addmenu');
  await page.keyboard.type('sph');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.physicslab.store.bodies().length === 1);
  const type = await page.evaluate(() => window.physicslab.store.bodies()[0].shape.type);
  assert(type === 'sphere', `added ${type}`);
  assert(!(await page.$('.addmenu')), 'menu closed');
  await page.keyboard.press('Shift+A');
  await wait(page, '.addmenu');
  await page.keyboard.press('Escape');
  assert(!(await page.$('.addmenu')), 'Escape closes');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});
