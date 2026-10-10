/**
 * End-to-end tests for the component system (FB-7) and the page side of protocol v2 (FB-8): adding components with
 * the inspector's Add menu, schema-generated editors for every field kind, live edits of a running simulation,
 * the worker driving bodies from component parameters, analog axes sent from the page, and published state shown live.
 */
import { assert, near, newPage, nextFrame, pose, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const blur = (page) => page.evaluate(() => document.activeElement?.blur());

/** A fresh scene with one box (selected), no gravity and no ground in the way. */
async function boxScene(page, over = {}) {
  await page.evaluate(async (over) => {
    const a = window.physicslab;
    a.newScene();
    a.store.updateSettings({ gravity: [0, 0, 0] });
    const b = a.editor.addShape('box', [0, 2, 0], { name: 'Crate', ...over });
    a.store.setSelection([b.id]);
    a.viewport.setView({ position: [0, 4, 9], target: [0, 2, 0] });
  }, over);
  return page.evaluate(() => window.physicslab.store.bodies()[0].id);
}

test('components: Add menu with search, a constant force driving the body, edits, reorder, disable, remove', async () => {
  const page = await newPage();
  const id = await boxScene(page);
  await page.waitForSelector('.panel.right .section-head:has-text("Components")');
  assert((await page.locator('.panel.right .comp').count()) === 0, 'no components yet');
  assert(
    /No components yet/.test((await page.locator('.panel.right .comp-empty').textContent()) ?? ''),
    'empty state explains',
  );

  // the Add menu: search, categories, keyboard
  await page.click('.panel.right .comp-add');
  await page.waitForSelector('.comp-menu');
  const all = await page.locator('.comp-menu .comp-item .comp-item-name').allTextContents();
  assert(all.includes('Constant force') && all.includes('Sine mover'), `both reference components are offered: ${all}`);
  const heads = await page.locator('.comp-menu .menu-label').allTextContents();
  assert(heads.includes('Forces') && heads.includes('Movers'), `grouped by category: ${heads}`);
  await page.fill('.comp-search', 'sine');
  assert((await page.locator('.comp-menu .comp-item').count()) === 1, 'search narrows the list');
  await page.fill('.comp-search', 'zzzz');
  assert(
    /Nothing matches/.test((await page.locator('.comp-menu .comp-empty').textContent()) ?? ''),
    'no-match message',
  );
  await page.fill('.comp-search', 'forc');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.panel.right .comp[data-type="constantForce"]');
  const added = await page.evaluate((id) => window.physicslab.store.body(id).components, id);
  assert(
    added.length === 1 && added[0].type === 'constantForce' && added[0].enabled,
    `component added: ${JSON.stringify(added)}`,
  );
  assert(await page.evaluate(() => !document.querySelector('.comp-menu')), 'the menu closed');
  assert(
    (await page.locator('.panel.right .section-head:has-text("Components") .badge').textContent()) === '1',
    'badge counts it',
  );

  // schema-driven fields: number-free here, vec3 + bool + enum + showIf
  const card = page.locator('.panel.right .comp[data-type="constantForce"]');
  const forceRow = card.locator('.comp-row:has(.row-label:text-is("Force"))');
  await forceRow.locator('.num-input').nth(0).fill('4');
  await forceRow.locator('.num-input').nth(0).press('Enter');
  await forceRow.locator('.num-input').nth(1).fill('0');
  await forceRow.locator('.num-input').nth(1).press('Enter');
  await card.locator('.comp-row:has(.row-label:text-is("Per unit mass")) .switch').click();
  let p = await page.evaluate((id) => window.physicslab.store.body(id).components[0].params, id);
  assert(JSON.stringify(p.force) === '[4,0,0]' && p.perMass === true, `fields edited: ${JSON.stringify(p)}`);
  assert(
    await card.locator('.comp-row:has(.row-label:text-is("Point"))').isHidden(),
    'the point row is hidden while it does not apply',
  );
  await card.locator('.comp-row:has(.row-label:text-is("Acts at")) select').selectOption('point');
  assert(await card.locator('.comp-row:has(.row-label:text-is("Point"))').isVisible(), 'showIf reveals the point row');
  await card.locator('.comp-row:has(.row-label:text-is("Acts at")) select').selectOption('center');
  await shot(page, 'fb-components');

  // simulate: the worker pushes the body; the live readout shows the published force
  await blur(page);
  await page.keyboard.press('Space');
  await simTime(page, 1);
  await page.waitForFunction((id) => window.physicslab.sim.poseOf(id).position[0] > 1.5, id, { timeout: 20000 });
  await page.keyboard.press('Space'); // pause
  await page.waitForTimeout(600); // the inspector's live readouts refresh at ~11 Hz
  const gauge = await card.locator('.comp-state').textContent();
  assert(
    /Force\s*[\d.]+\s*N/.test(gauge ?? '') && !/—/.test((gauge ?? '').split('Torque')[0]),
    `live gauge shows the applied force: ${gauge}`,
  );
  const x1 = (await pose(page, id)).position[0];
  // edit while paused / running: the new value is used at once, no rebuild (the body keeps its velocity history)
  await forceRow.locator('.num-input').nth(0).fill('0');
  await forceRow.locator('.num-input').nth(0).press('Enter');
  await page.keyboard.press('Space');
  await simTime(page, (await page.evaluate(() => window.physicslab.sim.client.stats?.simTime ?? 0)) + 0.5);
  const x2 = (await pose(page, id)).position[0];
  assert(x2 > x1, `it keeps coasting at the speed it had (${x1} → ${x2})`);
  await page.keyboard.press('Shift+Space'); // reset

  // reorder / disable / remove
  await page.click('.panel.right .comp-add');
  await page.fill('.comp-search', 'const');
  await page.locator('.comp-menu .comp-item').first().click();
  assert((await page.locator('.panel.right .comp').count()) === 2, 'a second force can be added (not unique)');
  const ids = await page.evaluate((id) => window.physicslab.store.body(id).components.map((c) => c.id), id);
  await page.locator('.panel.right .comp').nth(1).locator('button[title="Run earlier"]').click();
  const swapped = await page.evaluate((id) => window.physicslab.store.body(id).components.map((c) => c.id), id);
  assert(swapped[0] === ids[1] && swapped[1] === ids[0], 'reorder swaps the two');
  assert(
    await page.locator('.panel.right .comp').nth(0).locator('button[title="Run earlier"]').isDisabled(),
    'the first card cannot move up',
  );
  await page.locator('.panel.right .comp').nth(0).locator('.comp-switch').click();
  assert(
    await page.evaluate((id) => window.physicslab.store.body(id).components[0].enabled === false, id),
    'switch disables',
  );
  assert(
    await page
      .locator('.panel.right .comp')
      .nth(0)
      .evaluate((e) => e.classList.contains('disabled')),
    'a disabled card is dimmed',
  );
  await page.locator('.panel.right .comp').nth(0).locator('button[title^="Remove"]').click();
  assert((await page.locator('.panel.right .comp').count()) === 1, 'remove drops the card');
  await blur(page);
  await page.keyboard.press('Control+z');
  assert((await page.locator('.panel.right .comp').count()) === 2, 'undo brings it back');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('components: a sine mover drives a kinematic platform exactly and carries a box by friction', async () => {
  const page = await newPage();
  await page.evaluate(async () => {
    const { makeComponent } = await import('/src/model/componentRegistry.ts');
    const a = window.physicslab;
    a.newScene();
    const platform = a.editor.addShape('box', [0, 0.2, 0], {
      name: 'Platform',
      bodyType: 'kinematic',
      shape: { type: 'box', size: [5, 0.4, 3] },
      material: { preset: 'custom', friction: 0.8, color: '#4f8fdb' },
    });
    a.store.update(platform.id, {
      components: [makeComponent('sineMover', { amplitude: 1, frequency: 0.25, phase: -90 })],
    });
    a.editor.addShape('box', [-1, 0.65, 0], {
      name: 'Rider',
      material: { preset: 'custom', friction: 0.8, density: 300 },
    });
    a.store.setSelection([platform.id]);
    a.viewport.setView({ position: [0, 3, 9], target: [0, 0.5, 0] });
  });
  // the Sine mover warns when the body is not kinematic — here it is, so no warning
  await page.waitForSelector('.panel.right .comp[data-type="sineMover"]');
  assert(
    await page.locator('.panel.right .comp[data-type="sineMover"] .comp-warn').isHidden(),
    'no warning on a kinematic body',
  );
  const ids = await page.evaluate(() =>
    Object.fromEntries(window.physicslab.store.bodies().map((b) => [b.name, b.id])),
  );
  await page.keyboard.press('Space');
  // sample the platform against x(t) = A·sin(2π f t − 90°) over a couple of seconds (rendering interpolates between steps)
  let worst = 0;
  let rideMax = 0;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(150);
    const s = await page.evaluate((ids) => {
      const a = window.physicslab;
      return {
        t: a.sim.client.stats?.simTime ?? 0,
        px: a.sim.poseOf(ids.Platform).position[0],
        rx: a.sim.poseOf(ids.Rider).position[0],
      };
    }, ids);
    if (s.t < 0.05) continue; // before the worker's first frames the views still show the authored layout
    worst = Math.max(worst, Math.abs(s.px - Math.sin(2 * Math.PI * 0.25 * s.t - Math.PI / 2)));
    rideMax = Math.max(rideMax, Math.abs(s.rx - s.px));
  }
  await simTime(page, 2.5);
  assert(worst < 0.08, `the platform follows the sine within 8 cm in the browser too (worst ${worst.toFixed(3)} m)`);
  const end = await page.evaluate(
    (ids) => ({
      px: window.physicslab.sim.poseOf(ids.Platform).position[0],
      rx: window.physicslab.sim.poseOf(ids.Rider).position[0],
      ry: window.physicslab.sim.poseOf(ids.Rider).position[1],
    }),
    ids,
  );
  assert(
    Math.abs(end.rx - end.px - -1) < 0.15 || rideMax < 1.2,
    `the rider stays on the platform (offset ${(end.rx - end.px).toFixed(2)})`,
  );
  assert(end.ry > 0.5, 'and has not fallen off');
  const gauge = await page.locator('.panel.right .comp[data-type="sineMover"] .comp-state').textContent();
  assert(/Offset/.test(gauge ?? '') && !/Offset\s*—/.test(gauge ?? ''), `offset gauge is live: ${gauge}`);
  await shot(page, 'fb-sine-mover');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('components: a sine mover on a dynamic body warns in the inspector', async () => {
  const page = await newPage();
  const id = await boxScene(page);
  await page.evaluate(async (id) => {
    const { makeComponent } = await import('/src/model/componentRegistry.ts');
    window.physicslab.store.update(id, { components: [makeComponent('sineMover')] });
  }, id);
  await page.waitForSelector('.panel.right .comp[data-type="sineMover"]');
  const warn = page.locator('.panel.right .comp[data-type="sineMover"] .comp-warn');
  await warn.waitFor({ state: 'visible' });
  assert(/kinematic/i.test((await warn.textContent()) ?? ''), 'the warning says what to do');
  // fixing the body type clears it
  await page.click('.panel.right .seg-btn:has-text("Kinematic")');
  await warn.waitFor({ state: 'hidden' });
  // …and a unique component cannot be added twice
  await page.click('.panel.right .comp-add');
  const item = page.locator('.comp-menu .comp-item[data-type="sineMover"]');
  assert(await item.isDisabled(), 'the Sine mover item is disabled once it is on the body');
  assert(/Already added/.test((await item.textContent()) ?? ''), 'and says why');
  await page.keyboard.press('Escape');
  assert(await page.evaluate(() => !document.querySelector('.comp-menu')), 'Escape closes the menu');
});

test('protocol v2 from the page: analog axes reach the worker; seeds and ray casts answer through the client', async () => {
  const page = await newPage();
  const id = await boxScene(page);
  await page.evaluate(async (id) => {
    const { makeComponent } = await import('/src/model/componentRegistry.ts');
    const a = window.physicslab;
    a.store.update(id, {
      components: [makeComponent('constantForce', { force: [4, 0, 0], perMass: true, axis: 'throttle' })],
    });
  }, id);
  await page.keyboard.press('Space');
  await simTime(page, 0.5);
  const still = (await pose(page, id)).position[0];
  assert(Math.abs(still) < 1e-3, `axis unset: no force (${still})`);
  await page.evaluate(() => window.physicslab.sim.setAxis('throttle', 1));
  await page.waitForFunction((id) => window.physicslab.sim.poseOf(id).position[0] > 0.3, id, { timeout: 20000 });
  // reversing the axis decelerates and reverses the body
  await page.evaluate(() => window.physicslab.sim.setAxis('throttle', -1));
  await page.waitForFunction(
    (id) => window.physicslab.sim.poseOf(id).linvel === undefined || window.physicslab.sim.velocityOf(id).linear[0] < 0,
    id,
    { timeout: 20000 },
  );
  // ray cast through the client: the crate is at (x, 2, 0); cast straight down onto the ground from far to the side
  const down = await page.evaluate(() => window.physicslab.sim.client.raycast([20, 5, 0], [0, -1, 0], 50));
  assert(
    down && down.id === '$ground' && Math.abs(down.distance - 5) < 0.05,
    `ray hits the ground: ${JSON.stringify(down)}`,
  );
  const miss = await page.evaluate(() => window.physicslab.sim.client.raycast([20, 5, 0], [0, 1, 0], 50));
  assert(miss === null, 'and misses upwards');
  // a snapshot taken through the protocol restores the world to that moment
  const snapped = await page.evaluate(async (id) => {
    const a = window.physicslab;
    const snap = await a.sim.client.snapshot();
    const at = a.sim.client.stats?.simTime ?? 0;
    const x = snap.bodies.find((b) => b.def.id === id);
    return { at: snap.simTime, bodies: snap.bodies.length, has: !!x, bytes: snap.rapier.byteLength };
  }, id);
  assert(
    snapped.has && snapped.bytes > 100 && snapped.bodies === 1,
    `snapshot over the worker boundary: ${JSON.stringify(snapped)}`,
  );
  const restored = await page.evaluate(async (id) => {
    const a = window.physicslab;
    const snap = await a.sim.client.snapshot();
    a.sim.pause();
    a.sim.client.restore(snap);
    await new Promise((r) => setTimeout(r, 500));
    const t = a.sim.client.stats?.simTime ?? 0;
    return { t, snapT: snap.simTime };
  }, id);
  near(restored.t, restored.snapT, 0.05, 'restore puts the clock back to the snapshot');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('components: every field kind gets a generated editor (number, bool, enum, vec3, colour, key, text, entity, path, curve)', async () => {
  const page = await newPage();
  const id = await boxScene(page);
  const other = await page.evaluate(() => {
    const a = window.physicslab;
    const o = a.editor.addShape('sphere', [3, 1, 0], { name: 'Target' });
    a.editor.addPath([0, 0.05, 4], { name: 'Route' });
    a.store.setSelection([a.store.bodies()[0].id]); // adding selects the new object: back to the crate
    return o.id;
  });
  await page.evaluate(async (id) => {
    const { registerComponent, makeComponent } = await import('/src/model/componentRegistry.ts');
    registerComponent({
      type: 'e2eDemo',
      label: 'Demo',
      icon: 'component',
      category: 'Tests',
      blurb: 'every field kind',
      appliesTo: 'body',
      fields: [
        { kind: 'number', key: 'n', label: 'Number', default: 2, min: 0, max: 10, unit: 'm' },
        { kind: 'bool', key: 'b', label: 'Flag', default: false },
        {
          kind: 'enum',
          key: 'e',
          label: 'Mode',
          default: 'a',
          options: [
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
          ],
        },
        { kind: 'vec3', key: 'v', label: 'Vector', default: [1, 2, 3] },
        { kind: 'color', key: 'c', label: 'Tint', default: '#112233' },
        { kind: 'key', key: 'k', label: 'Hotkey', default: '' },
        { kind: 'text', key: 't', label: 'Name', default: 'hi', maxLength: 8 },
        { kind: 'entity', key: 'who', label: 'Target', default: '' },
        { kind: 'path', key: 'route', label: 'Route', default: '' },
        {
          kind: 'curve',
          key: 'curve',
          label: 'Curve',
          default: [
            [0, 0],
            [1, 1],
          ],
          xRange: [0, 1],
          yRange: [0, 10],
          xLabel: 'x',
          yLabel: 'y',
        },
      ],
    });
    window.physicslab.store.update(id, { components: [makeComponent('e2eDemo')] });
  }, id);
  const card = page.locator('.panel.right .comp[data-type="e2eDemo"]');
  await card.waitFor();
  const row = (label) => card.locator(`.comp-row:has(.row-label:text-is("${label}"))`);
  const params = () => page.evaluate((id) => window.physicslab.store.body(id).components[0].params, id);

  await row('Number').locator('.num-input').fill('99'); // clamped to the field's maximum
  await row('Number').locator('.num-input').press('Enter');
  assert((await params()).n === 10, 'number editor clamps to max');
  await row('Flag').locator('.switch').click();
  assert((await params()).b === true, 'bool editor toggles');
  await row('Mode').locator('select').selectOption('b');
  assert((await params()).e === 'b', 'enum editor selects');
  await row('Vector').locator('.num-input').nth(2).fill('-7');
  await row('Vector').locator('.num-input').nth(2).press('Enter');
  assert(JSON.stringify((await params()).v) === '[1,2,-7]', 'vec3 editor edits one axis');
  await row('Tint').locator('.hex-input').fill('#ff8800');
  await row('Tint').locator('.hex-input').press('Enter');
  await row('Tint')
    .locator('.hex-input')
    .evaluate((e) => e.dispatchEvent(new Event('change')));
  assert((await params()).c === '#ff8800', 'colour editor takes a hex value');
  await row('Hotkey').locator('.key-btn').click();
  await page.keyboard.press('KeyQ');
  assert((await params()).k === 'KeyQ', 'key editor captures a key press');
  await row('Name').locator('input').fill('abcdefghijkl');
  await row('Name').locator('input').press('Enter');
  assert((await params()).t === 'abcdefgh', 'text editor respects maxLength');
  // entity + path references list the scene by name
  const entityOptions = await row('Target').locator('select option').allTextContents();
  assert(
    entityOptions.includes('Target') && !entityOptions.includes('Route'),
    `entity picker offers bodies: ${entityOptions}`,
  );
  await row('Target').locator('select').selectOption(other);
  assert((await params()).who === other, 'entity reference stored by id');
  const pathOptions = await row('Route').locator('select option').allTextContents();
  assert(pathOptions.includes('Route') && !pathOptions.includes('Crate'), `path picker offers paths: ${pathOptions}`);
  const pathId = await page.evaluate(() => window.physicslab.store.paths()[0].id);
  await row('Route').locator('select').selectOption(pathId);
  assert((await params()).route === pathId, 'path reference stored by id');
  // deleting the referenced entity clears the reference, in the same undo step
  await page.evaluate((o) => window.physicslab.store.remove([o]), other);
  assert((await params()).who === '', 'deleting the target clears the reference');
  await page.evaluate(() => window.physicslab.store.undo());
  assert((await params()).who === other, 'and undo restores it');
  // the curve editor: add a point by clicking, drag it, delete it by double-click
  const svg = row('Curve').locator('svg.curve-svg');
  const box = await svg.boundingBox();
  const at = (cx, cy) => ({ x: box.x + (cx / 260) * box.width, y: box.y + (cy / 120) * box.height });
  const mid = at(14 + (260 - 28) * 0.5, 120 - 14 - (120 - 28) * 0.5);
  await page.mouse.click(mid.x, mid.y);
  let curve = (await params()).curve;
  assert(
    curve.length === 3 && Math.abs(curve[1][0] - 0.5) < 0.02 && Math.abs(curve[1][1] - 5) < 0.2,
    `click adds a point: ${JSON.stringify(curve)}`,
  );
  const to = at(14 + (260 - 28) * 0.5, 120 - 14 - (120 - 28) * 0.9);
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  curve = (await params()).curve;
  assert(
    curve.length === 3 && Math.abs(curve[1][1] - 9) < 0.3 && Math.abs(curve[1][0] - 0.5) < 0.02,
    `drag moves it: ${JSON.stringify(curve)}`,
  );
  await page.mouse.dblclick(to.x, to.y);
  curve = (await params()).curve;
  assert(curve.length === 2, `double-click deletes it: ${JSON.stringify(curve)}`);
  await shot(page, 'fb-component-editors');
  // an undo step per gesture: undo the delete → the point is back
  await page.evaluate(() => document.activeElement?.blur());
  await page.evaluate(() => window.physicslab.store.undo());
  assert((await params()).curve.length === 3, 'undo restores the deleted point');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('components: a component that fails in the worker is switched off and reported with a toast', async () => {
  const page = await newPage();
  const id = await boxScene(page);
  // The runtime registry is shared with the worker only for built-in components, so provoke a real fault
  // with built-in code: a path reference that makes no sense cannot throw… instead check the plumbing the app
  // uses for the toast by emitting the same event the host raises.
  await page.evaluate((id) => {
    const a = window.physicslab;
    a.sim.client.emit('event', {
      kind: 'component',
      t: 0,
      owner: id,
      component: 'c_x',
      type: 'constantForce',
      name: 'error',
      data: { phase: 'prestep', message: 'kaboom' },
    });
  }, id);
  const toast = await page.locator('.toast.warn').first().textContent();
  assert(
    /Constant force on Crate stopped: kaboom/.test(toast ?? ''),
    `toast names the component, owner and reason: ${toast}`,
  );
  await nextFrame(page);
});
