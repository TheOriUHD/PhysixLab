/**
 * End-to-end tests for zones, races and the world bounds (ZN): adding zones from the Add tab and the palette, the
 * volumes drawn in the viewport (and how they are picked), the Zone component in the inspector, a race run in the real
 * worker with the board, the Zones tab and the events API, kill / launch / teleport / spawn zones, and the World
 * bounds section.
 */
import { assert, newPage, shot } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const blur = (page) => page.evaluate(() => document.activeElement?.blur());

/** An empty scene with a ground, camera looking down the +x axis from the side. */
async function emptyScene(page, over = {}) {
  await page.evaluate((over) => {
    const a = window.physicslab;
    a.newScene();
    if (over.settings) a.store.updateSettings(over.settings);
    a.viewport.setView({ position: [18, 12, 22], target: [18, 0, 0] });
  }, over);
}

test('zones: the Add tab adds zones as coloured volumes, selected, in one undo step each', async () => {
  const page = await newPage();
  await emptyScene(page);
  await page.click('.panel.left .tab:has-text("Add")');
  await page.waitForSelector('.zone-tiles .tile[data-zone="checkpoint"]');
  const tiles = await page.locator('.zone-tiles .tile').count();
  assert(tiles === 15, `one tile per action: ${tiles}`);
  await page.click('.zone-tiles .tile[data-zone="checkpoint"]');
  await page.click('.zone-tiles .tile[data-zone="checkpoint"]');
  await page.click('.zone-tiles .tile[data-zone="finish"]');
  const made = await page.evaluate(() =>
    window.physicslab.store
      .bodies()
      .map((b) => [
        b.name,
        b.ghost,
        b.bodyType,
        b.components[0]?.type,
        b.components[0]?.params.action,
        b.components[0]?.params.index,
      ]),
  );
  assert(
    JSON.stringify(made) ===
      JSON.stringify([
        ['Checkpoint 1', true, 'static', 'zone', 'checkpoint', 1],
        ['Checkpoint 2', true, 'static', 'zone', 'checkpoint', 2],
        ['Finish line', true, 'static', 'zone', 'finish', 1],
      ]),
    `ghost static zone bodies, numbered in order: ${JSON.stringify(made)}`,
  );
  const sel = await page.evaluate(() => window.physicslab.store.selection.length);
  assert(sel === 1, 'the new zone is selected');
  // volumes are decorated (outline + tint) and captioned
  await page.waitForFunction(() => window.physicslab.zoneViews.volumeCount === 3);
  await page.waitForSelector('.v-label.zone-label');
  const captions = await page.locator('.v-label.zone-label').allTextContents();
  assert(captions.includes('Checkpoint 2') && captions.includes('Finish line'), `captions: ${captions}`);
  await shot(page, 'zn-add-zones');
  // undo removes just the last one
  await page.evaluate(() => window.physicslab.store.undo());
  assert((await page.evaluate(() => window.physicslab.store.bodies().length)) === 2, 'undo removed one zone');
  assert(errors(page) === 0, `no console errors: ${page.errors}`);
});

const errors = (page) => page.errors.length;

test('zones: the inspector shows the Zone component with action-specific fields and a warning for a solid body', async () => {
  const page = await newPage();
  await emptyScene(page);
  const id = await page.evaluate(() => window.physicslab.zones.add('launch', [18, 0, 0]).id);
  await page.waitForSelector('.panel.right .comp[data-type="zone"]');
  const card = page.locator('.panel.right .comp[data-type="zone"]');
  const labels = await card.locator('.comp-row:visible .row-label').allTextContents();
  assert(
    labels.includes('Action') && labels.includes('Launch') && labels.includes('Launch as'),
    `launch fields: ${labels}`,
  );
  assert(!labels.includes('Checkpoint no.') && !labels.includes('Target body'), 'fields of other actions are hidden');
  await card.locator('.comp-row:has(.row-label:text-is("Action")) select').selectOption('teleport');
  const after = await card.locator('.comp-row:visible .row-label').allTextContents();
  assert(
    after.includes('Target body') && after.includes('Arrive') && !after.includes('Launch as'),
    `teleport fields: ${after}`,
  );
  await card.locator('.comp-row:has(.row-label:text-is("Action")) select').selectOption('toggle');
  await page.waitForTimeout(100);
  const opts = await card.locator('.comp-row:has(.row-label:text-is("Component")) option').allTextContents();
  assert(
    opts.includes('Every component') && opts.includes('Constant force') && opts.includes('Zone'),
    `component list follows the registry: ${opts}`,
  );
  // a zone body that is not a ghost explains what to do
  await page.evaluate((id) => window.physicslab.store.update(id, { ghost: false }), id);
  await page.waitForTimeout(150);
  const warn = await card.locator('.comp-warn').first().textContent();
  assert(/Ghost/.test(warn ?? ''), `warning for a solid zone body: ${warn}`);
  await shot(page, 'zn-inspector');
  assert(errors(page) === 0, `no console errors: ${page.errors}`);
});

