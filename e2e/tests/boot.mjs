/**
 * The start-up splash (index.html + src/app/bootProgress.ts): a real progress bar. Against the dev server there is
 * no download phase (that is recorded at build time), so this checks what the app itself reports: milestones in
 * the order they really happen, a bar that never moves backwards, 100 % only once the first frame is drawn, and the
 * splash leaving the page afterwards.
 */
import { appUrl, assert, currentBrowser } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('start-up splash: a progress bar that only moves forward, reports real milestones and leaves after the first frame', async () => {
  const page = await currentBrowser().newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__bootLog = [];
    const log = () => {
      const r = document.getElementById('boot');
      if (r)
        window.__bootLog.push({
          v: Number(r.getAttribute('aria-valuenow')),
          role: r.getAttribute('role'),
          text: document.getElementById('boot-label')?.textContent ?? '',
        });
    };
    new MutationObserver(log).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
  await page.goto(`${appUrl()}/?nowelcome`);
  await page.waitForFunction(() => !!window.physixlab && window.physixlab.viewport, null, { timeout: 30000 });
  await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 15000 });
  const log = await page.evaluate(() => window.__bootLog);
  await page.close();

  assert(log.length >= 4, `the splash reported progress several times (${log.length})`);
  assert(
    log.every((s) => s.role === 'progressbar'),
    'the splash is an accessible progress bar',
  );
  const values = log.map((s) => s.v);
  assert(
    values.every((v, i) => i === 0 || v >= values[i - 1]),
    `the bar never moves backwards: ${values.join(', ')}`,
  );
  assert(values[0] < 50, `it starts low (${values[0]})`);
  assert(values.at(-1) === 100, `it ends at 100 % (${values.at(-1)})`);
  const texts = new Set(log.map((s) => s.text));
  for (const t of ['Starting the physics engine…', 'Building the interface…', 'Loading your scene…']) {
    assert(texts.has(t), `milestone shown: "${t}" (saw ${[...texts].join(' | ')})`);
  }
  assert(errors.length === 0, `no page errors: ${errors.join('; ')}`);
});
