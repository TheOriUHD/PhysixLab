/**
 * End-to-end tests of the inspector upgrades (UI-10 fields / filter / copy-paste / presets, UI-11 calculators,
 * UI-12 live readout panel) in the real app.
 */
import { assert, near, newPage, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const addBodies = (page, specs) =>
  page.evaluate((specs) => {
    const a = window.physicslab;
    const ids = specs.map((s) => a.editor.addShape(s.type ?? 'box', s.at ?? [0, 0.5, 0], s.over ?? {}).id);
    a.store.setSelection(ids);
    return ids;
  }, specs);
const body = (page, id) => page.evaluate((id) => JSON.parse(JSON.stringify(window.physicslab.store.body(id))), id);
const select = (page, ids) => page.evaluate((ids) => window.physicslab.store.setSelection(ids), ids);
/** The input of the inspector row with this label (slider rows have the number box last). */
const rowInput = (page, label) =>
  page
    .locator('.panel-body .row', { has: page.locator('.row-label', { hasText: new RegExp(`^${label}`) }) })
    .locator('.num-input')
    .first();
const typeInto = async (loc, text) => {
  await loc.click();
  await loc.press('Control+a');
  await loc.type(text);
  await loc.press('Enter');
};
const tick = (page) => page.waitForTimeout(150);

test('inspectorA: expressions and units in number fields, reset to default, label scrubbing', async () => {
  const page = await newPage();
  const [id] = await addBodies(page, [{ over: { name: 'Crate' } }]);
  await tick(page);

  // plain expression
  await typeInto(rowInput(page, 'Lin. damping'), '2*0.05');
  near((await body(page, id)).linearDamping, 0.1, 1e-9, '2*0.05 evaluated');
  // reset button appears for the modified field and restores the factory default
  const reset = page
    .locator('.row', { has: page.locator('.row-label', { hasText: /^Lin\. damping/ }) })
    .locator('.ui-a-reset');
  assert(await reset.isVisible(), 'reset button visible for a modified field');
  await reset.click();
  near((await body(page, id)).linearDamping, 0.01, 1e-9, 'reset restores the default');
  assert(!(await reset.isVisible()), 'reset button hides again at the default');

  // a bad expression is rejected and the value is kept
  await typeInto(rowInput(page, 'Gravity scale'), '2 +');
  assert((await body(page, id)).gravityScale === 1, 'garbage leaves the value alone');
  assert((await page.locator('.num-input.invalid').count()) === 1, 'the field is flagged invalid');
  await typeInto(rowInput(page, 'Gravity scale'), '5 ft'); // a length in a plain-number field
  assert((await body(page, id)).gravityScale === 1, 'a unit in a unit-less field is rejected');

  // imperial: the unit label switches, typed lengths convert, stored value stays SI
  await page.locator('.ui-a-tools .seg-btn', { hasText: 'Imp.' }).click();
  await tick(page);
  const posY = page.locator('.vec3 .num-field').nth(1).locator('.num-input');
  const shown = Number(await posY.inputValue());
  near(shown, 0.5 / 0.3048, 0.01, 'position Y shown in feet');
  await typeInto(posY, '5 ft');
  near((await body(page, id)).position[1], 1.524, 1e-3, '5 ft stored as metres');
  await typeInto(posY, '1 m'); // SI text in an imperial field converts too
  near((await body(page, id)).position[1], 1, 1e-3, '1 m stored as 1');
  // one click on a unit label flips just that field back to SI
  await page.locator('.vec3 .vec-unit').first().click();
  await tick(page);
  near(Number(await posY.inputValue()), 1, 1e-3, 'field switched to SI');
  await page.locator('.ui-a-tools .seg-btn', { hasText: 'SI' }).click();

  // scrub: dragging the row label changes the value
  const label = page.locator('.row-label', { hasText: /^Gravity scale/ });
  const box = await label.boundingBox();
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 50, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  const g = (await body(page, id)).gravityScale;
  assert(g > 1.5, `label scrub raised the gravity scale (${g})`);
  // the whole drag is one undo step
  await page.evaluate(() => window.physicslab.store.undo());
  near((await body(page, id)).gravityScale, 1, 1e-9, 'scrub undone in one step');
  assert(page.errors.length === 0, `no page errors: ${page.errors.join('; ')}`);
  await page.close();
});

test('inspectorA: filter box, collapsible sections remembered, multi-selection "mixed" editing', async () => {
  const page = await newPage();
  const ids = await addBodies(page, [
    { type: 'sphere', at: [-1, 0.5, 0], over: { name: 'A', material: { preset: 'custom', density: 500 } } },
    { type: 'sphere', at: [1, 0.5, 0], over: { name: 'B', material: { preset: 'custom', density: 900 } } },
  ]);
  await tick(page);
  assert((await rowInput(page, 'Density').inputValue()) === '—', 'differing densities show as mixed');
  await typeInto(rowInput(page, 'Density'), '1000');
  const [a, b] = await Promise.all(ids.map((i) => body(page, i)));
  assert(a.material.density === 1000 && b.material.density === 1000, 'one edit applies to every selected body');
  await page.evaluate(() => window.physicslab.store.undo());
  assert((await body(page, ids[0])).material.density === 500, 'one undo step restores both');

  // filter
  await page.fill('.ui-a-search', 'damp');
  await tick(page);
  const visible = await page.evaluate(() =>
    [...document.querySelectorAll('.panel-body .row-label')]
      .filter((l) => l.offsetParent)
      .map((l) => l.textContent.trim()),
  );
  assert(
    visible.some((t) => t.startsWith('Lin. damping')) && visible.some((t) => t.startsWith('Ang. damping')),
    `damping rows shown: ${visible}`,
  );
  assert(!visible.some((t) => t.startsWith('Density')), 'other rows hidden');
  await page.fill('.ui-a-search', '');
  await tick(page);
  assert(await rowInput(page, 'Density').isVisible(), 'clearing the filter shows everything again');

  // sections: collapse state is remembered across a reload of the selection and in storage
  const head = page.locator('.panel-body .section-head', { hasText: 'Physics' });
  await head.click();
  await select(page, [ids[0]]);
  await tick(page);
  assert(
    (await page.locator('.panel-body .section.open > .section-head', { hasText: 'Physics' }).count()) === 0,
    'Physics stays collapsed after reselecting',
  );
  assert(
    (await page.evaluate(() => localStorage.getItem('physicslab:section:physics'))) === '0',
    'remembered in localStorage',
  );
  await page.click('.ui-a-tools .icon-btn[title^="Collapse"]');
  await tick(page);
  assert(
    (await page.locator('.panel-body:has(.ui-a-tools) > .section.open').count()) === 0,
    'collapse all closes every section',
  );
  await page.click('.ui-a-tools .icon-btn[title^="Collapse"]');
  assert(
    (await page.locator('.panel-body:has(.ui-a-tools) > .section.open').count()) > 3,
    'expand all opens them again',
  );
  assert(page.errors.length === 0, `no page errors: ${page.errors.join('; ')}`);
  await page.close();
});

test('inspectorA: copy / paste of selected sections and property presets', async () => {
  const page = await newPage();
  const [a, b, c] = await page.evaluate(() => {
    const ed = window.physicslab.editor;
    return [
      ed.addShape('box', [-2, 0.5, 0], {
        name: 'Source',
        linearDamping: 0.3,
        material: { preset: 'custom', density: 2222, friction: 0.9 },
      }).id,
      ed.addShape('box', [0, 0.5, 0], { name: 'Target' }).id,
      ed.addShape('box', [2, 0.5, 0], { name: 'Third' }).id,
    ];
  });
  const frictionB = (await body(page, b)).material.friction;
  await select(page, [a]);
  await tick(page);
  await page.click('.ui-a-props-wrap [data-act="copy"]');
  await select(page, [b]);
  await tick(page);
  await page.click('.ui-a-props-wrap [data-act="paste"]');
  // paste only "Damping & mass"
  for (const g of ['Material', 'Appearance', 'Locks & options', 'Initial motion', 'Thruster']) {
    await page.locator('.ui-a-props .ui-a-group', { hasText: g }).locator('input').uncheck();
  }
  await page.locator('.ui-a-props button', { hasText: 'Paste' }).click();
  await tick(page);
  const pb = await body(page, b);
  near(pb.linearDamping, 0.3, 1e-9, 'damping pasted');
  assert(pb.material.friction === frictionB && pb.material.density !== 2222, 'unticked sections are untouched');
  await page.evaluate(() => window.physicslab.store.undo());
  near((await body(page, b)).linearDamping, 0.01, 1e-9, 'paste is one undo step');

  // presets: save the material of Source, apply to Third
  await select(page, [a]);
  await tick(page);
  await page.click('.ui-a-props-wrap [data-act="presets"]');
  await page.locator('.ui-a-props .ui-a-group', { hasText: 'Material' }).locator('input').check(); // ticks persist
  for (const g of ['Appearance', 'Damping & mass', 'Locks & options', 'Initial motion', 'Thruster']) {
    await page.locator('.ui-a-props .ui-a-group', { hasText: g }).locator('input').uncheck();
  }
  await page.fill('.ui-a-preset-name', 'Dense and grippy');
  await page.locator('.ui-a-props button', { hasText: 'Save' }).click();
  const toastText = await page.locator('.toast').allTextContents();
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('physicslab:ui-a:presets') ?? '{"presets":[]}'),
  );
  assert(stored.presets.length === 1, `preset saved (toasts: ${toastText.join(' | ')})`);
  assert(
    stored.presets.length === 1 && stored.presets[0].snapshot.material.density === 2222,
    'preset persisted without the unticked sections',
  );
  assert(!stored.presets[0].snapshot.damping, 'unticked groups are not saved');
  await select(page, [c]);
  await tick(page);
  await page.click('.ui-a-props-wrap [data-act="presets"]');
  await page.locator('.ui-a-preset', { hasText: 'Dense and grippy' }).click();
  await tick(page);
  const pc = await body(page, c);
  assert(pc.material.density === 2222 && pc.material.friction === 0.9, 'preset applied');
  // a corrupt stored preset list is ignored instead of breaking the inspector
  await page.evaluate(() => localStorage.setItem('physicslab:ui-a:presets', '{"presets":[{"id":1}]}'));
  await page.reload();
  await page.waitForFunction(() => !!window.physicslab?.viewport);
  assert(page.errors.length === 0, `no page errors: ${page.errors.join('; ')}`);
  await page.close();
});

