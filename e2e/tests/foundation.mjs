/**
 * Foundation end-to-end tests: the shape registry driving the palette, shortcuts and inspector, loading
 * old (v1) and damaged scene files, compound bodies, per-body physics fields and the asset store.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, near, newPage, nextFrame, root, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const fixture = (name) => readFileSync(join(root, 'tests', 'fixtures', name));

test('shape registry: palette, number keys and the prism inspector come from the registry', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physicslab.newScene());
  const reg = await page.evaluate(async () => {
    const { listShapes } = await import('/src/model/shapeRegistry.ts');
    return listShapes().map((d) => ({ id: d.id, label: d.label }));
  });
  // the original eight come first (the number keys depend on it); shape packages append after them
  const CORE = 'box,sphere,cylinder,capsule,cone,wedge,prism,icosahedron';
  assert(
    reg
      .slice(0, 8)
      .map((d) => d.id)
      .join() === CORE,
    `the eight original shapes come first (${reg.map((d) => d.id).join()})`,
  );
  // -- SH: the palette groups the registry by category, so compare as sets and check the order inside each group
  const tiles = await page.locator('.panel.left .shape-tile').allTextContents();
  assert(
    tiles
      .map((t) => t.trim())
      .sort()
      .join() ===
      reg
        .map((d) => d.label)
        .sort()
        .join(),
    `palette tiles follow the registry: ${tiles.join()}`,
  );
  const inGroups = await page
    .locator('.panel.left .shape-tiles')
    .evaluateAll((groups) => groups.map((g) => [...g.querySelectorAll('.shape-tile')].map((t) => t.dataset.shape)));
  const position = new Map(reg.map((d, i) => [d.id, i]));
  assert(
    inGroups.every((ids) => ids.every((id, i) => i === 0 || position.get(ids[i - 1]) < position.get(id))),
    `registry order is kept inside each category: ${JSON.stringify(inGroups)}`,
  );
  // the number keys address the registry order (7 = prism)
  await page.click('.viewport-canvas', { position: { x: 700, y: 400 } });
  await page.keyboard.press('7');
  await page.keyboard.press('Enter');
  const prism = await page.evaluate(() => {
    const b = window.physicslab.store.bodies()[0];
    return { type: b.shape.type, params: b.shape.params, id: b.id };
  });
  assert(
    prism.type === 'prism' && prism.params.sides === 6,
    `key 7 adds a prism with default sides ${JSON.stringify(prism)}`,
  );
  // the inspector shows the registry's parameter schema for it
  await page.waitForSelector('.panel.right .row:has(.row-label:text-is("Sides"))');
  const sides = page.locator('.panel.right .row:has(.row-label:text-is("Sides")) .num-input:visible');
  await sides.fill('9');
  await sides.press('Enter');
  const after = await page.evaluate((id) => window.physicslab.store.body(id).shape.params.sides, prism.id);
  assert(after === 9, `sides edited through the generated field (got ${after})`);
  // the rendered mesh follows: a 9-sided prism has more vertices than a 6-sided one
  const verts = await page.evaluate(
    (id) => window.physicslab.bodies.get(id).mesh.geometry.getAttribute('position').count,
    prism.id,
  );
  assert(verts > 60, `prism mesh rebuilt for 9 sides (${verts} vertices)`);
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate((id) => window.physicslab.store.body(id).shape.params.sides, prism.id);
  assert(undone === 6, `undo restores the parameter (got ${undone})`);
  await shot(page, 'fb-prism-inspector');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('scene files: a v1 file upgrades on import and a damaged one is repaired with a warning', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physicslab.newScene());
  // 1. the scene written by the first release
  await page.setInputFiles('input[type=file]', {
    name: 'legacy.json',
    mimeType: 'application/json',
    buffer: fixture('scene-v1.json'),
  });
  await page.waitForFunction(() => window.physicslab.store.name === 'Legacy kitchen sink', null, { timeout: 10000 });
  const legacy = await page.evaluate(() => {
    const d = window.physicslab.store.toDocument();
    const pent = d.entities.find((e) => e.name === 'Pentagon');
    return {
      version: d.version,
      assets: d.assets,
      sides: pent.shape.params.sides,
      legacy: 'sides' in pent.shape,
      gravity: d.settings.gravity,
    };
  });
  assert(
    legacy.version === 3 && Object.keys(legacy.assets).length === 0,
    `upgraded to the current format (v3) ${JSON.stringify(legacy)}`,
  );
  assert(legacy.sides === 5 && !legacy.legacy, 'prism side count moved into shape.params');
  near(legacy.gravity[1], -3.7, 1e-9, 'authored gravity survives');
  // it simulates
  await page.keyboard.press('Space');
  await simTime(page, 0.5);
  await page.keyboard.press('Space');
  await page.click('.tbtn[title^="Stop"]');
  // 2. a file naming a shape this build does not have
  const broken = JSON.parse(fixture('scene-v1.json').toString());
  broken.name = 'From the future';
  broken.entities[0].shape = { type: 'tesseract', size: [2, 2, 2] };
  await page.evaluate(() => window.physicslab.store.update(window.physicslab.store.bodies()[0].id, { name: 'dirty' }));
  await page.setInputFiles('input[type=file]', {
    name: 'odd.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(broken)),
  });
  await page.waitForSelector('.modal button:has-text("Replace scene")');
  await page.click('.modal button:has-text("Replace scene")');
  await page.waitForFunction(() => window.physicslab.store.name === 'From the future', null, { timeout: 10000 });
  const toast = await page.locator('.toast.warn').first().textContent();
  assert(/Unknown shape "tesseract"/.test(toast ?? ''), `a warning explains the repair: ${toast}`);
  const type = await page.evaluate(() => window.physicslab.store.bodies()[0].shape.type);
  assert(type === 'box', `unknown shape became a box (${type})`);
  // 3. a newer file is refused with a message that says what to do
  const future = JSON.parse(fixture('scene-v1.json').toString());
  future.version = 99;
  await page.setInputFiles('input[type=file]', {
    name: 'future.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(future)),
  });
  await page.waitForSelector('.toast.error');
  const err = await page.locator('.toast.error').first().textContent();
  assert(/newer version of PhysicsLab/.test(err ?? ''), `newer format rejected clearly: ${err}`);
  assert(
    (await page.evaluate(() => window.physicslab.store.name)) === 'From the future',
    'the open scene is untouched',
  );
  await shot(page, 'fb-import-warnings');
});

test('share links: a link from a newer version or a damaged link says so instead of opening another scene', async () => {
  // Build the links in one page, then close it: several live WebGL pages starve each other under software GL.
  const maker = await newPage();
  await maker.evaluate(() => window.physicslab.store.setName('Shared one'));
  const link = (version) =>
    maker.evaluate(async (version) => {
      const doc = JSON.parse(JSON.stringify(window.physicslab.store.toDocument()));
      if (version) doc.version = version;
      const stream = new Blob([JSON.stringify(doc)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const buf = new Uint8Array(await new Response(stream).arrayBuffer());
      let bin = '';
      for (const b of buf) bin += String.fromCharCode(b);
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }, version);
  const future = await link(99);
  const good = await link(0);
  await maker.close();
  // a link written by a newer release
  const p1 = await newPage(`#scene=${future}`);
  await p1.waitForSelector('.toast.error');
  const err = await p1.locator('.toast.error').first().textContent();
  assert(/newer version of PhysicsLab/.test(err ?? ''), `newer format explained: ${err}`);
  assert(p1.errors.length === 0, `no errors: ${p1.errors.join(' | ')}`);
  assert(await p1.evaluate(() => window.physicslab.store.size > 0), 'a fallback scene is loaded');
  await p1.close();
  // a truncated link
  const p2 = await newPage(`#scene=${good.slice(0, 40)}`);
  await p2.waitForSelector('.toast.error');
  const err2 = await p2.locator('.toast.error').first().textContent();
  assert(/share link is damaged/.test(err2 ?? ''), `damaged link explained: ${err2}`);
  assert(await p2.evaluate(() => window.physicslab.store.size > 0), 'a fallback scene is loaded');
  await p2.close();
  // and a good link still opens the shared scene
  const p3 = await newPage(`#scene=${good}`);
  await p3.waitForSelector('.toast.success:has-text("Opened shared scene")');
  assert((await p3.evaluate(() => window.physicslab.store.name)) === 'Shared one', 'the shared scene is open');
});

/** Build a three-part dumbbell (red sphere, blue sphere, grey bar) inside the page and add it to the scene. */
const addDumbbell = (page, at = [0, 3, 0]) =>
  page.evaluate(async (at) => {
    const { createBody } = await import('/src/model/factory.ts');
    const { makePart } = await import('/src/model/compound.ts');
    const a = window.physicslab;
    const body = createBody({
      name: 'Dumbbell',
      shape: { type: 'box', size: [2.6, 0.6, 0.6] },
      position: at,
      material: { preset: 'steel', density: 2000 },
      parts: [
        makePart({
          shape: { type: 'sphere', size: [0.6, 0.6, 0.6] },
          position: [-1, 0, 0],
          material: { color: '#e5484d' },
        }),
        makePart({
          shape: { type: 'sphere', size: [0.6, 0.6, 0.6] },
          position: [1, 0, 0],
          material: { color: '#3e63dd' },
        }),
        makePart({ shape: { type: 'cylinder', size: [0.16, 2, 0.16] }, rotation: [0, 0, 0.7071, 0.7071] }),
      ],
    });
    a.store.add([body]);
    return body.id;
  }, at);