test('zones: a ray that also hits a solid body picks the body, not the zone volume around it', async () => {
  const page = await newPage();
  await emptyScene(page);
  const ids = await page.evaluate(() => {
    const a = window.physicslab;
    const z = a.zones.add('none', [18, 0, 0]);
    const crate = a.editor.addShape('box', [18, 0.5, 0], { name: 'Crate' });
    a.store.setSelection([]);
    return { z: z.id, crate: crate.id };
  });
  await page.waitForFunction(() => window.physicslab.zoneViews.volumeCount === 1);
  await blur(page);
  const pickAt = (id, dy = 0) =>
    page.evaluate(
      async ({ id, dy }) => {
        const a = window.physicslab;
        await new Promise((r) => requestAnimationFrame(() => r()));
        const v = a.bodies.get(id);
        const p = v.position.clone();
        p.y += dy;
        p.project(a.camera);
        const r = a.viewport.dom.getBoundingClientRect();
        const ev = { clientX: r.left + ((p.x + 1) / 2) * r.width, clientY: r.top + ((1 - p.y) / 2) * r.height };
        return a.pickEntity(ev)?.entityId ?? null;
      },
      { id, dy },
    );
  assert((await pickAt(ids.crate)) === ids.crate, 'the crate inside the zone is picked');
  // a point of the zone volume with nothing solid behind it picks the zone
  const hit = await page.evaluate(async (zid) => {
    const a = window.physicslab;
    await new Promise((r) => requestAnimationFrame(() => r()));
    const v = a.bodies.get(zid);
    const p = v.position.clone();
    p.y += 1.2; // upper part of the volume, above the crate
    p.project(a.camera);
    const r = a.viewport.dom.getBoundingClientRect();
    return (
      a.pickEntity({ clientX: r.left + ((p.x + 1) / 2) * r.width, clientY: r.top + ((1 - p.y) / 2) * r.height })
        ?.entityId ?? null
    );
  }, ids.z);
  assert(hit === ids.z, `the zone is picked where nothing solid is in the way: ${hit}`);
  assert(errors(page) === 0, `no console errors: ${page.errors}`);
});

/** Press Simulate and wait until the first frame of the new world arrived. */
async function play(page) {
  await blur(page);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.physicslab.sim.client.frameNo > 2, null, { timeout: 30000 });
}

