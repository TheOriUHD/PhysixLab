/**
 * Diagnostics panel, profiler and error boundary (package UI-B: UI-43), driven through the real UI.
 * Screenshots (E2E_SHOTS=1) go to e2e/out/diag-*.png.
 */
import { assert, currentBrowser, newPage, shot, sleep } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const noErrors = (page) =>
  assert(
    page.errors.filter((e) => !/boom|loop \d|again|rejected in test|^pageerror: x$/.test(e)).length === 0,
    `no console errors: ${page.errors.join(' | ')}`,
  );
const SIZES = [
  ['1600', { width: 1600, height: 900 }],
  ['1280', { width: 1280, height: 720 }],
];
const command = (page, id) =>
  page.evaluate(async (id) => {
    const { runCommand } = await import('/src/app/registry/commands.ts');
    runCommand(id, window.physixlab);
  }, id);

// -- diagnostics + profiler -------------------------------------------------------------------------------------------
test('diag: the Diagnostics panel shows device, GPU, limits and worker status; the Profiler graph fills while simulating', async () => {
  for (const [tag, vp] of SIZES) {
    const page = await newPage('', vp);
    await command(page, 'panel.diagnostics');
    await page.waitForSelector('.diag-panel .diag-sec');
    const text = (await page.locator('.diag-panel').innerText()).toLowerCase();
    for (const want of [
      'Browser',
      'Graphics',
      'Max texture size',
      'Physics worker',
      'Protocol',
      'Capabilities',
      'WebGL 2',
    ])
      assert(text.includes(want.toLowerCase()), `diagnostics mention "${want}"`);
    assert(/v2 \(page expects v2\)/.test(text), 'worker protocol version shown');
    await sleep(600);
    await shot(page, `diag-diagnostics-${tag}`);
    // profiler
    await command(page, 'panel.profiler');
    await page.evaluate(() => window.physixlab.sim.play());
    await page.waitForSelector('.prof-graph');
    await page.waitForFunction(() => (window.physixlab.sim.client.stats?.simTime ?? 0) > 1, null, { timeout: 60000 });
    await page.waitForFunction(
      () => {
        const c = document.querySelector('.prof-graph');
        if (!c || !c.width) return false;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n > 200;
      },
      null,
      { timeout: 30000 },
    );
    const table = await page.locator('.prof-panel').innerText();
    for (const want of ['Physics', 'Scene', 'UI', 'Render', 'Frame interval', 'Step', 'Round trip'])
      assert(table.includes(want), `profiler lists "${want}"`);
    const renderAvg = await page.evaluate(
      () => document.querySelector('.prof-table tbody tr:nth-child(4) td:nth-child(2)').textContent,
    );
    assert(Number(renderAvg) > 0, `render time measured (${renderAvg})`);
    const step = await page.evaluate(
      () => document.querySelectorAll('.prof-table')[1].querySelector('tbody td:nth-child(2)').textContent,
    );
    assert(step !== '—', `worker step time shown while simulating (${step})`);
    await shot(page, `diag-profiler-${tag}`);
    // hidden panels cost nothing: switching to another tab stops drawing
    await command(page, 'panel.energy');
    await sleep(300);
    const laidOut = await page.evaluate(() => document.querySelector('.prof-graph')?.getClientRects().length ?? 0);
    assert(laidOut === 0, 'profiler graph is not laid out (not drawn) when its tab is hidden');
    noErrors(page);
    await page.close();
  }
});

