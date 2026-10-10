/**
 * Package SH, chunk 1 (primitive shapes I): the torus, ring, tube, arch, stairs, spiral stairs, hemisphere, dome,
 * frustum and the I / L / T beams in the real app — palette tiles, inspector fields, rendering, and the physics
 * worker building their compound colliders (a ball falls through the torus hole, rests on a step …).
 *
 * Set E2E_SHOTS=1 to write the screenshots (sh1-*.png) into e2e/out/.
 */
import { assert, near, newPage, pose, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const SHAPES = [
  ['torus', 'Torus', ['Outer diameter', 'Tube diameter'], ['Ring segments', 'Tube sides']],
  ['ring', 'Ring', ['Outer diameter', 'Thickness'], ['Hole', 'Segments']],
  ['tube', 'Tube', ['Outer diameter', 'Length'], ['Wall', 'Segments']],
  ['arch', 'Arch', ['Span', 'Height', 'Depth'], ['Thickness', 'Arc segments']],
  ['stairs', 'Stairs', ['Width', 'Height (rise)', 'Depth (run)'], ['Steps']],
  [
    'spiral-stairs',
    'Spiral stairs',
    ['Outer diameter', 'Height'],
    ['Turns', 'Steps per turn', 'Column', 'Tread thickness', 'Clockwise'],
  ],
  ['hemisphere', 'Hemisphere', ['Diameter'], ['Segments']],
  ['dome', 'Dome', ['Base diameter', 'Height'], ['Segments']],
  ['frustum', 'Frustum', ['Diameter (wide end)', 'Height'], ['Top ÷ bottom', 'Segments']],
  ['i-beam', 'I-beam', ['Length', 'Height', 'Width'], ['Flange', 'Web']],
  ['l-beam', 'L-beam', ['Length', 'Height', 'Width'], ['Base leg', 'Upright leg']],
  ['t-beam', 'T-beam', ['Length', 'Height', 'Width'], ['Flange', 'Stem']],
];

const rowLabels = (page) => page.locator('.panel.right .row .row-label').allTextContents();

test('SH-1..6 · every new primitive is an Add-tab tile; clicking adds it and the inspector shows its size fields and parameters', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physixlab.newScene());
  for (const [id, label, sizeLabels, paramLabels] of SHAPES) {
    const tile = page.locator('.tile', { hasText: new RegExp(`^${label}$`) });
    assert((await tile.count()) === 1, `exactly one Add tile named "${label}"`);
    const title = await tile.getAttribute('title');
    assert(/Drag into the scene/.test(title ?? ''), `${label} tile has a tooltip (${title})`);
    await tile.dblclick();
    const added = await page.evaluate(() => {
      const b = window.physixlab.store.bodies();
      const last = b[b.length - 1];
      return {
        type: last.shape.type,
        sel: window.physixlab.store.selection.includes(last.id),
        params: last.shape.params,
      };
    });
    assert(added.type === id, `${label} tile added a ${id} (got ${added.type})`);
    if (paramLabels.length) assert(added.params && Object.keys(added.params).length, `${id} got default params`);
    await page.waitForSelector('.panel.right .section-head:has-text("Physics")');
    const labels = await rowLabels(page);
    for (const l of [...sizeLabels, ...paramLabels])
      assert(labels.includes(l), `inspector of ${id} lists "${l}" (rows: ${labels.slice(0, 30).join(' | ')})`);
  }
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('SH-1..6 · editing size and parameters in the inspector reshapes the body (undoable)', async () => {
  const page = await newPage();
  const id = await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    const b = a.editor.addShape('torus', [0, 0.15, 0]);
    a.store.setSelection([b.id]);
    return b.id;
  });
  await page.waitForSelector('.panel.right .row:has(.row-label:text-is("Tube sides"))');
  const set = async (label, value) => {
    const f = page.locator(`.panel.right .row:has(.row-label:text-is("${label}")) .num-input:visible`).first();
    await f.fill(String(value));
    await f.press('Enter');
  };
  const shape = () => page.evaluate((id) => window.physixlab.store.body(id).shape, id);
  await set('Ring segments', 12);
  await set('Tube sides', 8);
  let s = await shape();
  assert(s.params.segments === 12 && s.params.tubeSides === 8, `params edited: ${JSON.stringify(s.params)}`);
  await set('Outer diameter', 2);
  s = await shape();
  near(s.size[0], 2, 1e-6, 'outer diameter');
  near(s.size[2], 2, 1e-6, 'a torus stays round in plan');
  await set('Tube diameter', 5);
  s = await shape();
  near(s.size[1], 0.8, 1e-6, 'the tube is capped at 40 % of the outer diameter so the hole stays open');
  // the mesh follows: geometry cache key changes with the parameters
  const verts = await page.evaluate(
    (id) => window.physixlab.bodies.get(id).mesh.geometry.getAttribute('position').count,
    id,
  );
  assert(verts > 0, 'torus has a mesh');
  await page
    .locator('body')
    .click({ position: { x: 5, y: 5 } })
    .catch(() => {});
  await page.keyboard.press('Control+z');
  s = await shape();
  near(s.size[1], 0.3, 1e-9, 'undo restores the tube diameter set before the capped edit');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('SH-1..6 · gallery: all twelve render with their own geometry, no errors', async () => {
  const page = await newPage('', { width: 1600, height: 900 });
  const ids = await page.evaluate((shapes) => {
    const a = window.physixlab;
    a.newScene();
    const out = [];
    shapes.forEach(([type], i) => {
      const col = i % 4,
        row = Math.floor(i / 4);
      const b = a.editor.addShape(type, [(col - 1.5) * 3.4, 0, (row - 1) * 3.4]);
      // rest each on the ground by its own half height
      a.store.update(b.id, { position: [(col - 1.5) * 3.4, b.shape.size[1] / 2, (row - 1) * 3.4] });
      out.push(b.id);
    });
    a.store.setSelection([]);
    a.viewport.setView({ position: [0, 9.5, 11.5], target: [0, 0.6, 0.4] });
    return out;
  }, SHAPES);
  await page.waitForTimeout(900);
  await shot(page, 'sh1-gallery');
  const meshes = await page.evaluate(
    (ids) =>
      ids.map((id) => {
        const m = window.physixlab.bodies.get(id).mesh;
        return m.geometry.getAttribute('position').count;
      }),
    ids,
  );
  assert(
    meshes.every((n) => n > 12),
    `every shape has geometry (${meshes.join(',')})`,
  );
  // close-ups of each row for the eye
  const rows = [
    { position: [-0.5, 3.6, 10.2], target: [-0.5, 0.4, 3.4] },
    { position: [-0.5, 3.4, 5.2], target: [-0.5, 0.4, 0] },
    { position: [-0.5, 3.4, -1.6], target: [-0.5, 0.4, -3.4] },
  ];
  for (const [i, v] of rows.entries()) {
    await page.evaluate((v) => window.physixlab.viewport.setView(v), v);
    await page.waitForTimeout(500);
    await shot(page, `sh1-row${i + 1}`);
  }
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('SH-1 · simulating: a small ball falls through the torus hole, a wide one rests on the ring (physics worker)', async () => {
  const page = await newPage();
  const ids = await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    a.viewport.setView({ position: [0, 3, 6], target: [0, 1, 0] });
    const dead = (b) => {
      a.store.update(b.id, { material: { ...a.store.body(b.id).material, restitution: 0 } });
      return b;
    };
    const t = dead(a.editor.addShape('torus', [0, 1.2, 0], { bodyType: 'static' })); // hole radius 0.2
    const small = a.editor.addShape('sphere', [0, 2.6, 0]);
    a.store.update(small.id, {
      shape: { ...small.shape, size: [0.24, 0.24, 0.24] },
      material: { ...small.material, restitution: 0 },
    });
    const wide = a.editor.addShape('sphere', [2.5, 2.6, 0]);
    a.store.update(wide.id, {
      shape: { ...wide.shape, size: [0.5, 0.5, 0.5] },
      material: { ...wide.material, restitution: 0 },
    });
    // a second torus with a ball too big for the hole
    const t2 = dead(a.editor.addShape('torus', [2.5, 1.2, 0], { bodyType: 'static' }));
    return { t: t.id, small: small.id, wide: wide.id, t2: t2.id };
  });
  await page.keyboard.press('Space');
  await simTime(page, 2.5);
  await shot(page, 'sh1-torus-sim');
  const small = await pose(page, ids.small);
  const wide = await pose(page, ids.wide);
  near(small.position[1], 0.12, 0.03, 'the small ball fell through the hole to the ground');
  assert(Math.abs(small.position[0]) < 0.06, 'it fell straight down the middle');
  assert(wide.position[1] > 1.3, `the 0.5 m ball is held by the ring (y = ${wide.position[1].toFixed(2)})`);
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('SH-3/4 · simulating: a ball rolls through the arch, comes to rest on a step and on a spiral tread', async () => {
  const page = await newPage();
  const ids = await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    a.viewport.setView({ position: [3, 3.2, 8], target: [0, 1, 0] });
    // nothing bounces: a pair's restitution is the larger of the two surfaces
    const dead = (b) => {
      a.store.update(b.id, { material: { ...a.store.body(b.id).material, restitution: 0 } });
      return b;
    };
    const arch = dead(a.editor.addShape('arch', [-4, 1, 0], { bodyType: 'static' }));
    const passer = a.editor.addShape('sphere', [-4, 0.2, 2.5]);
    a.store.update(passer.id, {
      shape: { ...passer.shape, size: [0.4, 0.4, 0.4] },
      velocity: [0, 0, -5],
      material: { ...passer.material, restitution: 0 },
    });
    // stairs: 6 steps, rise 0.2, run 0.3 — drop on the third tread (z centre 0.9 − 2.5·0.3 = 0.15)
    const stairs = dead(a.editor.addShape('stairs', [0, 0.6, 0], { bodyType: 'static' }));
    const stepper = a.editor.addShape('sphere', [0, 2.5, 0.15]);
    a.store.update(stepper.id, {
      shape: { ...stepper.shape, size: [0.16, 0.16, 0.16] },
      material: { ...stepper.material, restitution: 0 },
    });
    // spiral stairs: onto the first tread (starts at the front, +z)
    const spiral = dead(a.editor.addShape('spiral-stairs', [4, 1.2, 0], { bodyType: 'static' }));
    const climber = a.editor.addShape('sphere', [
      4 + 0.6 * Math.cos(Math.PI / 2 - 0.26),
      3,
      0.6 * Math.sin(Math.PI / 2 - 0.26),
    ]);
    a.store.update(climber.id, {
      shape: { ...climber.shape, size: [0.14, 0.14, 0.14] },
      material: { ...climber.material, restitution: 0 },
    });
    return {
      arch: arch.id,
      passer: passer.id,
      stairs: stairs.id,
      stepper: stepper.id,
      spiral: spiral.id,
      climber: climber.id,
    };
  });
  await page.keyboard.press('Space');
  await simTime(page, 3);
  await shot(page, 'sh1-arch-stairs-sim');
  const passer = await pose(page, ids.passer);
  assert(
    passer.position[2] < -2.5,
    `the ball came out of the far side of the arch (z = ${passer.position[2].toFixed(2)})`,
  );
  const stepper = await pose(page, ids.stepper);
  near(stepper.position[1], 3 * 0.2 + 0.08, 0.02, 'the ball rests on the tread of the third step');
  const climber = await pose(page, ids.climber);
  // the first tread's top is 0.124 above the ground (tread = 0.6 × the 0.207 rise), the ball is 0.07 in radius
  near(climber.position[1], 0.124 + 0.07, 0.02, 'the ball rests on the first tread of the spiral');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('SH-5/6 · dynamic dome, hemisphere, frustum and beams settle on the ground in the browser', async () => {
  const page = await newPage();
  const ids = await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    a.viewport.setView({ position: [0, 4, 9], target: [0, 0.4, 0] });
    const types = ['dome', 'hemisphere', 'frustum', 'i-beam', 'l-beam', 't-beam'];
    // spawn materials cycle through bouncy ones (rubber …): a bouncing body is still moving after seconds
    return types.map((t, i) => {
      const b = a.editor.addShape(t, [(i - 2.5) * 2.2, 1.2, 0]);
      a.store.update(b.id, { material: { ...b.material, restitution: 0.05 } });
      return b.id;
    });
  });
  await page.keyboard.press('Space');
  await simTime(page, 5);
  await shot(page, 'sh1-dynamic');
  const before = await Promise.all(ids.map((id) => pose(page, id)));
  await simTime(page, 5.6);
  const after = await Promise.all(ids.map((id) => pose(page, id)));
  ids.forEach((id, i) => {
    const y = after[i].position[1];
    assert(y < 0.9 && y > 0.05, `body ${i} rests near the ground (y = ${y.toFixed(2)})`);
    const moved = Math.hypot(...after[i].position.map((v, k) => v - before[i].position[k]));
    assert(moved < 0.05, `body ${i} has stopped (moved ${moved.toFixed(3)} m in 0.6 s)`);
  });
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('SH-1..6 · parameter variants render correctly (faceted low counts, tall stairs, segmental arch, clockwise spiral, inverted frustum)', async () => {
  const page = await newPage('', { width: 1600, height: 900 });
  const ids = await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    const V = [
      ['torus', { segments: 8, tubeSides: 6 }, [1, 0.3, 1]],
      ['torus', { segments: 64, tubeSides: 32 }, [1.4, 0.55, 1.4]],
      ['ring', { hole: 0.85, segments: 12 }, [1.2, 0.12, 1.2]],
      ['tube', { wall: 0.4, segments: 16 }, [0.7, 1.4, 0.7]],
      ['arch', { thickness: 0.12, segments: 24 }, [2.4, 1.4, 0.6]],
      ['arch', { thickness: 0.35, segments: 6 }, [2, 2.4, 1]],
      ['stairs', { steps: 14 }, [1, 1.4, 3]],
      ['spiral-stairs', { turns: 2, stepsPerTurn: 10, clockwise: true, core: 0.35 }, [2, 3.4, 2]],
      ['hemisphere', { segments: 12 }, [1.2, 0.6, 1.2]],
      ['dome', { segments: 48 }, [1.8, 0.4, 1.8]],
      ['frustum', { top: 1.7, segments: 12 }, [1.1, 1, 1.1]],
      ['i-beam', { flange: 0.25, web: 0.3 }, [2, 0.7, 0.6]],
      ['l-beam', { flange: 0.3, web: 0.3 }, [2, 0.7, 0.7]],
      ['t-beam', { flange: 0.3, web: 0.3 }, [2, 0.7, 0.8]],
    ];
    return V.map(([type, params, size], i) => {
      const b = a.editor.addShape(type, [0, 0, 0]);
      const col = i % 5,
        row = Math.floor(i / 5);
      a.store.update(b.id, {
        shape: { type, size, params: { ...b.shape.params, ...params } },
        position: [(col - 2) * 3.6, size[1] / 2, (row - 1) * 3.6],
      });
      return b.id;
    });
  });
  const shapes = await page.evaluate((ids) => ids.map((id) => window.physixlab.store.body(id).shape), ids);
  assert(
    shapes.every((s) => s.size.every((v) => v > 0.02)),
    'sizes valid',
  );
  await page.evaluate(() => window.physixlab.viewport.setView({ position: [0, 10, 12.5], target: [0, 0.5, 0.2] }));
  await page.waitForTimeout(900);
  await shot(page, 'sh1-variants');
  await page.evaluate(() =>
    window.physixlab.viewport.setView({ position: [-1.5, 3.2, 7.6], target: [-1.5, 0.7, -3.6] }),
  );
  await page.waitForTimeout(500);
  await shot(page, 'sh1-variants-back');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});
