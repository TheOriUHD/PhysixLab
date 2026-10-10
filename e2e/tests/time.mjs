/**
 * Package TM: the Timeline / Replay / Ghosts tabs, scrubbing, rewind, stepping back, bookmarks, replay record →
 * file → viewer with verification, ghosts of the previous run, the determinism check and the scene seed.
 */
import { readFileSync } from 'node:fs';
import { assert, newPage, shot, sleep } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** No console errors — apart from other packages' extensions failing to register (not this package's business). */
const assertClean = (page) => {
  const own = page.errors.filter((e) => !/\[extension \.\.\/extensions\/(?!timeTravel)/.test(e));
  assert(own.length === 0, `no console errors: ${own.join(' | ')}`);
};

const showTab = async (page, id) => {
  await page.evaluate((tab) => window.physixlab.prefs.set({ bottomTab: tab, showBottom: true }), id);
  await page.waitForSelector('.dock:not(.collapsed)');
};
const tt = (page, fn, ...args) =>
  page.evaluate(`(${fn})(window.physixlab.timeTravel, window.physixlab, ...${JSON.stringify(args)})`);
const step = (page) => page.evaluate(() => window.physixlab.sim.client.stats?.stepCount ?? 0);
const hashPoses = (page) =>
  page.evaluate(() => {
    const a = window.physixlab;
    return a.store
      .bodies()
      .filter((b) => b.bodyType === 'dynamic')
      .map((b) => (a.sim.poseOf(b.id)?.position ?? []).map((v) => v.toFixed(5)).join(','))
      .join('|');
  });

test('time: timeline tab shows the run, scrub back restores the exact earlier state', async () => {
  const page = await newPage();
  await showTab(page, 'timeline');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (window.physixlab.sim.client.stats?.stepCount ?? 0) > 150, null, {
    timeout: 15000,
  });
  await page.keyboard.press('Space'); // pause
  await sleep(300);
  const s1 = await step(page);
  const p1 = await hashPoses(page);
  // run on a little, then scrub back to s1 by seeking
  await page.keyboard.press('Space');
  await page.waitForFunction((s) => (window.physixlab.sim.client.stats?.stepCount ?? 0) > s + 120, s1, {
    timeout: 15000,
  });
  await page.keyboard.press('Space');
  await sleep(300);
  const head = await tt(page, (t) => t.head);
  assert(head > s1 + 100, `head advanced (${head} vs ${s1})`);
  // real pointer drag on the scrubber to the middle
  const box = await page.locator('.tm-canvas').boundingBox();
  await shot(page, 'tm-timeline-run');
  await tt(page, (t, a, s) => t.seek(s), s1);
  await page.waitForFunction((s) => (window.physixlab.sim.client.stats?.stepCount ?? 0) === s, s1, { timeout: 8000 });
  const p2 = await hashPoses(page);
  assert(p1 === p2, `scrubbing to step ${s1} restores the state\n${p1}\n${p2}`);
  // the drag itself
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.55, { steps: 4 });
  await page.mouse.up();
  await sleep(500);
  const dragged = await step(page);
  assert(dragged < head - 20, `dragging the scrubber moved the run back (${dragged} < ${head})`);
  const badge = await page.locator('.tm-badge.past').count();
  assert(badge === 1, 'the "past" badge shows');
  await shot(page, 'tm-timeline-scrubbed');
  assertClean(page);
});

test('time: hold Backspace to rewind, release resumes from the past (new branch); step back / forward by one frame', async () => {
  const page = await newPage();
  await showTab(page, 'timeline');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (window.physixlab.sim.client.stats?.stepCount ?? 0) > 200, null, {
    timeout: 15000,
  });
  const before = await step(page);
  await page.keyboard.down('Backspace');
  // software-GL frames are slow here (≈10 fps), so rewinding takes a few seconds to cover a second of simulation
  await page.waitForFunction((b) => (window.physixlab.sim.client.stats?.stepCount ?? 0) < b - 20, before, {
    timeout: 20000,
  });
  const during = await step(page);
  assert(during < before - 10, `rewinding moved back (${during} < ${before})`);
  await page.keyboard.up('Backspace');
  await sleep(500);
  const after = await step(page);
  assert(after > during - 5, `releasing continues the run (${after} vs ${during})`);
  const head = await tt(page, (t) => t.status?.head ?? 0);
  assert(head < before + 80, `the old future was discarded (head ${head}, was ${before})`);
  await page.keyboard.press('Space'); // pause
  await sleep(200);
  const s0 = await step(page);
  await page.keyboard.press('Comma');
  await page.waitForFunction((s) => (window.physixlab.sim.client.stats?.stepCount ?? 0) === s - 1, s0, {
    timeout: 5000,
  });
  await page.keyboard.press('Period');
  await page.waitForFunction((s) => (window.physixlab.sim.client.stats?.stepCount ?? 0) === s, s0, { timeout: 5000 });
  // bookmark
  await page.keyboard.press('Control+Shift+b');
  const n = await tt(page, (t) => t.bookmarks.length);
  assert(n === 1, 'bookmark added');
  await shot(page, 'tm-rewound');
  assertClean(page);
});

