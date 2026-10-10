/**
 * Visual effects (package FX): particles, impact effects, tyre smoke and skid marks, explosions, and the Effects
 * panel, driven through the real UI in the real renderer. Screenshots (E2E_SHOTS=1) go to e2e/out/fx-*.png.
 */
import { assert, newPage, screenOf, shot, simTime } from '../helpers.mjs';

// The graphics Auto governor drops software-GL runs to the Low tier (no explosion light, smaller particle budget): the
// effects are tested at the Medium tier they were written for.
export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const stats = (page) =>
  page.evaluate(() => ({ ...window.physicslab.fxDirector.stats, time: window.physicslab.fx.time }));
const noErrors = (page) => assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
const play = (page) => page.evaluate(() => window.physicslab.sim.play());
const pause = (page) => page.evaluate(() => window.physicslab.sim.pause());

test('fx: Effects panel — master switch, quality and intensity drive the system and persist', async () => {
  const page = await newPage('&quality=medium');
  await page.click('#tab-fx');
  await page.waitForSelector('.fx-panel .section-head:has-text("Visual effects")');
  await shot(page, 'fx-panel');
  let s = await page.evaluate(() => window.physicslab.fx.settings);
  assert(s.enabled && s.quality === 'auto' && s.intensity === 1, `defaults ${JSON.stringify(s)}`);

  // Master switch: the labelled switch toggles effects, the dependent sections are dimmed.
  await page.click('.fx-panel label.switch:has-text("Visual effects")');
  s = await page.evaluate(() => window.physicslab.fx.settings);
  assert(s.enabled === false, 'master off');
  assert(
    await page.evaluate(() => document.querySelector('.fx-panel .section.fx-dim').classList.contains('fx-disabled')),
    'sections dimmed',
  );
  assert(await page.evaluate(() => window.physicslab.prefs.value.fx.enabled === false), 'stored in the preferences');
  await page.waitForTimeout(350); // the switch animation
  await shot(page, 'fx-panel-off');
  await page.click('.fx-panel label.switch:has-text("Visual effects")');

  // Quality select and per-effect switch.
  await page.selectOption('.fx-panel select', 'high');
  s = await page.evaluate(() => ({ q: window.physicslab.fx.settings.quality, tier: window.physicslab.fx.tier.id }));
  assert(s.q === 'high' && s.tier === 'high', `quality ${JSON.stringify(s)}`);
  await page.click('.fx-panel label.switch:has-text("Skid marks")');
  assert(await page.evaluate(() => window.physicslab.fx.settings.skidMarks === false), 'skid marks off');

  // Persisted: reload and read the settings back.
  await page.reload();
  await page.waitForFunction(() => !!window.physicslab && window.physicslab.viewport);
  s = await page.evaluate(() => window.physicslab.fx.settings);
  assert(s.quality === 'high' && s.skidMarks === false && s.enabled === true, `after reload ${JSON.stringify(s)}`);
  noErrors(page);
});

test('fx: ball pit — 300 balls fill the pit within the particle budget, and Reset clears every particle', async () => {
  const page = await newPage('&scene=pit&quality=medium');
  await page.evaluate(() => window.physicslab.viewport.setView({ position: [0, 8.5, 5.5], target: [0, 0.2, 0] }));
  assert((await stats(page)).contactsWatched === true, 'contact events are requested from the physics');
  await play(page);
  await page.waitForFunction(() => window.physicslab.fx.stats.spawned > 400, null, { timeout: 60000 });
  const s = await stats(page);
  assert(s.live > 0 && s.bursts > 20, `bursts ${s.bursts}, live ${s.live}`);
  assert(s.live <= s.budget, `within the particle budget (${s.live} / ${s.budget})`);
  await pause(page);
  await page.waitForTimeout(400);
  await shot(page, 'fx-ball-pit');
  await page.evaluate(() => window.physicslab.sim.reset());
  await page.waitForTimeout(200);
  const after = await stats(page);
  assert(after.live === 0 && after.skidSegments === 0, 'reset clears the effects');
  noErrors(page);
});