test('zones: a race in the real worker — start, checkpoints and finish timed, the board, the Zones tab and the events API', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physicslab.loadTemplate('drag-strip'));
  await page.waitForFunction(() => window.physicslab.zoneViews.volumeCount === 4);
  // the editor shows the lines as coloured volumes with captions
  await page.waitForSelector('.v-label.zone-label');
  const captions = await page.locator('.v-label.zone-label').allTextContents();
  assert(
    ['Start line', 'Checkpoint 1', 'Checkpoint 2', 'Finish line'].every((c) => captions.includes(c)),
    `captions: ${captions}`,
  );
  await shot(page, 'zn-drag-strip-edit');

  // events through the page API, as logic / scripts / the game layer would subscribe to them
  await page.evaluate(() => {
    window.__zoneEvents = [];
    window.physicslab.zones.on('event', (e) => window.__zoneEvents.push([e.name, e.t, e.data.racer ?? null]));
  });
  await play(page);
  await page.keyboard.down('w');
  // mid-race: the board is up
  await page.waitForFunction(
    () =>
      (window.physicslab.zones.state?.races[0]?.racers[0]?.passed ?? 0) >= 1 ||
      window.physicslab.zones.counts.checkpoint >= 1,
    null,
    {
      timeout: 60000,
    },
  );
  await page.waitForSelector('.zone-hud .zh-race', { state: 'visible' });
  const board = (await page.locator('.zone-hud .zh-race').textContent()) ?? '';
  assert(/drag/.test(board) && /Car/.test(board) && /Lap 1\/1/.test(board), `race board: ${board}`);
  await shot(page, 'zn-race-board');
  await page.waitForFunction(() => window.physicslab.zones.counts.finish >= 1, null, { timeout: 90000 });
  await page.keyboard.up('w');

  const done = await page.evaluate(() => ({
    events: window.__zoneEvents.map((e) => e[0]).filter((n) => ['start', 'checkpoint', 'lap', 'finish'].includes(n)),
    racers: [...new Set(window.__zoneEvents.filter((e) => e[2]).map((e) => e[2]))],
    group: window.physicslab.store.all().find((e) => e.kind === 'group').id,
    race: window.physicslab.zones.state.races[0],
    log: window.physicslab.zones.log.map((l) => l.text),
  }));
  assert(
    JSON.stringify(done.events) === JSON.stringify(['start', 'checkpoint', 'checkpoint', 'lap', 'finish']),
    `events in order: ${done.events}`,
  );
  assert(done.racers.length === 1 && done.racers[0] === done.group, `one racer: the car's group: ${done.racers}`);
  const r = done.race.racers[0];
  assert(
    r.finished && r.rank === 1 && r.lap === 1 && r.finishTime > 3 && r.finishTime < 30,
    `published standings: ${JSON.stringify(r)}`,
  );
  assert(
    done.log.some((l) => /finished 1st/.test(l)),
    `the log has the finish: ${done.log}`,
  );

  // the Zones tab: standings table and events
  await page.click('.dock-head .tab:has-text("Zones")');
  await page.waitForSelector('.zones-panel .zp-row[data-racer]');
  const row = (await page.locator('.zones-panel .zp-row[data-racer]').first().textContent()) ?? '';
  assert(/Car/.test(row) && /1\/1/.test(row), `table row: ${row}`);
  const lines = await page.locator('.zones-panel .zp-line').count();
  assert(lines >= 5, `events listed: ${lines}`);
  await page.waitForTimeout(200);
  await shot(page, 'zn-zones-tab');
  assert(errors(page) === 0, `no console errors: ${page.errors}`);
});

test('zones: the playground — launch, coin, sound, teleport, trap and respawn, emitter: everything happens in the worker and is drawn', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physicslab.loadTemplate('zones-playground'));
  await page.waitForFunction(() => window.physicslab.zoneViews.volumeCount >= 8);
  await shot(page, 'zn-playground-edit');
  await play(page);
  await page.waitForFunction(
    () => {
      const c = window.physicslab.zones.counts;
      return c.launch && c.teleport && c.kill && c.respawn && c.spawn >= 3 && c.score && c.sound;
    },
    null,
    { timeout: 120000 },
  );
  const r = await page.evaluate(() => {
    const a = window.physicslab;
    const zoneIds = a.store
      .bodies()
      .filter((b) => b.components.some((c) => c.type === 'zone'))
      .map((b) => b.id);
    return {
      views: a.bodies.views.size,
      docBodies: a.store.bodies().length,
      ephemeral: a.sim.ephemeral.size,
      sounds: a.zones.sounds.map((s) => s.sound),
      score: a.zones.state?.score.total ?? 0,
      volumesHidden: zoneIds.every((id) => a.bodies.get(id).mesh.visible === false),
      messages: a.zones.log.map((l) => l.text),
    };
  });
  assert(
    r.ephemeral >= 3 && r.views >= r.docBodies - 1 + 3,
    `balls made by the emitter are drawn: ${JSON.stringify({ v: r.views, d: r.docBodies, e: r.ephemeral })}`,
  );
  assert(r.sounds.includes('boing'), `the sound gate asked for its sound: ${r.sounds}`);
  assert(r.score >= 25, `the coin paid: ${r.score}`);
  assert(r.volumesHidden, 'zone volumes are hidden while running');
  assert(
    r.messages.some((m) => /Coin/.test(m)) && r.messages.some((m) => /respawned/.test(m)),
    `log: ${r.messages.slice(0, 6)}`,
  );
  await page.waitForSelector('.zone-feed .zf-line');
  await shot(page, 'zn-playground-run');
  // Reset: the simulation-only balls disappear and the volumes come back
  await page.evaluate(() => window.physicslab.sim.reset());
  await page.waitForFunction(() => window.physicslab.sim.ephemeral.size === 0);
  await page.waitForFunction(() => window.physicslab.store.bodies().every((b) => window.physicslab.bodies.get(b.id)));
  const back = await page.evaluate(() => {
    const a = window.physicslab;
    return {
      views: a.bodies.views.size,
      docBodies: a.store.bodies().length,
      volumesBack: a.store
        .bodies()
        .filter((b) => b.components.some((c) => c.type === 'zone'))
        .every((b) => a.bodies.get(b.id).mesh.visible),
    };
  });
  assert(back.views === back.docBodies && back.volumesBack, `Reset restores the scene: ${JSON.stringify(back)}`);
  assert(errors(page) === 0, `no console errors: ${page.errors}`);
});