test('inspectorA: calculators write into the object and undo', async () => {
  const page = await newPage();
  const [id] = await addBodies(page, [{ type: 'sphere', over: { name: 'Ball', position: [0, 3, 0] } }]);
  await tick(page);
  await page.locator('.panel-body .section-head', { hasText: 'Calculators' }).click();
  await tick(page);
  const calc = (title) => page.locator('.ui-a-calc', { has: page.locator('.ui-a-calc-title', { hasText: title }) });

  // mass <-> density: ask for 10 kg
  const mb = calc('Mass · density · volume');
  const massIn = mb.locator('.row', { has: page.locator('.row-label', { hasText: /^Mass/ }) }).locator('.num-input');
  await typeInto(massIn, '10');
  const dens = Number(
    await mb
      .locator('.row', { has: page.locator('.row-label', { hasText: /^Density/ }) })
      .locator('.num-input')
      .inputValue(),
  );
  const vol = Math.PI / 6; // unit sphere
  near(dens, 10 / vol, 0.01 * (10 / vol), 'density computed from the wanted mass');
  await mb.locator('button', { hasText: 'Set density' }).click();
  near((await body(page, id)).material.density, 10 / vol, 0.5, 'Set density writes the material');
  await page.evaluate(() => window.physicslab.store.undo());
  assert((await body(page, id)).material.preset !== 'custom', 'undo restores the material');

  // terminal velocity -> drag coefficient c = m g / vt^2 (via 1/2 rho Cd A)
  const tb = calc('Terminal velocity');
  await tb.locator('button', { hasText: 'Set air drag' }).click();
  const drag = (await body(page, id)).drag.linear2;
  const expected = 0.5 * 1.225 * 0.47 * (Math.PI / 4);
  near(drag, expected, expected * 0.001, 'drag = ½ρCdA for the unit sphere');

  // projectile: 20 m/s at 45 degrees -> range v^2/g on level ground (launch height 0)
  const pb = calc('Projectile range');
  const prow = (label) => pb.locator('.row', { has: page.locator('.row-label', { hasText: new RegExp(`^${label}`) }) });
  await typeInto(prow('Launch speed').locator('.num-input'), '20');
  await typeInto(prow('Elevation').locator('.num-input'), '45');
  await typeInto(prow('Launch height').locator('.num-input'), '0');
  const rangeText = await prow('Range').locator('.ui-a-out').textContent();
  near(parseFloat(rangeText), 400 / 9.81, 0.05, `range ${rangeText}`);
  await pb.locator('button', { hasText: 'Set launch velocity' }).click();
  const v = (await body(page, id)).velocity;
  near(Math.hypot(...v), 20, 1e-3, 'launch speed written');
  near(v[1], 20 * Math.sin(Math.PI / 4), 1e-3, 'elevation written');
  await shot(page, 'inspectorA-calculators');

  // a spring: the stiffness from the period
  await page.evaluate(() => {
    const a = window.physicslab;
    const m = a.editor.addShape('box', [3, 3, 0], {
      name: 'Bob',
      massOverride: 2,
      material: { preset: 'custom', density: 100 },
    });
    const j = a.editor.addJoint('spring', { body: null, point: [3, 6, 0] }, { body: m.id, point: [3, 3, 0] });
    a.store.setSelection([j.id]);
  });
  await tick(page);
  const sb = calc('Spring constant');
  assert((await sb.count()) === 1, 'spring calculators shown for a spring joint');
  const srow = (label) => sb.locator('.row', { has: page.locator('.row-label', { hasText: new RegExp(`^${label}`) }) });
  await typeInto(srow('Mass').locator('.num-input'), '2');
  await typeInto(srow('Period T').locator('.num-input'), '0.5');
  await sb.locator('button', { hasText: 'Set stiffness' }).click();
  const jid = await page.evaluate(() => window.physicslab.store.selection[0]);
  const k = await page.evaluate((id) => window.physicslab.store.joint(id).spring.stiffness, jid);
  near(k, 2 * ((2 * Math.PI) / 0.5) ** 2, 0.5, 'k = m (2π/T)²');
  assert(page.errors.length === 0, `no page errors: ${page.errors.join('; ')}`);
  await page.close();
});