test('fx: ball drop — sparks, dust, chips, shards and scuffs follow the materials, scaled by the impact', async () => {
  const page = await newPage('&quality=medium');
  await page.evaluate(async () => {
    const { Builder } = await import('/src/model/builder.ts');
    const b = new Builder('Impact balls');
    const mats = ['steel', 'rubber', 'wood', 'glass', 'concrete', 'plastic'];
    for (let i = 0; i < 36; i++) {
      const m = mats[i % mats.length];
      const a = i * 2.399963;
      const r = Math.sqrt((i + 0.5) / 36) * 3.4;
      b.body(`${m} ball`, 'sphere', [0.5, 0.5, 0.5], [Math.cos(a) * r, 1.2 + (i % 6) * 0.9, Math.sin(a) * r], {
        material: m,
      });
    }
    const a = window.physicslab;
    a.loadDocument(b.done());
    a.viewport.setView({ position: [0.5, 2.4, 8.5], target: [0, 0.7, 0] });
  });
  await play(page);
  // Wait for every kind (the balls land at different times; pausing at "18 bursts" raced with the slow ones).
  await page.waitForFunction(
    () => {
      const by = window.physicslab.fx.emittedByType();
      return (
        window.physicslab.fx.stats.bursts >= 18 &&
        ['spark', 'dust', 'chip.wood', 'shard.glass', 'scuff.rubber', 'chip.stone'].every((t) => by[t] > 0)
      );
    },
    null,
    { timeout: 60000 },
  );
  await pause(page);
  await page.waitForTimeout(500);
  await shot(page, 'fx-ball-drop');
  const by = await page.evaluate(() => window.physicslab.fx.emittedByType());
  for (const t of ['spark', 'dust', 'chip.wood', 'shard.glass', 'scuff.rubber', 'chip.stone'])
    assert(by[t] > 0, `${t} was emitted (${JSON.stringify(by)})`);
  assert(by['glint'] > 0, 'glass glints');
  noErrors(page);
});

test('fx: car braking skid — slipping wheels smoke and leave skid marks; Reset clears them', async () => {
  const page = await newPage('&scene=car&quality=medium');
  await page.evaluate(async () => {
    const { buildCar } = await import('/src/model/templates.ts');
    const a = window.physicslab;
    a.loadDocument(buildCar(false)); // the car on an empty ground: no ramp to jump
    a.prefs.set({ followSelection: false });
    a.viewport.setView({ position: [5, 2.2, 6], target: [3, 0.3, 0] });
  });
  await play(page);
  await simTime(page, 0.3);
  await page.keyboard.down('KeyW');
  await simTime(page, 1.9);
  await page.keyboard.up('KeyW');
  await page.keyboard.down('KeyS'); // hard on the brakes: the rear wheels fight the car's speed
  await page.waitForFunction(() => window.physicslab.fx.stats.skidSegments > 8, null, { timeout: 60000 });
  const during = await page.evaluate(() => ({
    smoke: window.physicslab.fx.emittedByType()['smoke.tyre'] ?? 0,
    dust: window.physicslab.fx.emittedByType()['dust.trail'] ?? 0,
    segments: window.physicslab.fx.stats.skidSegments,
  }));
  assert(during.segments > 8, `skid marks laid (${during.segments})`);
  assert(during.smoke > 0, `tyre smoke emitted (${during.smoke})`);
  assert(during.dust > 0, `a dust trail behind the fast car (${during.dust})`);
  await page.keyboard.up('KeyS');
  await page.evaluate(() => {
    const a = window.physicslab;
    const car = a.sim.poseOf(a.store.bodies().find((b) => b.name === 'Chassis').id).position;
    a.viewport.setView({ position: [car[0] - 2.5, 1.7, car[2] + 5], target: [car[0] - 3.5, 0.1, car[2]] });
  });
  await pause(page);
  await page.waitForTimeout(600);
  await shot(page, 'fx-car-skid');
  assert((await stats(page)).skidSegments > 8, 'the marks stay while the simulation is paused');
  await page.evaluate(() => window.physicslab.sim.reset());
  await page.waitForTimeout(200);
  assert((await stats(page)).skidSegments === 0, 'Reset clears the skid marks');
  noErrors(page);
});

