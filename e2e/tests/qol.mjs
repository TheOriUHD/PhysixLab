/**
 * Presentation / photo mode (UI-41) and quality of life (UI-42), driven through the real UI in headless Chromium:
 * F10 hides every piece of chrome and Esc restores it, hi-res captures are real PNGs of the expected size, camera /
 * lighting presets move the real camera and renderer, favourites persist and are listed first, the recent list and
 * thumbnails follow loaded scenes, a scene file dropped on the window opens (other kinds say honestly that they
 * cannot be imported) and a scene on the clipboard is offered on Ctrl+V without breaking entity copy / paste.
 * Screenshots (E2E_SHOTS=1) go to e2e/out/qol-*.png.
 */
import { assert, newPage, shot, sleep } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });
/** Software GL renders a frame in about a second, so rAF-polled waits are slow: poll on a timer instead. */
const until = (page, fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { polling: 100, timeout });
/** Show a tab of a docked region (the tab strips overflow at 268 px, so go through the preference the strip stores). */
const showTab = async (page, region, id) => {
  await page.evaluate(
    ({ region, id }) =>
      window.physicslab.prefs.set(
        region === 'left' ? { leftTab: id, showLeft: true } : { rightTab: id, showRight: true },
      ),
    { region, id },
  );
  await page.waitForTimeout(150);
};
const noErrors = (page) => assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);

/** Serialise a real scene (one box) in the page, so the dropped / pasted text is a valid document. */
const makeSceneText = (page, name) =>
  page.evaluate(async (name) => {
    const { Builder } = await import('/src/model/builder.ts');
    const { serializeDocument } = await import('/src/model/serialize.ts');
    const b = new Builder(name);
    b.body('Dropped box', 'box', [1, 1, 1], [0, 2, 0], { material: 'wood' });
    b.body('Second box', 'box', [1, 1, 1], [3, 2, 0], { material: 'wood' });
    return serializeDocument(b.done());
  }, name);

const sceneName = (page) => page.evaluate(() => window.physicslab.store.name);
const bodyCount = (page) => page.evaluate(() => window.physicslab.store.bodies().length);

/** PNG width / height from its IHDR chunk, read in the page from a Blob. */
const pngSize = (page) =>
  page.evaluate(async () => {
    const { getPresenter } = await import('/src/ui/present/presenter.ts');
    const r = getPresenter(window.physicslab).lastCapture;
    const buf = new DataView(await r.blob.arrayBuffer());
    const sig = [0x89, 0x50, 0x4e, 0x47].every((b, i) => buf.getUint8(i) === b);
    return { sig, w: buf.getUint32(16), h: buf.getUint32(20), type: r.blob.type, bytes: r.blob.size };
  });

const dropFiles = (page, files, { drop = true, hold = false } = {}) =>
  page.evaluate(
    ({ files, drop, hold }) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([f.text], f.name, { type: f.type }));
      const fire = (type) =>
        window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      fire('dragenter');
      fire('dragover');
      const overlay = document.querySelector('.qol-drop');
      const state = {
        shown: overlay.classList.contains('show'),
        bad: overlay.classList.contains('bad'),
        title: overlay.querySelector('.qol-drop-title').textContent,
        detail: overlay.querySelector('.qol-drop-detail').textContent,
      };
      if (drop) fire('drop');
      else if (!hold) fire('dragleave');
      return state;
    },
    { files, drop, hold },
  );

