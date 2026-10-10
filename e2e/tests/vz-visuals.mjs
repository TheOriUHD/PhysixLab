/** VZ-A: materials, textures, environment, fog, ground (VZ-1..VZ-4, VZ-10..VZ-13). */
import { assert, newPage, shot, nextFrame } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const setEnv = (page, patch) =>
  page.evaluate(async (p) => {
    const a = window.physicslab;
    a.store.updateSettings({ environment: { ...a.store.settings.environment, ...p } }, 'test');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, patch);

test('environment presets render (shots)', async () => {
  const page = await newPage('&scene=pit&quality=low');
  await page.waitForTimeout(800);
  for (const sky of ['studio', 'day', 'sunset', 'night', 'physical', 'blueprint', 'space', 'lab', 'desert', 'snow', 'overcast']) {
    await page.evaluate((s) => {
      const a = window.physicslab;
      a.store.updateSettings({ environment: { ...a.store.settings.environment, sky: s } }, 'test');
    }, sky);
    await page.waitForTimeout(400);
    await nextFrame(page);
    await shot(page, `vz-sky-${sky}`);
  }
  assert(page.errors.length === 0, `no console errors: ${page.errors.join('|')}`);
});
