/**
 * ED-14 / ED-15 in the real UI: numeric entry with relative expressions and units, rotate-by, multi-selection centre,
 * vertex and surface snapping while dragging, the snap toolbox popover, and dropping a library tile on a slope.
 */
import { assert, near, newPage, nextFrame, screenOf, shot } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function fresh(page) {
  await page.evaluate(() => {
    const a = window.physicslab;
    a.newScene();
    a.store.remove(
      a.store.all().map((e) => e.id),
      'clear',
    );
    a.store.setSelection([]);
    a.prefs.set({
      followSelection: false,
      snap: false,
      snapVertex: false,
      snapEdge: false,
      snapFace: false,
      snapBounds: false,
      snapSurface: false,
      snapAlignNormal: false,
    });
  });
  await nextFrame(page);
}

const addBox = (page, name, pos, over = {}) =>
  page.evaluate(
    ([name, pos, over]) => {
      const a = window.physicslab;
      const b = a.editor.addShape('box', pos, { name, shape: { type: 'box', size: [1, 1, 1] }, ...over });
      return b.id;
    },
    [name, pos, over],
  );

const body = (page, id) => page.evaluate((id) => JSON.parse(JSON.stringify(window.physicslab.store.body(id))), id);

async function typeInto(page, locator, text) {
  await locator.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
}

const posField = (page, axis) =>
  page.locator('.row.stack:has(.row-label:text-is("Position (m)")) .num-input').nth(axis);
const rotField = (page, axis) =>
  page.locator('.row.stack:has(.row-label:text-is("Rotation (°)")) .num-input').nth(axis);

