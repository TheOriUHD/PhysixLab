/**
 * SF end-to-end tests: the soft-body inspector sections driven through the real UI (tyre pressure and puncture, the
 * Young's modulus field, the mesh source picker, fastenings, stability warnings with their fix button, the budget
 * section and economy mode). Every assertion reads the document back from the store.
 */
import { assert, near, newPage, nextFrame, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** Page errors, ignoring other packages' extension-registration warnings (a shortcut clash is not about the inspector). */
const ownErrors = (page) => page.errors.filter((e) => !/extensions\/|already used by/.test(e));

/** Add a soft body through the editor and select it (the inspector under test is the real one). */
async function addAndSelect(page, type, over = {}) {
  const id = await page.evaluate(
    ({ type, over }) => {
      const a = window.physixlab;
      const s = a.editor.addSoft(type, [0, 2, 0], over);
      a.viewport.setView({ position: [0, 3, 7], target: [0, 1.5, 0] });
      a.store.setSelection([s.id]);
      return s.id;
    },
    { type, over },
  );
  await page.waitForSelector('.section-head:has-text("Material")');
  return id;
}

const soft = (page, id) => page.evaluate((id) => JSON.parse(JSON.stringify(window.physixlab.store.soft(id))), id);

/** Type into the number field of the inspector row with this label and commit with Enter. */
async function typeInto(page, label, value) {
  const input = page.locator(`.row:has(.row-label:text-is("${label}")) .num-input`).first();
  await input.click();
  await input.press('Control+a');
  await input.type(String(value));
  await input.press('Enter');
}

async function openSection(page, title) {
  const open = await page.evaluate((t) => {
    for (const s of document.querySelectorAll('.section'))
      if (s.querySelector('.section-head')?.textContent?.includes(t)) return s.classList.contains('open');
    return null;
  }, title);
  assert(open !== null, `section "${title}" exists`);
  if (!open) await page.click(`.section-head:has-text("${title}")`);
}

test('softInspector: tyre pressure, puncture, seal and the Young modulus field edit the document', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physixlab.newScene());
  const id = await addAndSelect(page, 'tyre');
  const before = await soft(page, id);
  await shot(page, 'sf-tyre-1600');

  await typeInto(page, 'Pressure (target volume ×)', 1.45);
  near((await soft(page, id)).volumeFactor, 1.45, 0.001, 'pressure slider field sets volumeFactor');

  await page.click('button:has-text("Puncture")');
  near((await soft(page, id)).leakRate, 1.5, 1e-9, 'Puncture sets the leak rate');
  await page.waitForSelector('.sf-caption:has-text("Leaking")');
  await page.click('button:has-text("Seal")');
  near((await soft(page, id)).leakRate, 0, 1e-9, 'Seal closes the leak');

  // Young's modulus: double the displayed value -> stiffness grows by about sqrt(2)
  const kPa = await page.locator('.row:has(.row-label:has-text("Young")) .num-input').inputValue();
  await typeInto(page, "Young's modulus ≈", Number(kPa) * 2);
  const after = await soft(page, id);
  near(after.stiffness / before.stiffness, Math.SQRT2, 0.06, 'doubling E raises the stiffness by sqrt(2)');

  await typeInto(page, 'Surface friction', 2.2);
  near((await soft(page, id)).friction, 2.2, 0.001, 'friction field edits the document');
  await typeInto(page, 'Particle radius', 0.035);
  near((await soft(page, id)).particleRadius, 0.035, 1e-6, 'radius override edits the document');
  await page.waitForSelector('.sf-caption:has-text("Override in use")');
  await page.locator('.section-head:has-text("Contact")').scrollIntoViewIfNeeded();
  await shot(page, 'sf-tyre-contact-1600');
  await page.locator('.section-head:has-text("Pressure")').scrollIntoViewIfNeeded();
  await shot(page, 'sf-tyre-pressure-1600');

  // undo is one step per edit
  await page.evaluate(() => window.physixlab.store.undo());
  near((await soft(page, id)).particleRadius, 0, 1e-9, 'undo reverts the radius override');
  assert(ownErrors(page).length === 0, `no page errors: ${ownErrors(page).join('; ')}`);
});

test('softInspector: mesh source shape and cell size', async () => {
  const page = await newPage('', { width: 1280, height: 720 });
  await page.evaluate(() => window.physixlab.newScene());
  const id = await addAndSelect(page, 'mesh');
  await page.waitForSelector('.section-head:has-text("Mesh source")');
  const count0 = await page.locator('.sf-caption:has-text("particles")').first().textContent();
  await page.selectOption('.row:has(.row-label:text-is("Source shape")) select', 'cylinder');
  assert((await soft(page, id)).shape.type === 'cylinder', 'source shape stored');
  await typeInto(page, 'Cell size', 0.1);
  near((await soft(page, id)).cell, 0.1, 1e-6, 'cell size stored');
  const count1 = await page.locator('.sf-caption:has-text("particles")').first().textContent();
  const n = (t) => Number(/(\d+)/.exec(t)[1]);
  assert(n(count1) > n(count0), `smaller cells show more particles (${count0} -> ${count1})`);
  await shot(page, 'sf-mesh-1280');
});

