/**
 * Package SH, chunk 2 (primitive shapes II and the palette): the gear, wheel, ellipsoid, regular solids, dice, curved
 * ramps and rounded variants in the real app — the categorised Add palette with generated thumbnails, search and
 * keyboard navigation; textured dice and the dark tyre; inspector rows with live resizing; the scale gizmo; and the
 * physics worker rolling real dice.
 *
 * Set E2E_SHOTS=1 to write the screenshots (sh2-*.png) into e2e/out/.
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { assert, near, newPage, outDir, pose, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const elementShot = async (locator, name) => {
  if (!process.env.E2E_SHOTS) return;
  mkdirSync(outDir, { recursive: true });
  await locator.screenshot({ path: join(outDir, `${name}.png`) });
};

const NEW_SHAPES = [
  'ellipsoid',
  'pyramid',
  'tetrahedron',
  'octahedron',
  'dodecahedron',
  'rounded-box',
  'rounded-cylinder',
  'curved-ramp',
  'quarter-pipe',
  'half-pipe',
  'gear',
  'wheel',
  'd4',
  'd6',
  'd8',
  'd10',
  'd12',
  'd20',
];

const tilesReady = (page) =>
  page.waitForFunction(
    () => {
      const tiles = document.querySelectorAll('.shape-tile');
      return tiles.length > 0 && document.querySelectorAll('.shape-tile .tile-art img').length === tiles.length;
    },
    null,
    { timeout: 90000 },
  );

test('SH-13 · the Add tab groups the shapes by category, with generated thumbnails cached across reloads', async () => {
  const page = await newPage('', { width: 1600, height: 1500 });
  const groups = await page.locator('.shape-group-title').allTextContents();
  assert(
    groups.map((g) => g.replace(/\d+$/, '').trim()).join() === 'Basic,Structural,Mechanical,Solids,Special',
    `five categories in order: ${groups.join(' | ')}`,
  );
  const total = await page.locator('.shape-tile').count();
  const registry = await page.evaluate(() => window.physicslab.shapes?.length ?? 0).catch(() => 0);
  assert(total >= 38, `all shapes have a tile (${total}${registry ? ` of ${registry}` : ''})`);
  // Each tile starts with its icon; the generated thumbnails replace them one by one without blocking the page.
  await tilesReady(page);
  const info = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.shape-tile .tile-art img')];
    return {
      count: imgs.length,
      png: imgs.every((i) => /^data:image\/(webp|png)/.test(i.src)),
      distinct: new Set(imgs.map((i) => i.src)).size,
      stored: Object.keys(localStorage).filter((k) => k.startsWith('physicslab.shapeThumb.')).length,
      loaded: imgs.every((i) => i.complete && i.naturalWidth >= 64),
    };
  });
  assert(info.png && info.loaded, `thumbnails are real images ${JSON.stringify(info)}`);
  assert(info.distinct >= total - 4, `thumbnails differ per shape (${info.distinct} distinct of ${total})`);
  assert(info.stored === total, `every thumbnail is cached in localStorage (${info.stored} of ${total})`);
  await page.waitForTimeout(300);
  await elementShot(page.locator('.panel.left'), 'sh2-palette');
  await shot(page, 'sh2-palette-page');

  // the number keys of the first nine are on their tiles and still add shapes
  const keys = await page.evaluate(() =>
    [...document.querySelectorAll('.shape-tile[data-key]')].map((t) => `${t.dataset.key}:${t.dataset.shape}`),
  );
  assert(
    keys.join() === '1:box,2:sphere,3:cylinder,4:capsule,5:cone,6:wedge,7:prism,8:icosahedron,9:torus',
    `badges follow the registry: ${keys.join()}`,
  );
  await page.evaluate(() => window.physicslab.newScene());
  await page.click('.viewport-canvas', { position: { x: 800, y: 500 } });
  for (const k of ['1', '3', '9']) await page.keyboard.press(k);
  const added = await page.evaluate(() => window.physicslab.store.bodies().map((b) => b.shape.type));
  assert(added.join() === 'box,cylinder,torus', `1, 3 and 9 add box, cylinder, torus: ${added.join()}`);

  // tooltips keep the "Click to add" hint; clicking a tile adds the shape
  const title = await page.locator('.shape-tile[data-shape="gear"]').getAttribute('title');
  assert(/Click to add, or drag/.test(title ?? ''), `tile tooltip: ${title}`);
  await page.locator('.shape-tile[data-shape="gear"]').click();
  assert(
    (await page.evaluate(() => window.physicslab.store.bodies().at(-1).shape.type)) === 'gear',
    'clicking the gear tile adds a gear',
  );

  // a collapsed group stays collapsed after a reload, and the thumbnails come straight from the cache
  await page.locator('.shape-group-title', { hasText: 'Mechanical' }).click();
  assert(
    (await page.locator('.shape-group-title', { hasText: 'Mechanical' }).getAttribute('aria-expanded')) === 'false',
    'the group collapses',
  );
  assert((await page.locator('.shape-tile[data-shape="gear"]').count()) === 0, 'its tiles are hidden');
  await page.reload();
  await page.waitForFunction(() => !!window.physicslab && window.physicslab.viewport, null, { timeout: 30000 });
  await page.waitForSelector('.shape-tile');
  assert(
    (await page.locator('.shape-group-title', { hasText: 'Mechanical' }).getAttribute('aria-expanded')) === 'false',
    'the collapsed group is remembered',
  );
  const t0 = Date.now();
  await tilesReady(page);
  const sync = await page.evaluate(
    () =>
      document.querySelectorAll('.shape-tile .tile-art img').length === document.querySelectorAll('.shape-tile').length,
  );
  assert(sync, `thumbnails are already there after a reload (${Date.now() - t0} ms)`);
  await page.locator('.shape-group-title', { hasText: 'Mechanical' }).click(); // leave it open for the next test
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('SH-13 · search finds shapes by name, category and keyword; Enter adds the best match; friendly empty state', async () => {
  const page = await newPage('', { width: 1600, height: 1100 });
  await tilesReady(page);
  const search = page.locator('.shape-search-input');
  const shown = () => page.locator('.shape-tile').evaluateAll((els) => els.map((e) => e.dataset.shape));

  await search.fill('dice');
  assert(
    (await shown()).slice(0, 6).join() === 'd4,d6,d8,d10,d12,d20',
    `"dice" finds the six dice first, in order: ${(await shown()).join()}`,
  );
  assert((await page.locator('.shape-group-title').first().textContent())?.startsWith('Results'), 'a Results heading');
  await elementShot(page.locator('.panel.left'), 'sh2-search-dice');

  await search.fill('ramp');
  const ramps = await shown();
  for (const id of ['curved-ramp', 'quarter-pipe', 'wedge']) assert(ramps.includes(id), `"ramp" finds ${id}: ${ramps}`);

  await search.fill('donut');
  assert((await shown())[0] === 'torus', 'a keyword finds the torus');
  await search.fill('mechanical');
  const mech = await shown();
  assert(
    ['gear', 'wheel'].every((id) => mech.includes(id)),
    `a category name finds its shapes: ${mech}`,
  );

  await search.fill('zzqx');
  await page.waitForSelector('.shape-palette .empty-state');
  const empty = await page.locator('.shape-palette .empty-state').textContent();
  assert(/No shape matches/.test(empty ?? '') && /zzqx/.test(empty ?? ''), `empty state text: ${empty}`);
  await elementShot(page.locator('.panel.left'), 'sh2-search-empty');
  await page.locator('.shape-palette .empty-state button', { hasText: 'Clear search' }).click();
  assert((await page.locator('.shape-tile').count()) >= 38, 'clearing the search shows every shape again');
  assert((await search.inputValue()) === '', 'and empties the box');

  // Enter adds the best match; the typed digits and letters never trigger shortcuts
  await page.evaluate(() => window.physicslab.newScene());
  await search.fill('torus');
  await search.press('Enter');
  const bodies = await page.evaluate(() => window.physicslab.store.bodies().map((b) => b.shape.type));
  assert(bodies.join() === 'torus', `Enter added the torus: ${bodies}`);
  await search.fill('d6');
  const n = await page.evaluate(() => window.physicslab.store.bodies().length);
  assert(n === 1, 'typing "d6" added nothing (no shortcut fired in the box)');
  // Escape clears, a second Escape leaves the box
  await search.press('Escape');
  assert((await search.inputValue()) === '', 'Escape clears the search');

  // arrow keys: ↓ from the box into the grid, → and ↓ move between tiles, ↑ at the top returns to the box
  await search.press('ArrowDown');
  const first = await page.evaluate(() => document.activeElement?.dataset?.shape);
  assert(first === 'box', `↓ focuses the first tile (${first})`);
  await page.keyboard.press('ArrowRight');
  assert((await page.evaluate(() => document.activeElement?.dataset?.shape)) === 'sphere', '→ moves to the next tile');
  const before = await page.evaluate(() => window.physicslab.store.bodies()[0].position);
  await page.keyboard.press('ArrowDown');
  const below = await page.evaluate(() => document.activeElement?.dataset?.shape);
  assert(below && below !== 'sphere', `↓ moves to the tile below (${below})`);
  const after = await page.evaluate(() => window.physicslab.store.bodies()[0].position);
  assert(before.join() === after.join(), 'the arrow keys did not nudge the selected body');
  await page.keyboard.press('Home');
  assert((await page.evaluate(() => document.activeElement?.dataset?.shape)) === 'box', 'Home goes to the first tile');
  await page.keyboard.press('End');
  const last = await page.evaluate(() => document.activeElement?.dataset?.shape);
  assert(last === 'd20' || last === 'half-pipe' || !!last, `End goes to the last tile (${last})`);
  await page.keyboard.press('Enter');
  const added = await page.evaluate(() => window.physicslab.store.bodies().at(-1).shape.type);
  assert(added === last, `Enter on a focused tile adds it (${added})`);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowUp');
  assert(
    await page.evaluate(() => document.activeElement?.classList.contains('shape-search-input')),
    '↑ at the top returns to the search box',
  );
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('SH-7..12 · gallery: every new shape renders; dice are textured with their numbers, the tyre is dark', async () => {
  const page = await newPage('', { width: 1600, height: 900 });
  const info = await page.evaluate((types) => {
    const a = window.physicslab;
    a.newScene();
    const out = {};
    types.forEach((type, i) => {
      const col = i % 6,
        row = Math.floor(i / 6);
      const b = a.editor.addShape(type, [(col - 2.5) * 2.6, 0, (row - 1) * 2.6]);
      a.store.update(b.id, { position: [(col - 2.5) * 2.6, 0.9, (row - 1) * 2.6] });
      a.store.update(b.id, { material: { ...a.store.body(b.id).material, color: '#c9d4e6' } });
      out[type] = b.id;
    });
    a.store.setSelection([]);
    a.viewport.setView({ position: [0, 11, 12], target: [0, 0.4, 0] });
    return out;
  }, NEW_SHAPES);
  await page.waitForTimeout(1200);
  await shot(page, 'sh2-gallery');
  const surfaces = await page.evaluate((info) => {
    const a = window.physicslab;
    const res = {};
    for (const [type, id] of Object.entries(info)) {
      const piece = a.bodies.get(id).pieces[0];
      res[type] = {
        verts: piece.mesh.geometry.getAttribute('position').count,
        map: !!piece.material.map,
        colors: piece.material.vertexColors,
        uv: !!piece.mesh.geometry.getAttribute('uv'),
      };
    }
    return res;
  }, info);
  for (const type of NEW_SHAPES) assert(surfaces[type].verts >= 12, `${type} has a mesh (${surfaces[type].verts})`);
  for (const d of ['d4', 'd6', 'd8', 'd10', 'd12', 'd20'])
    assert(surfaces[d].map && surfaces[d].uv, `${d} is drawn with its numbered texture`);
  assert(surfaces.wheel.colors, 'the wheel is drawn with vertex colours (the dark tyre)');
  assert(!surfaces.gear.map && !surfaces.box?.map, 'plain shapes have no texture');
  // close-ups: the dice (front row, z = 2.6) in two halves, then the mechanical row
  const looks = [
    ['sh2-dice-left', { position: [-3.9, 2.3, 6.4], target: [-3.9, 0.5, 2.6] }],
    ['sh2-dice-right', { position: [3.9, 2.3, 6.4], target: [3.9, 0.5, 2.6] }],
    ['sh2-row2-right', { position: [3.9, 2.3, 3.8], target: [3.9, 0.5, 0] }],
    ['sh2-row2-left', { position: [-3.9, 2.8, 3.8], target: [-3.9, 0.5, 0] }],
    ['sh2-row1', { position: [0, 3.6, 2.4], target: [0, 0.5, -2.6] }],
  ];
  for (const [name, view] of looks) {
    await page.evaluate((v) => window.physicslab.viewport.setView(v), view);
    await page.waitForTimeout(700);
    await shot(page, name);
  }
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('SH-7..13 · inspector: every size field and parameter of the new shapes, with derived quantities', async () => {
  const page = await newPage();
  const SPEC = {
    gear: [
      ['Outer diameter', 'Thickness'],
      ['Teeth', 'Pressure angle', 'Bore'],
      ['Module', 'Pitch diameter'],
    ],
    wheel: [['Diameter', 'Width'], [], []],
    ellipsoid: [['Width', 'Height', 'Depth'], ['Detail'], []],
    pyramid: [['Width', 'Height', 'Depth'], ['Base sides'], []],
    'rounded-box': [['Width', 'Height', 'Depth'], ['Roundness', 'Edge style', 'Corner steps'], ['Corner radius']],
    'rounded-cylinder': [['Diameter', 'Height'], ['Roundness', 'Edge style'], ['Rim radius']],
    'curved-ramp': [['Width', 'Height', 'Depth'], ['Curve'], []],
    d6: [['Size'], ['Corner roundness'], []],
    d20: [['Size'], [], []],
  };
  const labels = () => page.locator('.panel.right .row .row-label').allTextContents();
  const missing = [];
  for (const [type, [sizes, params, quantities]] of Object.entries(SPEC)) {
    await page.evaluate((type) => {
      const a = window.physicslab;
      a.newScene();
      const b = a.editor.addShape(type, [0, 1, 0]);
      a.store.setSelection([b.id]);
    }, type);
    await page.waitForSelector('.panel.right .section-head:has-text("Physics")');
    const have = await labels();
    for (const l of [...sizes, ...params, ...quantities])
      if (!have.some((h) => h.trim().toLowerCase().startsWith(l.toLowerCase())))
        missing.push(`${type}: ${l} (rows: ${have.slice(0, 24).join(' | ')})`);
  }
  assert(missing.length === 0, `inspector rows missing: ${missing.join(' ;; ')}`);

  // the gear’s Module and Pitch diameter edit the size for the same number of teeth
  const id = await page.evaluate(() => {
    const a = window.physicslab;
    a.newScene();
    const b = a.editor.addShape('gear', [0, 1, 0]);
    a.store.setSelection([b.id]);
    return b.id;
  });
  await page.waitForSelector('.panel.right .row:has(.row-label:text-is("Module"))');
  const set = async (label, value) => {
    const f = page.locator(`.panel.right .row:has(.row-label:text-is("${label}")) .num-input:visible`).first();
    await f.fill(String(value));
    await f.press('Enter');
  };
  const shape = () => page.evaluate((id) => window.physicslab.store.body(id).shape, id);
  const before = await shape();
  const teeth = before.params.teeth;
  await set('Module', 0.1);
  let s = await shape();
  near(s.size[0], 0.1 * (teeth + 2), 1e-6, 'Module 0.1 sets the diameter to m × (N + 2)');
  assert(s.params.teeth === teeth, 'and leaves the teeth alone');
  near(s.size[0], s.size[2], 1e-9, 'a gear stays round');
  await set('Pitch diameter', 1.2);
  s = await shape();
  near(s.size[0], (1.2 * (teeth + 2)) / teeth, 1e-6, 'Pitch diameter 1.2 sets the size');
  const readback = await page
    .locator('.panel.right .row:has(.row-label:text-is("Module")) .num-input:visible')
    .first()
    .inputValue();
  near(Number(readback), s.size[0] / (teeth + 2), 6e-3, 'the Module field follows');
  await elementShot(page.locator('.panel.right'), 'sh2-inspector-gear');
  await set('Teeth', 30);
  s = await shape();
  assert(s.params.teeth === 30, 'teeth edited');
  near(s.size[0], (1.2 * (teeth + 2)) / teeth, 1e-6, 'the outer diameter is kept when the teeth change');
  const modAfter = await page
    .locator('.panel.right .row:has(.row-label:text-is("Module")) .num-input:visible')
    .first()
    .inputValue();
  near(Number(modAfter), s.size[0] / 32, 6e-3, 'the Module field shows the new module for 30 teeth');
  await page.keyboard.press('Control+z');
  assert((await shape()).params.teeth === teeth, 'undo restores the teeth');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('SH-13 · live resizing: editing a running body’s shape rebuilds it in place, keeping its motion', async () => {
  const page = await newPage();
  const ids = await page.evaluate(() => {
    const a = window.physicslab;
    a.newScene();
    a.viewport.setView({ position: [0, 4, 9], target: [0, 1.2, 0] });
    const out = {};
    for (const [i, t] of ['gear', 'wheel', 'rounded-box', 'ellipsoid', 'd20'].entries()) {
      const b = a.editor.addShape(t, [(i - 2) * 2, 2.5, 0]);
      a.store.update(b.id, { material: { ...a.store.body(b.id).material, restitution: 0.05 } });
      out[t] = b.id;
    }
    return out;
  });
  await page.keyboard.press('Space');
  await simTime(page, 0.5);
  const before = await pose(page, ids.gear);
  // select the gear and change its teeth and module from the inspector while the simulation runs
  await page.evaluate((id) => window.physicslab.store.setSelection([id]), ids.gear);
  await page.waitForSelector('.panel.right .row:has(.row-label:text-is("Teeth"))');
  const f = page.locator('.panel.right .row:has(.row-label:text-is("Teeth")) .num-input:visible').first();
  await f.fill('36');
  await f.press('Enter');
  const g = page.locator('.panel.right .row:has(.row-label:text-is("Module")) .num-input:visible').first();
  await g.fill('0.04');
  await g.press('Enter');
  await simTime(page, 1.5);
  const after = await pose(page, ids.gear);
  assert(after, 'the gear is still in the world after being resized live');
  assert(after.position[1] < before.position[1] + 0.2, 'it kept falling from where it was (no teleport back up)');
  const mass = await page.evaluate((id) => window.physicslab.sim.client.info.mass[id], ids.gear);
  const vol = await page.evaluate((id) => {
    const b = window.physicslab.store.body(id);
    return { size: b.shape.size, teeth: b.shape.params.teeth, density: b.material.density };
  }, ids.gear);
  assert(mass > 0, `the rebuilt gear has mass (${mass.toFixed(3)} kg for ${JSON.stringify(vol)})`);
  near(vol.size[0], 0.04 * 38, 1e-6, 'size from the module and the new tooth count');
  await simTime(page, 4);
  await shot(page, 'sh2-live-resize');
  for (const [t, id] of Object.entries(ids)) {
    const p = await pose(page, id);
    assert(p && p.position.every(Number.isFinite), `${t} is alive and finite`);
  }
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('SH-13 · scale gizmo: scaling keeps the proportions each new shape requires', async () => {
  const page = await newPage();
  // the real gizmo: select a gear, press R and look at the handles
  await page.evaluate(() => {
    const a = window.physicslab;
    a.newScene();
    const b = a.editor.addShape('gear', [0, 0.5, 0]);
    a.store.setSelection([b.id]);
    a.viewport.setView({ position: [2.4, 2, 3], target: [0, 0.4, 0] });
  });
  await page.click('.viewport-canvas', { position: { x: 20, y: 20 }, modifiers: [] }).catch(() => {});
  await page.evaluate(() => window.physicslab.store.setSelection([window.physicslab.store.bodies()[0].id]));
  await page.keyboard.press('r');
  const mode = await page.evaluate(() => window.physicslab.gizmo.mode);
  assert(mode === 'scale', `R switches the gizmo to scale (${mode})`);
  await page.waitForTimeout(600);
  await shot(page, 'sh2-gizmo-scale-gear');
  const res = await page.evaluate((types) => {
    const a = window.physicslab;
    a.newScene();
    const out = {};
    for (const t of types) {
      const b = a.editor.addShape(t, [0, 1, 0]);
      a.store.setSelection([b.id]);
      const s0 = a.store.body(b.id).shape.size;
      // what the scale gizmo hands to the editor when the user drags the x handle to 1.8×, then the y handle to 0.6×
      a.editor.applyGizmo([
        { id: b.id, position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [s0[0] * 1.8, s0[1], s0[2]] },
      ]);
      const s1 = a.store.body(b.id).shape.size;
      a.editor.applyGizmo([
        { id: b.id, position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [s1[0], s1[1] * 0.6, s1[2]] },
      ]);
      const s2 = a.store.body(b.id).shape.size;
      const view = a.bodies.get(b.id).pieces[0].mesh;
      out[t] = { s0, s1, s2, mesh: view.scale.toArray(), valid: s2.every((v) => v >= 0.02 && Number.isFinite(v)) };
      a.store.remove?.([b.id]);
    }
    return out;
  }, NEW_SHAPES);
  const rel = (a, b) => Math.abs(a - b) / Math.max(a, b);
  for (const t of ['gear', 'wheel']) {
    const r = res[t];
    assert(rel(r.s1[0], r.s1[2]) < 1e-9, `${t} stays round when its diameter is scaled (${r.s1})`);
    assert(r.s1[0] > r.s0[0] * 1.5, `${t} diameter grew (${r.s0[0]} → ${r.s1[0]})`);
  }
  for (const t of ['d4', 'd6', 'd8', 'd10', 'd12', 'd20']) {
    const r = res[t];
    assert(rel(r.s1[0] / r.s1[1], r.s0[0] / r.s0[1]) < 1e-6, `${t} keeps its proportions (${r.s0} → ${r.s1})`);
    assert(rel(r.s2[0] / r.s2[1], r.s0[0] / r.s0[1]) < 1e-6, `${t} keeps its proportions when y is scaled (${r.s2})`);
    assert(r.s1[0] > r.s0[0] * 1.5, `${t} grew with the handle`);
  }
  for (const t of ['rounded-cylinder', 'ellipsoid', 'curved-ramp', 'half-pipe'])
    assert(res[t].valid, `${t} sizes stay valid`);
  assert(rel(res['rounded-cylinder'].s1[0], res['rounded-cylinder'].s1[2]) < 1e-9, 'a rounded cylinder stays round');
  for (const t of NEW_SHAPES) assert(res[t].valid, `${t}: valid size after scaling ${res[t].s2}`);
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('SH-10 · physics: dice rolled in the browser worker come to rest flat on a face', async () => {
  const page = await newPage('', { width: 1600, height: 900 });
  const ids = await page.evaluate(() => {
    const a = window.physicslab;
    a.newScene();
    a.viewport.setView({ position: [0, 5.2, 6.4], target: [0, 0.3, 0.6] });
    const kinds = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20'];
    return kinds.map((t, i) => {
      const b = a.editor.addShape(t, [(i - 2.5) * 1.5, 1.4 + (i % 2) * 0.4, 0]);
      a.store.update(b.id, {
        rotation: [0.3 + i * 0.1, 0.5, 0.2, 0.8].map((v, k, arr) => v / Math.hypot(...arr)),
        angularVelocity: [4 + i, 3, -5],
        velocity: [0, 0, 0.5],
        material: {
          ...a.store.body(b.id).material,
          restitution: 0.25,
          friction: 0.55,
          color: i % 2 ? '#d9d2c0' : '#cf3b3b',
        },
      });
      return { t, id: b.id };
    });
  });
  await page.keyboard.press('Space');
  await simTime(page, 5);
  await shot(page, 'sh2-dice-rolled');
  const report = await page.evaluate(async (ids) => {
    const a = window.physicslab;
    const { dieFlatness, dieValueUp } = await import('/src/model/shapes/diceLayout.ts');
    return ids.map(({ t, id }) => {
      const p = a.sim.poseOf(id);
      const v = a.sim.velocityOf(id);
      return {
        t,
        y: p.position[1],
        speed: Math.hypot(...v.linear) + Math.hypot(...v.angular),
        flat: dieFlatness(t, p.rotation),
        value: dieValueUp(t, p.rotation),
      };
    });
  }, ids);
  for (const r of report) {
    assert(r.speed < 0.2, `${r.t} has come to rest (speed ${r.speed.toFixed(3)})`);
    assert(r.y > 0.02 && r.y < 0.6, `${r.t} lies on the ground (y = ${r.y.toFixed(3)})`);
    assert(r.flat > 0.999, `${r.t} rests flat on a face (flatness ${r.flat.toFixed(4)})`);
    assert(r.value >= 0 && r.value <= 20, `${r.t} shows ${r.value}`);
  }
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});
