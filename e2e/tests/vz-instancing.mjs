/** VZ-B: instanced rendering (VZ-30) — draw-call benchmark on the 300-ball pit, picking and highlight per instance. */
import { assert, newPage, screenOf, shot, nextFrame } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const calls = (page) =>
  page.evaluate(async () => {
    const a = window.physixlab;
    const info = a.viewport.renderer.info;
    // The composer renders several passes per frame: count them all for exactly one frame.
    info.autoReset = false;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    info.reset();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const n = info.render.calls;
    info.autoReset = true;
    return { calls: n, stats: a.bodies.poolStats() };
  });

test('instancing: the 300-ball pit needs ≥ 3× fewer draw calls than one mesh per body', async () => {
  const on = await newPage('&scene=pit&quality=low');
  await on.waitForTimeout(600);
  const a = await calls(on);
  await on.close(); // two live 300-ball pits starve each other of CPU in software GL: measure one at a time
  const off = await newPage('&scene=pit&quality=low&instancing=0');
  await off.waitForTimeout(600);
  const b = await calls(off);
  assert(a.stats.instances >= 290, `ball bodies are pooled (${JSON.stringify(a.stats)})`);
  assert(b.stats.pools === 0, 'instancing=0 disables pools');
  assert(b.calls >= 3 * a.calls, `draw calls with instancing ${a.calls} vs without ${b.calls}`);
  process.stderr.write(`[vz-30] pit draw calls: instanced ${a.calls}, per-body ${b.calls}\n`);
});

test('instancing: picking, hover and selection work per instance', async () => {
  const page = await newPage('&scene=pit&quality=low');
  await page.waitForTimeout(500);
  const id = await page.evaluate(() => {
    const a = window.physixlab;
    const balls = a.store.bodies().filter((b) => b.shape.type === 'sphere' && b.bodyType === 'dynamic');
    // The topmost ball is the easiest to hit.
    return balls.sort((p, q) => q.position[1] - p.position[1])[0].id;
  });
  await nextFrame(page);
  const { x, y } = await screenOf(page, id);
  await page.mouse.move(x, y);
  await page.waitForTimeout(200);
  const hov = await page.evaluate(() => window.physixlab.hoverId);
  assert(hov === id, `hover resolves the instance (${hov} vs ${id})`);
  await page.mouse.click(x, y);
  await page.waitForTimeout(250);
  const sel = await page.evaluate(() => window.physixlab.store.selection.slice());
  assert(sel.length === 1 && sel[0] === id, `click selects exactly the clicked instance (${sel})`);
  const info = await page.evaluate((id) => {
    const v = window.physixlab.bodies.get(id);
    return { promoted: v.promoted, meshVisible: v.mesh.visible, slotShown: v.poolVisible };
  }, id);
  assert(info.promoted && info.meshVisible && !info.slotShown, `selected instance is promoted ${JSON.stringify(info)}`);
  await shot(page, 'vz30-pit-selected');
});

const frameInfo = (page) =>
  page.evaluate(async () => {
    const a = window.physixlab;
    const info = a.viewport.renderer.info;
    info.autoReset = false;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    info.reset();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const out = { calls: info.render.calls, triangles: info.render.triangles };
    info.autoReset = true;
    return out;
  });

test('culling + LOD: looking away from the pit draws far less; distant balls use fewer triangles', async () => {
  const page = await newPage('&scene=pit&quality=low&instancing=0');
  await page.waitForTimeout(500);
  const look = (pos, target) =>
    page.evaluate(([p, t]) => window.physixlab.viewport.setView({ position: p, target: t }), [pos, target]);
  await page.evaluate(() => (window.physixlab.bodies.lodEnabled = false));
  await look([0, 6, 14], [0, 1, 0]);
  await page.waitForTimeout(300);
  const toward = await frameInfo(page);
  await look([0, 6, 14], [0, 1, 60]); // turn around: the pit is behind the camera
  await page.waitForTimeout(300);
  const away = await frameInfo(page);
  assert(
    away.calls < toward.calls * 0.35,
    `frustum culling: ${toward.calls} calls looking at the pit, ${away.calls} looking away`,
  );
  // LOD: pooled balls seen from far away use a lower level than up close.
  await page.evaluate(() => {
    const a = window.physixlab;
    a.bodies.lodEnabled = true;
    a.bodies.setInstancing(true);
  });
  await look([0, 4, 7], [0, 2, 0]);
  await page.waitForFunction(() => [...window.physixlab.bodies.lodLevels.values()].every((l) => l === 0), null, {
    timeout: 20000,
  });
  const near = await frameInfo(page);
  await look([0, 40, 120], [0, 2, 0]);
  await page.waitForFunction(() => [...window.physixlab.bodies.lodLevels.values()].some((l) => l === 2), null, {
    timeout: 20000,
  });
  const far = await frameInfo(page);
  const lods = await page.evaluate(() => [...window.physixlab.bodies.views.values()].map((v) => v.lod));
  assert(
    far.triangles < near.triangles * 0.5,
    `distant balls are cheaper: ${near.triangles} → ${far.triangles} triangles`,
  );
  process.stderr.write(
    `[vz-31] culling ${toward.calls}→${away.calls} calls; LOD ${near.triangles}→${far.triangles} triangles\n`,
  );
  assert(lods.length > 0, 'views exist');
});
