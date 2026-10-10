/**
 * Chart widgets (UI-30/31/32): the Charts tab of the bottom dock driven through the real UI — add a chart, add traces
 * through the picker and as an expression, live data on the canvas, zoom / pan / hover / markers, dual axes, derived
 * traces, statistics, CSV / PNG export (download hook), spectrum / XY / histogram views, reordering and persistence.
 * Screenshots (E2E_SHOTS=1) go to e2e/out/charts-*.png.
 */
import { assert, newPage, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const STORE = 'physixlab.charts.v1';
const stored = async (page) => {
  await page.waitForTimeout(450); // saves are debounced
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{"charts":[]}'), STORE);
};
/** Number of pixels in the first chart canvas that differ from its background. */
const inkOf = (page, n = 0) =>
  page.evaluate((n) => {
    const c = document.querySelectorAll('.ch-canvas')[n];
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const r = d[0],
      gr = d[1],
      b = d[2];
    let ink = 0;
    for (let i = 0; i < d.length; i += 4)
      if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - gr) + Math.abs(d[i + 2] - b) > 40) ink++;
    return ink;
  }, n);

async function openCharts(page) {
  await page.click('.dock .tab:has-text("Charts")');
  await page.waitForSelector('.ch-panel');
}

async function addEmptyChart(page) {
  await page.click('.ch-addchart');
  await page.click('.menu-item:has-text("Empty chart")');
}

async function addSignal(page, widget, signal) {
  await widget.locator('.ch-add').click();
  await page.waitForSelector('.td-modal');
  await page.click(`.td-sig[data-signal="${signal}"]`);
  await page.click('.td-save');
  await page.waitForSelector('.td-modal', { state: 'detached' });
}

async function startCrate(page) {
  await page.evaluate(() => window.physixlab.newScene());
  await page.keyboard.press('1'); // arms a ghost crate ...
  await page.keyboard.press('Enter'); // ... placed at the view centre (the pointer is off the viewport)
  await page.evaluate(() => {
    const a = window.physixlab;
    a.store.update(a.store.selection[0], { position: [0, 500, 0] }); // a long free fall
  });
  await page.keyboard.press('Space');
}

