/** VZ-B: post-processing stack (VZ-20/21) and quality presets / Auto governor (VZ-22) in the real renderer. */
import { assert, newPage, screenOf, shot, nextFrame } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const setGraphics = (page, patch) =>
  page.evaluate((patch) => {
    const a = window.physicslab;
    const g = structuredClone(a.prefs.value.graphics);
    for (const [k, v] of Object.entries(patch))
      g[k] = typeof v === 'object' && !Array.isArray(v) ? { ...g[k], ...v } : v;
    a.prefs.set({ graphics: g });
  }, patch);

const frames = async (page, n = 3) => {
  for (let i = 0; i < n; i++) await nextFrame(page);
};

test('post stack: every effect renders without errors on the car scene (ultra, all forced on)', async () => {
  const page = await newPage('&scene=car&quality=ultra');
  await frames(page, 4);
  const sig = await page.evaluate(() => window.physicslab.viewport.post.currentSignature);
  assert(
    /bloom/.test(sig) && /ssr/.test(sig) && /motionBlur/.test(sig) && /godRays/.test(sig),
    `ultra builds the full stack: ${sig}`,
  );
  await setGraphics(page, {
    dof: { on: true },
    aberration: { on: true },
    grain: { on: true },
    grading: { on: true, saturation: 1.2 },
  });
  await frames(page, 4);
  const sig2 = await page.evaluate(() => window.physicslab.viewport.post.currentSignature);
  assert(/dof/.test(sig2) && /aberration/.test(sig2) && /grain/.test(sig2) && /grading/.test(sig2), `all on: ${sig2}`);
  await shot(page, 'vz20-ultra-all');
  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
});

test('quality: Auto probes the software renderer to Low; the URL param and the menu choose a fixed tier', async () => {
  const page = await newPage('&scene=car&quality=auto');
  await frames(page, 2);
  const i = await page.evaluate(() => window.physicslab.viewport.graphicsInfo);
  assert(i.auto && i.probe === 'low' && i.tier === 'low', `software GL probes to low: ${JSON.stringify(i)}`);
  await page.evaluate(() => window.physicslab.prefs.set({ quality: 'high' }));
  await frames(page, 2);
  const j = await page.evaluate(() => ({
    g: window.physicslab.viewport.graphicsInfo,
    sig: window.physicslab.viewport.post.currentSignature,
  }));
  assert(
    !j.g.auto && j.g.tier === 'high' && /ao/.test(j.sig) && /bloom/.test(j.sig),
    `high tier: ${JSON.stringify(j)}`,
  );
});

test('depth of field: "Pick focus point" sets the focus distance from a click on a body', async () => {
  const page = await newPage('&scene=car&quality=low');
  await page.evaluate(() => {
    window.physicslab.store.setSelection([]);
    window.physicslab.prefs.set({ rightTab: 'world' });
  });
  await page.locator('.section-head', { hasText: 'Depth of field' }).scrollIntoViewIfNeeded();
  await page.locator('.section-head', { hasText: 'Depth of field' }).click();
  await page.getByRole('button', { name: 'Pick focus point' }).click();
  const id = await page.evaluate(() => window.physicslab.store.bodies().find((b) => b.name === 'Chassis').id);
  const { x, y } = await screenOf(page, id);
  await page.mouse.click(x, y);
  await frames(page, 2);
  const d = await page.evaluate(() => {
    const a = window.physicslab;
    return {
      dof: a.prefs.value.graphics.dof,
      dist: a.camera.position.distanceTo(a.bodies.get(a.store.bodies().find((b) => b.name === 'Chassis').id).position),
    };
  });
  assert(d.dof.on === true && d.dof.focusMode === 'manual', `dof enabled in manual mode ${JSON.stringify(d.dof)}`);
  assert(Math.abs(d.dof.focusDistance - d.dist) < 2.5, `focus ${d.dof.focusDistance} ≈ distance to the car ${d.dist}`);
});
