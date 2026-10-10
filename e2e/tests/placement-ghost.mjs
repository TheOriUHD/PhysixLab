/**
 * Ghost placement in the real UI (src/app/placementGhost.ts): a library tile dragged into the viewport (or armed by a
 * click or a number key) shows a ghost that follows the pointer, and the real object is created only on release /
 * click — one undo step, selected — while Esc, a right click or letting go over a panel cancels without a trace.
 * Real mouse and keyboard events throughout; touch is driven with pointer events of type "touch".
 */
import { assert, near, newPage, nextFrame, shot } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const HINT = 'Click to place · Esc to cancel · Q/E or R rotate · [ ] raise/lower · Shift+click = place several';

/** An empty scene viewed from a fixed camera, grid snapping on (0.25 m), a known viewport rectangle. */
async function fresh(page, prefs = {}) {
  await page.evaluate((prefs) => {
    const a = window.physicslab;
    a.newScene();
    a.store.remove(
      a.store.all().map((e) => e.id),
      'clear',
    );
    a.store.setSelection([]);
    a.prefs.set({
      followSelection: false,
      snap: true,
      snapGrid: 0.25,
      snapVertex: false,
      snapEdge: false,
      snapFace: false,
      snapBounds: false,
      snapSurface: true,
      snapAlignNormal: false,
      leftTab: 'add',
      showLeft: true,
      ...prefs,
    });
    a.viewport.setView({ position: [9, 7, 11], target: [0, 0.5, 0] });
  }, prefs);
  await nextFrame(page);
  await page.waitForTimeout(250);
  await nextFrame(page);
}

const viewRect = (page) =>
  page.evaluate(() => {
    const r = window.physicslab.viewport.dom.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });

/** Client position of a ground point (the pointer that lands the ghost there). */
const screenOfPoint = (page, p) =>
  page.evaluate((p) => {
    const a = window.physicslab;
    const v = new a.camera.position.constructor(p[0], p[1], p[2]).project(a.camera);
    const r = a.viewport.dom.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }, p);

const ghost = (page) =>
  page.evaluate(() => {
    const g = window.physicslab.placement.ghost;
    return {
      active: g.active,
      mode: g.mode,
      pose: g.pose,
      tint: g.tint,
      visible: g.visible,
      yaw: g.yawDeg,
      lift: g.lift,
      objects: g.objectCount,
      hud: g.hud(),
      id: g.placeable?.id ?? null,
    };
  });

/** Number of three.js objects in the whole scene graph (the ghost adds some while it is active). */
const sceneCount = (page) =>
  page.evaluate(() => {
    let n = 0;
    window.physicslab.viewport.scene.traverse(() => n++);
    return n;
  });

/** Objects of the ghost still in the scene graph (its two groups and everything below them): 0 when none. */
const ghostNodes = (page) =>
  page.evaluate(() => {
    let n = 0;
    window.physicslab.viewport.scene.traverse((o) => {
      if (o.name === 'placement-ghost' || o.name === 'placement-ghost-marks') o.traverse(() => n++);
    });
    return n;
  });

const bodies = (page) => page.evaluate(() => window.physicslab.store.bodies().length);
const entities = (page) => page.evaluate(() => window.physicslab.store.all().length);
const tileBox = async (page, sel) => {
  const t = page.locator(sel).first();
  await t.scrollIntoViewIfNeeded();
  return t.boundingBox();
};
const centre = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

async function pressTile(page, sel) {
  const c = centre(await tileBox(page, sel));
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  return c;
}

