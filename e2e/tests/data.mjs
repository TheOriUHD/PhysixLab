/** Data platform (package DT): share links, storage, exports, embed … */
import { assert, newPage, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('DT-20 compact share link: opens the same scene, is shorter than v1, damaged link explained', async () => {
  const maker = await newPage();
  const made = await maker.evaluate(async () => {
    const a = window.physixlab;
    a.store.setName('Compact one');
    const info = await a.persistence.shareInfo();
    return { hash: new URL(info.url).hash, format: info.format, chars: info.chars, v1: info.v1Chars, n: a.store.size };
  });
  await maker.close();
  assert(made.format === 'v2' && made.hash.startsWith('#s='), `compact format used (${made.format})`);
  assert(made.chars < made.v1 * 0.6, `at least 40 % shorter (${made.chars} vs ${made.v1})`);
  const p = await newPage(made.hash);
  // state, not toast timing: a slow machine can finish booting after the toast has gone
  await p.waitForFunction(() => window.physixlab.store.name === 'Compact one', null, { timeout: 30000 });
  const open = await p.evaluate(() => ({ name: window.physixlab.store.name, n: window.physixlab.store.size }));
  assert(open.name === 'Compact one' && open.n === made.n, `same scene (${JSON.stringify(open)} vs ${made.n})`);
  const err = await p.evaluate(async (hash) => {
    try {
      await (await import('/src/app/share/link.ts')).parseShareHash(hash.slice(0, 30));
      return 'no error';
    } catch (e) {
      return e.message;
    }
  }, made.hash);
  assert(/share link is damaged/.test(err), `damaged link explained: ${err}`);
});

const run = (page, id) =>
  page.evaluate(
    async (id) => (await import('/src/app/registry/index.ts')).runCommand(id, window.physixlab, 'api'),
    id,
  );

test('DT-11 restore points: manual point, automatic "before" point when a scene is replaced, restore through the dialog', async () => {
  const page = await newPage('&scene=newtons-cradle');
  const names = await page.evaluate(async () => {
    const a = window.physixlab;
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
  await manual.locator('button:has-text("Restore")').evaluate((b) => b.click());
  await page.waitForSelector('.modal-foot button.primary');
  await page
    .locator('.modal-foot button.primary')
    .last()
    .evaluate((b) => b.click());
  await page.waitForFunction(() => window.physixlab.store.name === 'First scene', null, { timeout: 30000 });
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('DT-12 crash recovery: an unclean previous session shows the banner and keeps the autosave; a dead physics worker is restarted', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(async () => {
    window.physixlab.store.setName('Crash me');
    window.physixlab.persistence.saveNow();
    await window.physixlab.persistence.flush();
    sessionStorage.__fakeCrash = '1';
  });
  await page.addInitScript(() => {
    if (sessionStorage.__fakeCrash) {
      delete sessionStorage.__fakeCrash;
      localStorage.setItem(
        'physixlab:session:v1',
        JSON.stringify({ id: 'dead', clean: false, at: Date.now() - 120000, since: Date.now() - 200000 }),
      );
    }
  });
  await page.goto(page.url().replace(/&scene=[^&#]*/, ''));
  await page.waitForFunction(() => !!window.physixlab && window.physixlab.viewport, null, { timeout: 30000 });
  await page.waitForSelector('.data-banner[data-key="crash-recovery"]');
  const text = (await page.locator('.data-banner[data-key="crash-recovery"]').textContent()) ?? '';
  assert(/did not close properly/.test(text) && /autosave was restored/.test(text), `banner text: ${text}`);
  assert((await page.evaluate(() => window.physixlab.store.name)) === 'Crash me', 'the autosaved scene is back');
  // worker crash: emit the client's crash event; the page restarts the worker and the sim works again
  await page.evaluate(() => {
    window.physixlab.sim.play();
    window.physixlab.sim.client.emit('crash', 'test crash');
  });
  await page.waitForSelector('.data-banner[data-key="worker-crash"]');
  assert(
    (await page.evaluate(() => window.physixlab.sim.mode)) === 'edit',
    'back to the authored layout after the crash',
  );
  await page.evaluate(() => window.physixlab.sim.play());
  await simTime(page, 0.5);
  const unexpected = page.errors.filter((e) => !e.includes('physics worker crashed'));
  assert(unexpected.length === 0, `no errors: ${unexpected.join(' | ')}`);
});

test('DT-10 storage dialog shows usage per collection and the quota meter; DT-13 folder sync dialog offers a folder choice', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(async () => {
    window.physixlab.persistence.saveToLibrary();
    await window.physixlab.persistence.flush();
  });
  await run(page, 'file.storage');
  await page.waitForSelector('.storage-row', { timeout: 120000 });
  const text = (await page.locator('.storage-body').textContent()) ?? '';
  assert(/Saved scenes/.test(text) && /Restore points/.test(text), `collections listed: ${text.slice(0, 200)}`);
  assert((await page.locator('.quota-bar').count()) === 1, 'quota meter present');
  await page.keyboard.press('Escape');
  await run(page, 'file.folderSync');
  await page.waitForSelector('.folder-body', { timeout: 120000 });
  const f = (await page.locator('.folder-body').textContent()) ?? '';
  assert(/Choose folder/.test(f) || /File System Access/.test(f), `folder sync dialog: ${f.slice(0, 160)}`);
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('DT-3 data export: telemetry CSV/JSON through the export menu and a standalone HTML lab report', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(() => {
    window.__e2eDownloads = true;
    window.physixlab.sim.play();
  });
  await simTime(page, 1.5);
  const out = await page.evaluate(async () => {
    const a = window.physixlab;
    const dx = await import('/src/app/export/dataExport.ts');
    const src = dx.listDataSources().find((s) => s.id === 'telemetry.energy');
    const table = src.table(a);
    await dx.exportTable(table, 'csv');
    const csv = window.__lastDownload;
    await dx.exportTable(table, 'json');
    const json = window.__lastDownload;
    const { buildReport } = await import('/src/app/export/reportData.ts');
    const html = await buildReport(a);
    return { csv, json, rows: table.rows.length, html };
  });
  assert(out.rows > 5, `telemetry recorded rows (${out.rows})`);
  assert(
    out.csv.name.endsWith('.csv') && /^Time \(s\),/.test(out.csv.text),
    `CSV header: ${out.csv.text.slice(0, 60)}`,
  );
  assert(out.csv.text.trim().split('\r\n').length === out.rows + 1, 'CSV has one line per row plus the header');
  assert(JSON.parse(out.json.text).rows.length === out.rows, 'JSON rows match');
  assert(
    /<h2>Energy<\/h2>/.test(out.html) && /<svg/.test(out.html),
    `report sections: ${(out.html.match(/<h2>[^<]*/g) ?? []).join('|')}; ${(out.html.match(/<title>[^<]*/) ?? [''])[0]}`,
  );
  assert(!/<script/i.test(out.html), 'report has no scripts');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});