/** Client-space position of a world point (waits for a fresh frame first). */
const screenPoint = async (page, world) => {
  await nextFrame(page);
  return page.evaluate((w) => {
    const a = window.physicslab;
    const v = new a.camera.position.constructor(...w).project(a.camera);
    const r = a.viewport.dom.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }, world);
};

test('compound bodies: every part is drawn, picked, outlined, simulated and scaled', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physicslab.newScene());
  const id = await addDumbbell(page, [0, 1.2, 0]);
  await page.evaluate(() => {
    window.physicslab.store.setSelection([]);
    window.physicslab.viewport.setView({ position: [0, 3, 7], target: [0, 1, 0] });
  });
  await page.waitForTimeout(300);
  // one mesh per part under a group, each tagged with the entity for picking
  const info = await page.evaluate((id) => {
    const v = window.physicslab.bodies.get(id);
    return {
      compound: v.compound,
      n: v.pieces.length,
      root: v.mesh.type,
      tags: v.pieces.every((p) => p.mesh.userData.entityId === id),
    };
  }, id);
  assert(
    info.compound && info.n === 3 && info.root === 'Group' && info.tags,
    `three part meshes under a group ${JSON.stringify(info)}`,
  );
  const pickables = await page.evaluate(
    (id) => window.physicslab.bodies.pickables().filter((m) => m.userData.entityId === id).length,
    id,
  );
  assert(pickables === 3, `all parts are pick targets (${pickables})`);

  // clicking either sphere or the bar selects the body; empty ground does not
  for (const [name, world] of [
    ['red sphere', [-1, 1.2, 0]],
    ['blue sphere', [1, 1.2, 0]],
    ['bar', [0.05, 1.2, 0]],
  ]) {
    await page.evaluate(() => window.physicslab.store.setSelection([]));
    const p = await screenPoint(page, world);
    await page.mouse.click(p.x, p.y);
    const sel = await page.evaluate(() => window.physicslab.store.selection.slice());
    assert(sel.length === 1 && sel[0] === id, `clicking the ${name} selects the dumbbell (${sel})`);
  }
  // the selection outline targets the whole group; the inspector says it is a compound of three parts
  const outlined = await page.evaluate((id) => {
    const a = window.physicslab;
    return a.viewport.outline.selectedObjects.includes(a.bodies.get(id).mesh);
  }, id);
  assert(outlined, 'the outline pass is given the compound body root');
  await page.waitForSelector('.panel.right .row:has(.row-label:text-is("Compound"))');
  const txt = await page.locator('.panel.right .row:has(.row-label:text-is("Compound")) .readout').textContent();
  assert(/3 collider parts/.test(txt ?? ''), `inspector row: ${txt}`);
  const mass = await page.locator('.panel.right .row:has(.row-label:text-is("Mass")) .readout').textContent();
  assert(/kg/.test(mass ?? ''), `mass preview: ${mass}`);
  await shot(page, 'fb-compound-edit');

  // editing the parts rebuilds the view and keeps the outline attached
  await page.evaluate(async (id) => {
    const { makePart } = await import('/src/model/compound.ts');
    const a = window.physicslab;
    const b = a.store.body(id);
    a.store.update(
      id,
      {
        parts: [
          ...b.parts,
          makePart({
            shape: { type: 'cone', size: [0.5, 0.8, 0.5] },
            position: [0, 0.6, 0],
            material: { color: '#30a46c' },
          }),
        ],
      },
      'Add part',
    );
  }, id);
  const rebuilt = await page.evaluate((id) => {
    const a = window.physicslab;
    const v = a.bodies.get(id);
    return { n: v.pieces.length, outlined: a.viewport.outline.selectedObjects.includes(v.mesh), y: v.mesh.position.y };
  }, id);
  assert(
    rebuilt.n === 4 && rebuilt.outlined && Math.abs(rebuilt.y - 1.2) < 1e-6,
    `view rebuilt with the new part ${JSON.stringify(rebuilt)}`,
  );
  await page.keyboard.press('Control+z');
  assert(
    (await page.evaluate((id) => window.physicslab.bodies.get(id).pieces.length, id)) === 3,
    'undo removes the part again',
  );

  // scaling the body (what the scale gizmo does) scales every part with it
  const scaled = await page.evaluate((id) => {
    const a = window.physicslab;
    const b = a.store.body(id);
    a.editor.applyGizmo([
      {
        id,
        position: b.position,
        rotation: b.rotation,
        scale: [b.shape.size[0] * 2, b.shape.size[1] * 2, b.shape.size[2] * 2],
      },
    ]);
    const nb = a.store.body(id);
    return {
      redX: nb.parts[0].position[0],
      d: nb.parts[0].shape.size[0],
      viewX: a.bodies.get(id).pieces[0].mesh.position.x,
    };
  }, id);
  near(scaled.redX, -2, 1e-9, 'part positions scale with the body');
  near(scaled.d, 1.2, 1e-9, 'part sizes scale with the body');
  near(scaled.viewX, -2, 1e-9, 'the part mesh follows');
  await page.keyboard.press('Control+z');

  // simulating: the body falls and tumbles, and every part mesh stays rigidly attached to the pose
  await page.evaluate(
    (id) => window.physicslab.store.update(id, { angularVelocity: [0, 0, 2], position: [0, 4, 0] }),
    id,
  );
  await page.keyboard.press('Space');
  await simTime(page, 0.6);
  await page.keyboard.press('Space');
  // let the frames already in flight land, so the meshes and the pose buffer describe the same instant
  await page.waitForTimeout(600);
  await nextFrame(page);
  await nextFrame(page);
  const rigid = await page.evaluate((id) => {
    const a = window.physicslab;
    const v = a.bodies.get(id);
    const p = a.sim.poseOf(id);
    v.mesh.updateWorldMatrix(true, true);
    const T = v.mesh.position.constructor;
    const Q = v.mesh.quaternion.constructor;
    const q = new Q(...p.rotation);
    const b = a.store.body(id);
    let worst = 0;
    v.pieces.forEach((piece, i) => {
      const expected = new T(...b.parts[i].position).applyQuaternion(q).add(new T(...p.position));
      const got = piece.mesh.getWorldPosition(new T());
      worst = Math.max(worst, expected.distanceTo(got));
    });
    return { worst, y: p.position[1], tilt: Math.abs(p.rotation[2]) };
  }, id);
  assert(rigid.worst < 1e-3, `part meshes follow the simulated pose (worst error ${rigid.worst})`);
  assert(rigid.y < 4 && rigid.tilt > 0.05, `it fell and rotated (y=${rigid.y}, qz=${rigid.tilt})`);
  await shot(page, 'fb-compound-sim');
  // physics really uses all three colliders: the engine mass is the sum of the parts
  const engineMass = await page.evaluate((id) => window.physicslab.sim.client.info.mass[id], id);
  const want = await page.evaluate(async (id) => {
    const { naturalMass } = await import('/src/model/compound.ts');
    return naturalMass(window.physicslab.store.body(id));
  }, id);
  near(engineMass / want, 1, 0.01, `engine mass ${engineMass} vs Σ parts ${want}`);
  await page.click('.tbtn[title^="Stop"]');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('asset store: assets travel in share links, autosave and exported files; unused ones are collected', async () => {
  const page = await newPage();
  const ids = await page.evaluate(async () => {
    const { makeMeshAsset, makeBlobAsset } = await import('/src/model/assets.ts');
    const { createBody } = await import('/src/model/factory.ts');
    const a = window.physicslab;
    a.newScene();
    // a quad mesh, referenced by a body, and a spare blob nothing uses
    const used = a.store.addAsset(
      makeMeshAsset('Quad', {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
        indices: [0, 1, 2, 0, 2, 3],
        uvs: [0, 0, 1, 0, 1, 1, 0, 1],
      }),
    );
    const spare = a.store.addAsset(makeBlobAsset('Spare', 'text/plain', new TextEncoder().encode('not referenced')));
    // adding the same content again returns the same id and does not grow the store
    const again = a.store.addAsset(
      makeMeshAsset('Quad (copy)', {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
        indices: [0, 1, 2, 0, 2, 3],
        uvs: [0, 0, 1, 0, 1, 1, 0, 1],
      }),
    );
    a.store.add([createBody({ name: 'Mesh body', shape: { type: 'box' }, position: [0, 1, 0], meshId: used })]);
    return { used, spare, again, held: Object.keys(a.store.assets).length };
  });
  assert(ids.again === ids.used && ids.held === 2, `identical content is stored once ${JSON.stringify(ids)}`);

  // 1. share link: only the referenced asset travels, byte for byte
  const shared = await page.evaluate(async () => {
    const a = window.physicslab;
    const { Persistence } = await import('/src/app/persistence.ts');
    const url = await a.persistence.shareLink();
    const back = await Persistence.fromHash(new URL(url).hash);
    return {
      keys: Object.keys(back.assets),
      same:
        JSON.stringify(Object.values(back.assets)[0]) ===
        JSON.stringify(Object.values(a.store.assets).find((x) => x.kind === 'mesh')),
      ref: back.entities[0].meshId,
    };
  });
  assert(
    shared.keys.length === 1 && shared.same && shared.ref === ids.used,
    `share link carries the used asset only ${JSON.stringify(shared)}`,
  );

  // 2. autosave in browser storage
  const auto = await page.evaluate(async () => {
    const a = window.physicslab;
    a.persistence.saveNow();
    await a.persistence.flush();
    // -- DT-10: the autosave lives in IndexedDB now (meta/autosave) --
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('physicslab');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const raw = await new Promise((res, rej) => {
      const q = db.transaction('meta').objectStore('meta').get('autosave');
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    db.close();
    const doc = JSON.parse(raw);
    return { keys: Object.keys(doc.assets), version: doc.version };
  });
  assert(auto.keys.length === 1 && auto.keys[0] === ids.used && auto.version === 3, `autosave ${JSON.stringify(auto)}`);

  // 3. exported file, then imported again into a fresh scene
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => window.physicslab.persistence.exportFile()),
  ]);
  const text = readFileSync(await download.path(), 'utf8');
  const exported = JSON.parse(text);
  assert(
    Object.keys(exported.assets).join() === ids.used && exported.version === 3,
    'the exported file contains the used asset',
  );
  assert(
    !('Spare' in Object.fromEntries(Object.values(exported.assets).map((x) => [x.name, 1]))),
    'the unused asset was collected on save',
  );
  await page.evaluate(() => window.physicslab.newScene());
  await page.setInputFiles('input[type=file]', {
    name: 'with-assets.physicslab.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await page.waitForFunction(() => window.physicslab.store.bodies().length === 1, null, { timeout: 10000 });
  const reloaded = await page.evaluate(() => {
    const a = window.physicslab;
    const b = a.store.bodies()[0];
    return {
      mesh: a.store.getAsset(b.meshId)?.kind,
      refs: a.store.assetRefCount(b.meshId),
      unused: a.store.unusedAssets().length,
    };
  });
  assert(
    reloaded.mesh === 'mesh' && reloaded.refs === 1 && reloaded.unused === 0,
    `import restores the asset and its reference ${JSON.stringify(reloaded)}`,
  );

  // 4. removing an asset unlinks it, and undo brings everything back
  const undo = await page.evaluate(() => {
    const a = window.physicslab;
    const b = a.store.bodies()[0];
    const id = b.meshId;
    a.store.removeAsset(id);
    const gone = !a.store.getAsset(id) && a.store.body(b.id).meshId === undefined;
    a.store.undo();
    return { gone, back: !!a.store.getAsset(id) && a.store.body(b.id).meshId === id };
  });
  assert(undo.gone && undo.back, `remove + undo ${JSON.stringify(undo)}`);

  // 5. a scene too big for a link says so instead of producing a useless URL
  const tooBig = await page.evaluate(async () => {
    const { makeBlobAsset } = await import('/src/model/assets.ts');
    const { createBody } = await import('/src/model/factory.ts');
    const a = window.physicslab;
    const noise = new Uint8Array(300_000);
    for (let i = 0; i < noise.length; i += 65536)
      crypto.getRandomValues(noise.subarray(i, Math.min(noise.length, i + 65536)));
    const id = a.store.addAsset(makeBlobAsset('Noise', 'application/octet-stream', noise));
    a.store.add([createBody({ shape: { type: 'box' }, meshId: id })]); // referenced, so it would be saved
    try {
      await a.persistence.shareLink();
      return 'no error';
    } catch (e) {
      return e.message;
    }
  });
  assert(/too large for a share link/.test(tooBig) && /Export it as a file/.test(tooBig), `big scene: ${tooBig}`);
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});

test('world settings: sub-steps from the World tab reach the store and a running simulation', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    const a = window.physicslab;
    a.newScene();
    a.editor.addShape('sphere', [0, 4, 0]);
  });
  await page.click('.panel.right .tab:has-text("World")');
  const subs = page.locator('.panel.right .row:has(.row-label:text-is("Sub-steps")) .num-input:visible');
  await subs.fill('4');
  await subs.press('Enter');
  const set = await page.evaluate(() => window.physicslab.store.settings);
  assert(set.substeps === 4, `sub-steps stored (${set.substeps})`);
  assert(
    set.seed === 1 && set.bounds.enabled === false && set.units.length === 'm',
    'the other v2 settings keep their defaults',
  );
  await shot(page, 'fb-world-substeps');
  // simulate: the fixed step still advances by 1/120 s per step while the engine takes four sub-steps
  await page.keyboard.press('Space');
  await simTime(page, 0.5);
  await subs.fill('8'); // live change while running
  await subs.press('Enter');
  await page.waitForTimeout(400);
  const y1 = (await page.evaluate(() => window.physicslab.sim.poseOf(window.physicslab.store.bodies()[0].id)))
    .position[1];
  await simTime(page, 1.5);
  const info = await page.evaluate(() => ({
    t: window.physicslab.sim.client.stats.simTime,
    steps: window.physicslab.sim.client.stats.stepCount,
    y: window.physicslab.sim.poseOf(window.physicslab.store.bodies()[0].id).position[1],
  }));
  assert(Math.abs(info.t - info.steps / 120) < 1e-3, `simulated time is steps / 120 Hz (${info.t} vs ${info.steps})`);
  assert(info.y < y1 || info.y < 0.6, `the ball keeps falling / settles (y ${y1} -> ${info.y})`);
  await page.click('.tbtn[title^="Stop"]');
  await page.keyboard.press('Control+z');
  assert((await page.evaluate(() => window.physicslab.store.settings.substeps)) === 4, 'undo steps the setting back');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
});
