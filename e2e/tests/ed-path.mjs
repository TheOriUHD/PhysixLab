/**
 * ED-23 — the Path tool in the real UI: draw a path with real pointer events (rubber band, one undo step), insert a
 * point by clicking the curve, delete a point with Delete, close the loop, reverse the direction, the inspector
 * operations and the commands in the palette registry.
 */
import { assert, near, newPage, nextFrame, shot } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** Client-space position of a world point. */
const screenPoint = async (page, world) => {
  await nextFrame(page);
  return page.evaluate((w) => {
    const a = window.physicslab;
    const v = new a.camera.position.constructor(...w).project(a.camera);
    const r = a.viewport.dom.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }, world);
};

const run = (page, id) =>
  page.evaluate(async (id) => {
    const { runCommand } = await import('/src/app/registry/commands.ts');
    return runCommand(id, window.physicslab, 'palette');
  }, id);

const paths = (page) => page.evaluate(() => window.physicslab.store.paths().map((p) => JSON.parse(JSON.stringify(p))));

const GROUND = [
  [-4, 0.05, 1],
  [-1.5, 0.05, -2],
  [1.5, 0.05, 2],
  [4, 0.05, -1],
];

test('path tool: draw with the pointer, insert, delete, close, reverse; the drawing is one undo step', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physicslab;
    a.newScene();
    a.viewport.setView({ position: [0, 11, 9], target: [0, 0, 0] });
    a.store.setSelection([]);
    a.prefs.set({ snap: false });
  });
  await page.keyboard.press('d');
  assert((await page.evaluate(() => window.physicslab.prefs.value.tool)) === 'path', 'P selects the path tool');
  assert(
    (await page.locator('.tool[data-tool="path"], [data-tool="path"]').count()) > 0,
    'the toolbox has a path button',
  );

  // three clicks, then hover where the fourth point goes: a rubber band is shown, the document is untouched
  for (const p of GROUND.slice(0, 3)) {
    const s = await screenPoint(page, p);
    await page.mouse.click(s.x, s.y);
  }
  const s4 = await screenPoint(page, GROUND[3]);
  await page.mouse.move(s4.x, s4.y, { steps: 4 });
  await nextFrame(page);
  const draft = await page.evaluate(() => {
    const a = window.physicslab;
    const v = a.pathViews.get('__draft_path__');
    return { exists: !!v, points: v?.def.points.length, docPaths: a.store.paths().length };
  });
  assert(
    draft.exists && draft.points === 4,
    `a draft with 3 placed points + the rubber-band end: ${JSON.stringify(draft)}`,
  );
  assert(draft.docPaths === 0, 'nothing is in the document until the drawing is finished');
  await shot(page, 'ed-path-drawing');

  await page.mouse.click(s4.x, s4.y);
  await page.keyboard.press('Enter');
  let ps = await paths(page);
  assert(
    ps.length === 1 && ps[0].points.length === 4,
    `one path with 4 points: ${JSON.stringify(ps.map((p) => p.points.length))}`,
  );
  for (let i = 0; i < 4; i++) {
    near(ps[0].points[i][0], GROUND[i][0], 0.2, `point ${i} x`);
    near(ps[0].points[i][2], GROUND[i][2], 0.2, `point ${i} z`);
  }
  assert(
    (await page.evaluate(() => window.physicslab.pathViews.get('__draft_path__'))) === undefined,
    'the draft is gone',
  );
  await shot(page, 'ed-path-drawn');

  // one undo removes the whole path; redo brings it back
  await page.keyboard.press('Control+z');
  assert((await paths(page)).length === 0, 'one undo removes the drawn path');
  await page.keyboard.press('Control+y');
  ps = await paths(page);
  assert(ps.length === 1 && ps[0].points.length === 4, 'redo restores it');
  const id = ps[0].id;
  assert(
    JSON.stringify(await page.evaluate(() => window.physicslab.store.selection)) === JSON.stringify([id]),
    'the new path is selected',
  );

  // insert a point by clicking the curve halfway along the first segment
  const mid = await page.evaluate(async (id) => {
    const { pathCurveOf } = await import('/src/model/path.ts');
    const c = pathCurveOf(window.physicslab.store.path(id));
    return c.positionAt(1 / 6);
  }, id);
  const sm = await screenPoint(page, mid);
  await page.mouse.click(sm.x, sm.y);
  let p = (await paths(page))[0];
  assert(p.points.length === 5, `clicking the curve inserted a point (${p.points.length})`);
  near(p.points[1][0], mid[0], 0.3, 'inserted point x is where the curve was clicked');
  near(p.points[1][2], mid[2], 0.3, 'inserted point z is where the curve was clicked');
  const active = await page.evaluate(() => window.physicslab.pathPoint);
  assert(active && active.index === 1, `the new point is active for the gizmo: ${JSON.stringify(active)}`);

  // Delete removes the active point, not the whole path
  await page.keyboard.press('Delete');
  p = (await paths(page))[0];
  assert(p.points.length === 4, `Delete removed the active point (${p.points.length})`);
  assert((await paths(page)).length === 1, 'the path itself stays');

  // the minimum is kept: reduce to 2 points, then a further delete is refused
  await page.evaluate((id) => {
    const a = window.physicslab;
    a.store.update(id, { points: a.store.path(id).points.slice(0, 2) }, 'test');
    a.setPathPoint(id, 0);
  }, id);
  await page.keyboard.press('Delete');
  assert((await paths(page))[0].points.length === 2, 'an open path keeps two points');

  // restore four points, then close / reverse with the commands and the key
  await page.evaluate(
    ({ id, pts }) => window.physicslab.store.update(id, { points: pts.map((q) => [q[0], q[1], q[2]]) }, 'test'),
    { id, pts: GROUND },
  );
  await page.evaluate(() => window.physicslab.setPathPoint(null));
  await page.keyboard.press('Shift+C');
  assert((await paths(page))[0].closed === true, 'Shift+C closes the loop');
  await page.keyboard.press('Shift+C');
  assert((await paths(page))[0].closed === false, 'Shift+C opens it again');
  await run(page, 'path.reverse');
  p = (await paths(page))[0];
  near(p.points[0][0], GROUND[3][0], 1e-6, 'reverse: first point is the old last');
  near(p.points[3][0], GROUND[0][0], 1e-6, 'reverse: last point is the old first');

  // an undo step per operation
  await run(page, 'path.subdivide');
  assert((await paths(page))[0].points.length === 7, 'subdivide adds one point per segment');
  await page.keyboard.press('Control+z');
  assert((await paths(page))[0].points.length === 4, 'subdivide is one undo step');
  assert(
    (await page.evaluate(() => window.physicslab.errors?.length ?? 0)) === 0 && page.errors.length === 0,
    `no errors: ${page.errors.join(' | ')}`,
  );
});

