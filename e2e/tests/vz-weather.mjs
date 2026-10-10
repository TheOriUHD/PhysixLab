/** VZ-B: weather (VZ-23) in the real renderer: GPU-instanced particles, caps per tier, wind, wet look, lightning. */
import { assert, newPage, shot, nextFrame } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const frames = async (page, n = 3) => {
  for (let i = 0; i < n; i++) await nextFrame(page);
};
const setWeather = (page, patch) =>
  page.evaluate((patch) => {
    const a = window.physicslab;
    const cur = a.store.settings.weather ?? {
      kind: 'none',
      intensity: 0.5,
      lightning: false,
      wet: 0,
      windSpeed: 0,
      windDir: 0,
    };
    a.store.updateSettings({ weather: { ...cur, ...patch } }, 'Weather');
  }, patch);
const stats = (page) => page.evaluate(() => ({ ...window.physicslab.viewport.weather.stats }));
const groundRoughness = (page) => page.evaluate(() => window.physicslab.viewport.slab.material.roughness);

test('weather: rain is one instanced draw call, capped by the quality tier, and wets the ground', async () => {
  const page = await newPage('&scene=pit&quality=low');
  await frames(page, 2);
  const clear = await stats(page);
  assert(
    clear.kind === 'none' && clear.count === 0 && clear.drawCalls === 0,
    `clear sky draws nothing: ${JSON.stringify(clear)}`,
  );
  const rough0 = await groundRoughness(page);
  await setWeather(page, { kind: 'rain', intensity: 1, windSpeed: 8, windDir: 90 });
  await frames(page, 6);
  const s = await stats(page);
  assert(s.kind === 'rain' && s.tier === 'low', `rain on the low tier: ${JSON.stringify(s)}`);
  assert(s.count > 0 && s.count <= s.cap && s.cap <= 1500, `rain count within the low-tier cap: ${JSON.stringify(s)}`);
  assert(s.drawCalls === 1, 'one draw call');
  await setWeather(page, { intensity: 0.2 });
  await frames(page, 2);
  const s2 = await stats(page);
  assert(s2.count > 0 && s2.count < s.count, `intensity scales the count: ${s.count} -> ${s2.count}`);
  await setWeather(page, { intensity: 1 });
  await page.waitForTimeout(1200); // the wet look is swept about every 0.75 s
  await frames(page, 2);
  const rough1 = await groundRoughness(page);
  assert(rough1 < rough0 - 0.3, `rain lowers the ground roughness: ${rough0} -> ${rough1}`);
  const stored = await page.evaluate(() => window.physicslab.store.toDocument().settings.weather?.kind);
  assert(stored === 'rain', 'weather is in the document');
  await shot(page, 'vz23-rain-low');
  await setWeather(page, { kind: 'none' });
  await page.waitForTimeout(1200);
  await frames(page, 2);
  const rough2 = await groundRoughness(page);
  assert(Math.abs(rough2 - rough0) < 1e-6, `the original roughness is restored: ${rough0} -> ${rough2}`);
  assert((await stats(page)).count === 0, 'cleared');
  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
});

test('weather: higher tiers allow more particles; snow, leaves and dust render', async () => {
  const page = await newPage('&scene=pit&quality=high');
  await setWeather(page, { kind: 'snow', intensity: 1, windSpeed: 6, windDir: 270 });
  await frames(page, 6);
  const snow = await stats(page);
  assert(snow.tier === 'high' && snow.count > 1500 && snow.count <= snow.cap, `snow on high: ${JSON.stringify(snow)}`);
  await shot(page, 'vz23-snow-high');
  await setWeather(page, { kind: 'leaves' });
  await frames(page, 6);
  const leaves = await stats(page);
  assert(
    leaves.kind === 'leaves' && leaves.count > 0 && leaves.count <= leaves.cap,
    `leaves: ${JSON.stringify(leaves)}`,
  );
  await shot(page, 'vz23-leaves-high');
  await setWeather(page, { kind: 'dust' });
  await frames(page, 6);
  const dust = await stats(page);
  assert(dust.kind === 'dust' && dust.count > 0, `dust: ${JSON.stringify(dust)}`);
  await shot(page, 'vz23-dust-high');
  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
});

test('weather: lightning flashes the overlay; the scene wind also reaches the effects package', async () => {
  const page = await newPage('&scene=pit&quality=low');
  await setWeather(page, { kind: 'rain', intensity: 0.8, lightning: true, windSpeed: 10, windDir: 90 });
  await frames(page, 3);
  const wind = await page.evaluate(() => [...window.physicslab.fx.env.wind]);
  assert(Math.abs(wind[0] - 10) < 1e-6 && Math.abs(wind[2]) < 1e-6, `effects wind follows the scene wind: ${wind}`);
  await page.evaluate(() => window.physicslab.viewport.weather.triggerLightning());
  await frames(page, 1);
  const flash = await page.evaluate(() => {
    const el = document.querySelector('[data-role="weather-flash"]');
    return { display: el.style.display, opacity: Number(el.style.opacity) };
  });
  assert(
    flash.display === 'block' && flash.opacity > 0 && flash.opacity <= 0.5,
    `overlay flashes, capped: ${JSON.stringify(flash)}`,
  );
  await shot(page, 'vz23-lightning');
  await page.waitForTimeout(1500);
  await frames(page, 2);
  const after = await page.evaluate(() => document.querySelector('[data-role="weather-flash"]').style.display);
  assert(after === 'none', 'the flash fades away');
  assert((await stats(page)).strikes >= 1, 'a strike was counted');
  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
});

test('weather: palette command sets it, the edit is undoable', async () => {
  const page = await newPage('&scene=pit&quality=low');
  await page.keyboard.press('Control+k');
  await page.fill('.palette-input', 'weather snow');
  await page.waitForSelector('.palette .palette-item');
  await page.keyboard.press('Enter');
  await frames(page, 2);
  const kind = await page.evaluate(() => window.physicslab.store.settings.weather?.kind ?? 'none');
  assert(kind === 'snow', `palette command sets snow: ${kind}`);
  assert((await stats(page)).kind === 'snow', 'renderer follows');
  await page.evaluate(() => window.physicslab.store.undo());
  const back = await page.evaluate(() => window.physicslab.store.settings.weather?.kind ?? 'none');
  assert(back === 'none', `undo reverts the weather change: ${back}`);
  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
});
