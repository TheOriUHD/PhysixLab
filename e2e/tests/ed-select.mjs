/**
 * ED-1 end-to-end: lasso and paint select with real pointer input (replace / Shift add / Ctrl subtract), the brush
 * radius keys, the Select commands through the palette and the keyboard, and the Select-by-condition panel.
 */
import { assert, newPage, screenOf, shot } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const sel = (page) => page.evaluate(() => [...window.physicslab.store.selection]);
const names = (page) =>
  page.evaluate(() => window.physicslab.store.selection.map((id) => window.physicslab.store.get(id).name).sort());

/** Row of bodies along x at y = 0.5, camera looking at them. Returns ids by name. */
async function setup(page, extra) {
  return page.evaluate(
    (src) => {
      const extra = src ? new Function(`return ${src}`)() : null;
      const a = window.physicslab;
      a.newScene();
      a.prefs.set({ followSelection: false }); // the start-up scene follows its selection; the camera must stay put
      const ids = {};
      [-3, -1, 1, 3].forEach((x, i) => {
        const b = a.editor.addShape(i % 2 ? 'sphere' : 'box', [x, 0.5, 0], { name: `N${i}` });
        ids[b.name] = b.id;
      });
      if (extra) extra(a, ids);
      a.viewport.setView({ position: [0, 3, 10], target: [0, 0.5, 0] });
      a.store.setSelection([]);
      return ids;
    },
    extra ? extra.toString() : null,
  );
}

async function drag(page, pts, mods = []) {
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y, { steps: 3 });
  const mid = await page.evaluate(() => ({
    lasso: getComputedStyle(document.querySelector('.ed-lasso') ?? document.body).display,
    ring: getComputedStyle(document.querySelector('.ed-brush-ring') ?? document.body).display,
  }));
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
  return mid;
}

const around = (c, r) => [
  { x: c.x - r, y: c.y - r },
  { x: c.x + r, y: c.y - r },
  { x: c.x + r, y: c.y + r },
  { x: c.x - r, y: c.y + r },
  { x: c.x - r, y: c.y - r + 2 },
];

