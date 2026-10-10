/**
 * UI-A outliner (UI-20 / UI-21): range / toggle multi-select, inline rename (F2 and double-click), drop indicators and
 * drag reorder / reparent, eye / lock / solo, colour tags and tag chips, search filters, thumbnails, selection sets,
 * and the virtualised list on a large scene.
 */
import { assert, newPage, shot } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const names = (page) => page.evaluate(() => window.physicslab.store.all().map((e) => e.name));
const sel = (page) =>
  page.evaluate(() => window.physicslab.store.selection.map((id) => window.physicslab.store.get(id).name).sort());
const row = (page, name) => page.locator(`.o-item:has(.o-name:text-is("${name}"))`);

test('outliner A: select ranges, rename, drag with drop indicators, eye / lock / solo, thumbnails', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physicslab;
    a.newScene();
    for (const [n, x] of [
      ['Aaa', -3],
      ['Bbb', -1],
      ['Ccc', 1],
      ['Ddd', 3],
    ])
      a.editor.addShape('box', [x, 0.5, 0], { name: n });
    a.editor.addShape('sphere', [0, 0.5, 3], { name: 'Ball' });
    a.editor.addGroup([0, 0, -3]).name;
    a.store.setSelection([]);
  });
  await page.click('.tab:has-text("Outliner")');
  assert((await page.locator('.o-item').count()) === 6, 'six rows');
  // Shift range, Ctrl toggle
  await row(page, 'Aaa').click();
  await row(page, 'Ccc').click({ modifiers: ['Shift'] });
  assert((await sel(page)).join() === 'Aaa,Bbb,Ccc', `shift selects the range: ${await sel(page)}`);
  await row(page, 'Ddd').click({ modifiers: ['Control'] });
  await row(page, 'Bbb').click({ modifiers: ['Control'] });
  assert((await sel(page)).join() === 'Aaa,Ccc,Ddd', `ctrl toggles: ${await sel(page)}`);
  // keyboard: arrows move the selection, F2 renames
  await row(page, 'Bbb').click();
  await page.keyboard.press('ArrowDown');
  assert((await sel(page)).join() === 'Ccc', 'ArrowDown moves to the next row');
  await page.keyboard.press('F2');
  await page.locator('.o-rename').fill('Renamed');
  await page.keyboard.press('Enter');
  assert((await names(page)).includes('Renamed'), 'F2 + Enter renames');
  await row(page, 'Ddd').locator('.o-name').dblclick();
  await page.locator('.o-rename').fill('Dee');
  await page.keyboard.press('Enter');
  assert((await names(page)).includes('Dee'), 'double-click renames');
  await page.locator('.o-item:has(.o-name:text-is("Dee"))').click();
  await page.keyboard.press('F2');
  await page.locator('.o-rename').fill('zzz');
  await page.keyboard.press('Escape');
  assert((await names(page)).includes('Dee'), 'Escape cancels a rename');
  // drag: indicator while hovering, reorder on drop
  const src = await row(page, 'Dee').boundingBox();
  const dst = await row(page, 'Aaa').boundingBox();
  await page.mouse.move(src.x + 60, src.y + 14);
  await page.mouse.down();
  await page.mouse.move(dst.x + 60, dst.y + 14, { steps: 6 });
  await page.mouse.move(dst.x + 60, dst.y + 3, { steps: 3 });
  assert((await page.locator('.o-item.drop-before').count()) === 1, 'a drop-before indicator shows on the hovered row');
  await page.mouse.up();
  const order = await names(page);
  assert(order.indexOf('Dee') < order.indexOf('Aaa') && order.indexOf('Dee') === 0, `dropped before Aaa: ${order}`);
  await page.keyboard.press('Control+z');
  assert((await names(page))[0] !== 'Dee', 'reorder is one undo step');
  // drop into the group (middle band) and out again (panel)
  const g = await page.locator('.o-item.is-group').boundingBox();
  const bbb = await row(page, 'Bbb').boundingBox();
  await page.mouse.move(bbb.x + 60, bbb.y + 14);
  await page.mouse.down();
  await page.mouse.move(g.x + 60, g.y + 14, { steps: 6 });
  await page.mouse.move(g.x + 62, g.y + 15, { steps: 2 });
  assert(
    (await page.locator('.o-item.drop-inside').count()) === 1,
    `drop-inside indicator on a group: ${JSON.stringify({ g, bbb, rows: await page.evaluate(() => [...document.querySelectorAll('.o-item')].map((r) => r.className + '@' + r.getBoundingClientRect().top)) })}`,
  );
  await page.mouse.up();
  const parentOf = (n) =>
    page.evaluate((n) => {
      const s = window.physicslab.store;
      const e = s.all().find((x) => x.name === n);
      return e.parent ? s.get(e.parent).kind : null;
    }, n);
  assert((await parentOf('Bbb')) === 'group', 'dropping on a group parents the row');
  // eye / lock / solo
  await row(page, 'Ball').hover();
  await row(page, 'Ball').locator('[data-act=eye]').click();
  await row(page, 'Ball').locator('[data-act=lock]').click();
  const ball = () =>
    page.evaluate(() => {
      const b = window.physicslab.store.bodies().find((x) => x.name === 'Ball');
      return { hidden: b.hidden, locked: b.locked };
    });
  assert(JSON.stringify(await ball()) === '{"hidden":true,"locked":true}', 'eye and lock buttons toggle the flags');
  await row(page, 'Ball').locator('[data-act=eye]').click();
  await row(page, 'Ball').locator('[data-act=lock]').click();
  await row(page, 'Ccc').count();
  await row(page, 'Renamed').hover();
  await row(page, 'Renamed').locator('[data-act=solo]').click();
  const hiddenNow = await page.evaluate(() => window.physicslab.store.all().filter((e) => e.hidden).length);
  assert(hiddenNow === 5, `solo hides everything unrelated (${hiddenNow})`);
  await row(page, 'Renamed').locator('[data-act=solo]').click();
  assert(
    (await page.evaluate(() => window.physicslab.store.all().filter((e) => e.hidden || e.solo || e.soloHid).length)) ===
      0,
    'un-solo restores everything',
  );
  // thumbnails: a real render of the shape
  await page.waitForFunction(() => document.querySelector('.o-item .o-thumb'), null, { timeout: 15000 });
  const thumb = await page.evaluate(() => document.querySelector('.o-item .o-thumb').getAttribute('src'));
  assert(thumb.startsWith('data:image/png;base64,') && thumb.length > 400, 'a rendered thumbnail, not an icon');
  await shot(page, 'outlinerA-tree');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('outliner A: tags, colour tags, filters, selection sets', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physicslab;
    a.newScene();
    a.editor.addShape('box', [-2, 0.5, 0], { name: 'Wheel L' });
    a.editor.addShape('box', [2, 0.5, 0], { name: 'Wheel R' });
    a.editor.addShape('sphere', [0, 0.5, 0], { name: 'Ball' });
    a.store.setSelection([]);
  });
  await page.click('.tab:has-text("Outliner")');
  // tag the two wheels through the context menu
  await row(page, 'Wheel L').click();
  await row(page, 'Wheel R').click({ modifiers: ['Control'] });
  await row(page, 'Wheel R').click({ button: 'right' });
  await page.locator('.menu-item:has-text("Add tag")').click();
  await page.locator('.modal input').fill('wheel');
  await page.keyboard.press('Enter');
  assert(
    (await page.evaluate(() => window.physicslab.store.bodies().filter((b) => b.tags.includes('wheel')).length)) === 2,
    'tag added to both selected bodies',
  );
  await row(page, 'Wheel R').click({ button: 'right' });
  await page.locator('.menu-item:has-text("Colour: red")').click();
  assert((await page.locator('.o-item .o-ctag').count()) === 2, 'colour dots on both rows');
  assert((await page.locator('.o-item .o-chip').count()) === 2, 'tag chips on both rows');
  // quick-select by tag: row chip and tag bar
  await row(page, 'Ball').click();
  await page.locator('.o-tags .o-tagchip:has-text("wheel")').click();
  assert((await sel(page)).join() === 'Wheel L,Wheel R', 'tag bar chip selects every tagged object');
  await row(page, 'Ball').click();
  await page.locator('.o-item .o-chip').first().click();
  assert((await sel(page)).join() === 'Wheel L,Wheel R', 'a row chip selects by tag');
  // search with filters
  await page.fill('.o-toolbar input', 'tag:wheel');
  assert((await page.locator('.o-item').count()) === 2, 'tag: filter');
  await page.fill('.o-toolbar input', 'type:sphere');
  assert((await page.locator('.o-item').count()) === 1, 'type: filter');
  await page.fill('.o-toolbar input', 'is:locked');
  assert((await page.locator('.o-item').count()) === 0, 'is:locked finds nothing');
  await page.fill('.o-toolbar input', '');
  await page.click('.o-filter-btn');
  await page.selectOption('.o-filters select[aria-label=Type]', 'sphere');
  assert((await page.locator('.o-item').count()) === 1, 'type dropdown filter');
  await page.selectOption('.o-filters select[aria-label=Type]', '');
  // sort
  await page.selectOption('.o-sort', 'nameDesc');
  assert((await page.locator('.o-item .o-name').first().textContent()) === 'Wheel R', 'sort Z-A');
  await page.selectOption('.o-sort', 'manual');
  // selection sets: save, clear, recall, survive a serialize round trip
  await row(page, 'Wheel L').click();
  await row(page, 'Ball').click({ modifiers: ['Control'] });
  await page.click('.o-set-add');
  await page.locator('.modal input').fill('Mix');
  await page.keyboard.press('Enter');
  await row(page, 'Wheel R').click();
  await page.locator('.o-set:has-text("Mix")').click();
  assert((await sel(page)).join() === 'Ball,Wheel L', 'recalling a set selects its members');
  const round = await page.evaluate(async () => {
    const m = await import('/src/model/serialize.ts');
    const a = window.physicslab;
    return m
      .parseDocument(m.serializeDocument(a.store.toDocument()))
      .settings.selectionSets.map((s) => `${s.name}:${s.ids.length}`);
  });
  assert(round.join() === 'Mix:2', `sets are saved in the scene: ${round}`);
  await page.keyboard.press('Control+z');
  assert((await page.locator('.o-set').count()) === 0, 'saving a set is undoable');
  await shot(page, 'outlinerA-tags');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('outliner A: a scene of thousands of objects only mounts the visible rows', async () => {
  const page = await newPage();
  await page.evaluate(async () => {
    const { createBody } = await import('/src/model/factory.ts');
    const a = window.physicslab;
    a.newScene();
    const list = [];
    for (let i = 0; i < 4000; i++)
      list.push(
        createBody({
          name: `Obj ${String(i).padStart(4, '0')}`,
          shape: { type: 'box' },
          position: [i % 60, 0.5, Math.floor(i / 60)],
        }),
      );
    a.store.add(list, 'many');
    a.store.setSelection([]);
  });
  await page.click('.tab:has-text("Outliner")');
  await page.waitForFunction(() => document.querySelector('.o-footer')?.textContent?.startsWith('4000'));
  const mounted = await page.locator('.o-item').count();
  assert(mounted > 5 && mounted < 80, `only a window of rows exists (${mounted} of 4000)`);
  const h = await page.evaluate(() => document.querySelector('.o-spacer').offsetHeight);
  assert(h === 4000 * 28, `the scrollbar covers all rows (${h})`);
  await page.evaluate(() => {
    document.querySelector('.o-scroll').scrollTop = 1e9;
  });
  await page.locator('.o-item:has(.o-name:text-is("Obj 3999"))').waitFor({ timeout: 5000 });
  // selecting an object far away scrolls it into view
  await page.evaluate(() => {
    const a = window.physicslab;
    a.store.setSelection([a.store.bodies().find((b) => b.name === 'Obj 0010').id]);
  });
  await page.locator('.o-item.sel:has(.o-name:text-is("Obj 0010"))').waitFor({ timeout: 5000 });
  assert((await page.locator('.o-item').count()) < 80, 'still a small window after scrolling');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});