test('qol: presentation mode hides every piece of chrome and Esc restores it', async () => {
  const page = await newPage('&scene=car');
  const chrome = () =>
    page.evaluate(() => {
      const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      const q = (s) => document.querySelector(s);
      const r = document.querySelector('.viewport-host').getBoundingClientRect();
      return {
        topbar: vis(q('.topbar')),
        left: vis(q('aside.panel.left')),
        right: vis(q('aside.panel.right')),
        dock: vis(q('.dock')),
        status: vis(q('.statusbar')),
        toolbox: [...document.querySelectorAll('.toolbox, .viewbar')].some(vis),
        viewport: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) },
        win: { w: innerWidth, h: innerHeight },
        hint: !!document.querySelector('.qol-exit-hint.show'),
        presenting: document.body.classList.contains('qol-presenting'),
      };
    });
  const before = await chrome();
  assert(
    before.topbar && before.left && before.right && before.status && before.toolbox,
    'chrome visible at the start',
  );
  assert(before.viewport.w < before.win.w, 'the viewport shares the window with the panels');
  await shot(page, 'qol-normal-1600x900');

  await page.keyboard.press('F10');
  await until(page, () => document.body.classList.contains('qol-presenting'));
  const hintAtOnce = await page.evaluate(() => !!document.querySelector('.qol-exit-hint.show'));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(1500);
  const on = await chrome();
  assert(
    !on.topbar && !on.left && !on.right && !on.dock && !on.status && !on.toolbox,
    `all chrome hidden: ${JSON.stringify(on)}`,
  );
  assert(
    on.viewport.w === on.win.w && on.viewport.h === on.win.h && on.viewport.x === 0 && on.viewport.y === 0,
    'the viewport fills the window',
  );
  assert(hintAtOnce, 'the exit hint is shown on entering');
  assert(
    (await page.evaluate(() => window.physicslab.joints.visible)) === false,
    'joint markers are hidden while presenting',
  );
  await shot(page, 'qol-presenting-1600x900');
  // the canvas itself follows the new size (drawing buffer matches the window)
  const canvas = await page.evaluate(() => {
    const c = window.physicslab.viewport.dom;
    return { w: c.clientWidth, h: c.clientHeight };
  });
  assert(canvas.w === on.win.w && canvas.h === on.win.h, `canvas resized to the window: ${JSON.stringify(canvas)}`);

  // the hint fades by itself, and comes back when the pointer moves
  await until(page, () => !document.querySelector('.qol-exit-hint.show'), null, 8000);
  await page.mouse.move(300, 300);
  await page.mouse.move(340, 320);
  await until(page, () => !!document.querySelector('.qol-exit-hint.show'));

  await page.keyboard.press('Escape');
  await until(page, () => !document.body.classList.contains('qol-presenting'));
  await page.waitForTimeout(500);
  const off = await chrome();
  assert(off.topbar && off.left && off.right && off.status && off.toolbox, `chrome restored: ${JSON.stringify(off)}`);
  assert(off.viewport.w === before.viewport.w && off.viewport.h === before.viewport.h, 'viewport size restored');
  assert(!off.hint, 'hint removed');
  assert(
    (await page.evaluate(() => window.physicslab.joints.visible)) === true,
    'joint markers are back after presenting',
  );

  // the same through the command (palette / menu) and a click on the hint
  await page.keyboard.press('F10');
  await until(page, () => document.body.classList.contains('qol-presenting'));
  await page.mouse.move(100, 100);
  await page.mouse.move(120, 110);
  await page.dispatchEvent('.qol-exit-hint', 'click');
  await until(page, () => !document.body.classList.contains('qol-presenting'));
  noErrors(page);
  await page.close();
});