test('time: record a replay, save it, open it in the viewer and watch it verify', async () => {
  const page = await newPage();
  await showTab(page, 'replay');
  await page.click('.tm-actions button:has-text("Record")');
  await page.waitForFunction(() => window.physixlab.timeTravel.recording, null, { timeout: 10000 });
  // recording starts the simulation when it is not running yet
  await page.waitForFunction(() => window.physixlab.sim.mode === 'running', null, { timeout: 5000 });
  await page.waitForFunction(() => (window.physixlab.sim.client.stats?.stepCount ?? 0) > 200, null, {
    timeout: 60000,
  });
  await page.keyboard.press('Space');
  const dl = page.waitForEvent('download');
  await page.click('.tm-actions button:has-text("Save replay")');
  const download = await (await dl).path();
  const bytes = readFileSync(download);
  assert(bytes.length > 100, `replay file written (${bytes.length} bytes)`);
  await page.close(); // two software-GL pages at once are too slow
  // open it again in a fresh page
  const viewer = await newPage();
  await showTab(viewer, 'replay');
  await viewer.setInputFiles('.tm-replay input[type=file]', {
    name: 'run.plreplay',
    mimeType: 'application/octet-stream',
    buffer: bytes,
  });
  await viewer.waitForFunction(() => window.physixlab.timeTravel.replaying, null, { timeout: 60000 });
  await viewer.keyboard.press('Space');
  await viewer.waitForFunction(() => document.querySelector('.tm-verify.ok'), null, { timeout: 90000 });
  const text = await viewer.locator('.tm-verify').innerText();
  assert(/Verified/.test(text), `verification shown: ${text}`);
  await shot(viewer, 'tm-replay-viewer');
  assertClean(viewer);
});

test('time: the previous run shows up as a ghost, the determinism check passes, the seed reseeds', async () => {
  const page = await newPage();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (window.physixlab.sim.client.stats?.stepCount ?? 0) > 150, null, {
    timeout: 15000,
  });
  await page.keyboard.press('Space');
  await page.evaluate(() => window.physixlab.sim.reset());
  await sleep(300);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.physixlab.timeTravel.ghosts.runs.length > 0, null, { timeout: 15000 });
  await page.waitForFunction(() => window.physixlab.viewport.scene.getObjectByName('ghosts')?.visible === true, null, {
    timeout: 8000,
  });
  await showTab(page, 'ghosts');
  assert((await page.locator('.tm-run').count()) >= 1, 'run listed');
  await shot(page, 'tm-ghost');
  await showTab(page, 'replay');
  await page.click('.tm-actions button:has-text("Check determinism")');
  await page.waitForFunction(() => document.querySelector('.tm-det.ok'), null, { timeout: 30000 });
  const det = await page.locator('.tm-det').innerText();
  assert(/Deterministic/.test(det), `determinism shown: ${det}`);
  // seed
  await page.evaluate(() => window.physixlab.prefs.set({ rightTab: 'world', showRight: true }));
  const before = await page.evaluate(() => window.physixlab.store.settings.seed);
  await page.click('button:has-text("Reseed")');
  const after = await page.evaluate(() => window.physixlab.store.settings.seed);
  assert(before !== after, `reseed changed the seed (${before} → ${after})`);
  assertClean(page);
});

