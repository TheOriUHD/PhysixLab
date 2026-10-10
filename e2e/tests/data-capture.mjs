/** Data platform DT-2: video / GIF / deterministic / turntable capture of the viewport. */
import { assert, newPage } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const VIEW = { width: 760, height: 480 };

/** Run a command by id through the real registry. */
const run = (page, id) =>
  page.evaluate(async (cid) => {
    const m = await import('/src/app/registry/index.ts');
    return m.runCommand(cid, window.physixlab, 'api');
  }, id);

/** Set a dialog control (select / input / checkbox) the way a user would. */
async function setField(page, cap, value) {
  const el = page.locator(`[data-cap="${cap}"]`);
  if (value === undefined) return el.click(); // a button (format choice)
  const type = await el.evaluate((n) => n.type);
  if (type === 'checkbox') {
    if ((await el.isChecked()) !== value) await page.locator(`label:has([data-cap="${cap}"])`).click();
  } else if (type === 'select-one') await el.selectOption(String(value));
  else await el.fill(String(value));
}

/** Parse a GIF: header, size, frame count, delay sum (centiseconds), trailer. */
function inspectGif(bytes) {
  const head = String.fromCharCode(...bytes.slice(0, 6));
  const width = bytes[6] | (bytes[7] << 8),
    height = bytes[8] | (bytes[9] << 8);
  let p = 13,
    frames = 0,
    delays = 0,
    loops = null;
  for (;;) {
    const m = bytes[p++];
    if (m === 0x3b) break;
    if (m === 0x21) {
      const label = bytes[p++];
      const subs = [];
      for (;;) {
        const len = bytes[p++];
        if (!len) break;
        subs.push(bytes.slice(p, p + len));
        p += len;
      }
      if (label === 0xf9) delays += subs[0][1] | (subs[0][2] << 8);
      if (label === 0xff) loops = subs[1][1] | (subs[1][2] << 8);
    } else if (m === 0x2c) {
      const flags = bytes[p + 8];
      p += 9 + (flags & 0x80 ? 3 * (2 << (flags & 7)) : 0) + 1;
      for (;;) {
        const len = bytes[p++];
        if (!len) break;
        p += len;
      }
      frames++;
    } else throw new Error(`bad GIF block 0x${m.toString(16)} at ${p - 1}`);
  }
  return { head, width, height, frames, delays, loops, endsAtTrailer: p === bytes.length };
}

const lastBytes = (page) =>
  page.evaluate(async () => {
    const d = window.__lastDownload;
    return d ? { name: d.name, type: d.type, bytes: Array.from(new Uint8Array(await d.blob.arrayBuffer())) } : null;
  });

async function startPage(query = '&scene=pit') {
  const page = await newPage(query, VIEW);
  await page.evaluate(() => {
    window.__downloadHook = true;
    window.physixlab.store.setSelection([]);
  });
  return page;
}

/** Open a capture dialog through its command, configure it, press Start and wait for the file. */
async function capture(page, command, settings) {
  await page.evaluate(() => {
    delete window.__lastDownload;
    delete window.__lastCapture;
  });
  assert(await run(page, command), `${command} is registered and enabled`);
  await page.waitForSelector('.modal [data-cap="start"]');
  for (const [k, v] of Object.entries(settings)) await setField(page, k, v);
  await page.click('[data-cap="start"]');
  await page.waitForSelector('.capture-indicator');
  await page.waitForFunction(() => !!window.__lastDownload || !document.querySelector('.capture-indicator'), null, {
    timeout: 120000,
  });
  return page.evaluate(() => window.__lastCapture ?? null);
}