test('fx: blast tool — fireball, shock ring, debris, smoke and a light flash', async () => {
  const page = await newPage('&scene=wreck&quality=medium');
  await page.evaluate(() => {
    const a = window.physicslab;
    a.viewport.setView({ position: [3, 4, 14], target: [3, 2, 0] });
    a.setTool('blast');
  });
  await play(page);
  await simTime(page, 0.05);
  const wallBrick = await page.evaluate(() => {
    const b = window.physicslab.store.bodies().find((e) => /brick/i.test(e.name));
    return b ? b.id : null;
  });
  assert(wallBrick, 'the scene has a wall to blast');
  const p = await screenOf(page, wallBrick);
  await page.mouse.click(p.x, p.y);
  await page.waitForFunction(() => window.physicslab.fx.stats.explosions >= 1, null, { timeout: 30000 });
  const peak = await page.evaluate(() => window.physicslab.fx.flashIntensity);
  assert(peak > 50, `the light flash is on (${peak} cd)`);
  // Let the explosion develop a little, then freeze the frame.
  const t0 = (await stats(page)).time;
  await page.waitForFunction((t) => window.physicslab.fx.time > t + 0.28, t0, { timeout: 30000 });
  await pause(page);
  await page.waitForTimeout(500);
  const kinds = await page.evaluate(() => {
    const fx = window.physicslab.fx;
    return Object.fromEntries(
      ['blast.fire', 'blast.ring', 'blast.flash', 'spark.hot', 'debris', 'smoke.dark'].map((t) => [
        t,
        fx.liveOfType(t),
      ]),
    );
  });
  assert(
    kinds['blast.fire'] > 0 && kinds['smoke.dark'] > 0 && kinds['spark.hot'] > 0 && kinds['debris'] > 0,
    `explosion parts ${JSON.stringify(kinds)}`,
  );
  await shot(page, 'fx-blast');
  noErrors(page);
});

test('fx: switched off — nothing is emitted, no contact events are requested, the blast keeps its plain shock wave', async () => {
  const page = await newPage('&scene=pit&quality=medium');
  await page.evaluate(() => window.physicslab.fxDirector.setSettings({ enabled: false }));
  assert((await stats(page)).contactsWatched === false, 'no contact events requested');
  await play(page);
  await simTime(page, 1.4);
  const s = await stats(page);
  assert(s.spawned === 0 && s.live === 0, `nothing emitted (${s.spawned})`);
  const shock = await page.evaluate(() => {
    const a = window.physicslab;
    a.setTool('blast');
    return a.fxDirector.blast({ x: 0, y: 1, z: 0 }, 7, 60);
  });
  assert(shock === false, 'the director declines, so the caller draws the plain shock wave');
  noErrors(page);
});

test('fx: determinism — the same scene seed gives the same effects, another seed does not (single-stepped runs)', async () => {
  const page = await newPage('&quality=medium');
  await page.evaluate(async () => {
    const { Builder } = await import('/src/model/builder.ts');
    const b = new Builder('Seeded drop');
    const mats = ['steel', 'wood', 'glass', 'concrete'];
    for (let i = 0; i < 16; i++) {
      const a = i * 2.399963;
      const r = Math.sqrt((i + 0.5) / 16) * 2.4;
      b.body('Ball', 'sphere', [0.5, 0.5, 0.5], [Math.cos(a) * r, 0.9 + (i % 4) * 0.7, Math.sin(a) * r], {
        material: mats[i % 4],
      });
    }
    const doc = b.done();
    doc.settings.seed = 5;
    window.physicslab.loadDocument(doc);
  });
  const stepTo = async (steps) => {
    for (let done = 0; done < steps; done += 10) {
      const f = await page.evaluate(() => {
        const a = window.physicslab;
        a.sim.step(10);
        return a.sim.client.frameNo;
      });
      await page.waitForFunction((f) => window.physicslab.sim.client.frameNo > f, f, { timeout: 30000 });
      await page.waitForTimeout(30); // a render frame consumes the events
    }
  };
  const run = async () => {
    await stepTo(130);
    await page.waitForTimeout(150);
    return page.evaluate(() => ({
      digest: window.physicslab.fx.digest(),
      emitted: window.physicslab.fx.emittedByType(),
      live: window.physicslab.fx.stats.live,
    }));
  };
  const a = await run();
  assert(a.live > 0 && Object.keys(a.emitted).length >= 2, `effects happened: ${JSON.stringify(a.emitted)}`);
  await page.evaluate(() => window.physicslab.sim.reset());
  await page.waitForTimeout(200);
  const b = await run();
  assert(b.digest === a.digest, `same seed, same particles (${a.digest} vs ${b.digest})`);
  assert(JSON.stringify(b.emitted) === JSON.stringify(a.emitted), 'same effects emitted');
  await page.evaluate(() => window.physicslab.sim.reset());
  await page.evaluate(() => window.physicslab.store.updateSettings({ seed: 6 }, 'seed'));
  await page.waitForTimeout(200);
  const c = await run();
  assert(c.digest !== a.digest, 'another seed gives other particles');
  noErrors(page);
});