test('inspectorA: Readout panel shows live engine values while simulating, pins and copies', async () => {
  const page = await newPage();
  const [id] = await addBodies(page, [{ type: 'sphere', at: [0, 6, 0], over: { name: 'Faller' } }]);
  await page.evaluate(() => window.physicslab.prefs.set({ rightTab: 'readout', showRight: true }));
  await tick(page);
  assert((await page.locator('.ui-a-readout .empty-state').count()) === 1, 'edit mode explains that values are live');
  await page.evaluate(() => window.physicslab.sim.play());
  await simTime(page, 0.6);
  await page.waitForSelector('.ui-a-readout-rows');
  await page.waitForTimeout(250);
  const text = (label) =>
    page
      .locator('.ui-a-readout .row', { has: page.locator('.row-label', { hasText: new RegExp(`^${label}`) }) })
      .locator('.ui-a-readout-value')
      .textContent();
  const accel = parseFloat((await text('Acceleration')).split(',')[1]);
  near(accel, -9.81, 2.5, `acceleration ≈ −g while falling (${accel})`);
  // freeze the world so the engine and the readout can be compared exactly
  await page.evaluate(() => window.physicslab.sim.pause());
  await page.waitForTimeout(500);
  const live = await page.evaluate((id) => window.physicslab.sim.velocityOf(id), id);
  const vy = parseFloat((await text('Velocity')).split(',')[1]);
  near(vy, live.linear[1], 0.01, `readout velocity ${vy} equals the engine ${live.linear[1]}`);
  assert(Number.isFinite(vy), 'velocity is a number');
  const speed = parseFloat(await text('Speed'));
  near(speed, Math.abs(vy), 0.01, 'speed is |v|');
  const mass = parseFloat(await text('Mass'));
  near(
    mass,
    await page.evaluate((id) => window.physicslab.sim.client.info.mass[id], id),
    1e-2,
    'mass is the engine mass',
  );
  const ke = parseFloat(await text('Kinetic energy'));
  const pe = parseFloat(await text('Potential energy'));
  // the engine's kinetic energy is translational + rotational, so ½mv² is a lower bound
  assert(
    ke >= 0.5 * mass * speed * speed - 0.02 * ke - 0.05,
    `kinetic energy ${ke} ≥ ½mv² = ${0.5 * mass * speed * speed}`,
  );
  const y = parseFloat((await text('Position')).split(',')[1]); // the same sample as the energies
  near(pe, mass * 9.81 * y, 0.02 * pe + 0.5, `potential energy m·g·h (y = ${y})`);
  await page.evaluate(() => window.physicslab.sim.play());

  // unit switch on one row
  const row = page.locator('.ui-a-readout .row', { has: page.locator('.row-label', { hasText: /^Speed/ }) });
  await row.locator('.unit-toggle').click();
  await page.waitForTimeout(250);
  assert((await row.locator('.unit-toggle').textContent()) === 'ft/s', 'speed row switched to ft/s');
  await row.locator('.unit-toggle').click();

  // pin: select nothing; the readout keeps following the body
  await page.click('.ui-a-readout-title', { trial: true }).catch(() => {});
  await page.locator('.ui-a-readout .ui-a-pin').click();
  await page.evaluate(() => window.physicslab.store.setSelection([]));
  await page.waitForTimeout(300);
  assert((await page.locator('.ui-a-readout-rows').count()) === 1, 'pinned readout survives deselecting');
  assert((await page.locator('.ui-a-readout-title .badge').textContent()) === 'PINNED', 'pinned badge');

  // contacts: let it land
  await page.waitForSelector('.ui-a-contact b', { timeout: 60000 }).catch(async (e) => {
    const d = await page.evaluate(
      (id) => ({ pose: window.physicslab.sim.poseOf(id), t: window.physicslab.sim.client.stats?.simTime }),
      id,
    );
    throw new Error(`no contact listed: ${JSON.stringify(d)} (${e.message})`);
  });
  await page.waitForTimeout(600);
  const contact = await page
    .locator('.ui-a-contact b')
    .first()
    .textContent()
    .catch(() => null);
  const known = await page.evaluate(() =>
    window.physicslab.store
      .all()
      .map((e) => e.name)
      .concat('ground'),
  );
  assert(contact && known.includes(contact), `landing is listed as a contact with a real object (${contact})`);
  assert(/N·s/.test(await page.locator('.ui-a-contact span').first().textContent()), 'contact shows its impulse');

  await shot(page, 'inspectorA-readout');
  const copyBtn = page.locator('.ui-a-readout .ui-a-copy');
  assert((await copyBtn.count()) === 1, `one Copy button in the readout (${await copyBtn.count()})`);
  await copyBtn.click({ timeout: 8000 });
  await page.waitForSelector('.toast');
  const toast = await page.locator('.toast').last().textContent();
  assert(/Readout copied|Could not copy/.test(toast), `copy gives feedback (${toast})`);
  await shot(page, 'inspectorA-readout');
  assert(page.errors.length === 0, `no page errors: ${page.errors.join('; ')}`);
  await page.close();
});