test('ED-1 lasso: replace, Shift adds, Ctrl subtracts; click picks one; outline shown while dragging', async () => {
  const page = await newPage();
  const ids = await setup(page);
  await page.click('.viewport-canvas', { position: { x: 700, y: 120 } }); // focus without selecting anything
  await page.keyboard.press('o');
  assert((await page.evaluate(() => window.physicslab.prefs.value.tool)) === 'lasso', 'O activates the lasso tool');
  assert(await page.locator('.toolbox [data-tool="lasso"]').count(), 'toolbox has the lasso button');
  const p = {};
  for (const n of ['N0', 'N1', 'N2', 'N3']) p[n] = await screenOf(page, ids[n]);

  // Loop around N0 and N1 only (the outline passes between N1 and N2).
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const gap = mid(p.N1, p.N2).x;
  const loop = [
    { x: p.N0.x - 80, y: p.N0.y - 90 },
    { x: gap, y: p.N0.y - 90 },
    { x: gap, y: p.N0.y + 90 },
    { x: p.N0.x - 80, y: p.N0.y + 90 },
  ];
  const during = await drag(page, loop);
  assert(during.lasso === 'block', 'the outline is drawn while dragging');
  assert(JSON.stringify(await names(page)) === '["N0","N1"]', `lasso selected N0,N1: ${await names(page)}`);
  assert(
    (await page.evaluate(() => getComputedStyle(document.querySelector('.ed-lasso')).display)) === 'none',
    'outline removed',
  );
  await shot(page, 'ed-select-lasso');

  // Shift: add N3 (a lasso around it).
  await drag(page, around(p.N3, 40), ['Shift']);
  assert(JSON.stringify(await names(page)) === '["N0","N1","N3"]', `Shift adds: ${await names(page)}`);
  // Control: subtract N0.
  await drag(page, around(p.N0, 40), ['Control']);
  assert(JSON.stringify(await names(page)) === '["N1","N3"]', `Ctrl subtracts: ${await names(page)}`);
  // Replace with a lasso around N2 only.
  await drag(page, around(p.N2, 40));
  assert(JSON.stringify(await names(page)) === '["N2"]', `replace: ${await names(page)}`);
  // A click on a body picks it; a click on empty ground clears.
  await page.mouse.click(p.N0.x, p.N0.y);
  assert(JSON.stringify(await names(page)) === '["N0"]', `click picks: ${await names(page)}`);
  await page.mouse.click(700, 300);
  assert((await sel(page)).length === 0, 'click on empty clears');
  // Escape during a drag cancels and leaves the selection as it was.
  await page.evaluate((id) => window.physicslab.store.setSelection([id]), ids.N3);
  await page.mouse.move(p.N0.x - 80, p.N0.y - 90);
  await page.mouse.down();
  await page.mouse.move(p.N1.x + 80, p.N1.y + 90, { steps: 4 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert(JSON.stringify(await names(page)) === '["N3"]', `Escape cancels the lasso: ${await names(page)}`);
  await page.close();
});

test('ED-1 lasso: hidden objects are not selectable, locked ones are', async () => {
  const page = await newPage();
  const ids = await setup(page);
  await page.evaluate((ids) => {
    const a = window.physicslab;
    a.store.update(ids.N0, { hidden: true });
    a.store.update(ids.N1, { locked: true });
  }, ids);
  await page.click('.viewport-canvas', { position: { x: 700, y: 120 } });
  await page.keyboard.press('o');
  const c = await screenOf(page, ids.N1);
  const left = await screenOf(page, ids.N0);
  await drag(page, [
    { x: left.x - 70, y: left.y - 90 },
    { x: c.x + 70, y: left.y - 90 },
    { x: c.x + 70, y: left.y + 90 },
    { x: left.x - 70, y: left.y + 90 },
  ]);
  assert(JSON.stringify(await names(page)) === '["N1"]', `hidden skipped, locked selected: ${await names(page)}`);
  await page.close();
});

test('ED-1 paint select: brush strokes select what they touch; Shift adds, Ctrl removes; [ ] resize the brush', async () => {
  const page = await newPage();
  const ids = await setup(page);
  await page.click('.viewport-canvas', { position: { x: 700, y: 120 } });
  await page.keyboard.press('s');
  assert((await page.evaluate(() => window.physicslab.prefs.value.tool)) === 'paintselect', 'S activates paint select');
  const p = {};
  for (const n of ['N0', 'N1', 'N2', 'N3']) p[n] = await screenOf(page, ids[n]);

  // Brush radius keys.
  await page.mouse.move(p.N0.x, p.N0.y);
  const r0 = await page.evaluate(() => document.querySelector('.ed-brush-ring').offsetWidth / 2);
  assert(r0 > 0, 'brush ring shown for the tool');
  await page.keyboard.press(']');
  const r1 = await page.evaluate(() => document.querySelector('.ed-brush-ring').offsetWidth / 2);
  assert(r1 > r0, `] enlarges the brush (${r0} -> ${r1})`);
  await page.keyboard.press('[');
  await page.keyboard.press('[');
  const r2 = await page.evaluate(() => document.querySelector('.ed-brush-ring').offsetWidth / 2);
  assert(r2 < r0, `[ shrinks the brush (${r0} -> ${r2})`);

  // Stroke from N0 to N2 (along the row) passes over N1.
  const during = await drag(page, [p.N0, p.N1, p.N2]);
  assert(during.ring === 'block', 'ring visible while painting');
  assert(JSON.stringify(await names(page)) === '["N0","N1","N2"]', `stroke selected N0..N2: ${await names(page)}`);
  await shot(page, 'ed-select-paint');
  // Ctrl stroke over N1 removes it.
  await drag(page, [{ x: p.N1.x - 3, y: p.N1.y }, p.N1], ['Control']);
  assert(JSON.stringify(await names(page)) === '["N0","N2"]', `Ctrl removes: ${await names(page)}`);
  // Shift stroke over N3 adds it.
  await drag(page, [p.N3, { x: p.N3.x + 3, y: p.N3.y }], ['Shift']);
  assert(JSON.stringify(await names(page)) === '["N0","N2","N3"]', `Shift adds: ${await names(page)}`);
  // A plain stroke replaces.
  await drag(page, [p.N3, { x: p.N3.x + 3, y: p.N3.y }]);
  assert(JSON.stringify(await names(page)) === '["N3"]', `plain stroke replaces: ${await names(page)}`);
  await page.close();
});

/** Run a command through the palette. */
async function palette(page, text) {
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette .palette-input');
  await page.waitForFunction(() => document.activeElement?.classList.contains('palette-input'));
  await page.keyboard.type(text);
  await page.waitForTimeout(80);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.palette'));
}

test('ED-1 select commands: similar (shape/material/size/tag), invert, group children, connected, grow, shrink', async () => {
  const page = await newPage();
  const ids = await setup(page, (a, ids) => {
    // N0 box, N1 sphere, N2 box, N3 sphere. Differentiate: N1 big; N2 carries a tag; materials differ.
    a.store.update(ids.N1, { shape: { ...a.store.get(ids.N1).shape, size: [2, 2, 2] } });
    a.store.update(ids.N2, { tags: ['crate'] });
    a.store.update(ids.N0, { tags: ['crate'] });
    a.store.update(ids.N3, { material: { ...a.store.get(ids.N3).material, preset: 'steel', color: '#888888' } });
    a.store.update(ids.N0, { material: { ...a.store.get(ids.N0).material, preset: 'steel', color: '#888888' } });
    // chain N0-N1-N2 by hinge joints; N3 alone
    const at = (id) => a.store.get(id).position;
    a.editor.addJoint('hinge', { body: ids.N0, point: at(ids.N0) }, { body: ids.N1, point: at(ids.N1) });
    a.editor.addJoint('hinge', { body: ids.N1, point: at(ids.N1) }, { body: ids.N2, point: at(ids.N2) });
  });
  const setSel = (list) =>
    page.evaluate(({ ids, list }) => window.physicslab.store.setSelection(list.map((n) => ids[n])), { ids, list });
  await page.click('.viewport-canvas', { position: { x: 700, y: 120 } });

  await setSel(['N0']);
  await palette(page, 'Select similar: Shape');
  assert(JSON.stringify(await names(page)) === '["N0","N2"]', `same shape (boxes): ${await names(page)}`);
  await setSel(['N3']);
  await palette(page, 'Select similar: Material');
  assert(JSON.stringify(await names(page)) === '["N0","N3"]', `same material (steel): ${await names(page)}`);
  await setSel(['N0']);
  await palette(page, 'Select similar: Size');
  assert(JSON.stringify(await names(page)) === '["N0","N2","N3"]', `same size (the 1 m ones): ${await names(page)}`);
  await setSel(['N2']);
  await palette(page, 'Select similar: Tag');
  assert(JSON.stringify(await names(page)) === '["N0","N2"]', `shared tag: ${await names(page)}`);

  // Invert by shortcut.
  await setSel(['N0', 'N1']);
  await page.keyboard.press('Control+i');
  assert(
    JSON.stringify(await names(page)) === '["N2","N3"]' || (await names(page)).includes('N2'),
    `invert: ${await names(page)}`,
  );
  const inv = await page.evaluate((ids) => {
    const a = window.physicslab;
    return a.store.selection.includes(ids.N0) || a.store.selection.includes(ids.N1);
  }, ids);
  assert(!inv, 'invert removed the originally selected ones');

  // Joint graph.
  await setSel(['N0']);
  await palette(page, 'Select connected');
  assert(JSON.stringify(await names(page)) === '["N0","N1","N2"]', `connected: ${await names(page)}`);
  await setSel(['N0']);
  await palette(page, 'Grow selection');
  assert(JSON.stringify(await names(page)) === '["N0","N1"]', `grow: ${await names(page)}`);
  await palette(page, 'Grow selection');
  assert(JSON.stringify(await names(page)) === '["N0","N1","N2"]', `grow again: ${await names(page)}`);
  await setSel(['N0', 'N1']);
  await palette(page, 'Shrink selection');
  assert(
    JSON.stringify(await names(page)) === '["N0"]',
    `shrink drops the boundary (N1 touches N2): ${await names(page)}`,
  );

  // Group children.
  await page.evaluate((ids) => {
    const a = window.physicslab;
    a.store.setSelection([ids.N2, ids.N3]);
    a.addGroup();
  }, ids);
  const grp = await page.evaluate(() => window.physicslab.store.selection[0]);
  assert(
    grp && (await page.evaluate((g) => window.physicslab.store.get(g).kind, grp)) === 'group',
    'group created and selected',
  );
  await palette(page, 'Select group children');
  assert(JSON.stringify(await names(page)) === '["N2","N3"]', `group members: ${await names(page)}`);
  assert(page.errors.length === 0, `no page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('ED-1 Select panel: name / tag / shape filters with live count; Replace, Add and Subtract', async () => {
  const page = await newPage();
  await setup(page, (a, ids) => {
    a.store.update(ids.N0, { tags: ['wood'] });
    a.store.update(ids.N2, { tags: ['wood'] });
    a.store.update(ids.N1, { name: 'Ball one' });
    a.store.update(ids.N3, { name: 'Ball two' });
  });
  await palette(page, 'Show Select');
  await page.waitForSelector('.ed-select-panel');
  const count = () => page.locator('.ed-sel-count').textContent();
  assert((await count()).includes('Set at least one condition'), `empty filter: ${await count()}`);
  assert(await page.locator('.ed-sel-replace').isDisabled(), 'buttons disabled without a condition');

  await page.fill('.ed-select-panel input[aria-label="Name contains"]', 'ball');
  assert((await count()).trim() === '2 matches', `name filter count: ${await count()}`);
  await page.click('.ed-sel-replace');
  assert(JSON.stringify(await names(page)) === '["Ball one","Ball two"]', `replace: ${await names(page)}`);

  await page.fill('.ed-select-panel input[aria-label="Name contains"]', '');
  await page.fill('.ed-select-panel input[aria-label="Tag"]', 'wood');
  assert((await count()).trim() === '2 matches', `tag filter count: ${await count()}`);
  await page.click('.ed-sel-add');
  assert((await sel(page)).length === 4, `add -> all four: ${await names(page)}`);
  await page.selectOption('.ed-sel-shape', 'sphere');
  assert((await count()).trim() === '0 matches', `wood spheres: ${await count()}`);
  await page.selectOption('.ed-sel-shape', 'box');
  assert((await count()).trim() === '2 matches', `wood boxes: ${await count()}`);
  await page.click('.ed-sel-subtract');
  assert(JSON.stringify(await names(page)) === '["Ball one","Ball two"]', `subtract: ${await names(page)}`);

  // Regex mode and an invalid pattern.
  await page.fill('.ed-select-panel input[aria-label="Tag"]', '');
  await page.selectOption('.ed-sel-shape', '');
  await page.locator('.ed-select-panel .switch').click();
  await page.fill('.ed-select-panel input[aria-label="Name contains"]', '^Ball (one|two)$');
  await page.waitForTimeout(300); // the regex count is debounced (150 ms)
  const rx = await count();
  assert(rx.trim() === '2 matches', `regex: ${JSON.stringify(rx)} then ${JSON.stringify(await count())}`);
  await page.fill('.ed-select-panel input[aria-label="Name contains"]', '(');
  await page.waitForTimeout(300);
  assert((await count()).includes('Invalid'), `invalid regex reported: ${await count()}`);
  await shot(page, 'ed-select-panel');
  assert(page.errors.length === 0, `no page errors: ${page.errors.join(' | ')}`);
  await page.close();
});