test('qol: captures are real PNGs at 1x, 2x and 4x with the interface and selection outline left out', async () => {
  const page = await newPage('&scene=car', { width: 800, height: 500 });
  // at 800 px the panels leave the viewport a sliver: present first, so it is the whole window
  await page.keyboard.press('F10');
  await until(
    page,
    () =>
      window.physicslab.viewport.cssSize.width === innerWidth &&
      window.physicslab.viewport.cssSize.height === innerHeight,
  );
  await page.waitForTimeout(1500);
  const css = await page.evaluate(() => window.physicslab.viewport.cssSize);
  assert(css.width === 800 && css.height === 500, `the viewport is the window: ${JSON.stringify(css)}`);
  const caps = {};
  for (const scale of [1, 2, 4]) {
    await page.evaluate(async (scale) => {
      const { getPresenter } = await import('/src/ui/present/presenter.ts');
      await getPresenter(window.physicslab).capture(scale);
    }, scale);
    caps[scale] = await pngSize(page);
    assert(caps[scale].sig, `${scale}x is a PNG`);
    assert(caps[scale].type === 'image/png', `${scale}x blob type ${caps[scale].type}`);
    assert(
      caps[scale].w === css.width * scale && caps[scale].h === css.height * scale,
      `${scale}x is ${css.width * scale}x${css.height * scale}, got ${caps[scale].w}x${caps[scale].h}`,
    );
  }
  assert(caps[4].bytes > caps[1].bytes, 'a 4x image carries more data than a 1x image');
  // the live viewport is back to its normal pixel ratio and size after capturing
  const after = await page.evaluate(() => {
    const vp = window.physicslab.viewport;
    return { ratio: vp.renderer.getPixelRatio(), w: vp.dom.width, h: vp.dom.height, css: vp.cssSize };
  });
  assert(after.w === Math.round(after.css.width * after.ratio), `canvas buffer restored: ${JSON.stringify(after)}`);
  assert(after.ratio <= 2, 'pixel ratio restored');

  // the picture is the scene, not a blank frame: decode it and look at the colours
  const stats = await page.evaluate(async () => {
    const { getPresenter } = await import('/src/ui/present/presenter.ts');
    const r = await getPresenter(window.physicslab).capture(1);
    const bmp = await createImageBitmap(r.blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) seen.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
    return { colours: seen.size, alpha: d[3] };
  });
  assert(stats.colours > 25 && stats.alpha === 255, `the capture has image content: ${JSON.stringify(stats)}`);
  noErrors(page);
  await page.close();
});