test('softInspector: fastenings list the target, its load, and Remove edits the document', async () => {
  const page = await newPage();
  const { cable, weight } = await page.evaluate(() => {
    const a = window.physixlab;
    a.newScene();
    const w = a.editor.addShape('sphere', [1.5, 1.2, 0], {
      name: 'Hanging weight',
      material: { preset: 'custom', density: 400 },
    });
    const c = a.editor.addSoft('cable', [0, 2.4, 0], {});
    a.store.update(
      c.id,
      {
        attachments: [
          { id: 'att1', body: w.id, kind: 'region', center: [1.5, 0, 0], radius: 0.2, offset: [0, 0.3, 0] },
        ],
      },
      'Test fastening',
    );
    return { cable: c.id, weight: w.id };
  });
  await page.evaluate((id) => window.physixlab.store.setSelection([id]), cable);
  await page.waitForSelector('.section-head:has-text("Fastenings")');
  await openSection(page, 'Fastenings');
  await page.waitForSelector('.sf-att');
  assert((await page.locator('.sf-att-name').first().textContent()) === 'Hanging weight', 'target body name shown');
  const expected = await page.evaluate((w) => {
    const a = window.physixlab;
    const b = a.store.body(w);
    const m = b.material.density * (4 / 3) * Math.PI * (b.shape.size[0] / 2) ** 3;
    return m * Math.hypot(...a.store.settings.gravity);
  }, weight);
  const shown = await page.locator('.sf-att .row:has(.row-label:text-is("Load carried")) .readout').textContent();
  near(parseFloat(shown), expected, 0.06, `load carried reads m*g (${shown}; expected ${expected.toFixed(2)} N)`);

  await typeInto(page, 'Radius', 0.5);
  near((await soft(page, cable)).attachments[0].radius, 0.5, 1e-6, 'fastening radius edit stored');

  // Release is a live-sim action: disabled in edit mode
  assert(
    await page.locator('.sf-att button:has-text("Release")').isDisabled(),
    'Release disabled without a simulation',
  );
  await page.click('.sf-att button:has-text("Remove")');
  assert((await soft(page, cable)).attachments.length === 0, 'Remove deletes the fastening from the document');
  await page.waitForSelector('.sf-att', { state: 'detached' });
  await page.evaluate(() => window.physixlab.store.undo());
  assert((await soft(page, cable)).attachments.length === 1, 'undo restores the fastening');

  // with the simulation running, Release sends the op and the page stays healthy
  await page.evaluate(() => window.physixlab.sim.play());
  await simTime(page, 0.2);
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('.sf-att button')].find((x) => x.textContent?.includes('Release'));
    return !!b && !b.disabled;
  });
  await page.click('.sf-att button:has-text("Release")');
  await simTime(page, 0.4);
  await page.evaluate(() => window.physixlab.sim.reset());
  assert(ownErrors(page).length === 0, `no page errors: ${ownErrors(page).join('; ')}`);
});

test('softInspector: a stability warning shows its fix button, which applies the patch', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physixlab.newScene());
  const id = await addAndSelect(page, 'cable', { stiffness: 3, size: [3, 0, 0], pin: 'ends' });
  await page.waitForSelector('.sf-warning[data-warning="too-soft"]');
  await shot(page, 'sf-warning-1600');
  const before = await soft(page, id);
  await page.click('.sf-warning[data-warning="too-soft"] button');
  const after = await soft(page, id);
  assert(
    after.stiffness > before.stiffness * 2,
    `fix raised the stiffness (${before.stiffness} -> ${after.stiffness})`,
  );
  await page.waitForSelector('.sf-warning[data-warning="too-soft"]', { state: 'detached' });
  await page.evaluate(() => window.physixlab.store.undo());
  near((await soft(page, id)).stiffness, 3, 1e-9, 'undo reverts the fix');
  await page.waitForSelector('.sf-warning[data-warning="too-soft"]');
});

test('softInspector: no stability section when the body is fine; budget, lower resolution and economy mode', async () => {
  const page = await newPage('', { width: 1280, height: 720 });
  await page.evaluate(() => window.physixlab.newScene());
  const id = await addAndSelect(page, 'cloth', { resolution: 40, pin: 'edge' });
  assert((await page.locator('.sf-warning').count()) === 0, 'no warnings for a healthy cloth');
  const visible = await page.evaluate(
    () => [...document.querySelectorAll('.section')].find((s) => s.textContent?.startsWith('Stability'))?.style.display,
  );
  assert(visible === 'none' || visible === undefined, `Stability section hidden when clean (${visible})`);

  await openSection(page, 'Budget');
  await page.waitForSelector('.sf-bar');
  const tier = await page.locator('.sf-bar').getAttribute('data-tier');
  assert(tier === 'heavy', `1600 particles reads as heavy (${tier})`);
  const r0 = (await soft(page, id)).resolution;
  await page.click('button:has-text("Lower resolution")');
  assert((await soft(page, id)).resolution < r0, 'Lower resolution reduced the resolution');

  await page.click('.section:has(.section-head:has-text("Budget")) .switch:has-text("Economy mode")');
  const st = await page.evaluate(() => ({
    pref: window.physixlab.prefs.value.softEconomy,
    sim: window.physixlab.sim.softEconomy,
  }));
  assert(
    st.pref === true && st.sim === true,
    `economy mode persisted in prefs and the controller (${JSON.stringify(st)})`,
  );

  // live elastic energy appears while simulating
  await page.evaluate(() => window.physixlab.sim.play());
  await simTime(page, 0.3);
  await nextFrame(page);
  await page.waitForSelector('.row:has(.row-label:text-is("Elastic energy")) .readout:not(:has-text("—"))');
  await page.evaluate(() => {
    window.physixlab.sim.reset();
    window.physixlab.prefs.set({ softEconomy: false });
    window.physixlab.sim.softEconomy = false;
  });
  await page.locator('.sf-bar').scrollIntoViewIfNeeded();
  await shot(page, 'sf-budget-1280');
  assert(ownErrors(page).length === 0, `no page errors: ${ownErrors(page).join('; ')}`);
});
