/**
 * End-to-end tests for the scene object kinds beyond bodies and joints: groups, lights and paths (FB-6) — adding
 * them from the palette, seeing them in the outliner and the viewport, moving a group with its members, editing a
 * path's control points and a light's parameters in the inspector, and simulating a scene that contains them.
 */
import { assert, near, newPage, nextFrame, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** Client-space position of a world point (waits for a fresh frame so the camera is current). */
const screenPoint = async (page, world) => {
  await nextFrame(page);
  return page.evaluate((w) => {
    const a = window.physixlab;
    const v = new a.camera.position.constructor(...w).project(a.camera);
    const r = a.viewport.dom.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }, world);
};

test('scene objects: lights, a path and a group are added from the palette and listed in the outliner', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    a.editor.addShape('box', [0, 0.5, 0], { name: 'Crate' });
    a.viewport.setView({ position: [0, 4, 9], target: [0, 1, 0] });
    a.store.setSelection([]);
  });
  await page.dblclick('.tile:has-text("Spot")');
  await page.dblclick('.tile:has-text("Sun")');
  await page.dblclick('.tile:has-text("Path")');
  await page.evaluate(() => window.physixlab.store.setSelection([])); // a selection would be grouped by the tile
  await page.click('.tile:has-text("Group")');
  const kinds = await page.evaluate(() =>
    window.physixlab.store
      .all()
      .map((e) => e.kind + (e.kind === 'light' ? `:${e.lightType}` : ''))
      .sort(),
  );
  assert(
    JSON.stringify(kinds) === JSON.stringify(['body', 'group', 'light:directional', 'light:spot', 'path']),
    `palette tiles add each kind: ${kinds}`,
  );
  // every light is a real three.js light of the right class, with the entity's physical values
  const real = await page.evaluate(() => {
    const a = window.physixlab;
    const found = [];
    a.viewport.scene.traverse((o) => {
      if (o.isLight && o.userData.lightEntity) {
        const e = a.store.light(o.userData.lightEntity);
        found.push({
          cls: o.type,
          intensity: o.intensity,
          expect: e.intensity,
          shadow: o.castShadow,
          visible: o.visible,
        });
      }
    });
    return found.sort((x, y) => x.cls.localeCompare(y.cls));
  });
  assert(real.length === 2, `two real lights in the scene graph (${real.length})`);
  assert(real[0].cls === 'DirectionalLight' && real[1].cls === 'SpotLight', `light classes ${JSON.stringify(real)}`);
  assert(
    real.every((r) => r.intensity === r.expect && r.visible),
    'lights carry the entity intensity and are on',
  );
  // the outliner lists everything, with kind-specific icons and titles
  await page.click('.tab:has-text("Outliner")');
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.o-item')].map((r) => ({
      kind: r.dataset.kind,
      name: r.querySelector('.o-name').textContent,
      title: r.querySelector('.o-name').title,
      icon: !!r.querySelector('svg'),
    })),
  );
  assert(rows.length === 5 && rows.every((r) => r.icon), `five outliner rows with icons: ${JSON.stringify(rows)}`);
  assert(
    rows.some((r) => r.kind === 'light' && /spot light, 120 cd/.test(r.title)),
    'spot light row titled with its intensity',
  );
  assert(
    rows.some((r) => r.kind === 'path' && /path, 4 points/.test(r.title)),
    'path row titled with its point count',
  );
  assert(
    rows.some((r) => r.kind === 'group'),
    'group row present',
  );
  // clicking the icon sprite of the spot light in the viewport selects it
  const spot = await page.evaluate(() => window.physixlab.store.lights().find((l) => l.lightType === 'spot'));
  await page.evaluate(() => window.physixlab.store.setSelection([]));
  const p = await screenPoint(page, spot.position);
  await page.mouse.click(p.x, p.y);
  const sel = await page.evaluate(() => window.physixlab.store.selection.slice());
  assert(sel.length === 1 && sel[0] === spot.id, `clicking the light's icon selects it (${sel})`);
  await page.click('.panel.right .tab:has-text("Inspector")');
  await page.waitForSelector('.panel.right .row:has(.row-label:text-is("Cone angle"))');
  await shot(page, 'fb-entities-edit');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('lights: inspector edits drive the real light; switching it off darkens the scene', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    a.editor.addShape('box', [0, 0.5, 0], { name: 'Crate' });
    a.editor.addLight('point', [0, 2.2, 1.5], { name: 'Lamp' });
    a.viewport.setView({ position: [0, 3, 6], target: [0, 0.5, 0] });
  });
  const id = await page.evaluate(() => window.physixlab.store.lights()[0].id);
  await page.waitForSelector('.panel.right .row:has(.row-label:text-is("Intensity"))');
  const intensity = page.locator('.panel.right .row:has(.row-label:text-is("Intensity")) .num-input');
  await intensity.fill('500');
  await intensity.press('Enter');
  const got = await page.evaluate((id) => window.physixlab.lightViews.get(id).light.intensity, id);
  assert(got === 500, `the three.js light follows the inspector (${got})`);
  await page.locator('.panel.right .row:has(.row-label:text-is("Range")) .num-input').fill('4');
  await page.keyboard.press('Enter');
  assert(
    (await page.evaluate((id) => window.physixlab.lightViews.get(id).light.distance, id)) === 4,
    'range is the light distance',
  );
  await shot(page, 'fb-light-on');
  // switch it off through the toggle: the three.js light is hidden and the entity says so
  await page.locator('.panel.right .row:has(.row-label:text-is("State")) .switch').click();
  const off = await page.evaluate(
    (id) => ({ e: window.physixlab.store.light(id).enabled, v: window.physixlab.lightViews.get(id).light.visible }),
    id,
  );
  assert(off.e === false && off.v === false, `off: ${JSON.stringify(off)}`);
  await shot(page, 'fb-light-off');
  await page.evaluate(() => document.activeElement?.blur()); // shortcuts are ignored while a form control has focus
  await page.keyboard.press('Control+z');
  assert(
    await page.evaluate((id) => window.physixlab.lightViews.get(id).light.visible, id),
    'undo switches it back on',
  );
  // changing the type rebuilds the real light
  await page.click('.panel.right .seg-btn:has-text("Spot")');
  const cls = await page.evaluate((id) => window.physixlab.lightViews.get(id).light.type, id);
  assert(cls === 'SpotLight', `a spot after changing the type (${cls})`);
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('groups: group the selection, move it with its members, duplicate, ungroup — all undoable', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    a.editor.addShape('box', [-1, 0.5, 0], { name: 'Left' });
    a.editor.addShape('sphere', [1, 0.5, 0], { name: 'Right' });
    a.editor.addShape('cylinder', [4, 0.5, 0], { name: 'Bystander' });
    a.editor.addLight('point', [0, 3, 0], { name: 'Lamp' });
    a.viewport.setView({ position: [0, 5, 10], target: [0, 1, 0] });
    const ids = a.store
      .all()
      .filter((e) => e.name === 'Left' || e.name === 'Right' || e.name === 'Lamp')
      .map((e) => e.id);
    a.store.setSelection(ids);
  });
  await page.keyboard.press('Control+g');
  const g = await page.evaluate(() => {
    const a = window.physixlab;
    const grp = a.store.groups()[0];
    return {
      id: grp?.id,
      members: grp
        ? a.store
            .children(grp.id)
            .map((c) => c.name)
            .sort()
        : [],
      sel: a.store.selection.slice(),
      pos: grp?.position,
    };
  });
  assert(g.id && g.members.join() === 'Lamp,Left,Right', `Ctrl+G groups the selection: ${JSON.stringify(g)}`);
  assert(g.sel.length === 1 && g.sel[0] === g.id, 'the new group is selected');
  near(g.pos[0], 0, 1e-9, 'pivot at the centre of the members (x)');
  // the outliner nests the members under the group
  await page.click('.tab:has-text("Outliner")');
  const depth = await page.evaluate(() =>
    [...document.querySelectorAll('.o-item')].map((r) => ({
      n: r.querySelector('.o-name').textContent,
      pad: parseFloat(r.style.paddingLeft || '0'),
    })),
  );
  const pad = (n) => depth.find((r) => r.n === n)?.pad ?? -1;
  assert(
    pad('Left') > 0 && pad('Right') > 0 && pad('Lamp') > 0 && pad('Bystander') === 0,
    `members are indented: ${JSON.stringify(depth)}`,
  );
  // folding hides the members
  await page.locator('.o-item.is-group .o-caret').click();
  assert((await page.locator('.o-item').count()) === 2, 'folded: only the group and the bystander remain');
  await page.locator('.o-item.is-group .o-caret').click();
  assert((await page.locator('.o-item').count()) === 5, 'unfolded again');
  await page.click('.panel.right .tab:has-text("Inspector")');
  // moving the group (arrow-key nudge acts on the selected group) carries every member
  const before = await page.evaluate(() =>
    Object.fromEntries(window.physixlab.store.all().map((e) => [e.name, e.position])),
  );
  await page.evaluate(() => window.physixlab.editor.translate(window.physixlab.store.selection, [0, 0, 2]));
  const after = await page.evaluate(() =>
    Object.fromEntries(window.physixlab.store.all().map((e) => [e.name, e.position])),
  );
  for (const n of ['Left', 'Right', 'Lamp']) near(after[n][2], before[n][2] + 2, 1e-9, `${n} moved with the group`);
  near(after.Bystander[2], before.Bystander[2], 1e-9, 'a body outside the group stays');
  // editing the group's position in the inspector does the same
  const px = page.locator('.panel.right .vec3 .num-input').first();
  await px.fill('3');
  await px.press('Enter');
  const moved = await page.evaluate(() => window.physixlab.store.bodies().find((b) => b.name === 'Left').position[0]);
  near(moved, 2, 1e-9, 'the inspector pivot field moves the members (Left was at −1, pivot 0 → 3)');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate(() =>
    Object.fromEntries(window.physixlab.store.all().map((e) => [e.name, e.position])),
  );
  for (const n of ['Left', 'Right', 'Lamp']) near(undone[n][2], before[n][2], 1e-9, `${n} back after undo`);
  near(undone.Left[0], before.Left[0], 1e-9, 'x back as well');
  await shot(page, 'fb-group');
  // duplicate: the copy brings its members and is its own group
  await page.keyboard.press('Control+d');
  const dup = await page.evaluate(() => {
    const a = window.physixlab;
    return {
      groups: a.store.groups().length,
      bodies: a.store.bodies().length,
      lights: a.store.lights().length,
      sel: a.store.selection.map((id) => a.store.get(id).kind),
    };
  });
  assert(
    dup.groups === 2 && dup.bodies === 5 && dup.lights === 2,
    `duplicate copies the subtree: ${JSON.stringify(dup)}`,
  );
  assert(dup.sel.length === 1 && dup.sel[0] === 'group', 'only the copied group is selected');
  await page.keyboard.press('Control+z');
  // ungroup releases the members (they keep their poses)
  await page.evaluate(() => {
    const a = window.physixlab;
    a.store.setSelection([a.store.groups()[0].id]);
  });
  await page.keyboard.press('Control+Shift+g');
  const un = await page.evaluate(() => {
    const a = window.physixlab;
    return {
      groups: a.store.groups().length,
      parented: a.store.all().filter((e) => e.parent).length,
      sel: a.store.selection.length,
    };
  });
  assert(un.groups === 0 && un.parented === 0 && un.sel === 3, `ungrouped: ${JSON.stringify(un)}`);
  await page.keyboard.press('Control+z');
  assert((await page.evaluate(() => window.physixlab.store.groups().length)) === 1, 'undo brings the group back');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('groups: ungrouping nested groups together hands members to the nearest surviving ancestor; only groups can be parents', async () => {
  const page = await newPage();
  const r = await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    const mk = (n, x) => a.editor.addShape('box', [x, 0.5, 0], { name: n });
    const b1 = mk('B1', -2);
    const b2 = mk('B2', 0);
    const b3 = mk('B3', 2);
    const g0 = a.editor.addGroup([0, 0, 0]);
    const g1 = a.editor.addGroup([0, 0, 0]);
    const g2 = a.editor.addGroup([0, 0, 0]);
    // g0 ▸ g1 ▸ g2 ▸ B2, g1 ▸ B1, g0 ▸ B3
    a.editor.setParent([g1.id], g0.id);
    a.editor.setParent([g2.id], g1.id);
    a.editor.setParent([b2.id], g2.id);
    a.editor.setParent([b1.id], g1.id);
    a.editor.setParent([b3.id], g0.id);
    const parent = (id) => a.store.get(id).parent;
    const before = { b1: parent(b1.id), b2: parent(b2.id) };
    a.editor.ungroup([g1.id, g2.id]);
    const after = {
      b1: parent(b1.id),
      b2: parent(b2.id),
      b3: parent(b3.id),
      groups: a.store.groups().map((g) => g.id),
    };
    a.store.undo();
    const undone = { b1: parent(b1.id), b2: parent(b2.id), groups: a.store.groups().length };
    // a body cannot be a parent, a group can
    const refused = a.editor.setParent([b1.id], b2.id);
    return {
      ids: { g0: g0.id, g1: g1.id, g2: g2.id, b1: b1.id, b2: b2.id },
      before,
      after,
      undone,
      refused,
      still: parent(b1.id),
    };
  });
  assert(
    r.after.b1 === r.ids.g0 && r.after.b2 === r.ids.g0 && r.after.b3 === r.ids.g0,
    `members of both dissolved groups end up in the surviving ancestor: ${JSON.stringify(r.after)}`,
  );
  assert(r.after.groups.length === 1 && r.after.groups[0] === r.ids.g0, 'only the outer group is left');
  assert(
    r.undone.b1 === r.ids.g1 && r.undone.b2 === r.ids.g2 && r.undone.groups === 3,
    `one undo restores the whole hierarchy: ${JSON.stringify(r.undone)}`,
  );
  assert(r.refused === false && r.still === r.ids.g1, 'setParent refuses a body as the parent and changes nothing');
  // an object that a damaged file links to a non-group stays visible, at the top of the outliner
  await page.evaluate((ids) => {
    const a = window.physixlab;
    a.store.update(ids.b1, { parent: ids.b2 });
  }, r.ids);
  await page.click('.tab:has-text("Outliner")');
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.o-item')].map((row) => ({
      n: row.querySelector('.o-name').textContent,
      pad: parseFloat(row.style.paddingLeft || '0'),
    })),
  );
  const b1 = rows.find((row) => row.n === 'B1');
  assert(b1 && b1.pad === 0, `B1 is listed at the top level, not lost: ${JSON.stringify(rows)}`);
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('selection: a marquee box-selects lights and group pivots together with bodies', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    a.editor.addShape('box', [-2, 0.5, 0], { name: 'Box' });
    a.editor.addShape('sphere', [2, 0.5, 0], { name: 'Ball' });
    a.editor.addLight('point', [0, 3, 0], { name: 'Lamp' });
    a.editor.addGroup([0, 0.2, 2]);
    a.editor.addShape('cylinder', [60, 0.5, 0], { name: 'Far' });
    a.viewport.setView({ position: [0, 5, 11], target: [0, 1, 0] });
    a.store.setSelection([]);
  });
  const box = await page.evaluate(() => {
    const r = window.physixlab.viewport.dom.getBoundingClientRect();
    return {
      x0: r.left + r.width * 0.2,
      y0: r.top + r.height * 0.18,
      x1: r.left + r.width * 0.8,
      y1: r.top + r.height * 0.85,
    };
  });
  await nextFrame(page);
  await page.mouse.move(box.x0, box.y0);
  await page.mouse.down();
  await page.mouse.move((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, { steps: 4 });
  await page.mouse.move(box.x1, box.y1, { steps: 4 });
  await page.mouse.up();
  const picked = await page.evaluate(() =>
    window.physixlab.store.selection.map((id) => {
      const e = window.physixlab.store.get(id);
      return e.kind === 'group' ? 'group' : e.name;
    }),
  );
  picked.sort();
  assert(
    JSON.stringify(picked) === JSON.stringify(['Ball', 'Box', 'Lamp', 'group']),
    `the marquee takes the bodies, the light and the group pivot inside it, not the far body: ${picked}`,
  );
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('groups: deleting a group keeps its members; hiding it hides them; they simulate and Reset restores', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    a.editor.addShape('box', [0, 3, 0], { name: 'Falling' });
    a.editor.addLight('spot', [0, 6, 2], { name: 'Key' });
    a.editor.addPath([0, 0.05, 0], { name: 'Track' });
    a.editor.groupSelection(a.store.all().map((e) => e.id));
    a.viewport.setView({ position: [0, 4, 10], target: [0, 1.5, 0] });
  });
  const ids = await page.evaluate(() => {
    const a = window.physixlab;
    return { group: a.store.groups()[0].id, body: a.store.bodies()[0].id };
  });
  // hiding the group hides what is in it
  await page.evaluate((id) => window.physixlab.editor.toggleFlag([id], 'hidden'), ids.group);
  const hid = await page.evaluate(() => window.physixlab.store.all().map((e) => e.hidden));
  assert(hid.every(Boolean), 'hide cascades to the members');
  await page.evaluate((id) => window.physixlab.editor.toggleFlag([id], 'hidden'), ids.group);
  // a scene with all kinds simulates; the body falls, the document keeps its authored pose
  await page.keyboard.press('Space');
  await simTime(page, 0.5);
  const y = await page.evaluate((id) => window.physixlab.sim.poseOf(id).position[1], ids.body);
  assert(y < 2.9, `the grouped body falls while the group, light and path are around (${y})`);
  assert(
    await page.evaluate(() => !window.physixlab.groupViews.get(window.physixlab.store.groups()[0].id).root.visible),
    'group helpers are hidden while the simulation owns the poses',
  );
  assert(
    await page.evaluate(
      () => window.physixlab.lightViews.views.size === 1 && window.physixlab.pathViews.views.size === 1,
    ),
    'light and path views stay',
  );
  await page.keyboard.press('Shift+Space');
  await nextFrame(page);
  near(
    await page.evaluate((id) => window.physixlab.store.body(id).position[1], ids.body),
    3,
    1e-9,
    'Reset keeps the authored pose',
  );
  assert(
    await page.evaluate(() => window.physixlab.groupViews.get(window.physixlab.store.groups()[0].id).root.visible),
    'group helpers are back after Reset',
  );
  // deleting the group leaves the members, now ungrouped
  await page.evaluate((id) => window.physixlab.store.setSelection([id]), ids.group);
  await page.keyboard.press('Delete');
  const left = await page.evaluate(() => ({
    n: window.physixlab.store.size,
    parented: window.physixlab.store.all().filter((e) => e.parent).length,
  }));
  assert(left.n === 3 && left.parented === 0, `members stay: ${JSON.stringify(left)}`);
  await page.keyboard.press('Control+z');
  assert(
    (await page.evaluate(() => window.physixlab.store.groups().length)) === 1,
    'undo restores the group and its links',
  );
  assert(
    (await page.evaluate(() => window.physixlab.store.all().filter((e) => e.parent).length)) === 3,
    '…including the member links',
  );
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('paths: curve, point handles, gizmo editing of a point and inspector point list', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    a.viewport.setView({ position: [0, 7, 7], target: [0, 0, 0] });
    a.editor.addPath([0, 0.05, 0], { name: 'Track' });
  });
  const id = await page.evaluate(() => window.physixlab.store.paths()[0].id);
  await page.waitForSelector('.panel.right .path-point');
  assert((await page.locator('.panel.right .path-point').count()) === 4, 'four points listed');
  const view = await page.evaluate((id) => {
    const v = window.physixlab.pathViews.get(id);
    return { len: v.length, handles: v.handles.geometry.getAttribute('position').count, arrows: v.arrows.count };
  }, id);
  assert(view.handles === 4 && view.arrows >= 2 && view.len > 6, `curve view: ${JSON.stringify(view)}`);
  await shot(page, 'fb-path');
  // clicking a point handle hands that point to the gizmo
  const world = await page.evaluate((id) => window.physixlab.pathViews.get(id).pointWorld(2).toArray(), id);
  const p = await screenPoint(page, world);
  await page.mouse.click(p.x, p.y);
  const pp = await page.evaluate(() => window.physixlab.pathPoint);
  assert(pp && pp.id === id && pp.index === 2, `handle click selects point 3 (${JSON.stringify(pp)})`);
  const item = await page.evaluate(() => window.physixlab.gizmo.pivot.position.toArray());
  near(item[0], world[0], 1e-6, 'the gizmo sits on the point');
  // dragging the gizmo moves just that point (simulated through the editor command the gizmo calls)
  const lenBefore = await page.evaluate((id) => window.physixlab.pathViews.get(id).length, id);
  await page.evaluate(([id, w]) => window.physixlab.editor.movePathPoint(id, 2, [w[0], w[1], w[2] + 3]), [id, world]);
  const pts = await page.evaluate((id) => window.physixlab.store.path(id).points, id);
  near(pts[2][2], -1.2 + 3, 1e-9, 'point 3 moved (local z = −1.2 + 3)');
  near(pts[1][2], 1.2, 1e-9, 'the other points did not');
  const lenAfter = await page.evaluate((id) => window.physixlab.pathViews.get(id).length, id);
  assert(Math.abs(lenAfter - lenBefore) > 0.3, `the curve was redrawn (${lenBefore} → ${lenAfter})`);
  // inspector: edit a coordinate, insert and delete points, close the loop, tension
  const x2 = page.locator('.panel.right .path-point').nth(1).locator('.num-input').first();
  await x2.fill('-0.5');
  await x2.press('Enter');
  near(
    await page.evaluate((id) => window.physixlab.store.path(id).points[1][0], id),
    -0.5,
    1e-9,
    'point coordinate edited',
  );
  await page.locator('.panel.right .path-point').nth(0).locator('button[title^="Insert"]').click();
  assert((await page.locator('.panel.right .path-point').count()) === 5, 'a point was inserted');
  await page.locator('.panel.right .path-point').nth(1).locator('button[title^="Delete"]').click();
  assert((await page.locator('.panel.right .path-point').count()) === 4, 'and deleted again');
  await page.locator('.panel.right .row:has(.row-label:text-is("Shape")) .switch').click();
  assert(await page.evaluate((id) => window.physixlab.store.path(id).closed, id), 'closed loop toggled');
  const closedLen = await page.evaluate((id) => window.physixlab.pathViews.get(id).length, id);
  assert(closedLen > lenAfter, 'closing adds the segment back to the start');
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Control+z');
  assert(!(await page.evaluate((id) => window.physixlab.store.path(id).closed, id)), 'undo reopens it');
  await page.keyboard.press('Escape');
  assert((await page.evaluate(() => window.physixlab.pathPoint)) === null, 'Esc leaves point editing');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('scene files: groups, lights and paths survive export, share link and autosave', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    a.editor.addShape('box', [0, 0.5, 0], { name: 'Member' });
    a.editor.addLight('area', [0, 3, 0], { name: 'Panel', size: [1.5, 0.5] });
    a.editor.addPath([1, 0.05, 1], { name: 'Route', closed: true, tension: 0.3 });
    a.editor.groupSelection(a.store.all().map((e) => e.id));
  });
  const doc = await page.evaluate(async () => {
    const { serializeDocument, parseDocument } = await import('/src/model/serialize.ts');
    const a = window.physixlab;
    const text = serializeDocument(a.store.toDocument());
    const back = parseDocument(text);
    return {
      same: JSON.stringify(back.entities) === JSON.stringify(a.store.toDocument().entities),
      version: back.version,
      kinds: back.entities.map((e) => e.kind).sort(),
    };
  });
  assert(doc.same && doc.version === 3, `round trip is lossless at v3: ${JSON.stringify(doc)}`);
  assert(doc.kinds.join() === 'body,group,light,path', `all kinds kept: ${doc.kinds}`);
  // autosave → reload gives the same scene back
  await page.evaluate(() => window.physixlab.persistence.saveNow());
  await page.reload();
  await page.waitForFunction(() => !!window.physixlab && window.physixlab.viewport, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  const re = await page.evaluate(() => {
    const a = window.physixlab;
    return {
      kinds: a.store
        .all()
        .map((e) => e.kind)
        .sort(),
      area: a.store.lights()[0]?.size,
      closed: a.store.paths()[0]?.closed,
      views: [a.groupViews.views.size, a.lightViews.views.size, a.pathViews.views.size],
    };
  });
  assert(re.kinds.join() === 'body,group,light,path' && re.closed === true, `after reload: ${JSON.stringify(re)}`);
  assert(re.views.join() === '1,1,1', `views were rebuilt: ${re.views}`);
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('outliner: drag a row onto a group to put it inside, onto empty space to take it out; the Group row in the inspector does the same', async () => {
  const page = await newPage();
  const ids = await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    const box = a.editor.addShape('box', [0, 0.5, 0], { name: 'Loose' });
    const group = a.editor.addGroup([4, 0, 0]);
    const other = a.editor.addShape('sphere', [2, 0.5, 0], { name: 'Other' });
    a.store.setSelection([]);
    return { box: box.id, group: group.id, other: other.id };
  });
  await page.click('.tab:has-text("Outliner")');
  await page.locator('.o-item:has-text("Loose")').dragTo(page.locator('.o-item.is-group'));
  assert(
    (await page.evaluate((id) => window.physixlab.store.body(id).parent, ids.box)) === ids.group,
    'dropping a row on a group parents it',
  );
  const posAfter = await page.evaluate((id) => window.physixlab.store.body(id).position, ids.box);
  assert(JSON.stringify(posAfter) === JSON.stringify([0, 0.5, 0]), 'the member keeps its world pose');
  // it is now nested (indented) under the group
  const pad = await page.locator('.o-item:has-text("Loose")').evaluate((el) => parseFloat(el.style.paddingLeft || '0'));
  assert(pad > 0, `indented under the group (${pad})`);
  // dropping onto the empty part of the list takes it out again
  await page
    .locator('.o-item:has-text("Loose")')
    .dragTo(page.locator('.panel.right .panel-body:visible'), { targetPosition: { x: 120, y: 360 } });
  assert(
    (await page.evaluate((id) => window.physixlab.store.body(id).parent, ids.box)) === undefined,
    'dropping on empty space releases it',
  );
  // a group cannot be dropped into itself or what is inside it
  await page.locator('.o-item:has-text("Other")').dragTo(page.locator('.o-item.is-group'));
  assert(
    (await page.evaluate((id) => window.physixlab.store.body(id).parent, ids.other)) === ids.group,
    'Other is inside',
  );
  await page.evaluate((g) => window.physixlab.store.setSelection([g]), ids.group);
  const refused = await page.evaluate((g) => {
    const a = window.physixlab;
    return [
      a.editor.setParent([g], g),
      a.editor.setParent([g], a.store.body(a.store.bodies().find((b) => b.parent === g).id).id),
    ];
  }, ids.group);
  assert(refused[0] === false && refused[1] === false, `no cycles: ${refused}`);
  // the inspector's Group row
  await page.evaluate((id) => window.physixlab.store.setSelection([id]), ids.box);
  await page.click('.panel.right .tab:has-text("Inspector")');
  await page.locator('.panel.right .row:has(.row-label:text-is("Group")) select').selectOption(ids.group);
  assert(
    (await page.evaluate((id) => window.physixlab.store.body(id).parent, ids.box)) === ids.group,
    'inspector row parents it',
  );
  await page.locator('.panel.right .row:has(.row-label:text-is("Group")) select').selectOption('');
  assert(
    (await page.evaluate((id) => window.physixlab.store.body(id).parent, ids.box)) === undefined,
    'and releases it',
  );
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('lights: more lights than the render budget keep their helper and are counted, shadows are capped', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    a.editor.addShape('box', [0, 0.5, 0]);
    for (let i = 0; i < 11; i++) a.editor.addLight(i < 6 ? 'spot' : 'point', [i - 5, 3, 0], { castShadow: true });
  });
  const budget = await page.evaluate(() => {
    const a = window.physixlab;
    const views = [...a.lightViews.views.values()];
    return {
      total: views.length,
      real: views.filter((v) => v.light.visible).length,
      over: a.lightViews.overBudgetCount,
      shadows: views.filter((v) => v.light.visible && v.light.castShadow).length,
      helpers: views.filter((v) => v.sprite.visible).length,
    };
  });
  assert(
    budget.total === 11 && budget.real === 8 && budget.over === 3,
    `8 real lights, 3 over budget: ${JSON.stringify(budget)}`,
  );
  assert(budget.shadows === 3, `at most 3 shadow casters (${budget.shadows})`);
  assert(budget.helpers === 11, 'every light keeps its helper');
  // switching one of the real lights off hands its place to the next
  await page.evaluate(() => {
    const a = window.physixlab;
    a.store.update(a.store.lights()[0].id, { enabled: false });
  });
  const after = await page.evaluate(() => {
    const a = window.physixlab;
    return {
      real: [...a.lightViews.views.values()].filter((v) => v.light.visible).length,
      over: a.lightViews.overBudgetCount,
    };
  });
  assert(after.real === 8 && after.over === 2, `the freed place goes to the next light: ${JSON.stringify(after)}`);
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});
