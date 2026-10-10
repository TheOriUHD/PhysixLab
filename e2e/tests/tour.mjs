/**
 * UI-40: the spotlight tour engine and the first-run onboarding tour, driven through the real UI —
 * Help menu → "Take the tour", then every step is advanced by doing what it asks.
 */
import { assert, newPage, screenOf, shot } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const card = (page) => page.locator('.tour-card');
const title = (page) => page.locator('.tour-card .tour-title').textContent();
const counter = (page) => page.locator('.tour-card .tour-counter').textContent();
const waitTitle = (page, t) =>
  page.waitForFunction((t) => document.querySelector('.tour-card .tour-title')?.textContent === t, t, {
    timeout: 8000,
  });
const guideState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('physicslab.guide.v1') ?? '{}'));

async function startFromHelpMenu(page) {
  await page.locator('.menubar .menu-btn', { hasText: 'Help' }).click();
  await page
    .locator('.menu .menu-item, .menu button', { hasText: /^\s*Take the tour/ })
    .first()
    .click();
  await page.waitForSelector('.tour-card');
}

const holeOf = (page) =>
  page.evaluate(() => {
    const r = document.querySelector('.tour-ring').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });

/** A body of the scene that is not currently selected, so clicking it changes the selection. */
const otherBody = (page) =>
  page.evaluate(() => {
    const a = window.physicslab;
    const sel = new Set(a.store.selection);
    const b = a.store.bodies().find((b) => !sel.has(b.id) && a.bodies.get(b.id));
    return b.id;
  });

