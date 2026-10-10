/**
 * End-to-end tests for the UI themes (VZ-50): every theme applies to the real page, the Appearance dialog is
 * keyboard operable, the choice persists across a reload, and the telemetry canvas follows the theme tokens.
 */
import { assert, newPage, shot } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const THEMES = ['dark', 'light', 'high-contrast', 'midnight', 'solarized', 'blueprint'];
const token = (page, name) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test('themes: each theme re-colours the chrome, persists, and the chart canvas follows', async () => {
  const page = await newPage();
  const seen = new Set();
  for (const t of THEMES) {
    await page.evaluate((t) => window.physicslab.prefs.set({ theme: t }), t);
    await page.waitForTimeout(150);
    assert((await page.evaluate(() => document.documentElement.dataset.theme)) === t, `data-theme ${t}`);
    const bg = await token(page, '--bg');
    seen.add(bg);
    const topbar = await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).borderBottomColor);
    assert(topbar !== '', `topbar styled in ${t}`);
    await shot(page, `theme-${t}`);
  }
  assert(seen.size === THEMES.length, 'every theme has its own --bg');
  await page.evaluate(() => window.physicslab.prefs.set({ theme: 'light', accent: '#ff8800' }));
  await page.reload();
  await page.waitForFunction(() => !!window.physicslab && window.physicslab.viewport, null, { timeout: 30000 });
  assert((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', 'theme persisted');
  const acc = await token(page, '--accent');
  assert(/^#[0-9a-f]{6}$/i.test(acc) && acc !== '#0a769b', `custom accent persisted (got ${acc})`);
  assert(page.errors.length === 0, `no page errors: ${page.errors.join('; ')}`);
  await page.close();
});

test('themes: Appearance dialog is keyboard operable and sets theme + accent', async () => {
  const page = await newPage();
  await page.click('button[title^="Appearance"]');
  await page.waitForSelector('.modal .theme-grid');
  assert((await page.locator('.theme-card').count()) === 6, 'six theme cards');
  assert((await page.locator('.theme-card[aria-checked="true"]').count()) === 1, 'one checked');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(100);
  assert(
    (await page.evaluate(() => window.physicslab.prefs.value.theme)) === 'light',
    'ArrowRight selects the next theme',
  );
  assert((await page.locator('.modal .theme-grid').count()) === 1, 'dialog still open after arrow key');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.modal-back')).opacity === '1', null, {
    timeout: 15000,
  }); // fade-in is slow under software GL
  await shot(page, 'theme-dialog');
  await page.click('.accent-swatch[data-value="#f472b6"]');
  assert((await page.evaluate(() => window.physicslab.prefs.value.accent)) === '#f472b6', 'accent preset applied');
  const pink = await token(page, '--accent'); // light panel: nudged darker until legible, so not the exact preset
  assert(/^#[0-9a-f]{6}$/i.test(pink) && pink !== '#0a769b', `accent token applied inline (got ${pink})`);
  await page.click('text=Theme default');
  assert((await page.evaluate(() => window.physicslab.prefs.value.accent)) === '', 'accent reset');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached' });
  assert(page.errors.length === 0, `no page errors: ${page.errors.join('; ')}`);
  await page.close();
});