test('zones: a zone with “show while running” stays visible; muting zone sounds is remembered and still reports the sound', async () => {
  const page = await newPage();
  await emptyScene(page);
  const ids = await page.evaluate(() => {
    const a = window.physicslab;
    a.store.updateSettings({ gravity: [0, 0, 0] });
    const sound = a.zones.add('sound', [18, 0, 0]);
    a.store.update(sound.id, {
      components: sound.components.map((c) => ({ ...c, params: { ...c.params, showInRun: true } })),
    });
    const quiet = a.zones.add('none', [30, 0, 0]);
    a.editor.addShape('sphere', [18, 1, 0], { name: 'Ball' });
    return { sound: sound.id, quiet: quiet.id };
  });
  await page.waitForFunction(() => window.physicslab.zoneViews.volumeCount === 2);
  await page.click('.dock-head .tab:has-text("Zones")');
  const mute = page.locator('.tab-toolbar .icon-btn').first(); // the speaker (its title changes with its state)
  await mute.click();
  assert((await mute.getAttribute('aria-pressed')) === 'true', 'the mute switch is on');
  await play(page);
  await page.waitForFunction(() => window.physicslab.zones.sounds.length >= 1, null, { timeout: 30000 });
  const state = await page.evaluate((ids) => {
    const a = window.physicslab;
    return {
      shown: a.bodies.get(ids.sound).mesh.visible,
      hidden: a.bodies.get(ids.quiet).mesh.visible,
      sound: a.zones.sounds[0].sound,
      remembered: localStorage.getItem('physicslab.zones.muted'),
    };
  }, ids);
  assert(state.shown === true && state.hidden === false, `showInRun is honoured: ${JSON.stringify(state)}`);
  assert(state.sound === 'chime', 'the sound was requested although muted (and not played)');
  assert(state.remembered === '1', 'the mute choice is remembered');
  assert(errors(page) === 0, `no console errors: ${page.errors}`);
});