test('qol: the caption is drawn into captures and the panel controls the real camera and renderer', async () => {
  const page = await newPage('&scene=car');
  await showTab(page, 'right', 'present');
  await page.waitForSelector('.qol-present');
  await shot(page, 'qol-present-panel-1600x900');

  // camera presets move the real camera to the preset side of the subject
  const subject = await page.evaluate(async () => {
    const { getPresenter } = await import('/src/ui/present/presenter.ts');
    return getPresenter(window.physicslab).subjectBounds();
  });
  await page.click('[data-camera="right"]');
  await until(page, (c) => window.physicslab.camera.position.x > c.center[0] + 2, subject, 30000);
  await page.click('[data-camera="top"]');
  await until(page, (c) => window.physicslab.camera.position.y > c.center[1] + c.radius, subject, 30000);
  await page.click('[data-camera="back"]');
  await until(page, (c) => window.physicslab.camera.position.z < c.center[2] - 2, subject, 30000);

  // lighting presets are the scene's environment (VZ): the document changes, the sun and the sky follow, Undo works
  const base = await page.evaluate(() => {
    const a = window.physicslab;
    return {
      sky: a.store.settings.environment.sky,
      sun: a.viewport.sun.color.getHexString(),
      sunI: a.viewport.sun.intensity,
      sunY: a.viewport.sun.position.y,
    };
  });
  await page.selectOption('[data-qol="light-select"]', 'sunset');
  await page.waitForTimeout(700);
  const sunset = await page.evaluate(() => {
    const a = window.physicslab;
    return {
      sky: a.store.settings.environment.sky,
      az: a.store.settings.environment.sun.azimuth,
      sun: a.viewport.sun.color.getHexString(),
      sunY: a.viewport.sun.position.y,
    };
  });
  assert(sunset.sky === 'sunset' && sunset.sun !== base.sun, `sunset applied: ${JSON.stringify({ base, sunset })}`);
  assert(sunset.sunY < base.sunY, `the sun is lower at sunset (${base.sunY} -> ${sunset.sunY})`);
  await page.waitForTimeout(600);
  await shot(page, 'qol-light-sunset-1600x900');
  await page.evaluate(() => window.physicslab.store.undo());
  const undone = await page.evaluate(() => window.physicslab.store.settings.environment.sky);
  assert(undone === base.sky, `Undo restores the environment (${undone})`);
  await page.waitForFunction((sky) => document.querySelector('[data-qol="light-select"]').value === sky, base.sky);

  // depth of field: the real pass, set through the graphics options
  await page.selectOption('[data-qol="dof-select"]', 'macro');
  const dof = await page.evaluate(() => ({
    pref: window.physicslab.prefs.value.graphics.dof,
    resolved: window.physicslab.viewport.resolvedGraphics.dof,
  }));
  assert(
    dof.pref.on === true && dof.pref.aperture > 0.8 && dof.resolved && dof.resolved.on,
    `DOF applied: ${JSON.stringify(dof)}`,
  );
  await page.waitForTimeout(800);
  await shot(page, 'qol-dof-macro-1600x900');
  const blur = await page.evaluate(async () => {
    const { getPresenter } = await import('/src/ui/present/presenter.ts');
    const p = getPresenter(window.physicslab);
    const sharp = async (preset) => {
      p.setDof(preset);
      const r = await p.capture(1);
      const bmp = await createImageBitmap(r.blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      let e = 0;
      for (let y = 1; y < bmp.height - 1; y += 2)
        for (let x = 1; x < bmp.width - 1; x += 2) {
          const i = (y * bmp.width + x) * 4;
          e += Math.abs(d[i + 4] - d[i - 4]) + Math.abs(d[i + bmp.width * 4] - d[i - bmp.width * 4]);
        }
      return e / ((bmp.width * bmp.height) / 4);
    };
    const off = await sharp('off');
    const macro = await sharp('macro');
    p.setDof('tier');
    return { off, macro };
  });
  assert(
    blur.macro < blur.off * 0.97,
    `macro DOF blurs the capture (edge energy ${blur.off.toFixed(3)} -> ${blur.macro.toFixed(3)})`,
  );

  // lens preset
  await page.click('[data-lens="tele"]');
  const fov = await page.evaluate(() => window.physicslab.camera.fov);
  assert(fov < 20, `135 mm lens narrows the field of view (${fov})`);
  await page.click('[data-lens="standard"]');

  // caption: typed into the panel, shown while presenting, and drawn into the capture
  await page.fill('.qol-present .qol-inputs input[placeholder="Title"]', 'Pendulum study');
  await page.fill('.qol-present .qol-inputs input[placeholder="Subtitle"]', 'Energy is conserved');
  const without = await page.evaluate(async () => {
    const { getPresenter } = await import('/src/ui/present/presenter.ts');
    const p = getPresenter(window.physicslab);
    p.set({ captionOn: false });
    const a = await p.capture(1);
    p.set({ captionOn: true, captionPos: 'center', captionSize: 60 });
    const b = await p.capture(1);
    const px = async (r) => {
      const bmp = await createImageBitmap(r.blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      return { w: bmp.width, h: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
    };
    const A = await px(a),
      B = await px(b);
    // count near-white pixels in the middle band: text is pure white on top of the scene
    const white = (P) => {
      let n = 0;
      for (let y = Math.floor(P.h * 0.4); y < Math.floor(P.h * 0.6); y++)
        for (let x = 0; x < P.w; x++) {
          const i = (y * P.w + x) * 4;
          if (P.data[i] > 250 && P.data[i + 1] > 250 && P.data[i + 2] > 250) n++;
        }
      return n;
    };
    return { off: white(A), on: white(B), opts: p.options, size: [B.w, B.h] };
  });
  assert(
    without.on > without.off + 200,
    `the caption text is in the capture (white pixels ${without.off} -> ${without.on}) ${JSON.stringify(without)}`,
  );
  await page.keyboard.press('F10');
  await page.waitForSelector('.qol-caption');
  const cap = await page.evaluate(() => {
    const el = document.querySelector('.qol-caption');
    return { text: el.textContent, op: getComputedStyle(el).opacity, pos: el.className };
  });
  assert(
    cap.text.includes('Pendulum study') && cap.text.includes('Energy is conserved') && cap.op === '1',
    `caption shown: ${JSON.stringify(cap)}`,
  );
  await page.waitForTimeout(500);
  await shot(page, 'qol-caption-presenting-1600x900');
  await page.keyboard.press('Escape');
  assert(!(await page.$('.qol-caption')), 'caption removed on exit');
  noErrors(page);
  await page.close();
});

test('qol: the turntable turns the camera about the target at the set speed', async () => {
  const page = await newPage('&scene=car');
  const r = await page.evaluate(async () => {
    const { getPresenter } = await import('/src/ui/present/presenter.ts');
    const app = window.physicslab;
    const p = getPresenter(app);
    p.set({ turntableSpeed: 45 });
    const angle = () => {
      const c = app.viewport.camera.position,
        t = app.viewport.controls.target;
      return Math.atan2(c.z - t.z, c.x - t.x);
    };
    const radius = () => {
      const c = app.viewport.camera.position,
        t = app.viewport.controls.target;
      return Math.hypot(c.x - t.x, c.z - t.z);
    };
    // expected turn = speed x the frame time the app itself reports (frames are slow under software GL)
    let simulated = 0,
      frames = 0;
    const off = app.on('frame', ({ dt }) => {
      simulated += dt;
      frames++;
    });
    const a0 = angle(),
      r0 = radius();
    p.setTurntable(true);
    while (frames < 6) await new Promise((res) => setTimeout(res, 100));
    p.setTurntable(false);
    off?.();
    let da = angle() - a0;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    return { turned: (da * 180) / Math.PI, expected: 45 * simulated, frames, drift: Math.abs(radius() - r0) };
  });
  assert(
    r.turned > 0 && Math.abs(r.turned - r.expected) < 0.2 * r.expected + 0.5,
    `turned ${r.turned.toFixed(2)}° of ${r.expected.toFixed(2)}° in ${r.frames} frames`,
  );
  assert(r.drift < 0.05, `the orbit radius is kept (drift ${r.drift})`);
  noErrors(page);
  await page.close();
});

test('qol: favourites are starred in the Scenes tab, listed first and remembered', async () => {
  const page = await newPage('&scene=car');
  await showTab(page, 'left', 'scenes');
  await page.waitForSelector('[data-fav="template:car"]');
  assert(
    (await page.locator('.panel.left .group-title:visible', { hasText: 'Favourites' }).count()) === 0,
    'no favourites yet',
  );
  await page.click('[data-fav="template:car"]');
  await page.waitForSelector('.panel.left .group-title:visible:has-text("Favourites")');
  const idx = await page.evaluate(() => {
    const vis = (e) => e.getClientRects().length > 0;
    const titles = [...document.querySelectorAll('.panel.left .group-title')].filter(vis).map((t) => t.textContent);
    return titles.findIndex((t) => /Favourites/.test(t));
  });
  assert(idx >= 0 && idx <= 2, `the Favourites group sits near the top of the tab (position ${idx})`);
  const listed = await page.evaluate(() => {
    const vis = (e) => e.getClientRects().length > 0;
    const groups = [...document.querySelectorAll('.panel.left .group-title')].filter(vis);
    const fav = groups.find((t) => /Favourites/.test(t.textContent));
    return [...fav.nextElementSibling.querySelectorAll('[data-template]')].map((c) => c.dataset.template);
  });
  assert(listed.length === 1 && listed[0] === 'car', `the starred example is listed: ${listed}`);
  await shot(page, 'qol-favourites-1600x900');
  // remembered across a reload
  await page.reload();
  await until(page, () => !!window.physicslab?.viewport);
  await showTab(page, 'left', 'scenes');
  await page.waitForSelector('.panel.left .group-title:visible:has-text("Favourites")');
  // prefabs, maps and shapes have stars too
  await showTab(page, 'left', 'maps');
  await page.waitForSelector('[data-fav^="map:"]');
  const mapId = await page.evaluate(() => document.querySelector('[data-fav^="map:"]').dataset.fav);
  await page.click(`[data-fav="${mapId}"]`);
  await page.waitForSelector('.panel.left .group-title:visible:has-text("Favourites")');
  await showTab(page, 'left', 'prefabs');
  await page.waitForSelector('[data-fav^="prefab:"]');
  const prefabId = await page.evaluate(() => document.querySelector('[data-fav^="prefab:"]').dataset.fav);
  await page.click(`[data-fav="${prefabId}"]`);
  await page.waitForSelector('.panel.left .group-title:visible:has-text("Favourites")');
  await showTab(page, 'left', 'add');
  await page.hover('.tile >> nth=0');
  await page.click('.tile:first-child .fav-star');
  await page.waitForSelector('[data-favourites="shape"]');
  await shot(page, 'qol-favourite-shape-1600x900');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('physicslab:qol:favourites:v1')));
  assert(
    stored.template.includes('car') &&
      stored.map.length === 1 &&
      stored.prefab.length === 1 &&
      stored.shape.length === 1,
    `stored: ${JSON.stringify(stored)}`,
  );
  // un-starring removes the group
  await page.click('[data-favourites="shape"] .fav-star');
  await until(page, () => !document.querySelector('[data-favourites="shape"]'));
  noErrors(page);
  await page.close();
});

test('qol: recent scenes, thumbnails and Open recent in the File menu follow loaded scenes', async () => {
  const page = await newPage('&scene=car');
  await showTab(page, 'left', 'scenes');
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('[data-template]')].slice(0, 3).map((c) => c.dataset.template),
  );
  const loaded = [];
  for (const id of names.slice(0, 2)) {
    await page.click(`.panel.left [data-template="${id}"]`);
    loaded.push(await page.evaluate(() => window.physicslab.store.name));
    await page.waitForTimeout(300);
  }
  // recent list: newest first, with thumbnails once the camera has settled
  await page.waitForSelector('[data-recents] [data-recent]');
  await until(page, () => document.querySelectorAll('[data-recents] .scene-thumb').length >= 1, null, 15000);
  const recent = await page.evaluate(() =>
    [...document.querySelectorAll('[data-recents] [data-recent]')].map((c) => c.dataset.recent),
  );
  assert(
    recent[0] === `template:${names[1]}` && recent[1] === `template:${names[0]}`,
    `recents newest first: ${recent}`,
  );
  await shot(page, 'qol-recent-1600x900');

  // File menu lists them under "Open recent"
  await page.click('.menu-btn:has-text("File")');
  await page.waitForSelector('.menu');
  const menu = await page.evaluate(() =>
    [...document.querySelectorAll('.menu .menu-label, .menu .menu-item')].map((e) => e.textContent.trim()),
  );
  assert(
    menu.some((t) => t === 'Open recent'),
    `menu has an Open recent heading: ${menu}`,
  );
  assert(
    menu.some((t) => t.startsWith(loaded[1])) && menu.some((t) => t.startsWith(loaded[0])),
    `menu lists the scenes: ${menu}`,
  );
  assert(
    menu.some((t) => t.startsWith('Paste scene from clipboard')),
    'menu has Paste scene from clipboard',
  );
  await shot(page, 'qol-open-recent-menu-1600x900');
  // opening the older one brings it back (the scene has unsaved edits? no edits were made, so no confirmation)
  await page.click(`.menu .menu-item:has-text("${loaded[0]}")`);
  await until(page, (n) => window.physicslab.store.name === n, loaded[0]);
  const order = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('physicslab:qol:recents:v1')).map((e) => e.key),
  );
  assert(order[0] === `template:${names[0]}`, `reopened scene moves to the top: ${order}`);
  // the cache holds a real image for it
  const thumb = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem('physicslab:qol:thumbs:v1'))[`template:${id}`]?.url ?? '',
    names[0],
  );
  assert(
    thumb.startsWith('data:image/jpeg') && thumb.length > 800 && thumb.length < 14000,
    `a small thumbnail is cached (${thumb.length} chars)`,
  );
  noErrors(page);
  await page.close();
});