test('fx: a hard projectile hit sets off a small blast on top of the material effects', async () => {
  const page = await newPage('&scene=wreck&quality=medium');
  await page.evaluate(() => {
    const a = window.physicslab;
    a.prefs.set({ shootSpeed: 30 });
    a.viewport.setView({ position: [3, 2.4, 11], target: [3, 1.8, 0] });
    a.setTool('shoot');
  });
  await play(page);
  await simTime(page, 0.1);
  const before = (await stats(page)).explosions;
  const brick = await page.evaluate(() => window.physicslab.store.bodies().find((e) => /brick/i.test(e.name)).id);
  const p = await screenOf(page, brick);
  await page.mouse.click(p.x, p.y);
  await page.waitForFunction((n) => window.physicslab.fx.stats.explosions > n, before, { timeout: 60000 });
  const by = await page.evaluate(() => window.physicslab.fx.emittedByType());
  assert(by['blast.flash'] > 0 && by['blast.fire'] > 0, `a small blast: ${JSON.stringify(by)}`);
  assert(by['spark'] > 0 || by['chip.stone'] > 0 || by['dust'] > 0, 'and the material effects of the hit');
  await pause(page);
  await page.waitForTimeout(400);
  await shot(page, 'fx-projectile-hit');
  noErrors(page);
});

test('fx: physical debris — off by default; on, a glass pane hit by steel throws capped, auto-cleaned fragments', async () => {
  const page = await newPage('&quality=medium');
  await page.evaluate(async () => {
    const { Builder } = await import('/src/model/builder.ts');
    const b = new Builder('Pane');
    b.body('Pane', 'box', [3, 0.25, 3], [0, 0.125, 0], { material: 'glass', bodyType: 'static' });
    b.body('Wrecking ball', 'sphere', [0.6, 0.6, 0.6], [0, 4.5, 0], { material: 'steel' });
    const a = window.physicslab;
    a.loadDocument(b.done());
    a.viewport.setView({ position: [3, 2.2, 6], target: [0, 0.4, 0] });
  });
  // 1. switch off: visual debris chunks only, no rigid fragments.
  await play(page);
  await page.waitForFunction(() => window.physicslab.fx.emittedByType()['debris'] > 0, null, { timeout: 60000 });
  assert((await stats(page)).fragments === 0, 'no physical fragments while the switch is off');
  await page.evaluate(() => window.physicslab.sim.reset());
  // 2. switch on through the panel.
  await page.click('#tab-fx');
  await page.click('.fx-panel label.switch:has-text("Physical debris bodies")');
  assert(await page.evaluate(() => window.physicslab.fx.settings.physicalDebris === true), 'switched on');
  await play(page);
  await page.waitForFunction(() => window.physicslab.fxDirector.stats.fragments > 0, null, { timeout: 60000 });
  const info = await page.evaluate(() => {
    const a = window.physicslab;
    const frags = [...a.sim.ephemeral.values()].filter((d) => d.tags.includes('fx-debris'));
    return {
      n: frags.length,
      cap: a.fx.tier.physicalDebrisCap,
      material: frags[0]?.material.preset,
      group: frags[0]?.collision.group,
    };
  });
  assert(info.n > 0 && info.n <= info.cap, `fragments exist and respect the cap (${info.n} / ${info.cap})`);
  assert(
    info.material === 'glass' && info.group === 1,
    `glass fragments in their own collision group (${JSON.stringify(info)})`,
  );
  await shot(page, 'fx-physical-debris');
  // 3. they are removed again.
  await page.evaluate(() => (window.physicslab.sim.timeScale = 4));
  await page.waitForFunction(
    () =>
      window.physicslab.fxDirector.stats.fragments === 0 &&
      ![...window.physicslab.sim.ephemeral.values()].some((d) => d.tags.includes('fx-debris')),
    null,
    { timeout: 120000 },
  );
  noErrors(page);
});