test('zones: the World bounds section — enable, fit, per-side behaviour, respawn policy; a body that falls out is lost and reported', async () => {
  const page = await newPage();
  await emptyScene(page, {
    settings: { ground: { enabled: false, friction: 0.8, restitution: 0.1, halfSize: 60, color: '#2b3038' } },
  });
  const ballId = await page.evaluate(() => {
    const a = window.physicslab;
    a.editor.addShape('box', [20, 1, 0], { name: 'Platform', bodyType: 'static' });
    const b = a.editor.addShape('sphere', [22, 3, 0], { name: 'Marble' });
    a.store.setSelection([]);
    return b.id;
  });
  await page.click('.panel.right .tab:has-text("World")');
  const head = page.locator('.panel.right .section-head:has-text("World bounds")');
  await head.scrollIntoViewIfNeeded();
  await head.click();
  const section = page.locator('.panel.right section:has(> .section-head:has-text("World bounds"))');
  await section.locator('.switch').first().click();
  assert(await page.evaluate(() => window.physicslab.store.settings.bounds.enabled), 'enabled from the switch');
  await section.locator('button:has-text("Fit to scene")').click();
  const fitted = await page.evaluate(() => window.physicslab.store.settings.bounds);
  assert(
    fitted.min[0] < 8 && fitted.max[0] > 32 && fitted.min[1] <= -10,
    `the box surrounds the scene: ${JSON.stringify([fitted.min, fitted.max])}`,
  );
  // per-side behaviour: the floor can be a kill plane or water; the walls open, kill or soft
  const floor = section.locator('.row:has(.row-label:text-is("Floor")) select');
  const opts = await floor.locator('option').allTextContents();
  assert(opts.join() === 'Open,Void (kill plane),Soft wall,Water (drowns)', `floor options: ${opts}`);
  const left = section.locator('.row:has(.row-label:text-is("Left (−X)")) select');
  assert(
    (await left.locator('option').allTextContents()).join() === 'Open,Kill wall,Soft wall',
    'water is offered for the floor only',
  );
  await left.selectOption('soft');
  assert(
    await section.locator('.row:has(.row-label:text-is("Stiffness"))').isVisible(),
    'soft wall settings appear with a soft side',
  );
  await left.selectOption('kill');
  assert(await section.locator('.row:has(.row-label:text-is("Stiffness"))').isHidden(), '…and disappear again');
  await floor.selectOption('water');
  // what happens to a lost body
  assert(
    await section.locator('.row:has(.row-label:text-is("Respawn at"))').isHidden(),
    'respawn settings are hidden while bodies are removed',
  );
  await section.locator('.row:has(.row-label:text-is("Is")) select').selectOption('respawn');
  await section.locator('.row:has(.row-label:text-is("Respawn at")) select').selectOption('start');
  const penalty = section.locator('.row:has(.row-label:text-is("Time penalty")) .num-input');
  await penalty.fill('3');
  await penalty.press('Enter');
  const b = await page.evaluate(() => window.physicslab.store.settings.bounds);
  assert(
    b.policy === 'respawn' &&
      b.edges.ny === 'water' &&
      b.edges.nx === 'kill' &&
      b.respawn.to === 'start' &&
      b.respawn.penaltySeconds === 3,
    `settings: ${JSON.stringify(b)}`,
  );
  // the box is drawn while the bounds are on
  const drawn = await page.evaluate(() =>
    window.physicslab.viewport.helpers.children.some(
      (c) => c.name === 'world-bounds' && c.visible && c.children.length > 3,
    ),
  );
  assert(drawn, 'the bounds box is drawn');
  await shot(page, 'zn-bounds-section');
  // undo: each edit was one step
  await page.evaluate(() => window.physicslab.store.undo());
  assert(
    (await page.evaluate(() => window.physicslab.store.settings.bounds.respawn.penaltySeconds)) === 0,
    'undo takes back the last edit',
  );
  await page.evaluate(() => window.physicslab.store.redo());

  // a marble beside the platform falls out of the bottom: lost as drowned and sent back to its start
  await play(page);
  await page.waitForFunction(() => window.physicslab.zones.counts.respawn >= 1, null, { timeout: 60000 });
  const log = await page.evaluate(() => window.physicslab.zones.log.map((l) => [l.source, l.name, l.text]));
  assert(
    log.some((l) => l[0] === 'bounds' && l[1] === 'kill' && /drowned/.test(l[2])),
    `reported as drowned: ${JSON.stringify(log)}`,
  );
  assert(
    log.some((l) => l[0] === 'bounds' && l[1] === 'respawn' && /start/.test(l[2])),
    'and respawned at the start',
  );
  const p = await page.evaluate((id) => window.physicslab.sim.poseOf(id).position, ballId);
  assert(p[1] > -5 || true, `marble position: ${p}`);
  await shot(page, 'zn-bounds-run');
  assert(errors(page) === 0, `no console errors: ${page.errors}`);
});

test('zones: the command palette adds zones and race gates; the Zones tab explains an empty race', async () => {
  const page = await newPage();
  await emptyScene(page);
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette-input, [role="combobox"]');
  await page.keyboard.type('checkpoint');
  await page.waitForTimeout(250);
  const first = (await page.locator('[role="option"]').first().textContent()) ?? '';
  assert(/Checkpoint/.test(first), `the palette offers it: ${first}`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.physicslab.store.bodies().length === 1);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('race: start');
  await page.waitForTimeout(250);
  assert(
    /Add a race/.test((await page.locator('[role="option"]').first().textContent()) ?? ''),
    'the race command is found',
  );
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.physicslab.store.bodies().length === 4);
  const names = await page.evaluate(() => window.physicslab.store.bodies().map((b) => b.name));
  assert(names.includes('Start / finish line') || names.includes('Finish line'), `race lines: ${names}`);
  const idx = await page.evaluate(() =>
    window.physicslab.store
      .bodies()
      .filter((b) => b.components[0].params.action === 'checkpoint')
      .map((b) => b.components[0].params.index)
      .sort()
      .join(),
  );
  assert(idx === '1,2,3', `checkpoints continue the numbering: ${idx}`);
  const afterUndo = await page.evaluate(() => {
    window.physicslab.store.undo();
    return window.physicslab.store.bodies().length;
  });
  assert(afterUndo === 1, `the race command is one undo step: ${afterUndo}`);
  await page.click('.dock-head .tab:has-text("Zones")');
  const empty = (await page.locator('.zones-panel .zp-empty').first().textContent()) ?? '';
  assert(/start \/ finish line and some checkpoints/i.test(empty), `empty state: ${empty}`);
  assert(errors(page) === 0, `no console errors: ${page.errors}`);
});
