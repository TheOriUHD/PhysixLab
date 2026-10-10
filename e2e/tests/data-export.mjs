/** Data platform (package DT-1): exporters driven through the real commands and dialogs. */
import { assert, newPage } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** Run a command, set the capture hook, click Export in the dialog, wait for the captured download. */
async function exportVia(page, commandId, prepare) {
  await page.evaluate(async (id) => {
    window.__physicslabCaptureDownloads = true;
    window.__lastDownload = undefined;
    const { runCommand } = await import('/src/app/registry/commands.ts');
    runCommand(id, window.physicslab, 'api');
  }, commandId);
  await page.waitForSelector('.modal [data-action="export"]');
  if (prepare) await prepare();
  await page.click('.modal [data-action="export"]');
  await page.waitForFunction(() => !!window.__lastDownload, null, { timeout: 30000 });
  // Read the captured Blob inside the page; hand back bytes as base64 plus metadata.
  return page.evaluate(async () => {
    const d = window.__lastDownload;
    const buf = new Uint8Array(await d.blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { name: d.name, type: d.type, size: d.size, b64: btoa(s) };
  });
}

const bytes = (r) => Buffer.from(r.b64, 'base64');
const toggle = (page, label) => page.locator('.modal .row', { hasText: label }).locator('.switch').click();

test('DT-1 export commands are in the File menu', async () => {
  const page = await newPage();
  await page.click('.menu-btn:has-text("File")');
  const items = await page.evaluate(() => [...document.querySelectorAll('.menu .menu-item')].map((b) => b.textContent));
  for (const want of ['glTF', 'OBJ', 'STL', 'PNG'])
    assert(
      items.some((t) => t.includes(want)),
      `File menu has an ${want} export: ${items}`,
    );
  await page.close();
});

test('DT-1 PNG export: a 1280x720 PNG and a transparent 4K image, viewport restored', async () => {
  const page = await newPage();
  const r = await exportVia(page, 'file.export.png', async () => {
    await page.selectOption('.modal select', '1280x720');
  });
  const png = bytes(r);
  assert(r.type === 'image/png' && r.name.endsWith('-1280x720.png'), `type/name ${r.type} ${r.name}`);
  assert(png.subarray(1, 4).toString() === 'PNG', 'PNG signature');
  assert(
    png.readUInt32BE(16) === 1280 && png.readUInt32BE(20) === 720,
    `size ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`,
  );
  assert(new Set(png.subarray(0, 4000)).size > 40, 'image has content');

  await exportVia(page, 'file.export.png', async () => {
    await page.selectOption('.modal select', '3840x2160');
    await toggle(page, 'Transparent background');
  });
  const stats = await page.evaluate(async () => {
    const bmp = await createImageBitmap(window.__lastDownload.blob);
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 144;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, 256, 144);
    const d = ctx.getImageData(0, 0, 256, 144).data;
    let clear = 0,
      solid = 0;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] < 8) clear++;
      else if (d[i] > 247) solid++;
    }
    return { w: bmp.width, h: bmp.height, clear, solid, total: d.length / 4 };
  });
  assert(stats.w === 3840 && stats.h === 2160, `4K size ${stats.w}x${stats.h}`);
  assert(stats.clear > stats.total * 0.3, `transparent background: ${stats.clear}/${stats.total} clear pixels`);
  assert(stats.solid > 20, `the objects stay opaque: ${stats.solid} solid pixels`);
  const canvas = await page.evaluate(() => {
    const c = window.physicslab.viewport.dom;
    return { w: c.width, h: c.height };
  });
  assert(canvas.w < 3840, `viewport canvas restored (${canvas.w}x${canvas.h})`);
  await page.close();
});