test('capture: 1 s deterministic GIF through the command has the right header, frame count and delays, and is repeatable', async () => {
  const page = await startPage();
  const cfg = { width: 320, fps: 10, duration: 1, deterministic: true, restart: true };
  const first = await capture(page, 'capture.gif', cfg);
  assert(first, 'a capture summary was recorded');
  const dl = await lastBytes(page);
  assert(dl && /\.gif$/.test(dl.name) && dl.type === 'image/gif', `gif download ${dl?.name} ${dl?.type}`);
  const g = inspectGif(dl.bytes);
  assert(g.head === 'GIF89a', `header ${g.head}`);
  assert(g.frames === 10, `10 frames (got ${g.frames})`);
  assert(g.delays === 100, `delays add up to 1.00 s (got ${g.delays} cs)`);
  assert(g.width === 320 && g.height === first.height && g.height > 100, `size ${g.width}x${g.height}`);
  assert(g.loops === 0 && g.endsAtTrailer, 'loops forever, ends with the trailer');
  assert(first.frames === 10 && first.hashes.length === 10, 'ten frame hashes');
  assert(
    new Set(first.hashes).size >= 5,
    `the simulation advanced between frames (${new Set(first.hashes).size} distinct)`,
  );
  const sim = await page.evaluate(() => window.physixlab.sim.mode);
  assert(sim === 'edit', `the editor is back in edit mode (${sim})`);

  // Second capture with identical settings: frame by frame identical.
  const second = await capture(page, 'capture.gif', cfg);
  assert(
    JSON.stringify(first.hashes) === JSON.stringify(second.hashes),
    `frame hashes differ between two deterministic captures:\n${first.hashes.join(' ')}\n${second.hashes.join(' ')}`,
  );
  const dl2 = await lastBytes(page);
  assert(
    dl.bytes.length === dl2.bytes.length && dl.bytes.every((b, i) => b === dl2.bytes[i]),
    'the two GIF files are byte-identical',
  );
  assert(page.errors.length === 0, `no page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('capture: dialog explains limits, Esc cancels a running capture without saving, record.stop saves early', async () => {
  const page = await startPage();
  assert(await run(page, 'capture.gif'), 'command runs');
  await page.waitForSelector('.modal [data-cap="start"]');
  await setField(page, 'duration', 100);
  const err = await page.locator('.cap-errors').textContent();
  assert(/limited to 30 s/.test(err ?? ''), `duration limit explained: ${err}`);
  assert(await page.locator('[data-cap="start"]').isDisabled(), 'Start is disabled while an option is invalid');
  await setField(page, 'duration', 25);
  await setField(page, 'fps', 30);
  const err2 = await page.locator('.cap-errors').textContent();
  assert(/at most 600 frames|600/.test(err2 ?? ''), `frame limit explained: ${err2}`);
  await setField(page, 'fps', 10);
  await setField(page, 'width', 320);
  await setField(page, 'deterministic', true);
  assert(!(await page.locator('[data-cap="start"]').isDisabled()), 'Start enabled for valid options');
  // Escape inside the dialog only closes it.
  await page.keyboard.press('Escape');
  assert((await page.locator('.modal').count()) === 0, 'Esc closes the dialog');

  // Start, then cancel with Esc.
  await page.evaluate(() => {
    delete window.__lastDownload;
  });
  await run(page, 'capture.gif');
  await page.waitForSelector('.modal [data-cap="start"]');
  await setField(page, 'duration', 20);
  await page.click('[data-cap="start"]');
  await page.waitForSelector('.capture-indicator .cap-dot');
  assert(!(await run(page, 'capture.gif')), 'a second capture cannot start while one runs');
  assert(
    await page.evaluate(() =>
      /Frame|Preparing/.test(document.querySelector('.capture-indicator .cap-label').textContent),
    ),
    'indicator shows progress',
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.capture-indicator'), null, { timeout: 30000 });
  await page.waitForSelector('.toast:has-text("cancelled")');
  assert(!(await page.evaluate(() => !!window.__lastDownload)), 'nothing was saved after Esc');
  assert((await page.evaluate(() => window.physixlab.sim.mode)) === 'edit', 'simulation state restored after cancel');

  // Stop early keeps the frames so far.
  await run(page, 'capture.gif');
  await page.waitForSelector('.modal [data-cap="start"]');
  await setField(page, 'duration', 20);
  await page.click('[data-cap="start"]');
  await page.waitForFunction(
    () => /Frame [3-9]\//.test(document.querySelector('.capture-indicator .cap-label')?.textContent ?? ''),
    null,
    {
      timeout: 60000,
    },
  );
  assert(await run(page, 'record.stop'), 'record.stop is enabled during a capture');
  await page.waitForFunction(() => !!window.__lastDownload, null, { timeout: 30000 });
  const info = await page.evaluate(() => window.__lastCapture);
  assert(info.stoppedEarly && info.frames >= 3 && info.frames < 200, `stopped early with ${info.frames} frames`);
  const g = inspectGif((await lastBytes(page)).bytes);
  assert(g.frames === info.frames, 'file holds exactly the captured frames');
  assert(!(await run(page, 'record.stop')), 'record.stop is disabled when nothing records');
  await page.close();
});

test('capture: deterministic turntable GIF orbits a full 360 degrees and restores the camera', async () => {
  const page = await startPage();
  // Let the start-up camera fly-in finish so "before" is the resting view.
  let still = 0,
    last = '';
  for (let i = 0; i < 60 && still < 3; i++) {
    const v = JSON.stringify(await page.evaluate(() => window.physixlab.viewport.getView()));
    still = v === last ? still + 1 : 0;
    last = v;
    await page.waitForTimeout(1000);
  }
  assert(still >= 3, 'camera came to rest');
  const before = await page.evaluate(() => window.physixlab.viewport.getView());
  const sum = await capture(page, 'capture.turntable', {
    'format-gif': undefined,
    width: 320,
    fps: 10,
    duration: 1.2,
    deterministic: true,
    turntable: true,
    'pause-sim': true,
  });
  assert(sum, 'turntable finished');
  assert(sum.frames === 12, `12 frames (got ${sum.frames})`);
  const distinct = new Set(sum.hashes).size;
  assert(distinct >= 10, `the camera moved between frames (${distinct} distinct of 12)`);
  const g = inspectGif((await lastBytes(page)).bytes);
  assert(g.frames === 12 && g.head === 'GIF89a', 'valid 12-frame GIF');
  const after = await page.evaluate(() => window.physixlab.viewport.getView());
  const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);
  assert(
    close(before.position, after.position) && close(before.target, after.target),
    `camera restored (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`,
  );
  assert(
    (await page.evaluate(() => window.physixlab.sim.mode)) === 'edit',
    'no simulation was started by a paused turntable',
  );
  await page.close();
});

test('capture: real-time WebM recording via MediaRecorder (skipped honestly where the browser lacks support)', async () => {
  const page = await startPage();
  const support = await page.evaluate(() => ({
    mr: typeof MediaRecorder !== 'undefined',
    webm:
      typeof MediaRecorder !== 'undefined' &&
      ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].some((m) => MediaRecorder.isTypeSupported(m)),
    mp4: typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/mp4'),
  }));
  if (!support.webm) {
    // The fallback message must be honest and reachable.
    assert(await run(page, 'record.start'), 'record.start opens');
    await page.waitForSelector('.modal [data-cap="start"]');
    const title = await page.locator('[data-cap="format-webm"]').getAttribute('title');
    assert(await page.locator('[data-cap="format-webm"]').isDisabled(), 'WebM is disabled');
    assert(/MediaRecorder|WebM/.test(title ?? ''), `explained: ${title}`);
    console.log('    (headless Chromium here cannot record WebM; the recording sub-check is skipped)');
    await page.close();
    return;
  }
  const sum = await capture(page, 'record.start', {
    'format-webm': undefined,
    width: 320,
    fps: 24,
    duration: 3,
    deterministic: false,
  });
  assert(sum === null || sum.format === 'webm', 'webm capture finished');
  const dl = await lastBytes(page);
  assert(dl && dl.type === 'video/webm', `webm download ${dl?.type}`);
  assert(dl.bytes.length > 500, `non-trivial file (${dl.bytes.length} bytes)`);
  assert(dl.bytes.slice(0, 4).join(',') === '26,69,223,163', 'starts with the EBML header 1A 45 DF A3');
  assert((await page.evaluate(() => document.querySelector('.capture-indicator'))) === null, 'indicator removed');
  console.log(`    (WebM recorded: ${dl.bytes.length} bytes; MP4 supported here: ${support.mp4})`);
  await page.close();
});
