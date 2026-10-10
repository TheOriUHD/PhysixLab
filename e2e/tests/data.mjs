/** Data platform (package DT): share links, storage, exports, embed … */
import { assert, newPage, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('DT-20 compact share link: opens the same scene, is shorter than v1, damaged link explained', async () => {
  const maker = await newPage();
  const made = await maker.evaluate(async () => {
    const a = window.physicslab;
    a.store.setName('Compact one');
    const info = await a.persistence.shareInfo();
    return { hash: new URL(info.url).hash, format: info.format, chars: info.chars, v1: info.v1Chars, n: a.store.size };
  });
  await maker.close();
  assert(made.format === 'v2' && made.hash.startsWith('#s='), `compact format used (${made.format})`);
  assert(made.chars < made.v1 * 0.6, `at least 40 % shorter (${made.chars} vs ${made.v1})`);
  const p = await newPage(made.hash);
  await p.waitForSelector('.toast.success:has-text("Opened shared scene")');
  const open = await p.evaluate(() => ({ name: window.physicslab.store.name, n: window.physicslab.store.size }));
  assert(open.name === 'Compact one' && open.n === made.n, `same scene (${JSON.stringify(open)} vs ${made.n})`);
  await p.close();
  const bad = await newPage(made.hash.slice(0, 30));
  await bad.waitForSelector('.toast.error');
  const err = await bad.locator('.toast.error').first().textContent();
  assert(/share link is damaged/.test(err ?? ''), `damaged link explained: ${err}`);
});

const run = (page, id) =>
  page.evaluate(
    async (id) => (await import('/src/app/registry/index.ts')).runCommand(id, window.physicslab, 'api'),
    id,
  );

test('DT-11 restore points: manual point, automatic "before" point when a scene is replaced, restore through the dialog', async () => {
  const page = await newPage('&scene=newtons-cradle');
  const names = await page.evaluate(async () => {
    const a = window.physicslab;
    a.store.setName('First scene');
    const n0 = a.store.size;
    await import('/src/app/registry/index.ts').then((m) => m.runCommand('file.restorePoint.create', a, 'api'));
    await new Promise((r) => setTimeout(r, 500));
    a.loadTemplate('car'); // replaces the scene -> "Before opening …" point
    await new Promise((r) => setTimeout(r, 500));
    const dp = await import('/src/app/data/platform.ts');
    const list = await dp.dataPlatform().restore.list();
    return { n0, labels: list.map((p) => `${p.kind}:${p.label}`), now: a.store.name };
  });
  assert(
    names.labels.some((l) => l.startsWith('manual:')),
    `manual point exists: ${names.labels}`,
  );
  assert(
    names.labels.some((l) => l.startsWith('before:Before opening')),
    `before-point exists: ${names.labels}`,
  );
  // restore the manual point through the dialog
  await run(page, 'file.restorePoints');
  await page.waitForSelector('.rp-card');
  const cards = await page.locator('.rp-card').count();
  assert(cards >= 2, `dialog lists the points (${cards})`);
  assert(/vs\. now:/.test((await page.locator('.rp-diff').first().textContent()) ?? ''), 'diff summary shown');
  const manual = page.locator('.rp-card', { hasText: 'Manual' }).first();
  await manual.locator('button:has-text("Restore")').click();
  await page.locator('.modal-foot button.primary, .modal-foot .btn:has-text("Restore")').last().click();
  await page.waitForFunction(() => window.physicslab.store.name === 'First scene', null, { timeout: 8000 });
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('DT-12 crash recovery: an unclean previous session shows the banner and keeps the autosave; a dead physics worker is restarted', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(async () => {
    window.physicslab.store.setName('Crash me');
    window.physicslab.persistence.saveNow();
    await window.physicslab.persistence.flush();
    sessionStorage.__fakeCrash = '1';
  });
  await page.addInitScript(() => {
    if (sessionStorage.__fakeCrash) {
      delete sessionStorage.__fakeCrash;
      localStorage.setItem(
        'physicslab:session:v1',
        JSON.stringify({ id: 'dead', clean: false, at: Date.now() - 120000, since: Date.now() - 200000 }),
      );
    }
  });
  await page.reload();
  await page.waitForFunction(() => !!window.physicslab && window.physicslab.viewport, null, { timeout: 30000 });
  await page.waitForSelector('.data-banner[data-key="crash-recovery"]');
  const text = (await page.locator('.data-banner[data-key="crash-recovery"]').textContent()) ?? '';
  assert(/did not close properly/.test(text) && /autosave was restored/.test(text), `banner text: ${text}`);
  assert((await page.evaluate(() => window.physicslab.store.name)) === 'Crash me', 'the autosaved scene is back');
  // worker crash: emit the client's crash event; the page restarts the worker and the sim works again
  await page.evaluate(() => {
    window.physicslab.sim.play();
    window.physicslab.sim.client.emit('crash', 'test crash');
  });
  await page.waitForSelector('.data-banner[data-key="worker-crash"]');
  assert(
    (await page.evaluate(() => window.physicslab.sim.mode)) === 'edit',
    'back to the authored layout after the crash',
  );
  await page.evaluate(() => window.physicslab.sim.play());
  await simTime(page, 0.5);
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('DT-10 storage dialog shows usage per collection and the quota meter; DT-13 folder sync dialog offers a folder choice', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(async () => {
    window.physicslab.persistence.saveToLibrary();
    await window.physicslab.persistence.flush();
  });
  await run(page, 'file.storage');
  await page.waitForSelector('.storage-row');
  const text = (await page.locator('.storage-body').textContent()) ?? '';
  assert(/Saved scenes/.test(text) && /Restore points/.test(text), `collections listed: ${text.slice(0, 200)}`);
  assert((await page.locator('.quota-bar').count()) === 1, 'quota meter present');
  await page.keyboard.press('Escape');
  await run(page, 'file.folderSync');
  await page.waitForSelector('.folder-body');
  const f = (await page.locator('.folder-body').textContent()) ?? '';
  assert(/Choose folder/.test(f) || /File System Access/.test(f), `folder sync dialog: ${f.slice(0, 160)}`);
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});