test('qol: a scene file dropped on the window opens; other kinds are refused with an honest message', async () => {
  const page = await newPage('&scene=car');
  const text = await makeSceneText(page, 'Dropped scene');
  const first = await dropFiles(page, [{ name: 'x.physicslab.json', text, type: 'application/json' }], {
    drop: false,
    hold: true,
  });
  assert(
    first.shown && !first.bad && /open this scene/i.test(first.title),
    `overlay says what happens: ${JSON.stringify(first)}`,
  );
  await page.waitForTimeout(250);
  await shot(page, 'qol-drop-overlay-1600x900');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'x.json', { type: 'application/json' }));
    window.dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt, bubbles: true }));
  });
  assert(
    !(await page.evaluate(() => document.querySelector('.qol-drop').classList.contains('show'))),
    'overlay hides when the drag leaves',
  );
  await dropFiles(page, [{ name: 'x.physicslab.json', text, type: 'application/json' }]);
  await until(page, () => window.physicslab.store.name === 'Dropped scene', null, 8000);
  assert((await bodyCount(page)) === 2, 'the dropped scene replaced the car');
  const rec = await page.evaluate(() => JSON.parse(localStorage.getItem('physicslab:qol:recents:v1'))[0]);
  assert(
    rec.key === 'file:Dropped scene' && rec.hasData,
    `the drop is a recent scene that can be reopened: ${JSON.stringify(rec)}`,
  );
  assert(
    !(await page.evaluate(() => document.querySelector('.qol-drop').classList.contains('show'))),
    'overlay hidden after the drop',
  );

  // an image: the overlay refuses before the drop, the drop explains and changes nothing
  const img = await dropFiles(page, [{ name: 'photo.png', text: 'not really a png', type: 'image/png' }]);
  assert(
    img.shown && img.bad && /can’t be imported yet/.test(img.title),
    `image overlay is honest: ${JSON.stringify(img)}`,
  );
  await until(page, () =>
    [...document.querySelectorAll('.toast')].some((t) => /Images aren't supported yet/.test(t.textContent)),
  );
  // a replay (json that is not a scene) and a mesh
  await dropFiles(page, [
    { name: 'run.json', text: '{"format":"physicslab-replay","frames":[]}', type: 'application/json' },
  ]);
  await until(page, () =>
    [...document.querySelectorAll('.toast')].some((t) => /Replays aren't supported yet/.test(t.textContent)),
  );
  await dropFiles(page, [{ name: 'part.obj', text: 'v 0 0 0', type: '' }]);
  await until(page, () =>
    [...document.querySelectorAll('.toast')].some((t) => /Mesh files aren't supported yet/.test(t.textContent)),
  );
  await dropFiles(page, [{ name: 'notes.json', text: '{"hello":1}', type: 'application/json' }]);
  await until(page, () =>
    [...document.querySelectorAll('.toast')].some((t) => /not a PhysicsLab scene/.test(t.textContent)),
  );
  assert((await sceneName(page)) === 'Dropped scene' && (await bodyCount(page)) === 2, 'refused drops changed nothing');
  await shot(page, 'qol-drop-refused-1600x900');

  // a damaged scene file reports the loader's own error
  await dropFiles(page, [{ name: 'broken.physicslab.json', text: '{oops', type: 'application/json' }]);
  await until(page, () => [...document.querySelectorAll('.toast')].some((t) => /not valid JSON/.test(t.textContent)));

  // dragging a shape tile (not a file) must not raise the overlay
  const shapeDrag = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/x-physicslab-shape', 'box');
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    return document.querySelector('.qol-drop').classList.contains('show');
  });
  assert(!shapeDrag, 'shape drags do not raise the file overlay');
  noErrors(page);
  await page.close();
});