test('DT-1 export thumbnail helper returns a small image without disturbing the viewport', async () => {
  const page = await newPage();
  const r = await page.evaluate(async () => {
    const { renderThumbnail, renderThumbnailDataUrl } = await import('/src/app/export/capture.ts');
    const blob = await renderThumbnail(window.physicslab, 160);
    const bmp = await createImageBitmap(blob);
    const url = renderThumbnailDataUrl(window.physicslab, 96, { mime: 'image/jpeg', quality: 0.7 });
    return { type: blob.type, w: bmp.width, h: bmp.height, url: url.slice(0, 23) };
  });
  assert(r.type === 'image/png' && Math.max(r.w, r.h) === 160, `thumbnail ${r.type} ${r.w}x${r.h}`);
  assert(r.url === 'data:image/jpeg;base64,', `data url ${r.url}`);
  await page.close();
});

test('DT-1 GLB export: valid container with the scene content, selection-only exports less', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physicslab;
    a.addShape('box', [0, 1, 0]);
    a.addShape('sphere', [3, 1, 0]);
  });
  const full = await exportVia(page, 'file.export.gltf');
  const glb = bytes(full);
  assert(full.type === 'model/gltf-binary' && full.name.endsWith('.glb'), `type/name ${full.type} ${full.name}`);
  assert(glb.readUInt32LE(0) === 0x46546c67 && glb.readUInt32LE(4) === 2, 'glTF magic, version 2');
  assert(glb.readUInt32LE(8) === glb.length, 'declared length equals file size');
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString());
  assert(json.nodes.length >= 2 && json.meshes.length >= 2, `nodes ${json.nodes.length}, meshes ${json.meshes.length}`);
  const binLen = glb.readUInt32LE(20 + jsonLen);
  assert(json.buffers[0].byteLength === binLen, 'buffer length matches the BIN chunk');
  for (const v of json.bufferViews) assert(v.byteOffset + v.byteLength <= binLen, 'buffer view inside the buffer');

  await page.evaluate(() => {
    const a = window.physicslab;
    const ids = a.store.bodies().map((b) => b.id);
    a.store.setSelection([ids[ids.length - 1]]);
  });
  const sel = await exportVia(page, 'file.export.gltf', async () => {
    await toggle(page, 'Selection only');
  });
  const g2 = bytes(sel);
  const j2 = JSON.parse(g2.subarray(20, 20 + g2.readUInt32LE(12)).toString());
  assert(j2.nodes.length === 1, `selection only exports one node, got ${j2.nodes.length}`);
  assert(g2.length < glb.length, 'selection-only file is smaller');
  await page.close();
});

test('DT-1 GLB with baked animation records the running simulation', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    window.physicslab.addShape('sphere', [0, 6, 0]);
  });
  const r = await exportVia(page, 'file.export.gltf', async () => {
    const field = page.locator('.modal .row', { hasText: 'Bake animation' }).locator('input');
    await field.fill('4');
    await field.press('Enter');
  });
  const glb = bytes(r);
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
  assert(
    json.animations && json.animations[0].channels.length >= 2,
    `animation channels: ${JSON.stringify(json.animations?.[0]?.channels)}`,
  );
  const t = json.accessors[json.animations[0].samplers[0].input];
  assert(t.count >= 10 && t.max[0] >= 3.5, `time samples ${t.count}, ends at ${t.max}`);
  await page.close();
});

test('DT-1 STL and OBJ exports are well-formed', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    window.physicslab.addShape('box', [0, 1, 0]);
  });
  const stl = await exportVia(page, 'file.export.stl');
  const s = bytes(stl);
  const tris = s.readUInt32LE(80);
  assert(tris >= 12 && s.length === 84 + 50 * tris, `STL size ${s.length} = 84 + 50 x ${tris}`);
  const obj = await exportVia(page, 'file.export.obj');
  const z = bytes(obj);
  assert(obj.name.endsWith('.obj.zip') && z.readUInt32LE(0) === 0x04034b50, `OBJ zip ${obj.name}`);
  const text = z.toString('latin1');
  assert(text.includes('.mtl') && text.includes('mtllib') && text.includes('newmtl'), 'zip holds the obj and the mtl');
  await page.close();
});