test('time: bookmarks (add, rename, jump), a loop region replays the recorded past without branching, auto slow-mo after a hard impact', async () => {
  const page = await newPage();
  await showTab(page, 'timeline');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (window.physixlab.sim.client.stats?.stepCount ?? 0) > 260, null, {
    timeout: 90000,
  });
  await page.keyboard.press('Space'); // pause
  await sleep(300);
  // bookmarks
  await tt(page, (t) => {
    t.addBookmark(undefined, 60);
    t.addBookmark('late', 200);
  });
  await page.waitForFunction(() => document.querySelectorAll('.tm-bm').length === 2, null, { timeout: 15000 });
  await tt(page, (t) => t.renameBookmark(t.bookmarks[0].id, 'first drop'));
  await page.waitForSelector('.tm-bm:has-text("first drop")');
  // (a hint bubble floats over the dock, so click through the DOM)
  await page.evaluate(() =>
    [...document.querySelectorAll('.tm-bm')].find((e) => /first drop/.test(e.textContent)).click(),
  );
  await page.waitForFunction(() => (window.physixlab.sim.client.stats?.stepCount ?? 0) === 60, null, {
    timeout: 15000,
  });
  // loop 40..100 over the recorded run
  const head0 = await tt(page, (t) => t.head);
  await tt(page, (t) => {
    t.setLoopPoint('a', 40);
    t.setLoopPoint('b', 100);
    t.toggleLoop();
  });
  await page.keyboard.press('Space'); // play: the loop keeps the run inside the region
  const seen = [];
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    seen.push(await step(page));
  }
  const wraps = seen.filter((s, i) => i > 0 && s < seen[i - 1]).length;
  assert(wraps >= 1, `the loop wrapped at least once: ${seen.join(',')}`);
  assert(Math.max(...seen) <= 100 + 70 && Math.min(...seen) >= 40 - 2, `stayed in the region: ${seen.join(',')}`);
  const head1 = await tt(page, (t) => t.status.head);
  assert(head1 >= head0 - 1, `looping did not discard the recorded run (head ${head1}, was ${head0})`);
  await shot(page, 'tm-loop');
  // leave the loop, then auto slow-mo
  await tt(page, (t) => t.clearLoop());
  const slow = await page.evaluate(() => {
    const a = window.physixlab;
    a.timeTravel.setOptions({ autoSlowmo: true });
    a.sim.client.emit('event', {
      kind: 'contact',
      t: 1,
      a: 'x',
      b: '$ground',
      point: [0, 0, 0],
      normal: [0, 1, 0],
      impulse: 50,
      speed: 5,
      matA: 'steel',
      matB: 'ground',
      count: 1,
    });
    return a.sim.timeScale;
  });
  assert(slow <= 0.25, `time scale dropped after the impact (${slow})`);
  await page.waitForFunction(() => window.physixlab.sim.timeScale === window.physixlab.prefs.value.timeScale, null, {
    timeout: 15000,
  });
  assertClean(page);
});

test('time: two runs compared: the distance chart appears', async () => {
  const page = await newPage();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => (window.physixlab.sim.client.stats?.stepCount ?? 0) > 150, null, {
    timeout: 90000,
  });
  await page.keyboard.press('Space');
  await page.evaluate(() => window.physixlab.sim.reset());
  await sleep(300);
  await page.evaluate(() => window.physixlab.prefs.set({ bottomTab: 'ghosts', showBottom: true }));
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.physixlab.timeTravel.ghosts.runs.length > 0, null, { timeout: 30000 });
  // nudge the second run so it differs: shoot a body with an impulse through the op channel
  await page.waitForFunction(() => (window.physixlab.sim.client.stats?.stepCount ?? 0) > 120, null, {
    timeout: 90000,
  });
  await page.evaluate(() => {
    const a = window.physixlab;
    const mass = a.sim.client.info.mass;
    const b = a.store
      .bodies()
      .filter((x) => x.bodyType === 'dynamic' && mass[x.id] > 0)
      .sort((p, q) => mass[p.id] - mass[q.id])[0];
    a.sim.client.op({ op: 'impulse', id: b.id, impulse: [0, 40, 30], point: b.position });
  });
  await page.waitForFunction(() => (window.physixlab.sim.client.stats?.stepCount ?? 0) > 300, null, {
    timeout: 90000,
  });
  await page.evaluate(() => window.physixlab.timeTravel.ghosts.compareWithLive());
  await page.waitForFunction(() => window.physixlab.timeTravel.ghosts.comparison !== null, null, { timeout: 15000 });
  const peak = await page.evaluate(() => window.physixlab.timeTravel.ghosts.comparison.peak.distance);
  assert(peak > 0.001, `the two runs drifted apart (${peak} m)`);
  await sleep(500);
  await shot(page, 'tm-compare');
  const summary = await page.locator('.tm-ghosts .tm-status').innerText();
  assert(/largest gap/.test(summary), `chart summary shown: ${summary}`);
  assertClean(page);
});
