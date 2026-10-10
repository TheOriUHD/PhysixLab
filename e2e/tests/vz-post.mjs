/** VZ-B: post-processing stack (VZ-20/21) and quality presets / Auto governor (VZ-22) in the real renderer. */
import { assert, newPage, shot, nextFrame } from '../helpers.mjs';

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