test('charts: add a chart and traces (picker + expression), live data, hover, zoom, markers, dual axis', async () => {
  const page = await newPage();
  await startCrate(page);
  await openCharts(page);
  assert(
    (await page.locator('.dock .tab').allTextContents()).map((s) => s.trim()).includes('Charts'),
    'Charts tab exists',
  );
  assert(await page.locator('.ch-emptystate').isVisible(), 'empty state with presets before the first chart');

  await addEmptyChart(page);
  const w = page.locator('.ch-widget').first();
  await w.waitFor();
  assert((await page.locator('.ch-widget').count()) === 1, 'one chart added');

  // Trace 1 through the signal picker (search + click), for the selected object
  await w.locator('.ch-add').click();
  await page.waitForSelector('.td-modal');
  await page.fill('.td-modal input[type="search"]', 'speed');
  await page.click('.td-sig[data-signal="speed"]');
  const expr1 = await page.inputValue('.td-expr');
  assert(expr1 === 'speed(selected)', `picker builds the expression (${expr1})`);
  assert(/Valid/.test(await page.textContent('.td-status')), 'live validation says valid');
  await page.click('.td-save');
  // Trace 2: a custom expression typed by hand, with live validation of errors
  await w.locator('.ch-add').click();
  await page.waitForSelector('.td-modal');
  await page.fill('.td-expr', 'speed(nobody) +');
  const bad = await page.textContent('.td-status');
  assert(/ends early|No body|Unexpected/i.test(bad), `an invalid expression is reported (${bad})`);
  await page.fill('.td-expr', 'speed(nobody)');
  assert(/No body called "nobody"/.test(await page.textContent('.td-status')), 'an unknown body is reported');
  await page.fill('.td-expr', '0.5*mass(selected)*speed(selected)^2');
  assert(/Valid/.test(await page.textContent('.td-status')), 'kinetic-energy expression is valid');
  await page.fill('.td-modal input[placeholder="Defaults to the expression"]', 'KE');
  await page.selectOption('.td-modal select >> nth=1', 'R'); // right axis
  await page.click('.td-save');
  await page.waitForSelector('.td-modal', { state: 'detached' });
  assert((await w.locator('.ch-chip').count()) === 2, 'two traces in the legend');

  await simTime(page, 1.2);
  await page.waitForTimeout(300);
  const ink = await inkOf(page);
  assert(ink > 300, `the canvas drew the traces (${ink} px of ink)`);
  const v0 = await w.locator('.ch-val').first().textContent();
  assert(/m\/s/.test(v0) && !/^—/.test(v0), `legend shows a live value with unit (${v0})`);
  const vKE = await w.locator('.ch-val').nth(1).textContent();
  assert(/^\S+\s?$/.test(vKE.trim()) || vKE.length > 0, `second legend value present (${vKE})`);

  // hover cursor changes the picture and the legend reads the value under the cursor
  const box = await page.locator('.ch-canvas').first().boundingBox();
  const before = await inkOf(page);
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForTimeout(150);
  const hovered = await inkOf(page);
  assert(hovered !== before, 'hover cursor + read-out are drawn');
  await shot(page, 'charts-hover');
  await page.mouse.move(box.x - 40, box.y - 40);

  // zoom with the wheel
  const span0 = (await stored(page)).charts[0].span;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(100);
  const span1 = (await stored(page)).charts[0].span;
  assert(span1 < span0 * 0.8, `the wheel zooms the time axis (${span0} -> ${span1})`);
  // drag pans and pauses the follow mode
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4, { steps: 6 });
  await page.mouse.up();
  assert((await stored(page)).charts[0].follow === false, 'dragging pans and pauses following');
  await w.locator('.ch-live').click();
  assert((await stored(page)).charts[0].follow === true, 'the Live button resumes following');

  // click adds a marker, clicking it edits the text
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
  let cfg = (await stored(page)).charts[0];
  assert(
    cfg.markers.length === 1 && /^M1$/.test(cfg.markers[0].text),
    `click adds a marker (${JSON.stringify(cfg.markers)})`,
  );
  await shot(page, 'charts-marker');

  // dual axes: trace 2 is on the right axis, flip trace 1 as well and back
  assert(cfg.traces[1].axis === 'R' && cfg.traces[0].axis === 'L', 'traces are assigned to different y axes');
  await w.locator('.ch-axis').first().click();
  assert((await stored(page)).charts[0].traces[0].axis === 'R', 'the axis button moves a trace to the other axis');
  await w.locator('.ch-axis').first().click();

  // hide / show a trace
  await w.locator('.ch-sw').nth(1).click();
  assert((await stored(page)).charts[0].traces[1].visible === false, 'the swatch hides a trace');
  await w.locator('.ch-sw').nth(1).click();

  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('charts: derived traces, statistics, CSV and PNG export, clear', async () => {
  const page = await newPage();
  await startCrate(page);
  await openCharts(page);
  await addEmptyChart(page);
  const w = page.locator('.ch-widget').first();
  await addSignal(page, w, 'vel_y');
  await w.locator('.ch-chipmore').first().click();
  await page.click('.menu-item:has-text("Derivative")');
  await w.locator('.ch-chip >> nth=1').waitFor();
  await w.locator('.ch-chipmore').first().click();
  await page.click('.menu-item:has-text("Integral")');
  assert((await w.locator('.ch-chip').count()) === 3, 'derivative and integral traces were added');
  await simTime(page, (await page.evaluate(() => window.physixlab.sim.client.stats?.simTime ?? 0)) + 1.5);
  await page.waitForTimeout(300);
  // free fall: d/dt of vy is -g (about -9.81), shown in the legend of the derived trace
  await page.mouse.move(5, 5); // the legend reads the value under the cursor; keep it away from the plot
  await page.waitForTimeout(250);
  const itxt = await w.locator('.ch-val').nth(2).textContent();
  const iv = parseFloat(itxt);
  const tNow = await page.evaluate(() => window.physixlab.sim.client.stats.simTime);
  assert(iv < -2 && iv > -0.5 * 9.81 * tNow * tNow * 1.3, `integral of vy is about -g t²/2 (${itxt}, t=${tNow})`);
  const dtxt = await w.locator('.ch-val').nth(1).textContent();
  const dv = parseFloat(dtxt);
  assert(Math.abs(dv + 9.81) < 1.2, `derivative of the vertical velocity is about -g (${dtxt})`);
  assert(/m\/s\/s|m\/s²|m\/s\//.test(dtxt), `derived unit is shown (${dtxt})`);

  // statistics table
  await w.locator('.ch-sigma').click();
  await page.waitForSelector('.ch-st.head');
  await page.waitForTimeout(400);
  const rows = await w.locator('.ch-st').count();
  assert(rows === 4, `statistics: header + one row per trace (${rows})`);
  const cells = await w.locator('.ch-st').nth(1).locator('span').allTextContents();
  assert(cells.length === 9 && cells.slice(1).every((c) => c !== '—'), `statistics are filled in (${cells.join('|')})`);
  await shot(page, 'charts-stats');
  await w.locator('.ch-sigma').click();

  // CSV
  const dl1 = page.waitForEvent('download');
  await w.locator('button[title^="Export this chart"]').click();
  await page.click('.menu-item:has-text("Export data (CSV)")');
  const download = await dl1;
  assert(download.suggestedFilename().endsWith('.csv'), `csv file name (${download.suggestedFilename()})`);
  const stream = await download.createReadStream();
  let csv = '';
  for await (const chunk of stream) csv += chunk;
  const lines = csv.trim().split('\n');
  assert(lines[0].startsWith('time [s],') && lines[0].split(',').length === 4, `csv header (${lines[0]})`);
  assert(lines.length > 20, `csv has the recorded rows (${lines.length})`);
  const last = lines[lines.length - 1].split(',').map(Number);
  assert(last[0] > 1 && last[1] < -5, `csv rows hold time and falling velocity (${lines[lines.length - 1]})`);
  assert(
    lines.slice(1).every((l, i, a) => i === 0 || Number(l.split(',')[0]) > Number(a[i - 1].split(',')[0])),
    'csv times increase',
  );

  // PNG
  const dl2 = page.waitForEvent('download');
  await w.locator('button[title^="Export this chart"]').click();
  await page.click('.menu-item:has-text("Export image (PNG)")');
  const png = await dl2;
  assert(png.suggestedFilename().endsWith('.png'), 'png file name');
  const buf = [];
  for await (const chunk of await png.createReadStream()) buf.push(chunk);
  const bytes = Buffer.concat(buf);
  assert(
    bytes.length > 3000 && bytes.subarray(1, 4).toString() === 'PNG',
    `png is a real image (${bytes.length} bytes)`,
  );

  // clear
  await w.locator('.ch-more').click();
  await page.click('.menu-item:has-text("Clear recorded data")');
  await page.keyboard.press('Shift+Space');
  await page.waitForTimeout(200);
  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('charts: spectrum, XY and histogram views; reorder; persistence', async () => {
  const page = await newPage();
  await startCrate(page);
  await openCharts(page);
  // a preset with a trace, then every view
  await page.click('.ch-addchart');
  await page.click('.menu-item:has-text("Selected object: speed and height")');
  const w = page.locator('.ch-widget').first();
  await simTime(page, 1.5);
  await page.waitForTimeout(300);
  assert((await inkOf(page)) > 300, 'time view drew');

  await w.locator('.ch-modes .seg-btn[data-value="spectrum"]').click();
  await page.waitForSelector('.ch-sub');
  assert((await w.locator('.ch-sub select').count()) >= 2, 'spectrum has signal + window selectors');
  const opts = await w.locator('.ch-sub select >> nth=1').locator('option').allTextContents();
  assert(opts.join() === 'Rectangular,Hann,Hamming,Blackman', `window choices (${opts})`);
  await page.selectOption('.ch-sub select >> nth=1', 'blackman');
  await page.waitForTimeout(350);
  assert((await inkOf(page)) > 200, 'spectrum drew');
  await shot(page, 'charts-spectrum');
  assert((await stored(page)).charts[0].spectrum.window === 'blackman', 'window choice persisted');

  await w.locator('.ch-modes .seg-btn[data-value="xy"]').click();
  await page.waitForTimeout(350);
  assert((await inkOf(page)) > 200, 'XY view drew');
  await shot(page, 'charts-xy');
  await w.locator('.ch-modes .seg-btn[data-value="hist"]').click();
  await page.waitForTimeout(350);
  assert((await inkOf(page)) > 200, 'histogram view drew');
  await w.locator('.ch-modes .seg-btn[data-value="time"]').click();

  // second chart, reorder with the menu and by dragging the grip, persistence across reload
  await addEmptyChart(page);
  assert((await page.locator('.ch-widget').count()) === 2, 'two charts');
  const ids0 = (await stored(page)).charts.map((c) => c.id);
  await page.locator('.ch-widget').nth(1).locator('.ch-more').click();
  await page.click('.menu-item:has-text("Move earlier")');
  const ids1 = (await stored(page)).charts.map((c) => c.id);
  assert(ids1[0] === ids0[1] && ids1[1] === ids0[0], 'Move earlier reorders the charts');
  const g = await page.locator('.ch-widget').nth(1).locator('.ch-grip').boundingBox();
  const tgt = await page.locator('.ch-widget').nth(0).boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 + 8, g.y + g.height / 2 + 6, { steps: 3 });
  await page.mouse.move(tgt.x + 30, tgt.y + 90, { steps: 10 });
  await page.mouse.move(tgt.x + 32, tgt.y + 92, { steps: 2 });
  await page.mouse.up();
  const ids2 = (await stored(page)).charts.map((c) => c.id);
  assert(
    ids2[0] === ids0[0] && ids2[1] === ids0[1],
    `dragging a chart by its grip reorders (${ids2.join()} vs ${ids0.join()})`,
  );

  // resize with the corner handle
  const wBefore = (await stored(page)).charts[0].w;
  const hb = await page.locator('.ch-widget').first().locator('.ch-resize').boundingBox();
  await page.mouse.move(hb.x + 6, hb.y + 6);
  await page.mouse.down();
  await page.mouse.move(hb.x + 126, hb.y + 6, { steps: 5 });
  await page.mouse.up();
  const wAfter = (await stored(page)).charts[0].w;
  assert(wAfter > wBefore + 80, `resizing changes the width (${wBefore} -> ${wAfter})`);

  await page.reload();
  await page.waitForFunction(() => !!window.physixlab?.viewport);
  await page.click('.dock .tab:has-text("Charts")');
  await page.waitForSelector('.ch-widget');
  assert((await page.locator('.ch-widget').count()) === 2, 'charts persist across a reload');
  assert(
    (await page.locator('.ch-widget').first().locator('.ch-chip').count()) === 2,
    'traces persist across a reload',
  );
  // remove
  await page.locator('.ch-widget').nth(1).locator('.ch-more').click();
  await page.click('.menu-item:has-text("Remove chart")');
  assert((await page.locator('.ch-widget').count()) === 1, 'a chart can be removed');
  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('charts: spectrum of a real spring-mass oscillator peaks at f = sqrt(k/m) / 2pi (in the browser)', async () => {
  const page = await newPage();
  await page.evaluate(async () => {
    const { Builder } = await import('/src/model/builder.ts');
    const b = new Builder('Oscillator');
    const anchor = b.body('Anchor', 'box', [0.4, 0.4, 0.4], [0, 8, 0], { bodyType: 'static' });
    const weight = b.body('Weight', 'sphere', [0.8, 0.8, 0.8], [0, 4.5, 0], { material: 'steel' });
    b.tether('spring', anchor, [0, 8, 0], weight, [0, 4.5, 0], {
      spring: { restLength: 2, stiffness: 40000, damping: 0, breakForce: 0 },
    });
    window.physixlab.loadDocument(b.done());
  });
  await openCharts(page);
  await addEmptyChart(page);
  const w = page.locator('.ch-widget').first();
  await w.locator('.ch-add').click();
  await page.waitForSelector('.td-modal');
  await page.fill('.td-expr', 'pos_y(Weight)');
  await page.click('.td-save');
  await page.waitForSelector('.td-modal', { state: 'detached' });
  await w.locator('.ch-modes .seg-btn[data-value="spectrum"]').click();
  await page.keyboard.press('Space');
  await simTime(page, 14);
  await page.waitForTimeout(500);
  const r = await page.evaluate(async () => {
    const a = window.physixlab;
    const { chartsFor } = await import('/src/ui/charts/panel.ts');
    const widget = chartsFor(a).list()[0];
    const m = a.sim.client.info.mass[a.store.bodies().find((x) => x.name === 'Weight').id];
    const peaks = widget.peaks();
    return { m, peaks: peaks.slice(0, 2), rows: widget.model.data.length };
  });
  const expected = Math.sqrt(40000 / r.m) / (2 * Math.PI);
  assert(r.peaks.length > 0 && expected > 0.5, `the spectrum has a peak (${r.rows} rows, f = ${expected})`);
  assert(
    Math.abs(r.peaks[0].freq - expected) / expected < 0.06,
    `peak ${r.peaks[0].freq.toFixed(3)} Hz vs analytic ${expected.toFixed(3)} Hz (m = ${r.m.toFixed(2)} kg)`,
  );
  await shot(page, 'charts-spectrum-oscillator');
  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('charts: screenshots at 1600x900 and 1280x720', async () => {
  for (const [vw, vh] of [
    [1600, 900],
    [1280, 720],
  ]) {
    const page = await newPage('', { width: vw, height: vh });
    await startCrate(page);
    await openCharts(page);
    await page.click('.ch-presets >> text=Selected object: speed and height');
    await page.click('.ch-addtile');
    await page.click('.menu-item:has-text("Energy of the whole scene")');
    await simTime(page, 2);
    await page.waitForTimeout(400);
    await shot(page, `charts-${vw}x${vh}`);
    assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
    await page.close();
  }
});