test('numeric entry: +0.5 moves the body by 0.5, units and expressions work, bad input explains itself', async () => {
  const page = await newPage();
  await fresh(page);
  const id = await addBox(page, 'A', [1, 0.5, 2]);
  await page.evaluate((id) => window.physicslab.store.setSelection([id]), id);
  await page.waitForSelector('.row.stack .num-input');

  await typeInto(page, posField(page, 0), '+0.5');
  near((await body(page, id)).position[0], 1.5, 1e-9, '+0.5 adds to x');
  await typeInto(page, posField(page, 0), '*2');
  near((await body(page, id)).position[0], 3, 1e-9, '*2 doubles x');
  await typeInto(page, posField(page, 0), '- 1');
  near((await body(page, id)).position[0], 2, 1e-9, '"- 1" subtracts');
  await typeInto(page, posField(page, 2), '50cm');
  near((await body(page, id)).position[2], 0.5, 1e-9, '50cm is 0.5 m');
  await typeInto(page, posField(page, 2), '(1+2)*3');
  near((await body(page, id)).position[2], 9, 1e-9, 'parentheses');
  await typeInto(page, posField(page, 1), '2ft');
  near((await body(page, id)).position[1], 0.6096, 1e-9, '2ft');
  await typeInto(page, posField(page, 0), '-2');
  near((await body(page, id)).position[0], -2, 1e-9, 'a plain negative number is absolute');

  // an invalid entry changes nothing, shows the reason and keeps the old text
  const before = (await body(page, id)).position[0];
  await typeInto(page, posField(page, 0), '45deg');
  near((await body(page, id)).position[0], before, 1e-12, 'invalid entry leaves the value alone');
  const msg = await page.locator('.num-field.bad .num-err').first().textContent();
  assert(/angle, but this field takes a length/.test(msg ?? ''), `error text: ${msg}`);
  await shot(page, 'ed-snap-entry-error');

  // every entry above was ONE undo step: undo walks back through them
  await page.evaluate(() => window.physicslab.store.undo());
  near((await body(page, id)).position[0], 2, 1e-9, 'undo reverts the last entry only');
  assert(page.errors.length === 0, `page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('numeric entry: +15 in a Rotation field turns the body 15° about that axis; Rotate by works; undo is one step', async () => {
  const page = await newPage();
  await fresh(page);
  const id = await addBox(page, 'A', [0, 0.5, 0]);
  await page.evaluate((id) => window.physicslab.store.setSelection([id]), id);
  await page.waitForSelector('.row.stack .num-input');
  await page.evaluate(() => window.physicslab.prefs.set({ space: 'world' }));
  await typeInto(page, rotField(page, 1), '+15');
  let q = (await body(page, id)).rotation;
  // yaw of 15° about Y: (0, sin 7.5°, 0, cos 7.5°)
  near(q[1], Math.sin((7.5 * Math.PI) / 180), 1e-9, 'qy');
  near(q[3], Math.cos((7.5 * Math.PI) / 180), 1e-9, 'qw');
  await typeInto(page, rotField(page, 1), '+15');
  q = (await body(page, id)).rotation;
  near(q[1], Math.sin((15 * Math.PI) / 180), 1e-9, 'a second +15 gives 30° in total');

  // "Rotate by": X axis, 90°, +
  await page.locator('.rotate-by .segmented .seg-btn[data-value="0"]').click();
  const angle = page.locator('.rotate-by .num-input');
  await typeInto(page, angle, '90');
  await page.locator('.rotate-by .btn', { hasText: '+' }).click();
  await page.waitForTimeout(80);
  const after = (await body(page, id)).rotation;
  // the object was yawed 30° about Y, then turned 90° about world X: qx component must now be sin45°·cos15°
  near(Math.hypot(...after), 1, 1e-9, 'unit quaternion');
  near(after[0], Math.sin(Math.PI / 4) * Math.cos((15 * Math.PI) / 180), 1e-6, 'qx after the 90° turn about X');
  await page.evaluate(() => window.physicslab.store.undo());
  const undone = (await body(page, id)).rotation;
  near(undone[0], 0, 1e-9, 'one undo step reverts the whole Rotate by');
  assert(page.errors.length === 0, `page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('numeric entry: several bodies — the centre field moves the selection rigidly, relative entries apply to each body', async () => {
  const page = await newPage();
  await fresh(page);
  const a = await addBox(page, 'A', [0, 0.5, 0]);
  const b = await addBox(page, 'B', [2, 0.5, 4]);
  await page.evaluate(([a, b]) => window.physicslab.store.setSelection([a, b]), [a, b]);
  await page.waitForSelector('.row.stack:has(.row-label:text-is("Centre (m)"))');
  const centreX = page.locator('.row.stack:has(.row-label:text-is("Centre (m)")) .num-input').nth(0);
  await typeInto(page, centreX, '5'); // centre was x = 1
  near((await body(page, a)).position[0], 4, 1e-9, 'A moved by +4');
  near((await body(page, b)).position[0], 6, 1e-9, 'B moved by +4');
  await typeInto(page, centreX, '+1');
  near((await body(page, a)).position[0], 5, 1e-9, '+1 shifts the centre');
  near((await body(page, b)).position[0], 7, 1e-9, '+1 shifts the centre');
  await shot(page, 'ed-snap-multi');

  // a physics field on two bodies: *2 doubles each body's own value (their masses differ)
  await page.evaluate(
    ([a, b]) => {
      const s = window.physicslab.store;
      s.update(a, { linearDamping: 0.2 }, 'x');
      s.update(b, { linearDamping: 0.5 }, 'x');
    },
    [a, b],
  );
  await page.waitForTimeout(100);
  const row = page.locator('.row:has(.row-label:text-is("Linear damping")) .num-input').first();
  if (await row.count()) {
    await typeInto(page, row, '*2');
    near((await body(page, a)).linearDamping, 0.4, 1e-9, 'A: 0.2 * 2');
    near((await body(page, b)).linearDamping, 1.0, 1e-9, 'B: 0.5 * 2');
  }
  assert(page.errors.length === 0, `page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

/** Drag body `id` so that its picked point ends over the world point `to` on the plane of the pick. */
async function dragBodyTo(page, id, wantCentre) {
  // a selected body wears the gizmo, whose centre handle would take the press: start from no selection
  await page.evaluate(() => window.physicslab.store.setSelection([]));
  await nextFrame(page);
  const sp = await screenOf(page, id);
  const info = await page.evaluate(
    ([id, sp, want]) => {
      const a = window.physicslab;
      const hit = a.pickEntity({ clientX: sp.x, clientY: sp.y });
      const start = a.store.body(id).position;
      const target = hit.point.clone();
      target.x += want[0] - start[0];
      target.z += want[2] - start[2];
      target.y += want[1] - start[1];
      const p = target.clone().project(a.camera);
      const r = a.viewport.dom.getBoundingClientRect();
      const out = { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
      const g = a.picker.groundPoint({ clientX: out.x, clientY: out.y }, hit.point.y);
      return { ...out, hit: hit.point.toArray(), back: g && g.toArray(), start, sp };
    },
    [id, sp, wantCentre],
  );
  await page.mouse.move(sp.x, sp.y);
  await page.mouse.down();
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(sp.x + ((info.x - sp.x) * i) / steps, sp.y + ((info.y - sp.y) * i) / steps);
    (info.trace ??= []).push(
      await page.evaluate((id) => window.physicslab.store.body(id).position.map((v) => +v.toFixed(2)), id),
    );
  }
  return info;
}

test('snap: a dragged box corner snaps exactly onto a vertex of another box; Ctrl suspends it', async () => {
  const page = await newPage();
  await fresh(page);
  await page.evaluate(() => window.physicslab.prefs.set({ snapVertex: true }));
  await addBox(page, 'T', [0.1, 0.5, 0], { bodyType: 'static' });
  const mover = await addBox(page, 'M', [3, 0.5, 3]);
  await page.evaluate(() => window.physicslab.viewport.setView({ position: [4, 9, 8], target: [1, 0.5, 1] }));
  await nextFrame(page);
  // the mover's (-,-,-) bottom corner is 0.03 m / 0.04 m from the target's (+,-,+) bottom corner (0.6, 0, 0.5)
  const dinfo = await dragBodyTo(page, mover, [1.13, 0.5, 1.04]);
  const label = await page
    .locator('.v-label.snap')
    .textContent({ timeout: 4000 })
    .catch(async () => {
      const dbg = await page.evaluate(
        (id) => ({
          p: window.physicslab.store.body(id).position,
          sel: window.physicslab.store.selection,
          prefs: window.physicslab.prefs.value.snapVertex,
        }),
        mover,
      );
      throw new Error(
        `no snap label; ${JSON.stringify(dbg)} errors ${page.errors.join('|')} info ${JSON.stringify(dinfo)}`,
      );
    });
  await shot(page, 'ed-snap-vertex');
  await page.mouse.up();
  const p = (await body(page, mover)).position;
  near(p[0], 1.1, 1e-6, 'x = target corner + half size');
  near(p[1], 0.5, 1e-6, 'y');
  near(p[2], 1.0, 1e-6, 'z');
  assert(label === 'Vertex', `indicator label "${label}"`);
  assert((await page.locator('.v-label.snap').count()) === 0, 'the indicator is gone after the drop');

  // with Ctrl held the object snaps are suspended: the box ends where the pointer put it
  await page.evaluate((id) => window.physicslab.editor.moveTo(new Map([[id, [3, 0.5, 3]]])), mover);
  await nextFrame(page);
  await page.keyboard.down('Control');
  await dragBodyTo(page, mover, [1.13, 0.5, 1.04]);
  await page.mouse.up();
  await page.keyboard.up('Control');
  const q = (await body(page, mover)).position;
  assert(Math.abs(q[0] - 1.1) > 0.01 || Math.abs(q[2] - 1.0) > 0.01, `Ctrl suspended the vertex snap (${q})`);
  assert(page.errors.length === 0, `page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('snap: dragging over another box puts the box flush on its top (surface snap) and the move is one undo step', async () => {
  const page = await newPage();
  await fresh(page);
  await page.evaluate(() => window.physicslab.prefs.set({ snapSurface: true }));
  await addBox(page, 'T', [0, 0.5, 0], { bodyType: 'static' });
  const mover = await addBox(page, 'M', [3, 0.5, 3]);
  await page.evaluate(() => window.physicslab.viewport.setView({ position: [4, 9, 8], target: [1, 0.5, 1] }));
  await nextFrame(page);
  await dragBodyTo(page, mover, [0.1, 0.5, 0.05]);
  const label = await page.locator('.v-label.snap').textContent();
  await page.mouse.up();
  const p = (await body(page, mover)).position;
  near(p[1], 1.5 + 0.002, 1e-6, `resting on the top face (target top 1.0 + half height 0.5 + 2 mm)`);
  assert(Math.abs(p[0]) < 0.6 && Math.abs(p[2]) < 0.6, `above the target (${p})`);
  assert(label === 'Surface', `indicator label "${label}"`);
  await page.evaluate(() => window.physicslab.store.undo());
  const back = (await body(page, mover)).position;
  near(back[0], 3, 1e-9, 'undo returns the box to its start (one step)');
  assert(page.errors.length === 0, `page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('snap: the Snap chip opens the popover with every switch; toggling updates the preference and the chip', async () => {
  const page = await newPage('', { width: 1280, height: 720 });
  await page.evaluate(() => window.physicslab.prefs.set({ snapVertex: false, snapSurface: true }));
  const chip = page.locator('[data-tool="snapMenu"]');
  await chip.waitFor();
  await chip.click();
  await page.waitForSelector('.menu');
  const labels = await page.locator('.menu .menu-item .grow').allTextContents();
  for (const want of [
    'Grid',
    'Snap to vertices',
    'Snap to edge midpoints',
    'Snap to face centres',
    'Snap to object bounds',
    'Snap to surfaces',
    'Align to surface normal',
  ]) {
    assert(
      labels.some((l) => l.startsWith(want)),
      `popover lists "${want}" (has ${labels.join(', ')})`,
    );
  }
  await shot(page, 'ed-snap-popover');
  await page.locator('.menu .menu-item', { hasText: 'Snap to vertices' }).click();
  assert(await page.evaluate(() => window.physicslab.prefs.value.snapVertex), 'vertex snap switched on');
  // the toolbox does not overflow the 720 px viewport and the chip does not overlap another button
  const geo = await page.evaluate(() => {
    const t = document.querySelector('.toolbox').getBoundingClientRect();
    const btns = [...document.querySelectorAll('.toolbox button')].map((b) => b.getBoundingClientRect());
    let overlap = false;
    for (let i = 0; i < btns.length; i++)
      for (let j = i + 1; j < btns.length; j++) {
        const a = btns[i],
          b = btns[j];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1)
          overlap = true;
      }
    const vb = document.querySelector('.viewbar').getBoundingClientRect();
    const st = document.querySelector('.stage').getBoundingClientRect();
    return {
      vbOk: vb.left > t.right && vb.right <= st.right && vb.top >= st.top,
      bottom: t.bottom,
      overlap,
      h: document.querySelector('.stage').getBoundingClientRect().bottom,
    };
  });
  assert(!geo.overlap, 'toolbox buttons do not overlap');
  assert(geo.vbOk, 'the view bar with the Snap chip fits beside the toolbox');
  assert(geo.bottom <= geo.h - 4, `toolbox fits inside the stage at 1280x720 (bottom ${geo.bottom})`);
  await shot(page, 'ed-snap-toolbox-1280');
  assert(page.errors.length === 0, `page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('drop: a palette tile dragged onto a 30° slope lands flush on it, aligned to the normal when asked', async () => {
  const page = await newPage();
  await fresh(page);
  // a static slab tilted 30° about X
  const slab = await addBox(page, 'Slope', [0, 1, 0], {
    bodyType: 'static',
    shape: { type: 'box', size: [6, 0.2, 6] },
    rotation: [Math.sin(Math.PI / 12), 0, 0, Math.cos(Math.PI / 12)],
  });
  await page.evaluate(() => {
    const a = window.physicslab;
    a.viewport.setView({ position: [7, 6, 9], target: [0, 1, 0] });
    a.prefs.set({ snapSurface: true, snapAlignNormal: true, snap: false, snapVertex: false });
  });
  await nextFrame(page);
  await page.waitForTimeout(300);
  const target = await page.evaluate(() => {
    const a = window.physicslab;
    const r = a.viewport.dom.getBoundingClientRect();
    const p = a.camera ? { x: 0, y: 1.1, z: 0.3 } : null;
    const v = a.camera && new a.camera.position.constructor(p.x, p.y, p.z).project(a.camera);
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  });
  const before = await page.evaluate(() => window.physicslab.store.bodies().length);
  // a real HTML5 drag from the Add tab's Box tile
  const tile = page.locator('.tile', { hasText: 'Box' }).first();
  await tile.dragTo(page.locator('.stage'), {
    targetPosition: {
      x: target.x - (await page.locator('.stage').boundingBox()).x,
      y: target.y - (await page.locator('.stage').boundingBox()).y,
    },
  });
  await page.waitForTimeout(200);
  const info = await page.evaluate(
    ([slabId, before]) => {
      const a = window.physicslab;
      const bodies = a.store.bodies();
      const s = a.store.body(slabId);
      const nb = bodies.find((b) => b.id !== slabId && b.name.startsWith('Box'));
      if (!nb || bodies.length !== before + 1) return { ok: false, count: bodies.length };
      // slab normal
      const [x, y, z, w] = s.rotation;
      const n = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
      const [qx, qy, qz, qw] = nb.rotation;
      const up = [2 * (qx * qy - qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qw * qx)];
      const d = [nb.position[0] - s.position[0], nb.position[1] - s.position[1], nb.position[2] - s.position[2]];
      const height = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
      return {
        ok: true,
        n,
        up,
        height,
        size: nb.shape.size,
        pos: nb.position,
        slab: [s.position, s.shape.size, s.rotation],
      };
    },
    [slab, before],
  );
  assert(info.ok, `one new body was dropped (${JSON.stringify(info)})`);
  const dot = info.up[0] * info.n[0] + info.up[1] * info.n[1] + info.up[2] * info.n[2];
  near(dot, 1, 1e-6, 'the box is aligned to the slope normal');
  await shot(page, 'ed-snap-drop-slope');
  near(info.height, 0.1 + info.size[1] / 2 + 0.002, 2e-3, 'its bottom face lies on the slope surface (flush)');
  await shot(page, 'ed-snap-drop-slope');
  assert(page.errors.length === 0, `page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('drop: a prefab card dragged onto the scene is inserted at the pointer (not the view target) and keeps one undo step', async () => {
  const page = await newPage();
  await fresh(page);
  await page.evaluate(() => {
    const a = window.physicslab;
    a.viewport.setView({ position: [9, 7, 11], target: [0, 0, 0] });
    a.prefs.set({ snap: false, leftTab: 'prefabs', showLeft: true });
  });
  await page.waitForSelector('.card[draggable="true"]');
  await nextFrame(page);
  const box = await page.locator('.stage').boundingBox();
  const target = await page.evaluate(() => {
    const a = window.physicslab;
    const r = a.viewport.dom.getBoundingClientRect();
    const v = new a.camera.position.constructor(4, 0, 3).project(a.camera);
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  });
  const before = await page.evaluate(() => window.physicslab.store.bodies().length);
  await page
    .locator('.card[draggable="true"]')
    .first()
    .dragTo(page.locator('.stage'), { targetPosition: { x: target.x - box.x, y: target.y - box.y } });
  await page.waitForTimeout(250);
  const out = await page.evaluate(() => {
    const bodies = window.physicslab.store.bodies();
    const c = [0, 0, 0];
    for (const b of bodies) for (let i = 0; i < 3; i++) c[i] += b.position[i] / bodies.length;
    return { n: bodies.length, c };
  });
  assert(out.n > before, 'the prefab was inserted');
  near(out.c[0], 4, 1.6, 'inserted around the pointer x');
  near(out.c[2], 3, 1.6, 'inserted around the pointer z');
  await page.evaluate(() => window.physicslab.store.undo());
  assert(
    (await page.evaluate(() => window.physicslab.store.bodies().length)) === before,
    'one undo removes the whole prefab',
  );
  assert(page.errors.length === 0, `page errors: ${page.errors.join(' | ')}`);
  await page.close();
});