test('placement ghost: dragging a tile into the viewport shows a ghost that follows the pointer; the object is created on release only', async () => {
  const page = await newPage();
  await fresh(page);
  const base = await sceneCount(page);
  const n0 = await bodies(page);
  const from = await pressTile(page, '.shape-tile[data-shape="box"]');
  await page.mouse.move(from.x + 2, from.y + 1);
  assert(!(await ghost(page)).active, 'a press that barely moves is not a drag yet');
  const spot1 = await screenOfPoint(page, [1.5, 0, 2]);
  await page.mouse.move(spot1.x, spot1.y, { steps: 8 });
  await nextFrame(page);
  let g = await ghost(page);
  assert(g.active && g.mode === 'drag' && g.visible, `a ghost appears in the viewport ${JSON.stringify(g)}`);
  assert(g.id === 'shape:box' && g.tint === 'ok', 'a valid spot is tinted ok (cyan)');
  near(g.pose.position[0], 1.5, 0.01, 'ghost x lands under the pointer (grid snapped)');
  near(g.pose.position[2], 2, 0.01, 'ghost z lands under the pointer (grid snapped)');
  near(g.pose.position[1], 0.501, 0.002, 'the ghost rests flush on the ground (half height up)');
  assert((await sceneCount(page)) > base, 'the ghost is in the three.js scene');
  assert((await bodies(page)) === n0 && (await entities(page)) === n0, 'nothing was created while dragging');
  assert(
    (await page.evaluate(() => window.physicslab.bodies.views.size)) === n0,
    'no body view was made for the ghost (it is not part of the scene or the physics)',
  );
  // the ghost is never hit by a pick ray
  const hit = await page.evaluate(
    ([x, y]) => window.physicslab.pickEntity({ clientX: x, clientY: y }),
    [spot1.x, spot1.y],
  );
  assert(hit === null, 'the ghost cannot be picked');
  assert(
    (await page.locator('.place-hud').isVisible()) && (await page.locator('.v-label.place-label').count()) === 1,
    'hint bar and label are shown',
  );
  await shot(page, 'placement-ghost-drag-box');
  // it follows the pointer
  const spot2 = await screenOfPoint(page, [-2, 0, -1]);
  await page.mouse.move(spot2.x, spot2.y, { steps: 6 });
  await nextFrame(page);
  g = await ghost(page);
  near(g.pose.position[0], -2, 0.01, 'the ghost follows the pointer (x)');
  near(g.pose.position[2], -1, 0.01, 'the ghost follows the pointer (z)');
  const ghostAt = [...g.pose.position];
  await page.mouse.up();
  await nextFrame(page);
  g = await ghost(page);
  assert(!g.active, 'the ghost is gone after the release');
  assert((await ghostNodes(page)) === 0, 'every ghost object left the scene');
  assert((await bodies(page)) === n0 + 1, 'one body was created on release');
  const placed = await page.evaluate(() => {
    const a = window.physicslab;
    const b = a.store.body(a.store.selection[0]);
    return { pos: b.position, sel: a.store.selection.length, label: a.store.undoLabel };
  });
  for (let i = 0; i < 3; i++)
    near(placed.pos[i], ghostAt[i], 1e-6, `the body is exactly where the ghost was (axis ${i})`);
  assert(placed.sel === 1, 'the new object is selected');
  assert(/Add Box/.test(placed.label), `one undo step named for it (${placed.label})`);
  await page.evaluate(() => window.physicslab.store.undo());
  assert((await bodies(page)) === n0, 'one undo removes it');
  assert(page.errors.length === 0, `page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('placement ghost: Esc, a right click or letting go over a panel cancels with no side effects', async () => {
  const page = await newPage();
  await fresh(page);
  const spot = await screenOfPoint(page, [1, 0, 1]);
  // Esc mid-drag
  await pressTile(page, '.shape-tile[data-shape="sphere"]');
  await page.mouse.move(spot.x, spot.y, { steps: 6 });
  assert((await ghost(page)).active, 'ghost while dragging');
  await page.keyboard.press('Escape');
  assert(!(await ghost(page)).active, 'Esc cancels the drag');
  await page.mouse.up();
  await nextFrame(page);
  assert((await entities(page)) === 0 && (await ghostNodes(page)) === 0, 'nothing created, nothing left behind');
  // moving on after Esc does not bring the ghost back
  await page.mouse.move(spot.x + 30, spot.y + 10);
  assert(!(await ghost(page)).active, 'the cancelled drag stays cancelled');
  // letting go over a panel (the left library)
  const tb = await tileBox(page, '.shape-tile[data-shape="cone"]');
  await pressTile(page, '.shape-tile[data-shape="cone"]');
  await page.mouse.move(spot.x, spot.y, { steps: 6 });
  const over = await ghost(page);
  assert(over.active && over.visible, 'ghost over the viewport');
  await page.mouse.move(tb.x + 10, tb.y + tb.height + 40, { steps: 6 });
  const away = await ghost(page);
  assert(away.active && !away.visible, 'over a panel the ghost hides (release would cancel)');
  assert(await page.locator('.place-chip.cancel').isVisible(), 'the drag chip says release cancels');
  await page.mouse.up();
  await nextFrame(page);
  assert(!(await ghost(page)).active && (await entities(page)) === 0, 'release over a panel cancels');
  assert((await ghostNodes(page)) === 0, 'no ghost objects left');
  // right click while dragging
  await pressTile(page, '.shape-tile[data-shape="cylinder"]');
  await page.mouse.move(spot.x, spot.y, { steps: 6 });
  assert((await ghost(page)).active, 'ghost again');
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  assert(!(await ghost(page)).active, 'a right click cancels the drag');
  await page.mouse.up();
  await nextFrame(page);
  assert((await entities(page)) === 0, 'still nothing created');
  // no stale chip or hint
  assert(
    !(await page.locator('.place-hud').isVisible()) && !(await page.locator('.place-chip').isVisible()),
    'no hint or chip is left',
  );
  assert(page.errors.length === 0, `page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('placement ghost: a click arms placement; click places, Shift+click places several, Esc cancels; Enter places at the view centre', async () => {
  const page = await newPage();
  await fresh(page);
  await page.locator('.shape-tile[data-shape="box"]').first().click();
  let g = await ghost(page);
  assert(g.active && g.mode === 'armed', 'a click on a tile arms placement');
  assert((await bodies(page)) === 0, 'nothing is created by arming');
  assert((await page.locator('.place-hud-main').textContent()) === HINT, 'the hint bar says how to place');
  assert((await page.locator('.shape-tile[data-shape="box"].armed').count()) === 1, 'the armed tile is highlighted');
  assert(g.visible && g.tint === 'ok', 'while the pointer is off the viewport the ghost waits at the view centre');
  // pointer into the viewport: the ghost follows
  const a = await screenOfPoint(page, [2, 0, 1]);
  await page.mouse.move(a.x, a.y, { steps: 6 });
  await nextFrame(page);
  g = await ghost(page);
  near(g.pose.position[0], 2, 0.01, 'armed ghost follows the cursor');
  await page.mouse.click(a.x, a.y);
  await nextFrame(page);
  assert(!(await ghost(page)).active && (await bodies(page)) === 1, 'a click places one and ends placement');
  near(await page.evaluate(() => window.physicslab.store.bodies()[0].position[0]), 2, 0.01, 'placed under the click');
  // Shift+click keeps it armed
  await page.locator('.shape-tile[data-shape="sphere"]').first().click();
  const b1 = await screenOfPoint(page, [-1, 0, 0]);
  const b2 = await screenOfPoint(page, [-2, 0, 1.5]);
  await page.mouse.move(b1.x, b1.y, { steps: 5 });
  await page.keyboard.down('Shift');
  await page.mouse.click(b1.x, b1.y);
  await page.mouse.move(b2.x, b2.y, { steps: 5 });
  await page.mouse.click(b2.x, b2.y);
  await page.keyboard.up('Shift');
  assert((await bodies(page)) === 3, 'Shift+click placed two more');
  assert((await ghost(page)).active, 'and placement is still armed');
  await page.keyboard.press('Escape');
  assert(!(await ghost(page)).active, 'Esc cancels the armed placement');
  assert((await bodies(page)) === 3 && (await ghostNodes(page)) === 0, 'with nothing added or left behind');
  // right click cancels
  await page.locator('.shape-tile[data-shape="cone"]').first().click();
  await page.mouse.move(a.x, a.y, { steps: 4 });
  await page.mouse.click(a.x, a.y, { button: 'right' });
  assert(!(await ghost(page)).active && (await bodies(page)) === 3, 'a right click cancels too');
  // a click on a panel ends it
  await page.locator('.shape-tile[data-shape="cone"]').first().click();
  await page.locator('.shape-search-input').click();
  assert(!(await ghost(page)).active, 'pressing elsewhere in the UI ends placement');
  // Enter with the pointer off the viewport places at the view centre; double-click adds at once
  await page.locator('.shape-tile[data-shape="cylinder"]').first().click();
  const before = await bodies(page);
  await page.keyboard.press('Enter');
  assert(
    (await bodies(page)) === before + 1 && !(await ghost(page)).active,
    'Enter places it at the ghost (view centre)',
  );
  await page.locator('.shape-tile[data-shape="cone"]').first().dblclick();
  assert(
    (await bodies(page)) === before + 2 && !(await ghost(page)).active,
    'a double-click adds at the view centre at once',
  );
  // the number keys use the same flow
  await page.keyboard.press('2');
  g = await ghost(page);
  assert(g.active && g.id.startsWith('shape:'), `a number key arms a ghost (${g.id})`);
  assert((await bodies(page)) === before + 2, 'and does not create anything yet');
  await page.keyboard.press('Escape');
  await page.close();
});

test('placement ghost: Q/E rotate, [ ] raise and lower, X aligns, Alt suspends snapping, and no tool shortcut fires behind it', async () => {
  const page = await newPage();
  await fresh(page);
  await page.locator('.shape-tile[data-shape="box"]').first().click();
  const spot = await screenOfPoint(page, [1.13, 0, 0.9]);
  await page.mouse.move(spot.x, spot.y, { steps: 5 });
  const tool0 = await page.evaluate(() => window.physicslab.prefs.value.tool);
  const key = async (k, mod) => {
    if (mod) await page.keyboard.down(mod);
    await page.keyboard.press(k);
    if (mod) await page.keyboard.up(mod);
  };
  await key('KeyE');
  await key('KeyE');
  assert((await ghost(page)).yaw === 30, 'E twice turns by 30°');
  await key('KeyQ');
  assert((await ghost(page)).yaw === 15, 'Q turns back 15°');
  await key('KeyE', 'Shift');
  assert((await ghost(page)).yaw === 16, 'Shift+E turns 1°');
  await key('KeyR');
  assert((await ghost(page)).yaw === 30, 'R turns on to the next 15°');
  await key('KeyR', 'Shift');
  assert((await ghost(page)).yaw === 15, 'Shift+R turns back');
  await key('BracketRight');
  await key('BracketRight');
  let g = await ghost(page);
  near(g.lift, 0.5, 1e-9, '] raises by the grid step');
  near(g.pose.position[1], 1.001, 0.002, 'the ghost is raised with the surface offset');
  await key('BracketLeft');
  near((await ghost(page)).lift, 0.25, 1e-9, '[ lowers');
  await key('BracketLeft');
  await key('BracketLeft');
  near((await ghost(page)).lift, -0.25, 1e-9, '[ can sink it below the surface offset');
  await key('BracketRight');
  await key('BracketRight');
  await key('BracketRight');
  near((await ghost(page)).lift, 0.5, 1e-9, 'back up to +0.5 m');
  // X flips the alignment toggle
  const a0 = await page.evaluate(() => window.physicslab.placement.ghost.hud().align);
  await key('KeyX');
  assert(
    (await page.evaluate(() => window.physicslab.placement.ghost.hud().align)) === !a0,
    'X toggles align to surface',
  );
  await key('KeyX');
  // other tool shortcuts do not fire behind the ghost
  await key('KeyW');
  await key('KeyT');
  assert(
    (await page.evaluate(() => window.physicslab.prefs.value.tool)) === tool0,
    'W / T do not change the tool while placing',
  );
  assert((await ghost(page)).active, 'and the ghost is still armed');
  // legend
  const legend = await page.evaluate(() => window.physicslab.placement.ghost.legendEntries());
  const keysText = legend.map((l) => l.keys).join(' | ');
  for (const k of ['Q / E', '[ / ]', 'X', 'Esc', 'Click'])
    assert(keysText.includes(k), `legend lists ${k} (${keysText})`);
  assert(
    await page.evaluate(() =>
      window.physicslab.placement.ghost.handleKey(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' })),
    ),
    'handleKey swallows plain letters',
  );
  assert(
    !(await page.evaluate(() =>
      window.physicslab.placement.ghost.handleKey(new KeyboardEvent('keydown', { code: 'Digit4', key: '4' })),
    )),
    'handleKey leaves digits to the shape commands',
  );
  assert(
    !(await page.evaluate(() =>
      window.physicslab.placement.ghost.handleKey(
        new KeyboardEvent('keydown', { code: 'KeyZ', key: 'z', ctrlKey: true }),
      ),
    )),
    'handleKey leaves Ctrl chords (undo) alone',
  );
  // the same key event handed over twice is applied once
  const once = await page.evaluate(() => {
    const g = window.physicslab.placement.ghost;
    const e = new KeyboardEvent('keydown', { code: 'KeyE', key: 'e' });
    const y0 = g.yawDeg;
    g.handleKey(e);
    g.handleKey(e);
    return g.yawDeg - y0;
  });
  assert(once === 15, `a key event is applied once even when routed twice (${once})`);
  // Alt: snapping off — the ghost sits exactly under the pointer instead of on the grid
  const snapped = (await ghost(page)).pose.position;
  near(snapped[0] % 0.25, 0, 1e-6, 'grid snapped by default');
  await page.keyboard.down('Alt');
  await nextFrame(page);
  const free = (await ghost(page)).pose.position;
  await page.keyboard.up('Alt');
  assert(
    Math.abs((free[0] / 0.25) % 1) > 1e-3 || Math.abs((free[2] / 0.25) % 1) > 1e-3,
    `Alt disables snapping (${free})`,
  );
  near(free[0], 1.13, 0.05, 'Alt: the ghost is exactly under the pointer');
  // place it and compare with what the ghost showed
  await key('Enter');
  const b = await page.evaluate(() => {
    const a = window.physicslab;
    const e = a.store.body(a.store.selection[0]);
    return { pos: e.position, rot: e.rotation };
  });
  assert(Math.abs(b.rot[1]) > 0.1, `the body carries the ghost's turn (${b.rot})`);
  assert(b.pos[1] > 0.7, `and its height (${b.pos})`);
  await page.close();
});

test('placement ghost: tilt alignment follows a slope, and Alt places without snapping', async () => {
  const page = await newPage();
  await fresh(page, { snapAlignNormal: true });
  await page.evaluate(() => {
    const a = window.physicslab;
    a.editor.addShape('box', [0, 1, 0], {
      bodyType: 'static',
      shape: { type: 'box', size: [6, 0.2, 6] },
      rotation: [Math.sin(Math.PI / 12), 0, 0, Math.cos(Math.PI / 12)],
    });
    a.store.setSelection([]);
  });
  await nextFrame(page);
  const spot = await screenOfPoint(page, [0, 1.1, 0.3]);
  await page.locator('.shape-tile[data-shape="box"]').first().click();
  await page.mouse.move(spot.x, spot.y, { steps: 5 });
  await nextFrame(page);
  const g = await ghost(page);
  const q = g.pose.rotation;
  const up = [2 * (q[0] * q[1] - q[3] * q[2]), 1 - 2 * (q[0] * q[0] + q[2] * q[2]), 2 * (q[1] * q[2] + q[3] * q[0])];
  near(up[1], Math.cos(Math.PI / 6), 1e-6, 'the ghost is tilted onto the slope normal');
  near(Math.abs(up[2]), Math.sin(Math.PI / 6), 1e-6, 'about the slope axis');
  await shot(page, 'placement-ghost-slope');
  await page.keyboard.press('KeyX');
  const q2 = (await ghost(page)).pose.rotation;
  assert(Math.abs(q2[0]) < 1e-9 && Math.abs(q2[2]) < 1e-9, 'X turns the alignment off: the ghost stands upright');
  await page.keyboard.press('Escape');
  await page.close();
});

test('placement ghost: prefabs show every body, soft bodies show their surface; both land as one undo step', async () => {
  const page = await newPage();
  await fresh(page, { leftTab: 'prefabs' });
  await page.waitForSelector('.card[data-placeable]');
  const spot = await screenOfPoint(page, [0, 0, 1]);
  // a multi-body assembly with joints (the first built-in prefab is the drivable car)
  const card = '.card:has-text("Domino row")';
  await pressTile(page, card);
  await page.mouse.move(spot.x, spot.y, { steps: 8 });
  await nextFrame(page);
  let g = await ghost(page);
  assert(g.active && g.id.startsWith('prefab:'), 'a prefab ghost appears');
  assert(g.objects > 4, `a prefab ghost is more than a box (${g.objects} objects)`);
  const ghostBodies = await page.evaluate(
    () => window.physicslab.placement.ghost.placeable.entities().filter((e) => e.kind === 'body').length,
  );
  assert(ghostBodies >= 14, `it stands for every body of the prefab (${ghostBodies})`);
  assert((await entities(page)) === 0, 'nothing is created while dragging');
  await shot(page, 'placement-ghost-prefab');
  const at = [...g.pose.position];
  await page.mouse.up();
  await nextFrame(page);
  const n = await bodies(page);
  assert(n === ghostBodies, `all ${ghostBodies} bodies were created on release (${n})`);
  const sel = await page.evaluate(() => window.physicslab.store.selection.length);
  assert(sel === n, 'they are all selected');
  const c = await page.evaluate(() => {
    const bs = window.physicslab.store.bodies();
    const m = [0, 0, 0];
    for (const b of bs) for (let i = 0; i < 3; i++) m[i] += b.position[i] / bs.length;
    return m;
  });
  near(c[0], at[0], 1.2, 'the assembly is where the ghost was (x)');
  near(c[2], at[2], 1.2, 'the assembly is where the ghost was (z)');
  await page.evaluate(() => window.physicslab.store.undo());
  assert((await entities(page)) === 0, 'one undo removes the whole assembly');
  assert((await ghostNodes(page)) === 0, 'no ghost objects left');
  // soft bodies
  await page.evaluate(() => window.physicslab.prefs.set({ leftTab: 'add' }));
  await page.waitForSelector('.tile:has-text("Jelly")');
  await pressTile(page, '.tile:has-text("Jelly")');
  await page.mouse.move(spot.x, spot.y, { steps: 8 });
  await nextFrame(page);
  g = await ghost(page);
  assert(
    g.active && g.id === 'soft:jelly' && g.objects >= 5,
    `a jelly ghost shows its surface (${g.id}, ${g.objects})`,
  );
  await shot(page, 'placement-ghost-jelly');
  await page.mouse.up();
  await nextFrame(page);
  const soft = await page.evaluate(() => window.physicslab.store.all().filter((e) => e.kind === 'soft').length);
  assert(soft === 1, 'the jelly was created on release');
  await page.evaluate(() => window.physicslab.store.undo());
  // cloth hovers above the surface
  await pressTile(page, '.tile:has-text("Cloth")');
  await page.mouse.move(spot.x, spot.y, { steps: 8 });
  await nextFrame(page);
  g = await ghost(page);
  assert(g.pose.position[1] >= 1.4, `a cloth hangs above the surface under the pointer (${g.pose.position[1]})`);
  assert((await page.locator('.v-label.place-label').count()) === 1, 'with a label');
  await shot(page, 'placement-ghost-cloth');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert((await entities(page)) === 0, 'Esc cancels the cloth');
  assert(page.errors.length === 0, `page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('placement ghost: lights and zones place on the surface under the pointer', async () => {
  const page = await newPage();
  await fresh(page);
  const spot = await screenOfPoint(page, [2, 0, 0]);
  await pressTile(page, '.tile:has-text("Spot")');
  await page.mouse.move(spot.x, spot.y, { steps: 6 });
  let g = await ghost(page);
  near(g.pose.position[1], 3.01, 0.02, 'a light hangs 3 m above the point under the pointer');
  await page.mouse.up();
  await nextFrame(page);
  const light = await page.evaluate(() => window.physicslab.store.lights().length);
  assert(light === 1, 'the light was created');
  await page.evaluate(() => window.physicslab.store.setSelection([]));
  await pressTile(page, '.zone-tiles .tile[data-zone="checkpoint"]');
  await page.mouse.move(spot.x, spot.y, { steps: 6 });
  g = await ghost(page);
  assert(g.active && g.id === 'zone:checkpoint', 'a zone ghost appears');
  await page.mouse.up();
  await nextFrame(page);
  const zones = await page.evaluate(() => window.physicslab.zones.zones().length);
  assert(zones === 1, 'the zone was created');
  assert(page.errors.length === 0, `page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('placement ghost: red outside the world bounds (nothing is placed there), amber when it sinks into something solid', async () => {
  const page = await newPage();
  await fresh(page);
  await page.evaluate(() => {
    const a = window.physicslab;
    a.store.updateSettings({
      bounds: { ...a.store.settings.bounds, enabled: true, min: [-6, -3, -6], max: [1, 20, 6] },
    });
    a.editor.addShape('box', [-2, 0.5, 0], {
      bodyType: 'static',
      name: 'Slab',
      shape: { type: 'box', size: [2, 1, 2] },
    });
    a.store.setSelection([]);
  });
  await nextFrame(page);
  await page.locator('.shape-tile[data-shape="box"]').first().click();
  const out = await screenOfPoint(page, [3, 0, 1]);
  await page.mouse.move(out.x, out.y, { steps: 6 });
  await nextFrame(page);
  let g = await ghost(page);
  assert(
    g.tint === 'bad' && g.pose.reason === 'Outside the world bounds',
    `outside the bounds is red (${g.tint} ${g.pose.reason})`,
  );
  assert(
    /Outside the world bounds/.test(await page.locator('.v-label.place-label').textContent()),
    'the label says why',
  );
  await shot(page, 'placement-ghost-invalid');
  const n0 = await bodies(page);
  await page.mouse.click(out.x, out.y);
  assert(
    (await bodies(page)) === n0 && (await ghost(page)).active,
    'clicking there places nothing and keeps the ghost',
  );
  // inside, on the ground: fine; lowered into the slab: amber with a warning (allowed)
  const inside = await screenOfPoint(page, [-2, 1, 0]);
  await page.mouse.move(inside.x, inside.y, { steps: 6 });
  g = await ghost(page);
  assert(g.tint === 'ok', `on top of the slab is fine (${g.tint})`);
  for (let i = 0; i < 3; i++) await page.keyboard.press('BracketLeft');
  g = await ghost(page);
  assert(
    g.tint === 'warn' && /Overlaps Slab/.test(g.pose.warning),
    `sunk into a solid body is amber (${g.tint} ${g.pose.warning})`,
  );
  await shot(page, 'placement-ghost-warning');
  await page.mouse.click(inside.x, inside.y);
  assert((await bodies(page)) === n0 + 1, 'a warned spot can still be placed');
  await page.close();
});

test('placement ghost: no ghost is left behind by blur, a new scene or starting the simulation; placing works while running and paused', async () => {
  const page = await newPage();
  await fresh(page);
  const arm = (id) => page.locator(`.shape-tile[data-shape="${id}"]`).first().click();
  await arm('box');
  assert((await ghost(page)).active, 'armed');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert(!(await ghost(page)).active && (await ghostNodes(page)) === 0, 'window blur ends placement');
  await arm('box');
  await page.evaluate(() => window.physicslab.newScene());
  assert(!(await ghost(page)).active && (await ghostNodes(page)) === 0, 'loading a scene ends placement');
  await arm('box');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.physicslab.sim.mode === 'running');
  assert(!(await ghost(page)).active && (await ghostNodes(page)) === 0, 'starting the simulation ends placement');
  // while running: a live body
  const n0 = await bodies(page);
  const spot = await screenOfPoint(page, [1, 3, 0]);
  await arm('sphere');
  await page.mouse.move(spot.x, spot.y, { steps: 4 });
  await page.mouse.click(spot.x, spot.y);
  assert((await bodies(page)) === n0 + 1, 'placing while running adds a body');
  const id = await page.evaluate(() => window.physicslab.store.selection[0]);
  await page.waitForFunction((id) => !!window.physicslab.sim.poseOf(id), id);
  // paused
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.physicslab.sim.mode === 'paused');
  await arm('cone');
  assert((await ghost(page)).active, 'a ghost can be armed while paused');
  await page.keyboard.press('Enter');
  assert((await bodies(page)) === n0 + 2, 'and places while paused');
  assert((await ghostNodes(page)) === 0, 'no ghost objects left');
  assert(page.errors.length === 0, `page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('placement ghost: touch — a long-press then drag on a tile shows the ghost and places on release; a quick swipe still scrolls', async () => {
  const page = await newPage();
  await fresh(page);
  const tb = await tileBox(page, '.shape-tile[data-shape="box"]');
  const spot = await screenOfPoint(page, [1, 0, 1]);
  const fire = (type, target, x, y, id = 7) =>
    page.evaluate(
      ([type, target, x, y, id]) => {
        const el =
          target === 'tile' ? document.querySelector('.shape-tile[data-shape="box"]') : document.elementFromPoint(x, y);
        const ev = new PointerEvent(type, {
          pointerId: id,
          pointerType: 'touch',
          isPrimary: true,
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
        });
        (el ?? document.body).dispatchEvent(ev);
      },
      [type, target, x, y, id],
    );
  const c = centre(tb);
  // a quick swipe: the finger moves before the long-press fires, so it is a scroll
  await fire('pointerdown', 'tile', c.x, c.y);
  await fire('pointermove', 'tile', c.x, c.y + 40);
  await page.waitForTimeout(500);
  assert(!(await ghost(page)).active, 'a quick swipe does not start a drag');
  await fire('pointerup', 'tile', c.x, c.y + 40);
  // long-press, then drag
  await fire('pointerdown', 'tile', c.x, c.y, 8);
  await page.waitForTimeout(520);
  assert((await ghost(page)).active, 'a long-press arms the drag');
  await fire('pointermove', 'viewport', spot.x, spot.y, 8);
  await nextFrame(page);
  let g = await ghost(page);
  assert(g.visible && g.mode === 'drag', 'the ghost follows the finger over the viewport');
  near(g.pose.position[0], 1, 0.01, 'under the finger');
  await fire('pointerup', 'viewport', spot.x, spot.y, 8);
  await nextFrame(page);
  assert(!(await ghost(page)).active && (await bodies(page)) === 1, 'lifting the finger places it');
  assert(page.errors.length === 0, `page errors: ${page.errors.join(' | ')}`);
  await page.close();
});