// -- error boundary ---------------------------------------------------------------------------------------------------
test('diag: an uncaught error shows the recovery card; a loop shows one card; recovery never drops the scene silently', async () => {
  for (const [tag, vp] of SIZES) {
    const page = await newPage('', vp);
    const count = await page.evaluate(() => window.physixlab.store.all().length);
    await page.evaluate(() => {
      window.dispatchEvent(new ErrorEvent('error', { message: 'boom from test', error: new Error('boom from test') }));
    });
    await page.waitForSelector('.err-card');
    const card = await page.locator('.err-card').innerText();
    for (const want of [
      'Something went wrong',
      'boom from test',
      'Copy diagnostics',
      'Reload',
      'Download scene',
      'Restore last autosave',
      'Reset layout and preferences',
      'Start empty',
      'Keep working',
    ])
      assert(card.includes(want), `card offers "${want}"`);
    await sleep(800);
    await shot(page, `diag-error-${tag}`);
    // an error loop: 100 more events, still one card, counted
    await page.evaluate(() => {
      for (let i = 0; i < 100; i++)
        window.dispatchEvent(new ErrorEvent('error', { message: 'loop', error: new Error('loop') }));
    });
    assert((await page.locator('.err-card').count()) === 1, 'one card during an error loop');
    const more = await page.locator('.err-more').innerText();
    assert(/100 more errors/.test(more) && /repeating/.test(more), `counter: ${more}`);
    // the report text
    const json = await page.evaluate(async () => {
      const { collectReport } = await import('/src/ui/diag/collect.ts');
      const { errorLog } = await import('/src/ui/diag/boot.ts');
      const { formatReport } = await import('/src/ui/diag/report.ts');
      return formatReport(collectReport(window.physixlab, errorLog));
    });
    const j = JSON.parse(json);
    assert(
      j.app.version && j.browser.userAgent && j.gpu?.renderer && j.gpu.limits['Max texture size'] > 0,
      'report has version, UA, GPU, limits',
    );
    assert(j.worker.expectedProtocol === 2 && j.scene.entities === count, 'report has worker and scene summary');
    assert(
      j.recentErrors.some((e) => e.message === 'boom from test'),
      'report lists the recent error',
    );
    // two-step confirmation on the destructive options
    const start = page.locator('.err-card button', { hasText: 'Start empty' });
    await start.click();
    assert(
      (await page.evaluate(() => window.physixlab.store.all().length)) === count,
      'first click does not replace the scene',
    );
    assert((await page.locator('.err-card button', { hasText: 'Click again' }).count()) === 1, 'asks to click again');
    // keep working closes the card
    await page.locator('.err-card button', { hasText: 'Keep working' }).click();
    await page.waitForSelector('.err-card', { state: 'detached' });
    // a new error within the cooldown is only a toast, not another card
    await page.evaluate(() =>
      window.dispatchEvent(new ErrorEvent('error', { message: 'again', error: new Error('again') })),
    );
    await sleep(200);
    assert((await page.locator('.err-card').count()) === 0, 'no second card right after dismissing');
    assert(
      await page.evaluate(async () =>
        (await import('/src/ui/diag/boot.ts')).errorLog.recent().some((e) => e.message === 'again'),
      ),
      'logged',
    );
    await page.close();
  }
});

test('diag: restore autosave and start empty replace the scene only after confirmation; download offers the scene', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physixlab.persistence.saveNow());
  await page.evaluate(() => window.physixlab.persistence.flush());
  const before = await page.evaluate(() => window.physixlab.store.all().length);
  assert(before > 0, 'a scene is loaded');
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'x', error: new Error('x') })));
  await page.waitForSelector('.err-card');
  const dl = page.waitForEvent('download');
  await page.locator('.err-card button', { hasText: 'Download scene' }).click();
  const file = await dl;
  assert(/\.json$/.test(file.suggestedFilename()), `downloads a json file (${file.suggestedFilename()})`);
  await page.evaluate(() => {
    const a = window.physixlab;
    a.store.remove([a.store.bodies()[0].id]);
  });
  const reduced = await page.evaluate(() => window.physixlab.store.all().length);
  assert(reduced < before, 'something was removed');
  const restore = page.locator('.err-card button', { hasText: 'Restore last autosave' });
  await restore.click();
  assert((await page.evaluate(() => window.physixlab.store.all().length)) === reduced, 'first click changes nothing');
  await page.locator('.err-card button', { hasText: 'Click again' }).click();
  await page.waitForSelector('.err-card', { state: 'detached' });
  assert(
    (await page.evaluate(() => window.physixlab.store.all().length)) === before,
    'autosave restored after the second click',
  );
  noErrors(page);
  await page.close();
});

test('diag: a browser without WebGL 2 gets a plain-language screen instead of a stack trace', async () => {
  const probe = await newPage();
  const base = probe.url().split('?')[0];
  await probe.close();
  const page = await currentBrowser().newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (type === 'webgl2') return null;
      return orig.call(this, type, ...rest);
    };
  });
  await page.goto(`${base}?nowelcome`);
  await page.waitForSelector('.err-screen.boot .err-card');
  const text = await page.locator('.err-card').innerText();
  assert(/couldn.t start/i.test(text), 'title');
  assert(/WebGL 2/.test(text) && /hardware acceleration/i.test(text), 'guidance names WebGL 2 and what to try');
  assert(/None of these buttons deletes a scene/.test(text), 'reassures about scenes');
  assert(!/\bat \w+.*\.ts:\d+/.test(text), 'no stack trace');
  assert((await page.locator('.err-card button', { hasText: 'Copy diagnostics' }).count()) === 1, 'copy diagnostics');
  await sleep(300);
  await shot(page, 'diag-boot-nowebgl');
  await page.close();
});
