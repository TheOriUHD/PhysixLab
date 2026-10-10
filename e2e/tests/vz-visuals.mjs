/** VZ-A: materials, textures, environment, fog, ground (VZ-1..VZ-4, VZ-10..VZ-13). */
import { assert, newPage, shot, nextFrame } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const settle = async (page) => {
  await page.waitForTimeout(250);
  await nextFrame(page);
};

const setEnv = async (page, patch) => {
  await page.evaluate((p) => {
    const a = window.physicslab;
    a.store.updateSettings({ environment: { ...a.store.settings.environment, ...p } }, 'test');
  }, patch);
  await settle(page);
};

const firstBody = (page) =>
  page.evaluate(() => {
    const a = window.physicslab;
    const b = a.store.bodies().find((x) => x.shape.type === 'sphere') ?? a.store.bodies()[0];
    a.store.setSelection([b.id]);
    return b.id;
  });

const pieceMat = (page, id, field) =>
  page.evaluate(([i, f]) => {
    const m = window.physicslab.bodies.get(i).pieces[0].material;
    return f === 'map' ? !!m.map : f === 'normalMap' ? !!m.normalMap : f === 'transmission' ? m.transmission : f === 'clearcoat' ? m.clearcoat : f === 'emissive' ? m.emissive.r : null;
  }, [id, field]);

