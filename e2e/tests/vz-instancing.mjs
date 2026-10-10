/** VZ-B: instanced rendering (VZ-30) — draw-call benchmark on the 300-ball pit, picking and highlight per instance. */
import { assert, newPage, screenOf, shot, nextFrame } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const calls = (page) =>
  page.evaluate(async () => {
    const a = window.physicslab;
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
    const a = window.physicslab;
    const balls = a.store.bodies().filter((b) => b.shape.type === 'sphere' && b.bodyType === 'dynamic');
    // The topmost ball is the easiest to hit.
    return balls.sort((p, q) => q.position[1] - p.position[1])[0].id;
  });
  await nextFrame(page);
  const { x, y } = await screenOf(page, id);
  await page.mouse.move(x, y);
  await page.waitForTimeout(200);
  const hov = await page.evaluate(() => window.physicslab.hoverId);
  assert(hov === id, `hover resolves the instance (${hov} vs ${id})`);
  await page.mouse.click(x, y);
  await page.waitForTimeout(250);
  const sel = await page.evaluate(() => window.physicslab.store.selection.slice());
  assert(sel.length === 1 && sel[0] === id, `click selects exactly the clicked instance (${sel})`);
  const info = await page.evaluate((id) => {
    const v = window.physicslab.bodies.get(id);
    return { promoted: v.promoted, meshVisible: v.mesh.visible, slotShown: v.poolVisible };
  }, id);
  assert(info.promoted && info.meshVisible && !info.slotShown, `selected instance is promoted ${JSON.stringify(info)}`);
  await shot(page, 'vz30-pit-selected');
});