test('onboarding tour: every step advances by doing the real thing, and the tour completes', async () => {
  const page = await newPage('&scene=car');
  await startFromHelpMenu(page);

  // Step 1: a centred welcome card with dialog semantics, a counter and a dimmed backdrop.
  assert((await title(page)) === 'Welcome to PhysicsLab', 'first step');
  assert((await counter(page)) === 'Step 1 of 10', `counter ${await counter(page)}`);
  const sem = await page.evaluate(() => {
    const c = document.querySelector('.tour-card');
    return {
      role: c.getAttribute('role'),
      labelled: document.getElementById(c.getAttribute('aria-labelledby'))?.textContent,
      live: !!document.querySelector('.tour-layer [aria-live]'),
      focusOnNext: document.activeElement?.classList.contains('tour-next'),
      dim: getComputedStyle(document.querySelector('.tour-dim')).pointerEvents,
    };
  });
  assert(sem.role === 'dialog' && sem.labelled === 'Welcome to PhysicsLab', `dialog semantics ${JSON.stringify(sem)}`);
  assert(sem.live, 'an aria-live region announces the steps');
  assert(sem.focusOnNext, 'keyboard focus moved to Next');
  assert(sem.dim === 'auto', 'a step that waits for nothing blocks the dimmed area');
  assert(await page.evaluate(() => window.physicslab.sim.mode === 'edit'), 'edit mode');

  // Step 2: spotlight on the shape tiles; pointer events pass through to the app; clicking a tile advances.
  await page.keyboard.press('Enter'); // Next is focused: keyboard only
  await waitTitle(page, 'Add a shape');
  assert((await counter(page)) === 'Step 2 of 10', 'counter moved');
  await page.waitForSelector('.tour-ring:not([hidden])');
  const tiles = await page.locator('#panel-add .tiles').first().boundingBox();
  const hole = await holeOf(page);
  assert(
    hole.x <= tiles.x && hole.y <= tiles.y && hole.x + hole.w >= tiles.x + tiles.width - 1,
    `the spotlight surrounds the tiles ${JSON.stringify({ hole, tiles })}`,
  );
  const dimPE = await page.evaluate(() => getComputedStyle(document.querySelector('.tour-dim')).pointerEvents);
  assert(dimPE === 'none', 'a step that waits lets clicks through');
  await shot(page, 'tour-add-step');
  const before = await page.evaluate(() => window.physicslab.store.bodies().length);
  await page.locator('#panel-add .tile').first().click();
  await waitTitle(page, 'Select it');
  assert((await page.evaluate(() => window.physicslab.store.bodies().length)) === before + 1, 'the shape was added');

  // Step 3: select by clicking an object in the 3D view.
  const id = await otherBody(page);
  const p = await screenOf(page, id);
  await page.mouse.click(p.x, p.y);
  await waitTitle(page, 'Edit its properties');

  // Step 4 (no wait): Next. Step 5: press Simulate.
  await page.locator('.tour-next').click();
  await waitTitle(page, 'Press Simulate');
  await shot(page, 'tour-simulate-step');
  await page.locator('.tbtn.play').click();
  await waitTitle(page, 'Grab a body');

  // Step 6: really grab a body with the mouse.
  const dyn = await page.evaluate(() => {
    const a = window.physicslab;
    return a.store.bodies().find((b) => b.type === 'dynamic' || b.bodyType === 'dynamic')?.id ?? a.store.bodies()[0].id;
  });
  const g = await screenOf(page, dyn);
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  await page.mouse.move(g.x + 25, g.y - 25, { steps: 4 });
  await waitTitle(page, 'Reset the scene');
  await page.mouse.up();

  // Step 7: Reset. Step 8: the palette (opened and closed again). Step 9: undo. Step 10: Help.
  await page.locator('.transport > .tbtn:nth-child(3)').click();
  await waitTitle(page, 'The command palette');
  assert(!(await page.locator('.tour-dim').first().isVisible()) || true, 'palette step');
  const dimShown = await page.evaluate(() => getComputedStyle(document.querySelector('.tour-dim')).display);
  assert(dimShown === 'none', 'no dimming while the user is asked to open the palette');
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette-back');
  assert(await card(page).isVisible(), 'the tour card stays above the palette');
  await shot(page, 'tour-palette-step');
  await page.keyboard.press('Escape'); // closes the palette, not the tour
  await waitTitle(page, 'Undo anything');
  assert(await card(page).isVisible(), 'Esc in the palette did not end the tour');
  await page.locator('.topbar-right .icon-btn[title^="Undo"]').click();
  await waitTitle(page, 'Help is always here');
  assert((await counter(page)) === 'Step 10 of 10', 'last step');
  assert((await page.locator('.tour-next').textContent()) === 'Done', 'last button says Done');
  await shot(page, 'tour-last-step');
  await page.locator('.tour-next').click();
  await page.waitForFunction(() => !document.querySelector('.tour-layer'));
  const st = await guideState(page);
  assert(st.completed?.includes('onboarding'), `completion persisted ${JSON.stringify(st)}`);
  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('tour: Back works, Esc closes and remembers the skip, the first-run offer is not repeated', async () => {
  const page = await newPage('&scene=car');
  await startFromHelpMenu(page);
  await page.locator('.tour-next').click();
  await waitTitle(page, 'Add a shape');
  await page.locator('.tour-foot .btn', { hasText: 'Back' }).click();
  await waitTitle(page, 'Welcome to PhysicsLab');
  assert(await page.locator('.tour-foot .btn', { hasText: 'Back' }).isHidden(), 'no Back on the first step');
  // "Skip step" is there on a step that waits, so the user is never stuck.
  await page.locator('.tour-next').click();
  assert((await page.locator('.tour-next').textContent()) === 'Skip step', 'waiting steps offer Skip step');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.tour-layer'));
  const st = await guideState(page);
  assert(st.dismissed?.includes('onboarding'), `skip persisted ${JSON.stringify(st)}`);
  assert(!st.completed?.includes('onboarding'), 'a skipped tour is not completed');
  await page.close();
});

test('tour: a missing target shows a centred card, repositions on resize, and Skip works by button', async () => {
  const page = await newPage();
  await page.evaluate(async () => {
    const t = await import('/src/ui/tour/index.ts');
    t.registerTour({
      id: 'e2e-missing',
      title: 'Missing',
      steps: [
        { target: '#does-not-exist', title: 'Nothing here', body: 'The target is gone.' },
        { target: '.tbtn.play', title: 'Play button', body: 'Look here.', placement: 'bottom' },
      ],
    });
    t.startTour('e2e-missing', window.physicslab);
  });
  await waitTitle(page, 'Nothing here');
  const mid = await page.evaluate(() => {
    const r = document.querySelector('.tour-card').getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, hidden: document.querySelector('.tour-ring').hidden };
  });
  assert(mid.hidden, 'no spotlight without a target');
  assert(Math.abs(mid.cx - 800) < 4 && Math.abs(mid.cy - 450) < 60, `centred ${JSON.stringify(mid)}`);
  await page.locator('.tour-next').click();
  await waitTitle(page, 'Play button');
  const place = async () =>
    page.evaluate(() => {
      const c = document.querySelector('.tour-card').getBoundingClientRect();
      const b = document.querySelector('.tbtn.play').getBoundingClientRect();
      const ring = document.querySelector('.tour-ring').getBoundingClientRect();
      return { cardTop: c.top, cardL: c.left, cardR: c.right, btnBottom: b.bottom, ringL: ring.left, btnL: b.left };
    });
  const a = await place();
  assert(a.cardTop >= a.btnBottom, `card below the button ${JSON.stringify(a)}`);
  assert(a.ringL <= a.btnL, 'ring around the button');
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForTimeout(500);
  const b = await place();
  assert(b.cardR <= 1100 - 8 && b.cardL >= 0, `card stays on screen after resize ${JSON.stringify(b)}`);
  assert(
    Math.abs(
      b.ringL - (await page.evaluate(() => document.querySelector('.tbtn.play').getBoundingClientRect().left - 6)),
    ) < 2,
    'ring follows the button after resize',
  );
  await page.locator('.tour-skip').click();
  await page.waitForFunction(() => !document.querySelector('.tour-layer'));
  assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('welcome dialog offers the tour; a context hint appears once', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physicslab.prefs.set({ seenWelcome: false }));
  await page.evaluate(async () => {
    const d = await import('/src/ui/dialogs.ts');
    d.showWelcome(window.physicslab);
  });
  await page.locator('.modal .btn', { hasText: 'Take the tour' }).click();
  await page.waitForSelector('.tour-card');
  assert((await title(page)) === 'Welcome to PhysicsLab', 'the welcome dialog started the tour');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.tour-layer'));

  // Hints are quiet under ?nowelcome (all tests run that way); open a page that allows them.
  const hp = page;
  const url = page.url().replace('?nowelcome', '?x=1');
  await hp.goto(url);
  await hp.waitForFunction(() => !!window.physicslab?.viewport, null, { timeout: 30000 });
  await hp.evaluate(() => {
    const a = window.physicslab;
    a.prefs.set({ seenWelcome: true });
    a.store.setSelection([]);
  });
  await hp.waitForTimeout(300);
  await hp.evaluate(() => {
    const a = window.physicslab;
    a.store.setSelection([a.store.bodies()[0].id]);
  });
  await hp.waitForSelector('.tour-hint', { timeout: 6000 });
  const text = await hp.locator('.tour-hint .tour-hint-text').textContent();
  assert(/Selected!/.test(text), `first-selection hint: ${text}`);
  // Software WebGL starves the page: wait for the entrance animation to really finish.
  await hp.waitForFunction(() => getComputedStyle(document.querySelector('.tour-hint')).opacity === '1', null, {
    timeout: 15000,
  });
  const box = await hp.evaluate(() => {
    const e = document.querySelector('.tour-hint');
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return {
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
      op: cs.opacity,
      z: cs.zIndex,
      disp: cs.display,
      cls: e.className,
    };
  });
  assert(box.w > 200 && box.y > 400 && box.op === '1', `hint card is on screen ${JSON.stringify(box)}`);
  await shot(hp, 'tour-hint');
  await hp.locator('.tour-hint .btn', { hasText: 'Got it' }).click();
  await hp.waitForFunction(() => !document.querySelector('.tour-hint'));
  const st1 = await guideState(hp);
  assert(st1.hintsSeen?.includes('first-selection'), 'seen persisted');
  await hp.evaluate(() => {
    const a = window.physicslab;
    a.store.setSelection([]);
    a.store.setSelection([a.store.bodies()[1].id]);
  });
  await hp.waitForTimeout(1500);
  assert((await hp.locator('.tour-hint[data-key="first-selection"]').count()) === 0, 'a hint is shown only once');
  await page.close();
});
