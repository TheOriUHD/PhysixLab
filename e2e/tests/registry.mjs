/**
 * End-to-end tests of the UI registries (FB-9) and the content registries (FB-10): the command palette, the
 * keyboard shortcuts, menus, toolbox and shortcut help generated from the command / tool / menu registries, the
 * docked regions generated from the panel registry, the Maps tab, and the extension examples from
 * docs/EXTENDING.md running in the real app.
 */
import { assert, near, newPage, screenOf, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const openPalette = async (page) => {
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette .palette-input');
};
const paletteLabels = (page) => page.locator('.palette-item .palette-label').allTextContents();
const paletteClosed = (page) => page.evaluate(() => !document.querySelector('.palette'));
const prefs = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.physicslab.prefs.value)));

test('command palette: Ctrl+K, type "gravity", choose with the arrow keys, Enter runs it; recents come first', async () => {
  const page = await newPage();
  await page.click('.viewport-canvas', { position: { x: 500, y: 300 } });
  const before = await prefs(page);
  await openPalette(page);

  // Accessible combobox + listbox wiring, focus in the search box.
  const aria = await page.evaluate(() => {
    const input = document.querySelector('.palette-input');
    const list = document.querySelector('.palette-list');
    const first = document.querySelector('.palette-item');
    return {
      role: input.getAttribute('role'),
      expanded: input.getAttribute('aria-expanded'),
      controls: input.getAttribute('aria-controls'),
      autocomplete: input.getAttribute('aria-autocomplete'),
      listRole: list.getAttribute('role'),
      listId: list.id,
      focused: document.activeElement === input,
      active: input.getAttribute('aria-activedescendant'),
      firstId: first.id,
      firstRole: first.getAttribute('role'),
      selected: first.getAttribute('aria-selected'),
      dialog: document.querySelector('.palette').getAttribute('role'),
      modal: document.querySelector('.palette').getAttribute('aria-modal'),
    };
  });
  assert(
    aria.role === 'combobox' && aria.expanded === 'true' && aria.autocomplete === 'list',
    `combobox ${JSON.stringify(aria)}`,
  );
  assert(aria.controls === aria.listId && aria.listRole === 'listbox', 'the combobox controls the listbox');
  assert(aria.focused, 'focus is in the search box');
  assert(
    aria.firstRole === 'option' && aria.selected === 'true' && aria.active === aria.firstId,
    'first option is active',
  );
  assert(aria.dialog === 'dialog' && aria.modal === 'true', 'the palette is a modal dialog');

  // Nothing typed yet: the commands, grouped; no "Recent" section on a fresh browser.
  const headings0 = await page.locator('.palette-heading').allTextContents();
  assert(!headings0.includes('Recent'), `no recents yet (${headings0.join()})`);
  assert(
    headings0.includes('Simulation') && headings0.includes('Settings') && headings0.includes('Maps'),
    `sections: ${headings0.join()}`,
  );

  await page.keyboard.type('gravity');
  const labels = await paletteLabels(page);
  assert(
    labels.slice(0, 5).every((l) => l.startsWith('Gravity:')),
    `the five gravity presets come first: ${labels.join(' | ')}`,
  );
  assert(!labels.includes('Group selection'), 'scattered letters in a description do not match');
  const marks = await page.locator('.palette-item').first().locator('mark').allTextContents();
  assert(marks.join('') === 'Gravity', `the match is highlighted (${marks.join('|')})`);
  // Typing went to the search box, not to the shortcuts (g = snapping, t = fire tool …).
  const mid = await prefs(page);
  assert(
    mid.snap === before.snap && mid.tool === 'select' && mid.followSelection === before.followSelection,
    'typed keys did not trigger shortcuts',
  );

  // The palette fades in; under software WebGL frames are slow, so wait for it to be fully opaque.
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.palette-back')).opacity === '1');
  await shot(page, 'fb-palette-gravity');
  const activeLabel = () =>
    page.evaluate(() => document.querySelector('.palette-item[aria-selected=true] .palette-label').textContent);
  const ordered = labels.slice(0, 5);
  const moonAt = ordered.findIndex((l) => /Moon/.test(l));
  const earthAt = ordered.findIndex((l) => /Earth/.test(l));
  await page.keyboard.press('ArrowDown');
  const active = await page.evaluate(() => {
    const el = document.getElementById(document.querySelector('.palette-input').getAttribute('aria-activedescendant'));
    return { text: el.querySelector('.palette-label').textContent, selected: el.getAttribute('aria-selected') };
  });
  assert(active.text === labels[1] && active.selected === 'true', `ArrowDown moves to the second row (${active.text})`);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp'); // wraps to the last
  const wrapped = await activeLabel();
  assert(wrapped === labels.at(-1), `ArrowUp wraps around (${wrapped})`);
  await page.keyboard.press('ArrowDown'); // wraps to the first again
  for (let i = 0; i < moonAt; i++) await page.keyboard.press('ArrowDown');
  assert(/Moon/.test(await activeLabel()), `arrowed down to the Moon preset (${earthAt} / ${moonAt})`);
  await page.keyboard.press('Enter');
  assert(await paletteClosed(page), 'Enter closes the palette');
  const g = await page.evaluate(() => window.physicslab.store.settings.gravity);
  assert(
    g[0] === 0 && g[2] === 0 && near(g[1], -1.62, 1e-9, 'moon gravity') === undefined,
    `gravity is now the Moon's ${g}`,
  );
  assert(
    (await page.evaluate(() => window.physicslab.store.undoLabel)).includes('Moon'),
    'one undo step named after the preset',
  );
  // The World tab shows the same preset: the command and the panel edit the same setting.
  await page.click('.panel.right .tab:has-text("World")');
  const shown = await page
    .locator('.panel.right select:visible')
    .first()
    .evaluate((s) => s.options[s.selectedIndex].text);
  assert(/Moon/.test(shown), `World tab shows ${shown}`);

  // Re-open: the command just run comes first, in a "Recent" section.
  await page.evaluate(() => (window.__before = document.activeElement));
  await openPalette(page);
  const headings = await page.locator('.palette-heading').allTextContents();
  const firstLabel = (await paletteLabels(page))[0];
  assert(headings[0] === 'Recent' && /Moon/.test(firstLabel), `recent first: ${headings[0]} / ${firstLabel}`);
  // The recent item survives a reload (it is stored in the browser).
  await page.keyboard.press('Escape');
  assert(await paletteClosed(page), 'Escape closes the palette');
  const focusBack = await page.evaluate(() => document.activeElement === window.__before);
  assert(focusBack, 'focus returns to where it was');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('command palette: finds scenes, prefabs, maps, saved scenes and settings; clicking outside closes; dialogs keep priority', async () => {
  const page = await newPage();
  await page.click('.viewport-canvas', { position: { x: 500, y: 300 } });

  // A map by name.
  await openPalette(page);
  await page.keyboard.type('sandbox');
  let rows = await page.evaluate(() =>
    [...document.querySelectorAll('.palette-item')].map((r) => ({
      label: r.querySelector('.palette-label').textContent,
      tag: r.querySelector('.palette-tag')?.textContent,
    })),
  );
  assert(rows[0].label === 'Sandbox box' && rows[0].tag === 'Map', `map first: ${JSON.stringify(rows[0])}`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.physicslab.store.name === 'Sandbox box');
  assert((await page.evaluate(() => window.physicslab.store.size)) === 110, 'the map loaded (110 objects)');

  // A prefab.
  await openPalette(page);
  await page.keyboard.type('pendulum');
  rows = await page.evaluate(() =>
    [...document.querySelectorAll('.palette-item')].map((r) => r.querySelector('.palette-tag')?.textContent),
  );
  assert(rows[0] === 'Prefab', `prefab first (${rows.join()})`);
  await page.keyboard.press('Enter');
  const pendulum = await page.evaluate(
    async () => (await import('/src/model/content/index.ts')).getPrefab('pendulum').build().length,
  );
  assert(
    (await page.evaluate(() => window.physicslab.store.size)) === 110 + pendulum,
    `the prefab was inserted (${pendulum} objects: rod, bob, post, mount, joints)`,
  );

  // An example scene: the scene has unsaved edits now, so the usual confirmation appears first.
  await openPalette(page);
  await page.keyboard.type('cradle');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.modal button:has-text("Replace scene")');
  await page.click('.modal button:has-text("Replace scene")');
  await page.waitForFunction(() => window.physicslab.store.name.includes('cradle'));

  // A setting shows its state, and running it flips it.
  await openPalette(page);
  await page.keyboard.type('velocity vec');
  let state = await page.locator('.palette-item').first().locator('.palette-state').textContent();
  assert(state === 'Off', `setting shows Off (${state})`);
  await page.keyboard.press('Enter');
  assert((await prefs(page)).overlays.velocity === true, 'velocity vectors switched on');
  await openPalette(page);
  await page.keyboard.type('velocity vec');
  state = await page.locator('.palette-item').first().locator('.palette-state').textContent();
  assert(state === 'On', `and now shows On (${state})`);
  await page.keyboard.press('Escape');

  // A saved scene.
  await page.evaluate(() => {
    window.physicslab.store.setName('My pendulum lab');
    window.physicslab.persistence.saveToLibrary();
  });
  await openPalette(page);
  await page.keyboard.type('pendulum lab');
  const savedTag = await page.locator('.palette-item').first().locator('.palette-tag').textContent();
  assert(savedTag === 'Saved scene', `saved scenes are searchable (${savedTag})`);
  await page.keyboard.press('Escape');

  // Commands that cannot run are not offered; disabled ones come back when they can.
  await openPalette(page);
  await page.keyboard.type('stop and return');
  assert((await page.locator('.palette-item').count()) === 0, 'Reset is not offered while nothing is simulating');
  const empty = await page.locator('.palette-empty').textContent();
  assert(/Nothing matches/.test(empty), `empty state: ${empty}`);
  assert((await page.locator('.palette [role=status]').textContent()) === 'No results', 'announced to assistive tools');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Space');
  await openPalette(page);
  await page.keyboard.type('stop and return');
  assert((await paletteLabels(page)).length === 1, 'Reset is offered while simulating');
  await page.keyboard.press('Enter');
  assert((await page.evaluate(() => window.physicslab.sim.mode)) === 'edit', 'and it resets the simulation');

  // A command that needs the browser's user-activation (the file picker) still works when run from the palette.
  const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
  await openPalette(page);
  await page.keyboard.type('import scene');
  await page.keyboard.press('Enter');
  await chooser;

  // Click outside closes; the palette does not open over a dialog (Esc closes the dialog first).
  await openPalette(page);
  await page.mouse.click(5, 450);
  assert(await paletteClosed(page), 'clicking outside closes the palette');
  await page.keyboard.press('?');
  await page.waitForSelector('.modal');
  await page.keyboard.press('Control+k');
  assert(await paletteClosed(page), 'no palette over a dialog');
  await page.keyboard.press('Escape');
  assert(await page.evaluate(() => !document.querySelector('.modal')), 'Escape closes the dialog');
  // The topbar button opens it too, and Ctrl+K closes it again.
  await page.click('button[title^="Command palette"]');
  await page.waitForSelector('.palette');
  await page.keyboard.press('Control+k');
  assert(await paletteClosed(page), 'Ctrl+K toggles');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('keyboard shortcuts generated from the command registry keep working exactly', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physicslab.newScene());
  await page.click('.viewport-canvas', { position: { x: 500, y: 300 } });
  const press = async (key) => {
    await page.keyboard.press(key);
    return prefs(page);
  };

  // Tools and gizmos.
  let p = await press('e');
  assert(p.tool === 'select' && p.gizmo === 'rotate', 'E rotates');
  p = await press('r');
  assert(p.gizmo === 'scale', 'R scales');
  p = await press('q');
  assert(p.gizmo === 'none', 'Q selects only');
  p = await press('w');
  assert(p.gizmo === 'translate', 'W moves');
  for (const [key, tool] of [
    ['j', 'joint'],
    ['m', 'measure'],
    ['b', 'blast'],
    ['t', 'shoot'],
  ]) {
    p = await press(key);
    assert(p.tool === tool, `${key.toUpperCase()} → ${tool}`);
    assert(
      await page.evaluate((t) => window.physicslab.viewport.dom.classList.contains(`tool-${t}`), tool),
      `viewport cursor class tool-${tool}`,
    );
    const hint = await page.evaluate(() => document.querySelector('.hint-bar').textContent);
    assert(hint.length > 5, `a hint for ${tool}: ${hint}`);
    p = await press('Escape');
    assert(p.tool === 'select', `Escape leaves ${tool}`);
  }
  // Toggles.
  const snap0 = p.snap;
  p = await press('g');
  assert(p.snap === !snap0, 'G toggles snapping');
  assert(/Snapping (on|off)/.test(await page.locator('.toast').last().textContent()), 'with a toast');
  p = await press('x');
  assert(p.space === 'local', 'X switches to local space');
  p = await press('x');
  assert(p.space === 'world', 'and back');
  const follow0 = p.followSelection;
  p = await press('c');
  assert(p.followSelection === !follow0, 'C toggles following the selection');
  await press('c');

  // Adding shapes by number: the registry order.
  const ids = await page.evaluate(async () =>
    (await import('/src/model/shapeRegistry.ts')).listShapes().map((s) => s.id),
  );
  await page.keyboard.press('3');
  await page.keyboard.press('2');
  const types = await page.evaluate(() => window.physicslab.store.bodies().map((b) => b.shape.type));
  assert(types.join() === [ids[2], ids[1]].join(), `3 and 2 add ${types}`);

  // Selection and editing.
  await page.keyboard.press('Control+a');
  assert((await page.evaluate(() => window.physicslab.store.selection.length)) === 2, 'Ctrl+A selects all');
  await page.keyboard.press('Control+d');
  assert((await page.evaluate(() => window.physicslab.store.bodies().length)) === 4, 'Ctrl+D duplicates');
  await page.keyboard.press('Control+z');
  assert((await page.evaluate(() => window.physicslab.store.bodies().length)) === 2, 'Ctrl+Z undoes');
  assert(/Undo/.test(await page.locator('.toast').last().textContent()), 'with a toast');
  await page.keyboard.press('Control+Shift+z');
  assert((await page.evaluate(() => window.physicslab.store.bodies().length)) === 4, 'Ctrl+Shift+Z redoes');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');
  assert((await page.evaluate(() => window.physicslab.store.bodies().length)) === 4, 'Ctrl+Y redoes');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+g');
  assert(
    (await page.evaluate(() => window.physicslab.store.all().filter((e) => e.kind === 'group').length)) === 1,
    'Ctrl+G groups',
  );
  await page.keyboard.press('Control+Shift+g');
  assert(
    (await page.evaluate(() => window.physicslab.store.all().filter((e) => e.kind === 'group').length)) === 0,
    'Ctrl+Shift+G ungroups',
  );
  await page.keyboard.press('Escape');
  assert((await page.evaluate(() => window.physicslab.store.selection.length)) === 0, 'Escape deselects');

  // The app owns its keys: Ctrl+D with nothing selected is still swallowed (the browser would bookmark the page).
  await page.evaluate(() => {
    window.__prevented = {};
    window.addEventListener('keydown', (e) => {
      // Registered after the app's own listener, so by now the app has made its decision.
      window.__prevented[`${e.ctrlKey ? 'Ctrl+' : ''}${e.key}`] = e.defaultPrevented;
    });
  });
  await page.keyboard.press('Control+d');
  await page.keyboard.press('Control+y');
  await page.keyboard.press('ArrowUp');
  const prevented = await page.evaluate(() => window.__prevented);
  assert(
    prevented['Ctrl+d'] === true && prevented['Ctrl+y'] === true,
    `Ctrl+D / Ctrl+Y are swallowed with nothing to do (${JSON.stringify(prevented)})`,
  );
  assert(prevented.ArrowUp === false, 'an arrow key with nothing to nudge is left alone');

  // Hide, lock, nudge, delete on one body.
  const id = await page.evaluate(() => window.physicslab.store.bodies()[0].id);
  await page.evaluate((id) => window.physicslab.store.setSelection([id]), id);
  await page.keyboard.press('h');
  assert((await page.evaluate((id) => window.physicslab.store.body(id).hidden, id)) === true, 'H hides');
  await page.keyboard.press('h');
  await page.keyboard.press('l');
  assert((await page.evaluate((id) => window.physicslab.store.body(id).locked, id)) === true, 'L locks');
  await page.keyboard.press('l');
  const at = await page.evaluate((id) => window.physicslab.store.body(id).position, id);
  await page.keyboard.press('ArrowRight');
  const moved = await page.evaluate((id) => window.physicslab.store.body(id).position, id);
  const d = Math.hypot(moved[0] - at[0], moved[1] - at[1], moved[2] - at[2]);
  const step = (await prefs(page)).snap ? (await prefs(page)).snapGrid : 0.1;
  near(d, step, 1e-6, `an arrow key nudges by ${step} m (the snap grid, or 0.1 with snapping off)`);
  await page.keyboard.press('Shift+ArrowLeft');
  const back = await page.evaluate((id) => window.physicslab.store.body(id).position, id);
  near(
    Math.hypot(back[0] - moved[0], back[1] - moved[1], back[2] - moved[2]),
    1,
    1e-6,
    'Shift+arrow nudges by a metre',
  );
  await page.keyboard.press('Delete');
  assert(await page.evaluate((id) => !window.physicslab.store.body(id), id), 'Delete deletes');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Backspace');
  assert(await page.evaluate((id) => !window.physicslab.store.body(id), id), 'Backspace deletes too');
  await page.keyboard.press('Control+z');

  // Simulation.
  await page.keyboard.press('Space');
  assert((await page.evaluate(() => window.physicslab.sim.mode)) === 'running', 'Space starts');
  await simTime(page, 0.3);
  await page.keyboard.press('Space');
  assert((await page.evaluate(() => window.physicslab.sim.mode)) === 'paused', 'Space pauses');
  const steps0 = await page.evaluate(() => window.physicslab.sim.client.stats.stepCount);
  await page.keyboard.press('.');
  await page.waitForFunction((n) => window.physicslab.sim.client.stats.stepCount > n, steps0);
  await page.keyboard.press('Shift+Space');
  assert((await page.evaluate(() => window.physicslab.sim.mode)) === 'edit', 'Shift+Space resets');

  // Save, help, typing guard.
  await page.keyboard.press('Control+s');
  assert(
    (await page.evaluate(() => window.physicslab.persistence.library().length)) === 1,
    'Ctrl+S saves to the library',
  );
  await page.keyboard.press('?');
  await page.waitForSelector('.modal .kbd-row');
  await page.keyboard.press('Escape');
  const nameBefore = await prefs(page);
  await page.click('.scene-name');
  await page.keyboard.type('qwerjmbt');
  const after = await prefs(page);
  assert(
    after.gizmo === nameBefore.gizmo && after.tool === nameBefore.tool,
    'typing in a text field does not trigger shortcuts',
  );
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('menus, toolbox and the shortcut help are generated from the registries — and follow them at run time', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physicslab.newScene());
  await page.click('.viewport-canvas', { position: { x: 500, y: 300 } });

  // Toolbox and view bar = the tool registry.
  const reg = await page.evaluate(async () => {
    const { listTools, getCommand } = await import('/src/app/registry/index.ts');
    const f = (region) => listTools(region).map((t) => t.id);
    return {
      toolbox: f('toolbox'),
      viewbar: f('viewbar'),
      hasCommands: listTools('toolbox').every((t) => !!getCommand(t.command ?? t.commandId ?? `tool.${t.id}`)),
    };
  });
  const dom = await page.evaluate(() => ({
    toolbox: [...document.querySelectorAll('.toolbox button')].map((b) => b.dataset.tool),
    viewbar: [...document.querySelectorAll('.viewbar button')].map((b) => b.dataset.tool),
    seps: document.querySelectorAll('.toolbox hr').length,
    vseps: document.querySelectorAll('.viewbar .sep').length,
    titles: Object.fromEntries([...document.querySelectorAll('.toolbox button')].map((b) => [b.dataset.tool, b.title])),
  }));
  assert(
    dom.toolbox.join() === reg.toolbox.join() && dom.viewbar.join() === reg.viewbar.join(),
    `bars follow the registry: ${dom.toolbox}`,
  );
  assert(dom.seps === 3 && dom.vseps === 2, `separators between groups (${dom.seps}, ${dom.vseps})`);
  assert(
    dom.titles.select === 'Select (Q)' &&
      dom.titles.joint === 'Connect with a joint — click two bodies (J)' &&
      dom.titles.snap === 'Grid snapping (G)',
    JSON.stringify(dom.titles),
  );
  assert(reg.hasCommands, 'every toolbox button has a command');
  // A click runs the command and the highlight follows.
  await page.click('.toolbox [data-tool="measure"]');
  assert(
    (await prefs(page)).tool === 'measure' && (await page.locator('.toolbox [data-tool="measure"].on').count()) === 1,
    'measure tool armed',
  );
  await page.click('.toolbox [data-tool="select"]');
  assert((await page.locator('.toolbox [data-tool="select"].on').count()) === 1, 'select armed again');
  await page.click('.toolbox [data-tool="snap"]');
  assert((await page.evaluate(() => window.physicslab.prefs.value.snap)) === false, 'the snap button toggles snapping');
  assert((await page.locator('.toolbox [data-tool="snap"].on').count()) === 0, 'and loses its highlight');
  await page.click('.viewbar [data-tool="viewVelocity"]');
  assert(
    (await page.locator('.viewbar [data-tool="viewVelocity"].on').count()) === 1,
    'view bar toggles follow commands',
  );

  // Menu bar.
  const bar = await page.locator('.menubar .menu-btn').allTextContents();
  assert(bar.join() === 'File,Edit,View,Help', `menu bar: ${bar}`);
  await page.click('.menu-btn:has-text("Edit")');
  let items = await page.evaluate(() =>
    [...document.querySelectorAll('.menu .menu-item')].map((b) => ({
      label: b.querySelector('.grow').textContent,
      kbd: b.querySelector('.kb')?.textContent,
      disabled: b.disabled,
    })),
  );
  assert(
    items[0].label === 'Undo' && items[0].disabled && items[0].kbd === 'Ctrl+Z',
    `Undo disabled: ${JSON.stringify(items[0])}`,
  );
  assert(items.find((i) => i.label === 'Delete').kbd === 'Del', 'Delete shows Del');
  await page.keyboard.press('Escape');
  await page.keyboard.press('1');
  await page.click('.menu-btn:has-text("Edit")');
  items = await page.evaluate(() =>
    [...document.querySelectorAll('.menu .menu-item')].map((b) => ({
      label: b.querySelector('.grow').textContent,
      disabled: b.disabled,
    })),
  );
  assert(/^Undo Add/.test(items[0].label) && !items[0].disabled, `Undo names the last edit: ${items[0].label}`);
  await page.click('.menu-item:has-text("Select all")');
  assert((await page.evaluate(() => window.physicslab.store.selection.length)) === 1, 'Select all runs its command');
  await page.click('.menu-btn:has-text("View")');
  const checks = await page.evaluate(() =>
    [...document.querySelectorAll('.menu .menu-item')]
      .map((b) => [b.querySelector('.grow').textContent, b.querySelector('.check')?.textContent])
      .filter(([, c]) => c !== undefined),
  );
  assert(
    checks.find(([l]) => l === 'Material')[1] === '✓' && checks.find(([l]) => l === 'Speed')[1] === '',
    'radio choice shows a check mark',
  );
  await page.click('.menu-item:has-text("Speed")');
  assert((await prefs(page)).colorMode === 'speed', 'choosing Speed colours bodies by speed');
  await page.click('.menu-btn:has-text("File")');
  const fileItems = await page.locator('.menu .menu-item .grow').allTextContents();
  assert(
    fileItems.includes('New scene') &&
      fileItems.includes('Drivable car') &&
      fileItems.includes("Newton's cradle") &&
      fileItems.includes('Copy share link'),
    'File menu lists the example scenes from the registry',
  );
  await page.keyboard.press('Escape');

  // Context menu.
  const pos = await screenOf(page, await page.evaluate(() => window.physicslab.store.bodies()[0].id));
  await page.mouse.click(pos.x, pos.y, { button: 'right' });
  await page.waitForSelector('.menu');
  const ctx = await page.locator('.menu .menu-item .grow').allTextContents();
  // -- ED-B: the menu also offers the kind-aware body entries (ED-31) --
  assert(
    ctx.join() === 'Frame,Duplicate,Hide / show,Lock / unlock,Make static,Material,Pin to world,Delete,Simulate',
    `context menu: ${ctx}`,
  );
  await page.keyboard.press('Escape');

  // Shortcut help = the registry.
  await page.click('button[title="Keyboard shortcuts"]');
  await page.waitForSelector('.modal .kbd-row');
  const help = await page.evaluate(async () => {
    const { helpSections } = await import('/src/app/registry/index.ts');
    const secs = helpSections();
    return {
      expectedRows: secs.reduce((n, s) => n + s.rows.length, 0),
      expectedGroups: secs.map((s) => s.title),
      rows: document.querySelectorAll('.modal .kbd-row').length,
      groups: [...document.querySelectorAll('.modal .kbd-group')].map((g) => g.textContent),
      undo: [...document.querySelectorAll('.modal .kbd-row')].find((r) => r.firstChild.textContent === 'Undo')
        ?.lastChild.textContent,
    };
  });
  assert(
    help.rows === help.expectedRows && help.groups.join() === help.expectedGroups.join(),
    `help dialog = registry (${help.rows}/${help.expectedRows})`,
  );
  assert(/Ctrl.*Z/.test(help.undo), `Undo row shows its keys (${help.undo})`);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.modal-back')).opacity === '1');
  await shot(page, 'fb-shortcuts-help');
  await page.keyboard.press('Escape');

  // A command registered at run time is everywhere at once: keyboard, palette, menu, help.
  await page.evaluate(async () => {
    const r = await import('/src/app/registry/index.ts');
    window.__hello = 0;
    r.registerCommand({
      id: 'e2e.hello',
      label: 'E2E say hello',
      category: 'Edit',
      shortcut: 'Mod+Shift+H',
      keywords: ['greeting'],
      run: () => void window.__hello++,
    });
    r.registerMenuEntry({ id: 'menu.edit.hello', menu: 'edit', group: 'sim', order: 450, command: 'e2e.hello' });
    r.registerHelp({ id: 'e2e.gesture', group: 'Edit', label: 'E2E gesture', keys: 'Shift drag', order: 99 });
  });
  await page.keyboard.press('Control+Shift+h');
  assert((await page.evaluate(() => window.__hello)) === 1, 'its shortcut works');
  await openPalette(page);
  await page.keyboard.type('greeting');
  assert((await paletteLabels(page))[0] === 'E2E say hello', 'the palette finds it by keyword');
  await page.keyboard.press('Enter');
  assert((await page.evaluate(() => window.__hello)) === 2, 'and runs it');
  await page.click('.menu-btn:has-text("Edit")');
  const edit = await page.evaluate(() =>
    [...document.querySelectorAll('.menu .menu-item')].map((b) => [
      b.querySelector('.grow').textContent,
      b.querySelector('.kb')?.textContent,
    ]),
  );
  assert(
    edit.some(([l, k]) => l === 'E2E say hello' && k === 'Ctrl+Shift+H'),
    `Edit menu lists it with its shortcut: ${JSON.stringify(edit.slice(-3))}`,
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('?');
  await page.waitForSelector('.modal .kbd-row');
  const helpText = await page.locator('.modal').textContent();
  assert(
    helpText.includes('E2E say hello') && helpText.includes('E2E gesture'),
    'the shortcut help lists the command and the gesture',
  );
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const r = await import('/src/app/registry/index.ts');
    r.unregisterMenuEntry('menu.edit.hello');
    r.unregisterCommand('e2e.hello');
    r.helpRegistry.unregister('e2e.gesture');
  });
  await page.keyboard.press('Control+Shift+h');
  assert((await page.evaluate(() => window.__hello)) === 2, 'unregistered: the shortcut is gone');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('panels: the three regions are generated from the panel registry, follow it live, and fall back sensibly', async () => {
  const page = await newPage();
  const tabs = async (sel) => (await page.locator(`${sel} .tab`).allTextContents()).map((t) => t.trim());
  // The foundation's tabs come first and in this order; packages add their own (Effects, Help, My prefabs, ...) around them.
  const only = (list, names) => list.filter((t) => names.includes(t)).join();
  const left = await tabs('.panel.left');
  assert(only(left, ['Add', 'Prefabs', 'Maps', 'Scenes']) === 'Add,Prefabs,Maps,Scenes', `left: ${left}`);
  const right0 = await tabs('.panel.right');
  assert(only(right0, ['Inspector', 'Outliner', 'World']) === 'Inspector,Outliner,World', `right: ${right0}`);
  assert(right0.includes('Effects'), `the Effects tab is in the right region: ${right0}`);
  // -- ZN: packages add their own dock tabs (Zones, ...), so the built-in ones are checked in order, not the whole list.
  const dockTabs = await tabs('.dock');
  assert(
    dockTabs.filter((t) => t === 'Energy' || t === 'Selection').join() === 'Energy,Selection',
    `bottom dock: ${dockTabs}`,
  );
  assert(dockTabs.includes('Charts'), `the Charts tab is in the bottom dock: ${dockTabs}`);
  assert(dockTabs.includes('Zones'), `the Zones tab is in the bottom dock: ${dockTabs}`);

  // Tab semantics.
  const aria = await page.evaluate(() => {
    const t = document.querySelector('.panel.left .tab.on');
    const panel = document.getElementById(t.getAttribute('aria-controls'));
    return {
      role: t.getAttribute('role'),
      selected: t.getAttribute('aria-selected'),
      panelRole: panel.getAttribute('role'),
      labelled: panel.getAttribute('aria-labelledby') === t.id,
      list: document.querySelector('.panel.left [role=tablist]')?.getAttribute('role'),
    };
  });
  assert(
    aria.role === 'tab' &&
      aria.selected === 'true' &&
      aria.panelRole === 'tabpanel' &&
      aria.labelled &&
      aria.list === 'tablist',
    JSON.stringify(aria),
  );
  // Arrow keys move between tabs.
  await page.focus('.panel.left .tab.on');
  const chassis = await page.evaluate(() => {
    const a = window.physicslab;
    return { id: a.store.selection[0], at: a.store.body(a.store.selection[0]).position };
  });
  assert(chassis.id, 'the car scene starts with its chassis selected');
  await page.keyboard.press('ArrowRight');
  assert((await prefs(page)).leftTab === 'prefabs', 'ArrowRight selects the next tab');
  assert(
    (await page.evaluate((c) => window.physicslab.store.body(c.id).position.join(), chassis)) === chassis.at.join(),
    'and does not also nudge the selection',
  );
  await page.keyboard.press('ArrowLeft');
  assert((await prefs(page)).leftTab === 'add', 'ArrowLeft goes back');

  // An id that no longer exists falls back to the first tab.
  await page.evaluate(() => window.physicslab.prefs.set({ leftTab: 'no-such-panel', rightTab: 'gone' }));
  assert(
    (await page.locator('.panel.left .tab.on').textContent()).trim() === 'Add',
    'left falls back to the first tab',
  );
  assert((await page.locator('.panel.right .tab.on').textContent()).trim() === 'Inspector', 'right falls back too');

  // The panel commands.
  await page.evaluate(async () =>
    (await import('/src/app/registry/index.ts')).runCommand('panel.outliner', window.physicslab, 'api'),
  );
  assert(
    (await prefs(page)).rightTab === 'outliner' &&
      (await page.locator('.panel.right .tab.on').textContent()).trim() === 'Outliner',
    'the Show Outliner command switches the tab',
  );

  // The topbar buttons run the panel-visibility commands.
  const hidden = () => page.evaluate(() => document.getElementById('app').classList.contains('no-left'));
  await page.click('button[title="Toggle library panel"]');
  assert(
    (await hidden()) === true && !(await page.locator('.panel.left').isVisible()),
    'the library panel button hides the left region',
  );
  await page.click('button[title="Toggle library panel"]');
  assert((await hidden()) === false && (await page.locator('.panel.left').isVisible()), 'and shows it again');

  // The Maps tab and the telemetry dock work.
  await page.click('.panel.left .tab:has-text("Maps")');
  assert((await page.locator('.panel.left .map-card').count()) >= 2, 'maps are listed');
  await page.click('.panel.left .tab:has-text("Add")');
  await page.evaluate(() => window.physicslab.newScene());
  await page.keyboard.press('1');
  await page.keyboard.press('Space');
  await simTime(page, 0.6);
  const legend = await page.locator('.dock .legend-item b').first().textContent();
  assert(legend !== '—' && /J/.test(legend), `the energy chart is fed (${legend})`);
  await page.click('.dock .tab:has-text("Selection")');
  assert((await prefs(page)).bottomTab === 'selection', 'the Selection tab opens');
  assert(
    (await page.locator('.dock .tab-toolbar select').isVisible()) &&
      (await page.locator('.dock .tab-toolbar button').isVisible()),
    'the dock toolbar (time window, clear) is shown',
  );
  await page.keyboard.press('Shift+Space');

  // A panel registered later appears (the example from docs/EXTENDING.md) and disappears when removed.
  await page.evaluate(async () => {
    await import('/tests/examples/stats-panel.ts');
  });
  const rightNow = await tabs('.panel.right');
  assert(
    rightNow.includes('Stats') && rightNow.filter((t) => t !== 'Stats').join() === right0.join(),
    `right now: ${rightNow} (before: ${right0})`,
  );
  await page.click('.panel.right .tab:has-text("Stats")');
  await page.waitForFunction(() =>
    /\d+ bodies, \d+ joints/.test(
      document.querySelector('.panel.right [role=tabpanel]:not([style*="none"])')?.textContent ?? '',
    ),
  );
  const n0 = await page.evaluate(() => window.physicslab.store.bodies().length);
  await page.keyboard.press('2');
  await page.waitForFunction(
    (n) => document.querySelector('#panel-stats').textContent.startsWith(`${n} bodies`),
    n0 + 1,
  );
  const offered = await page.evaluate(
    async () => (await import('/src/app/registry/index.ts')).getCommand('panel.stats')?.label,
  );
  assert(offered === 'Show Stats', 'registering the panel also registered its Show command');
  await page.evaluate(async () => (await import('/src/app/registry/index.ts')).unregisterPanel('stats'));
  assert((await tabs('.panel.right')).join() === right0.join(), 'unregistering removes the tab');
  assert(
    (await page.locator('.panel.right .tab.on').textContent()).trim() === 'Inspector',
    'and the region falls back to the first tab',
  );
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('maps tab: the registered maps with thumbnails, filter, open one (camera + objective), simulate it', async () => {
  const page = await newPage();
  await page.click('.panel.left .tab:has-text("Maps")');
  await page.waitForSelector('.map-card');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.map-thumb img')].every((i) => i.complete && i.naturalWidth > 0),
  );
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('.map-card')].map((c) => ({
      id: c.dataset.map,
      name: c.querySelector('h4').firstChild.textContent,
      diff: c.querySelector('.tag').textContent,
      img: c.querySelector('.map-thumb img')?.src.slice(0, 30),
      imgOk: !!c.querySelector('.map-thumb img') && c.querySelector('.map-thumb img').naturalWidth > 0,
      tags: [...c.querySelectorAll('.chip-tag')].map((t) => t.textContent),
    })),
  );
  assert(cards.length === 2, `two maps: ${JSON.stringify(cards.map((c) => c.id))}`);
  assert(
    cards.every((c) => c.diff === 'Free play' && c.img?.startsWith('data:image/svg+xml') && c.imgOk),
    `thumbnails are real images: ${JSON.stringify(cards[0])}`,
  );
  assert(cards[0].id === 'empty-arena' && cards[1].id === 'sandbox-box', 'in registry order');
  const heading = await page.locator('.panel.left .panel-body:visible .group-title').first().textContent();
  assert(heading === 'Arenas', `grouped by category (${heading})`);
  await shot(page, 'fb-maps-tab');

  // Filter.
  await page.fill('#panel-maps .search input', 'blocks');
  assert(
    (await page.locator('.map-card').count()) === 1 &&
      (await page.locator('.map-card').getAttribute('data-map')) === 'sandbox-box',
    'filter finds the map by tag',
  );
  await page.fill('#panel-maps .search input', 'zzzz');
  assert(
    /No map matches/.test(await page.locator('#panel-maps .empty-state').textContent()),
    'and says when nothing matches',
  );
  await page.fill('#panel-maps .search input', '');

  // Open the sandbox: scene, camera and objective.
  const camBefore = await page.evaluate(() => window.physicslab.camera.position.toArray());
  await page.click('.map-card[data-map="sandbox-box"]');
  await page.waitForFunction(() => window.physicslab.store.name === 'Sandbox box');
  assert((await page.evaluate(() => window.physicslab.store.size)) === 110, '110 objects');
  const toast = await page.locator('.toast').last().textContent();
  assert(/Free play/.test(toast), `the objective is shown (${toast})`);
  await page.waitForFunction(
    () => window.physicslab.camera.position.y > 7 && window.physicslab.camera.position.y < 10,
    null,
    { timeout: 5000 },
  );
  const cam = await page.evaluate(() => window.physicslab.camera.position.toArray());
  assert(Math.hypot(...cam.map((v, i) => v - camBefore[i])) > 1, 'the camera flew to the map’s opening view');
  await shot(page, 'fb-map-sandbox-box');
  await page.keyboard.press('Space');
  await simTime(page, 1);
  const stats = await page.evaluate(() => window.physicslab.sim.client.stats);
  assert(stats.bodies === 110, `the map simulates (${stats.bodies} bodies)`);
  await page.keyboard.press('Shift+Space');

  // The scene now has no unsaved edits, but the arena after a prefab would ask first.
  await page.click('.map-card[data-map="empty-arena"]');
  await page.waitForFunction(() => window.physicslab.store.name === 'Empty arena');
  assert((await page.evaluate(() => window.physicslab.store.size)) === 4, 'the empty arena is four walls');
  await shot(page, 'fb-map-empty-arena');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('extension examples from docs/EXTENDING.md run in the real app: command, tool, inspector section, template, prefab and map', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physicslab.newScene());
  const box = await page.evaluate(() => window.physicslab.addShape('box', [0, 0.5, 0]).id);
  await page.evaluate((id) => window.physicslab.store.setSelection([id]), box);

  // command + menu entry
  await page.evaluate(async () => {
    await import('/tests/examples/lift-command.ts');
  });
  await page.keyboard.press('Control+Shift+u');
  const y = await page.evaluate((id) => window.physicslab.store.body(id).position[1], box);
  near(y, 1.5, 1e-9, 'the example command lifts the selection by a metre');
  await page.click('.menu-btn:has-text("Edit")');
  const lift = page.locator('.menu .menu-item:has-text("Lift selection by 1 m")');
  assert(
    (await lift.count()) === 1 && (await lift.locator('.kb').textContent()) === 'Ctrl+Shift+U',
    'and it is in the Edit menu with its shortcut',
  );
  await lift.click();
  near(
    await page.evaluate((id) => window.physicslab.store.body(id).position[1], box),
    2.5,
    1e-9,
    'the menu item runs it too',
  );

  // tool
  await page.evaluate(async () => {
    await import('/tests/examples/dropper-tool.ts');
  });
  assert((await page.locator('.toolbox [data-tool="dropper"]').count()) === 1, 'the toolbox shows the new tool');
  const dropperTitle = await page.locator('.toolbox [data-tool="dropper"]').getAttribute('title');
  assert(dropperTitle === 'Drop a ball where you click (D)', `with its tooltip and shortcut (${dropperTitle})`);
  await page.keyboard.press('d');
  assert((await prefs(page)).tool === 'dropper', 'D arms it');
  assert(/Click the ground to drop a ball/.test(await page.locator('.hint-bar').textContent()), 'its hint is shown');
  const n0 = await page.evaluate(() => window.physicslab.store.bodies().length);
  await page.mouse.click(300, 600);
  const spheres = await page.evaluate(() =>
    window.physicslab.store
      .bodies()
      .filter((b) => b.shape.type === 'sphere')
      .map((b) => b.position),
  );
  assert(
    (await page.evaluate(() => window.physicslab.store.bodies().length)) === n0 + 1 &&
      spheres.length === 1 &&
      spheres[0][1] === 2,
    `clicking the ground drops a ball from 2 m (${JSON.stringify(spheres)})`,
  );
  await page.keyboard.press('Escape');

  // inspector section
  await page.evaluate(async () => {
    await import('/tests/examples/volume-section.ts');
  });
  await page.evaluate((id) => window.physicslab.store.setSelection([id]), box);
  await page.waitForSelector('.panel.right .section-head:has-text("Volume")');
  const vol = await page.locator('.panel.right .row:has(.row-label:text-is("Shape volume")) .readout').textContent();
  assert(vol === '1.000 m³', `the section shows the volume (${vol})`);
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('.panel.right .section-head span')].map((s) => s.textContent),
  );
  assert(
    order.indexOf('Volume') > order.indexOf('Physics') && order.indexOf('Volume') < order.indexOf('Organise'),
    `at its place between the body panel and Organise: ${order}`,
  );
  await page.evaluate((id) => window.physicslab.store.update(id, { shape: { type: 'box', size: [2, 1, 1] } }), box);
  await page.waitForFunction(() => document.querySelector('.panel.right .row .readout')?.textContent !== undefined);
  const vol2 = await page.locator('.panel.right .row:has(.row-label:text-is("Shape volume")) .readout').textContent();
  assert(vol2 === '2.000 m³', `and follows edits (${vol2})`);

  // template, prefab, map
  await page.evaluate(async () => {
    await import('/tests/examples/ramps-template.ts');
    await import('/tests/examples/domino-prefab.ts');
    await import('/tests/examples/court-map.ts');
  });
  await page.click('.panel.left .tab:has-text("Scenes")');
  assert((await page.locator('.card:has-text("Three ramps")').count()) === 1, 'the template is in the Scenes tab');
  await page.click('.panel.left .tab:has-text("Prefabs")');
  await page.click('.card:has-text("Domino trio")');
  assert(
    (await page.evaluate(() => window.physicslab.store.bodies().filter((b) => b.name === 'Domino').length)) === 3,
    'the prefab inserts three dominoes',
  );
  await page.click('.panel.left .tab:has-text("Maps")');
  assert((await page.locator('.map-card[data-map="step-court"]').count()) === 1, 'the map is in the Maps tab');
  await page.click('.panel.left .tab:has-text("Scenes")');
  await page.click('.card:has-text("Three ramps")');
  await page.waitForSelector('.modal button:has-text("Replace scene")');
  await page.click('.modal button:has-text("Replace scene")');
  await page.waitForFunction(() => window.physicslab.store.name === 'Three ramps');
  await page.keyboard.press('Space');
  await simTime(page, 1);
  const dist = await page.evaluate(() => {
    const a = window.physicslab;
    const out = {};
    for (const b of a.store.bodies().filter((x) => x.name.endsWith(' block'))) {
      const p = a.sim.poseOf(b.id);
      out[b.name.split(' ')[0]] = Math.hypot(
        p.position[0] - b.position[0],
        p.position[1] - b.position[1],
        p.position[2] - b.position[2],
      );
    }
    return out;
  });
  assert(
    dist.ice > 1.5 && dist.ice > 3 * dist.wood && dist.rubber < 0.02,
    `ice slides, wood creeps, rubber holds: ${JSON.stringify(dist)}`,
  );
  await shot(page, 'fb-example-three-ramps');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('keyboard: Ctrl+K works inside text fields; a focused panel tab leaves the arrow keys to the simulation; tooltips follow the keymap', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physicslab.newScene());
  const id = await page.evaluate(() => window.physicslab.addShape('box', [0, 0.5, 0]).id);
  await page.evaluate((id) => window.physicslab.store.setSelection([id]), id);

  // The palette key is handled before a field can swallow it (the scene name, number fields and filters stop their
  // key events from bubbling so typing never reaches the shortcuts).
  const fields = [
    ['the scene name', '.scene-name'],
    ['an inspector field', '.panel.right input[type=text], .panel.right input:not([type])'],
  ];
  for (const [what, selector] of fields) {
    await page.locator(selector).first().click();
    await page.keyboard.press('Control+k');
    assert(!(await paletteClosed(page)), `Ctrl+K opens the palette from ${what}`);
    await page.keyboard.press('Escape');
    assert(await paletteClosed(page), `and Escape closes it again (${what})`);
  }
  await page.click('.panel.left .tab:has-text("Maps")');
  await page.click('#panel-maps .search input');
  await page.keyboard.press('Control+k');
  assert(!(await paletteClosed(page)), 'Ctrl+K opens the palette from the Maps filter');
  await page.keyboard.press('Control+k');
  assert(await paletteClosed(page), 'and toggles it shut again');
  // The text typed into a field still stays in the field.
  await page.click('#panel-maps .search input');
  await page.keyboard.type('blocks');
  assert((await page.locator('.map-card').count()) === 1, 'typing in the filter still filters');
  await page.fill('#panel-maps .search input', '');

  // Arrow keys: on a focused tab they switch tabs while editing, but while a simulation runs they belong to the
  // motors and thrusters (the tab used to swallow them if it still had focus from a click).
  await page.click('.panel.right .tab:has-text("Outliner")');
  await page.focus('#tab-outliner'); // the dock re-renders its tab strip on a click, which drops the focus
  // the tab after the Outliner (packages add tabs between the foundation's, so read it from the strip)
  const nextTab = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.panel.right .tab')];
    return tabs[tabs.findIndex((t) => /Outliner/.test(t.textContent ?? '')) + 1]?.id.replace(/^tab-/, '');
  });
  await page.keyboard.press('ArrowRight');
  const nowOn = await page.evaluate(() => document.querySelector('.panel.right .tab.on')?.id.replace(/^tab-/, ''));
  assert(!!nextTab && nowOn === nextTab, `ArrowRight on a focused tab selects the next tab while editing (${nextTab})`);
  await page.keyboard.press('Space');
  await simTime(page, 0.1);
  await page.click('.panel.right .tab:has-text("Outliner")');
  await page.focus('#tab-outliner');
  await page.keyboard.down('ArrowRight');
  // the input hub copies the held keys into the simulation's key set once per frame
  await page
    .waitForFunction(() => window.physicslab.sim.keys.has('ArrowRight'), null, { timeout: 5000 })
    .catch(() => undefined);
  const held = await page.evaluate(() => [...window.physicslab.sim.keys]);
  await page.keyboard.up('ArrowRight');
  assert(held.includes('ArrowRight'), `the simulation sees the arrow key (${held})`);
  assert((await prefs(page)).rightTab === 'outliner', 'and the tab stays put');
  await page.keyboard.press('Shift+Space');

  // Topbar tooltips are generated from the commands' shortcuts.
  const titles = await page.evaluate(() => ({
    play: document.querySelector('.tbtn.play, .tbtn.pause').title,
    step: document.querySelector('.tbtn[title^="Advance"]').title,
    reset: document.querySelector('.tbtn[title^="Stop"]').title,
    undo: document.querySelector('.topbar-right button[title^="Undo"]').title,
  }));
  assert(titles.play === 'Start / pause (Space)', titles.play);
  assert(titles.step === 'Advance one physics step (.)', titles.step);
  assert(titles.reset === 'Stop and return to the editable layout (Shift+Space)', titles.reset);
  assert(/^Undo Add .* \(Ctrl\+Z\)$/.test(titles.undo), titles.undo);
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});