test('qol: pasting a scene from the clipboard is offered, and entity copy / paste still works', async () => {
  const page = await newPage('&scene=car');
  const text = await makeSceneText(page, 'Pasted scene');

  // entity copy / paste with a clipboard that holds no scene
  const before = await bodyCount(page);
  await page.evaluate(() => {
    const a = window.physicslab;
    a.store.setSelection([a.store.bodies()[0].id]);
  });
  await page.keyboard.press('Control+C');
  await page.keyboard.press('Control+V');
  await until(page, (n) => window.physicslab.store.bodies().length > n, before, 20000);
  assert((await sceneName(page)) !== 'Pasted scene', 'entity paste did not open a scene');

  // a paste event whose text is a scene -> confirm dialog -> opens it
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
  await page.waitForSelector('.modal');
  const dialog = await page.textContent('.modal');
  assert(/Pasted scene/.test(dialog) && /2 objects/.test(dialog), `the dialog names the scene: ${dialog}`);
  await shot(page, 'qol-paste-dialog-1600x900');
  await page.click('.modal .btn.primary');
  await until(page, () => window.physicslab.store.name === 'Pasted scene', null, 8000);
  assert((await bodyCount(page)) === 2, 'the pasted scene is loaded');
  const rec = await page.evaluate(() => JSON.parse(localStorage.getItem('physicslab:qol:recents:v1'))[0]);
  assert(rec.key === 'paste:Pasted scene', `listed as recent: ${rec.key}`);

  // plain text on the clipboard is left alone; a text field keeps its own paste
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'just some words');
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await sleep(200);
  assert(!(await page.$('.modal')), 'ordinary text does not raise a dialog');
  const prevented = await page.evaluate((text) => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    input.remove();
    return ev.defaultPrevented;
  }, text);
  assert(!prevented && !(await page.$('.modal')), 'pasting a scene into a text field is not intercepted');

  // the real Ctrl+V with a real clipboard (permissions granted for the test)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const other = await makeSceneText(page, 'Clipboard keyboard');
  await page.evaluate((t) => navigator.clipboard.writeText(t), other);
  await page.mouse.click(700, 120); // focus the page body, not a field
  await page.keyboard.press('Control+V');
  const gotDialog = await page.waitForSelector('.modal', { timeout: 4000 }).then(
    () => true,
    () => false,
  );
  assert(gotDialog, 'Ctrl+V with a scene on the clipboard offers it');
  await page.click('.modal .btn:has-text("Cancel")');
  assert((await sceneName(page)) === 'Pasted scene', 'cancelling leaves the scene alone');
  // and the File-menu command reads the clipboard explicitly
  await page.click('.menu-btn:has-text("File")');
  await page.click('.menu .menu-item:has-text("Paste scene from clipboard")');
  await page.waitForSelector('.modal');
  await page.click('.modal .btn.primary');
  await until(page, () => window.physicslab.store.name === 'Clipboard keyboard', null, 8000);
  noErrors(page);
  await page.close();
});

test('qol: layout at 1280x720 with the Present panel and the drop overlay', async () => {
  const page = await newPage('&scene=car', { width: 1280, height: 720 });
  await showTab(page, 'right', 'present');
  await page.waitForSelector('.qol-present');
  await shot(page, 'qol-present-panel-1280x720');
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('.qol-present');
    return { sw: el.scrollWidth, cw: el.clientWidth };
  });
  assert(overflow.sw <= overflow.cw + 1, `no horizontal overflow in the panel: ${JSON.stringify(overflow)}`);
  await page.keyboard.press('F10');
  await page.waitForTimeout(500);
  await shot(page, 'qol-presenting-1280x720');
  await page.keyboard.press('Escape');
  const text = await makeSceneText(page, 'Layout');
  await dropFiles(page, [{ name: 'a.json', text, type: 'application/json' }], { drop: false, hold: true });
  await page.waitForTimeout(250);
  await shot(page, 'qol-drop-overlay-1280x720');
  noErrors(page);
  await page.close();
});
