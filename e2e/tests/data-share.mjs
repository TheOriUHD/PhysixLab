/** DT-21 share dialog (preview image, QR, copy image + link, Open Graph) and the DT-22 Embed dialog. */
import { assert, newPage } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('DT-21 share dialog: preview image, size readout, QR code, copy image + link, Open Graph tags', async () => {
  const p = await newPage();
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await p.click('.menu-btn:has-text("File")');
  await p.click('text=Share with preview and QR code…');
  await p.waitForSelector('.share-dialog');
  const dlg = await p.evaluate(() => {
    const img = document.querySelector('.share-thumb');
    const svg = document.querySelector('.share-qr svg');
    const path = svg?.querySelector('path')?.getAttribute('d') ?? '';
    return {
      w: img?.naturalWidth ?? 0,
      h: img?.naturalHeight ?? 0,
      allFacts: [...document.querySelectorAll('.share-facts')].map((e) => e.textContent).join(' | '),
      qrBox: svg ? svg.getAttribute('viewBox') : null,
      qrRuns: (path.match(/M/g) ?? []).length,
      url: document.querySelector('.share-url')?.value ?? '',
    };
  });
  assert(dlg.w > 100 && dlg.h > 60, `thumbnail decoded (${dlg.w}x${dlg.h})`);
  assert(
    /\d+(\.\d)? kB link/.test(dlg.allFacts) && /% shorter/.test(dlg.allFacts),
    `size readout + N % shorter (${dlg.allFacts})`,
  );
  assert(dlg.qrBox && dlg.qrRuns > 100, `QR drawn (${dlg.qrBox}, ${dlg.qrRuns} runs)`);
  assert(dlg.url.includes('#s='), 'link shown');
  // The thumbnail is not a blank frame: count distinct colours in the PNG.
  const distinct = await p.evaluate(() => {
    const img = document.querySelector('.share-thumb');
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 36;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 64, 36);
    const d = ctx.getImageData(0, 0, 64, 36).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4) seen.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
    return seen.size;
  });
  assert(distinct > 6, `the preview shows the scene, not a blank frame (${distinct} colours)`);
  // Copy image + link: one clipboard item with both representations.
  await p.click('button:has-text("Copy image + link")');
  await p.waitForSelector('.toast');
  const clip = await p.evaluate(async () => (await navigator.clipboard.read()).map((i) => i.types));
  assert(
    clip.length === 1 && clip[0].includes('image/png') && clip[0].includes('text/plain'),
    `clipboard holds image/png + text/plain (${JSON.stringify(clip)})`,
  );
  await p.click('button:has-text("Copy Open Graph tags")');
  await p.waitForFunction(async () => (await navigator.clipboard.readText()).includes('og:title'), null, {
    timeout: 5000,
  });
  assert(p.errors.length === 0, `no console errors: ${p.errors.join('; ')}`);
  await p.close();
});

test('DT-21 share dialog says so when the link is too long for a QR code', async () => {
  const p = await newPage();
  // Random 110-character names do not compress, so a few dozen bodies push the link past what a QR code holds.
  const len = await p.evaluate(async () => {
    const a = window.physixlab;
    let s = 7;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const word = () => Array.from({ length: 110 }, () => abc[Math.floor(rnd() * abc.length)]).join('');
    a.store.updateMany(a.store.bodies().map((b) => [b.id, { name: word() }]));
    for (let i = 0; i < 20; i++) a.addShape('box', [i * 1.2, 0.5, 6]);
    a.store.updateMany(a.store.bodies().map((b) => [b.id, { name: word() }]));
    return (await a.persistence.shareInfo()).url.length;
  });
  await p.click('.menu-btn:has-text("File")');
  await p.click('text=Share with preview and QR code…');
  await p.waitForSelector('.share-dialog');
  const text = (await p.locator('.share-dialog').textContent()) ?? '';
  assert(len > 2953, `test scene link is longer than a QR code holds (${len})`);
  assert(
    /QR code holds at most 2953/.test(text) || /too large for a link/.test(text),
    `too-long message shown: ${text.slice(0, 200)}`,
  );
  assert((await p.locator('.share-qr svg').count()) === 0, 'no QR drawn for an oversized link');
  assert(/scene as a file|scene file/.test(text), 'the file alternative is offered');
  await p.close();
});

test('DT-22 embed dialog: snippet from options, live preview viewer, copy', async () => {
  const p = await newPage();
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await p.click('.menu-btn:has-text("File")');
  await p.click('text=Embed in a web page…');
  await p.waitForSelector('.embed-dialog textarea.embed-code');
  const first = await p.inputValue('.embed-code');
  assert(
    /^<iframe src="[^"]*embed=1[^"]*#s=/.test(first) && first.includes('width="640"'),
    `snippet (${first.slice(0, 120)})`,
  );
  await p.selectOption('.embed-dialog select', 'fixed');
  await p.fill('.embed-dialog input[type=number] >> nth=0', '800');
  await p.locator('.embed-dialog .switch').filter({ hasText: 'Show play / reset bar' }).click();
  const second = await p.inputValue('.embed-code');
  assert(
    second.includes('camera=fixed') && second.includes('controls=0') && second.includes('width="800"'),
    `options reflected (${second.slice(0, 200)})`,
  );
  // The preview iframe loads the same viewer URL and boots a viewer with those options.
  // The viewer is rebuilt a moment after the last option change: wait for the one that carries the new options.
  await p.waitForFunction(
    () => /controls=0/.test(document.querySelector('.embed-preview iframe')?.getAttribute('src') ?? ''),
    null,
    { timeout: 90000 },
  );
  const frame = await (await p.waitForSelector('.embed-preview iframe')).contentFrame();
  await frame.waitForFunction(() => !!window.physixlab, null, { timeout: 90000 });
  const inFrame = await frame.evaluate(() => ({
    bar: !!document.querySelector('.embed-bar'),
    orbit: window.physixlab.viewport.controls.enabled,
    panels: document.querySelectorAll('aside, .topbar').length,
  }));
  assert(
    !inFrame.bar && inFrame.orbit === false && inFrame.panels === 0,
    `preview honours the options (${JSON.stringify(inFrame)})`,
  );
  await p.click('button:has-text("Copy embed code")');
  const copied = await p.evaluate(() => navigator.clipboard.readText());
  assert(copied === second, 'copy button copies the snippet');
  await p.close();
});
