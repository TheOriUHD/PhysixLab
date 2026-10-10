/**
 * Visual effects (package FX): particles, impact effects, tyre smoke and skid marks, explosions, and the Effects
 * panel, driven through the real UI in the real renderer. Screenshots (E2E_SHOTS=1) go to e2e/out/fx-*.png.
 */
import { assert, newPage, screenOf, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const stats = (page) =>
  page.evaluate(() => ({ ...window.physicslab.fxDirector.stats, time: window.physicslab.fx.time }));
const noErrors = (page) => assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
const play = (page) => page.evaluate(() => window.physicslab.sim.play());
const pause = (page) => page.evaluate(() => window.physicslab.sim.pause());

test('fx: Effects panel — master switch, quality and intensity drive the system and persist', async () => {
  const page = await newPage();
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
  const page = await newPage('&scene=pit');
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
  const page = await newPage();
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
  await page.waitForFunction(() => window.physicslab.fx.stats.bursts >= 18, null, { timeout: 60000 });
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
  const page = await newPage('&scene=car');
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
    segments: window.physicslab.fx.stats.skidSegments,
  }));
  assert(during.segments > 8, `skid marks laid (${during.segments})`);
  assert(during.smoke > 0, `tyre smoke emitted (${during.smoke})`);
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
  const page = await newPage('&scene=wreck');
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
  const page = await newPage('&scene=pit');
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