test('fx: previews, the clear button and the palette commands act on the real system', async () => {
  const page = await newPage('&scene=car&quality=medium');
  await page.click('#tab-fx');
  await page.waitForSelector('.fx-panel .fx-previews');
  const live = () => page.evaluate(() => window.physicslab.fx.stats.live);
  assert((await live()) === 0, 'nothing alive at the start');
  await page.click('.fx-previews button:has-text("Sparks")');
  await page.click('.fx-previews button:has-text("Dust")');
  await page.waitForTimeout(100);
  assert((await live()) > 0, 'previews fire real particles in edit mode');
  const before = (await stats(page)).explosions;
  await page.click('.fx-previews button:has-text("Explosion")');
  assert((await stats(page)).explosions === before + 1, 'explosion preview');
  // They play out in real time while no simulation runs.
  const peak = await live();
  await page.waitForFunction((n) => window.physicslab.fx.stats.live < n * 0.6, peak, { timeout: 60000 });
  // A preview works even for an effect whose own switch is off (only the master switch rules).
  await page.evaluate(() => window.physicslab.fxDirector.setSettings({ impacts: false, explosions: false }));
  const sparks0 = await page.evaluate(() => window.physicslab.fx.emittedByType()['spark'] ?? 0);
  await page.click('.fx-previews button:has-text("Sparks")');
  await page.click('.fx-previews button:has-text("Explosion")');
  assert(
    (await page.evaluate(() => window.physicslab.fx.emittedByType()['spark'] ?? 0)) > sparks0,
    'sparks preview with impacts off',
  );
  assert((await stats(page)).explosions === before + 2, 'explosion preview with explosions off');
  await page.evaluate(() => window.physicslab.fxDirector.setSettings({ impacts: true, explosions: true }));
  // Skid marks: lay some by hand, clear them with the button.
  await page.evaluate(() => {
    const fx = window.physicslab.fx;
    for (let i = 0; i < 30; i++) {
      fx.beginScan();
      fx.skid(1, i * 0.2, 0, 0.4, 1, 0);
      fx.endScan();
    }
  });
  assert((await stats(page)).skidSegments > 5, 'marks laid');
  await page.click('.fx-panel button:has-text("Clear skid marks")');
  assert((await stats(page)).skidSegments === 0, 'cleared by the button');
  // Palette: quality and the master switch.
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette .palette-input');
  await page.keyboard.type('Effects quality: Low');
  await page.keyboard.press('Enter');
  assert(
    await page.evaluate(
      () => window.physicslab.fx.settings.quality === 'low' && window.physicslab.fx.tier.id === 'low',
    ),
    'quality low from the palette',
  );
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette .palette-input');
  await page.keyboard.type('Visual effects');
  await page.keyboard.press('Enter');
  assert(await page.evaluate(() => window.physicslab.fx.settings.enabled === false), 'master switch from the palette');
  // View menu entry for the same command.
  await page.click('.menubar >> text=View');
  await page.waitForSelector('.menu-item:has-text("Visual effects")');
  await page.keyboard.press('Escape');
  noErrors(page);
});

test('fx: skid marks fade with age and are drawn as darker ground (read back from the rendered image)', async () => {
  const page = await newPage('&quality=medium');
  await page.evaluate(() => {
    const a = window.physicslab;
    a.newScene();
    a.viewport.setView({ position: [0.5, 5, 2.51], target: [0.5, 0, 2.5] });
    for (let i = 0; i < 40; i++) {
      a.fx.beginScan();
      a.fx.skid(1, -2.5 + i * 0.15, 2.5, 0.5, 0.9, 0);
      a.fx.endScan();
    }
  });
  await page.waitForFunction(() => window.physicslab.fx.skidMesh.mesh.visible, null, { timeout: 30000 }); // a frame has run
  // Mean luminance of a patch of the picture around a world point, read straight from the renderer.
  const sample = (x, z) =>
    page.evaluate(
      async ([x, z]) => {
        const a = window.physicslab;
        const v = a.viewport;
        v.post.render(0.016);
        const img = new Image();
        img.src = v.dom.toDataURL('image/png');
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        const p = { x, y: 0.012, z };
        const s = new a.camera.position.constructor(p.x, p.y, p.z).project(a.camera);
        const px = Math.round(((s.x + 1) / 2) * img.width);
        const py = Math.round(((1 - s.y) / 2) * img.height);
        const d = g.getImageData(px - 4, py - 4, 9, 9).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        return sum / (d.length / 4);
      },
      [x, z],
    );
  const mark = await sample(0.5, 2.5);
  const ground = await sample(0.5, 3.5);
  assert(
    mark < ground - 8,
    `the mark is darker than the ground beside it (${mark.toFixed(1)} vs ${ground.toFixed(1)})`,
  );
  await shot(page, 'fx-skid-top');
  // Age it: halfway through the fade the mark is lighter, past it it is gone.
  await page.evaluate(() => window.physicslab.fx.update(55, window.physicslab.camera));
  const half = await sample(0.5, 2.5);
  assert(half > mark + 3 && half < ground, `half faded (${half.toFixed(1)})`);
  await page.evaluate(() => window.physicslab.fx.update(40, window.physicslab.camera));
  const gone = await sample(0.5, 2.5);
  assert(Math.abs(gone - ground) < 4, `faded away (${gone.toFixed(1)} vs ${ground.toFixed(1)})`);
  noErrors(page);
});