test('path tool: Escape with fewer than two points leaves nothing, Backspace removes the last point, double-click finishes', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physicslab;
    a.newScene();
    a.viewport.setView({ position: [0, 11, 9], target: [0, 0, 0] });
    a.prefs.set({ snap: false });
    a.prefs.set({ tool: 'path' });
  });
  const a1 = await screenPoint(page, GROUND[0]);
  await page.mouse.click(a1.x, a1.y);
  await page.keyboard.press('Escape');
  assert((await paths(page)).length === 0, 'one point + Escape: no path');
  assert(
    (await page.evaluate(() => window.physicslab.pathViews.get('__draft_path__'))) === undefined,
    'the draft preview is removed',
  );

  for (const g of GROUND.slice(0, 3)) {
    const s = await screenPoint(page, g);
    await page.mouse.click(s.x, s.y);
  }
  await page.keyboard.press('Backspace');
  const s3 = await screenPoint(page, GROUND[2]);
  await page.mouse.dblclick(s3.x, s3.y);
  const ps = await paths(page);
  assert(
    ps.length === 1 && ps[0].points.length === 3,
    `Backspace dropped the third point, the double-click re-added and finished: ${ps.map((x) => x.points.length)}`,
  );
  assert(ps[0].closed === false, 'open path');
  // the camera did not "frame" on the double click (the tool swallows it): view still looks down at the origin
  const cam = await page.evaluate(() => window.physicslab.camera.position.y);
  near(cam, 11, 0.5, 'double-click did not move the camera');
});

test('path inspector: operations section, respace to N points, flatten', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physicslab;
    a.newScene();
    a.viewport.setView({ position: [0, 11, 9], target: [0, 0, 0] });
    a.editor.addPath([0, 0, 0], {
      position: [0, 0, 0],
      points: [
        [0, 1, 0],
        [3, 2, 0.13],
        [6, 1, -0.07],
        [10, 3, 0],
      ],
    });
  });
  await page.click('.panel.right .tab:has-text("Inspector")');
  await page.waitForSelector('.panel.right .section-head:has-text("Path tools")');
  const row = page.locator('.panel.right .row:has(.row-label:text-is("Respace"))');
  await row.locator('.num-input').fill('7');
  await row.locator('.num-input').press('Enter');
  await row.locator('button:has-text("Apply")').click();
  let p = (await paths(page))[0];
  assert(p.points.length === 7, `respaced to 7 points (${p.points.length})`);
  const gaps = await page.evaluate(() => {
    const pts = window.physicslab.store.paths()[0].points;
    return pts.slice(1).map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1], q[2] - pts[i][2]));
  });
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  assert(
    gaps.every((g) => Math.abs(g - mean) / mean < 0.12),
    `points are evenly spaced: ${gaps.map((g) => g.toFixed(2))}`,
  );
  await page.click('.panel.right button:has-text("Flatten")');
  p = (await paths(page))[0];
  assert(
    p.points.every((q) => Math.abs(q[1] - 0.05) < 1e-6),
    'flatten puts all points at ground height',
  );
  await shot(page, 'ed-path-inspector');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});