test('material editor: picker search + preset click, preview sphere, texture pattern, triplanar', async () => {
  const page = await newPage('&scene=pit&quality=low');
  await page.waitForTimeout(600);
  const id = await firstBody(page);
  await page.waitForSelector('.material-swatch');
  const presetCount = await page.locator('.material-swatch').count();
  assert(presetCount >= 35, `≥35 swatches in the picker (${presetCount})`);
  assert((await page.locator('.material-preview').count()) === 1, 'preview sphere present');
  // preview actually painted something
  const painted = await page.evaluate(() => {
    const c = document.querySelector('.material-preview');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  assert(painted > 2000, `preview sphere is painted (${painted} px)`);
  await page.fill('input[aria-label="Search materials"]', 'brass');
  assert((await page.locator('.material-swatch:visible').count()) === 1, 'search narrows to one swatch');
  await page.locator('.material-swatch:visible').click();
  const preset = await page.evaluate((i) => window.physicslab.store.body(i).material.preset, id);
  assert(preset === 'brass', `brass applied (${preset})`);
  await page.fill('input[aria-label="Search materials"]', 'carbon');
  await page.locator('.material-swatch:visible').click();
  await settle(page);
  assert(await pieceMat(page, id, 'map'), 'carbon preset renders with a map');
  assert(await pieceMat(page, id, 'normalMap'), 'carbon preset has a derived normal map');
  assert((await pieceMat(page, id, 'clearcoat')) === 1, 'carbon preset has clearcoat 1');
  await page.evaluate((i) => {
    const a = window.physicslab;
    const b = a.store.body(i);
    a.store.update(i, { material: { ...b.material, texture: { ...b.material.texture, triplanar: true } } }, 'tri');
  }, id);
  await settle(page);
  await shot(page, 'vz-material-triplanar');
  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
});

test('material: glass transmission, emissive glow and user image textures', async () => {
  const page = await newPage('&scene=pit&quality=medium');
  await page.waitForTimeout(600);
  const id = await firstBody(page);
  await page.evaluate((i) => {
    const a = window.physicslab;
    a.store.update(i, { material: { ...a.store.body(i).material, transmission: 0.9, ior: 1.5, thickness: 0.5, emissive: '#ff4400', emissiveIntensity: 2 } }, 'glass');
  }, id);
  await settle(page);
  assert(Math.abs((await pieceMat(page, id, 'transmission')) - 0.9) < 1e-6, 'transmission applied at medium quality');
  assert((await pieceMat(page, id, 'emissive')) > 0.3, 'emissive colour applied');
  // user image as albedo + a generated normal map, stored as assets
  const ok = await page.evaluate(async (i) => {
    const a = window.physicslab;
    const mk = (fill) => {
      const c = document.createElement('canvas');
      c.width = c.height = 16;
      const g = c.getContext('2d');
      g.fillStyle = fill;
      g.fillRect(0, 0, 16, 16);
      g.fillStyle = '#000';
      g.fillRect(0, 0, 8, 8);
      return c.toDataURL('image/png');
    };
    const { makeTextureAsset } = await import('/src/model/assets.ts');
    const img = a.store.addAsset(makeTextureAsset('a.png', mk('#00ff00'), 16, 16));
    const nrm = a.store.addAsset(makeTextureAsset('n.png', mk('#8080ff'), 16, 16));
    const b = a.store.body(i);
    a.store.update(i, { material: { ...b.material, transmission: 0, texture: { pattern: 'image', color2: '#fff', scale: [2, 2], rotation: 30, offset: [0.1, 0], triplanar: false, bump: 0, normalStrength: 1, imageId: img, normalId: nrm } } }, 'img');
    await new Promise((r) => setTimeout(r, 400));
    const m = a.bodies.get(i).pieces[0].material;
    return !!m.map && !!m.normalMap && m.map.repeat.x === 2 && Math.abs(m.map.rotation - Math.PI / 6) < 1e-6 && !!m.map.image;
  }, id);
  assert(ok, 'image albedo + normal map applied with UV transform and loaded');
  const refs = await page.evaluate((i) => window.physicslab.store.assetRefCount(window.physicslab.store.body(i).material.texture.imageId), id);
  assert(refs === 1, 'texture asset is referenced by the body');
  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
});

test('environment: every preset, the physical sky and tone mappings render without errors', async () => {
  const page = await newPage('&scene=pit&quality=low');
  await page.waitForTimeout(600);
  for (const sky of ['studio', 'day', 'sunset', 'night', 'physical', 'blueprint', 'space', 'lab', 'desert', 'snow', 'overcast']) {
    await setEnv(page, { sky });
    if (sky === 'physical' || sky === 'sunset') await shot(page, `vz-sky-${sky}`);
  }
  for (const toneMapping of ['aces', 'agx', 'neutral', 'linear']) {
    await setEnv(page, { toneMapping });
    const tm = await page.evaluate(() => window.physicslab.viewport.renderer.toneMapping);
    assert(typeof tm === 'number' && tm >= 0, `tone mapping ${toneMapping} → ${tm}`);
  }
  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
});

test('time of day moves the sun, its light and its shadow direction; the cycle advances', async () => {
  const page = await newPage('&scene=pit&quality=medium');
  await page.waitForTimeout(600);
  const read = () =>
    page.evaluate(() => {
      const v = window.physicslab.viewport;
      return { dir: v.sunDir.toArray(), i: v.sun.intensity, hours: v.env.hours };
    });
  await setEnv(page, { sky: 'physical', sun: { azimuth: 180, elevation: 60, intensity: 1, turbidity: 6, rayleigh: 1.5 } });
  const noon = await read();
  await setEnv(page, { sun: { azimuth: 90, elevation: 5, intensity: 1, turbidity: 6, rayleigh: 1.5 } });
  const dawn = await read();
  await setEnv(page, { sun: { azimuth: 90, elevation: -20, intensity: 1, turbidity: 6, rayleigh: 1.5 } });
  const night = await read();
  assert(noon.dir[1] > 0.8 && dawn.dir[1] < 0.2 && dawn.dir[0] > 0.9, `sun direction follows angles ${JSON.stringify([noon.dir, dawn.dir])}`);
  assert(noon.i > dawn.i && dawn.i > night.i && night.i === 0, `sun intensity ${noon.i} > ${dawn.i} > ${night.i}`);
  await setEnv(page, { timeOfDay: 6, cycle: { enabled: true, hoursPerSecond: 6 } });
  const h0 = (await read()).hours;
  await page.waitForTimeout(700);
  const h1 = (await read()).hours;
  assert(h1 !== h0, `day cycle advances (${h0} → ${h1})`);
  await setEnv(page, { cycle: { enabled: false, hoursPerSecond: 6 } });
  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
});

test('user HDRI: a .hdr stored as an asset lights the scene; removing it falls back', async () => {
  const page = await newPage('&scene=pit&quality=low');
  await page.waitForTimeout(600);
  const result = await page.evaluate(async () => {
    const a = window.physicslab;
    // 4×2 uncompressed Radiance image: bright sky on top, dark ground below
    const head = new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n');
    const px = [];
    for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) px.push(...(y === 0 ? [200, 220, 255, 129] : [40, 40, 40, 128]));
    const bytes = new Uint8Array(head.length + px.length);
    bytes.set(head);
    bytes.set(px, head.length);
    const { makeBlobAsset } = await import('/src/model/assets.ts');
    const id = a.store.addAsset(makeBlobAsset('test.hdr', 'image/vnd.radiance', bytes));
    a.store.updateSettings({ environment: { ...a.store.settings.environment, sky: 'hdri', hdri: { ...a.store.settings.environment.hdri, assetId: id, backgroundBlur: 0.3 } } }, 'hdri');
    for (let i = 0; i < 40 && !a.viewport.env.hdriReady; i++) await new Promise((r) => setTimeout(r, 100));
    return { ready: a.viewport.env.hdriReady, bg: !!a.viewport.scene.background, blur: a.viewport.scene.backgroundBlurriness };
  });
  assert(result.ready && result.bg && Math.abs(result.blur - 0.3) < 1e-6, `HDRI loaded and used: ${JSON.stringify(result)}`);
  await settle(page);
  await shot(page, 'vz-hdri');
  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
});

test('fog (linear / exponential / height) and ground types apply', async () => {
  const page = await newPage('&scene=pit&quality=low');
  await page.waitForTimeout(600);
  const fogKind = () => page.evaluate(() => {
    const f = window.physicslab.viewport.scene.fog;
    return f ? (f.isFogExp2 ? 'exp' : f.far < 0 ? 'height' : 'linear') : 'none';
  });
  assert((await fogKind()) === 'none', 'no fog by default');
  const fog = { enabled: true, color: '#9db4cc', density: 0.03, near: 5, far: 60, height: 0, falloff: 0.2 };
  for (const type of ['linear', 'exp', 'height']) {
    await setEnv(page, { fog: { ...fog, type } });
    assert((await fogKind()) === type, `fog type ${type}`);
    await shot(page, `vz-fog-${type}`);
  }
  for (const type of ['checker', 'plain', 'water', 'none', 'grid']) {
    await page.evaluate((t) => {
      const a = window.physicslab;
      a.store.updateSettings({ ground: { ...a.store.settings.ground, type: t } }, 'g');
    }, type);
    await settle(page);
    const vis = await page.evaluate(() => {
      const v = window.physicslab.viewport;
      return { slab: v.slab.visible, grid: v.grid.visible, map: !!v.slab.material.map, nrm: !!v.slab.material.normalMap };
    });
    const want = { checker: [true, false, true, false], plain: [true, false, false, false], water: [true, false, false, true], none: [false, false, false, false], grid: [true, true, false, false] }[type];
    assert(JSON.stringify([vis.slab, vis.grid, vis.map, vis.nrm]) === JSON.stringify(want), `ground ${type}: ${JSON.stringify(vis)}`);
    if (type === 'water' || type === 'checker') await shot(page, `vz-ground-${type}`);
  }
  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
});

test('World panel: environment controls edit the scene settings', async () => {
  const page = await newPage('&scene=pit&quality=low');
  await page.waitForTimeout(600);
  await page.evaluate(() => window.physicslab.store.setSelection([]));
  await page.getByText('World', { exact: true }).first().click().catch(() => {});
  const found = await page.evaluate(() => [...document.querySelectorAll('.section-head span')].map((e) => e.textContent));
  assert(['Sky & sun', 'Display', 'Fog', 'Ground look'].every((t) => found.includes(t)), `world sections present: ${found.join(', ')}`);
  await shot(page, 'vz-world-panel');
});
