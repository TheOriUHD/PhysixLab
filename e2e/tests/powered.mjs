/**
 * End-to-end tests for the powered parts (package CP-1 … CP-5): the Controls panel (keys and analog axes), the
 * flames, blades and gauges drawn in the viewport, the inspector for a drive-train component, and a few of the
 * example scenes driven with the real keyboard.
 */
import { assert, near, newPage, nextFrame, pose, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** The first component of a given type on the named entity, with its published numbers. */
const compOf = (page, entityName, type) =>
  page.evaluate(
    ([entityName, type]) => {
      const a = window.physixlab;
      const e = a.store.all().find((x) => x.name === entityName);
      const c = e.components.find((c) => c.type === type);
      return { owner: e.id, id: c.id, params: c.params };
    },
    [entityName, type],
  );
const stateOf = (page, id) =>
  page.evaluate((id) => {
    const v = window.physixlab.sim.client.stateOf(id);
    return v ? [...v] : null;
  }, id);
const velocity = (page, id) => page.evaluate((id) => window.physixlab.sim.velocityOf(id)?.linear ?? null, id);
/** Pause on a frame that shows what the test just made happen, take the screenshot, and carry on. */
const freezeShot = async (page, name) => {
  await page.evaluate(() => window.physixlab.sim.pause());
  for (let i = 0; i < 3; i++) await nextFrame(page);
  await shot(page, name);
  await page.evaluate(() => window.physixlab.sim.play());
};
const play = async (page) => {
  await page.evaluate(() => window.physixlab.sim.play());
  await simTime(page, 0.3);
};
const openControls = async (page) => {
  await page.getByRole('tab', { name: 'Controls' }).click();
  await page.waitForSelector('#panel-controls', { state: 'visible' });
};

test('powered: the Controls panel lists the keys and axes of a rocket and its slider sets the throttle', async () => {
  const page = await newPage('&scene=rocket-launch');
  await openControls(page);
  assert((await page.locator('.ctl-key').count()) === 1, 'one key cap (F)');
  assert((await page.locator('.ctl-key kbd').first().textContent()) === 'F', 'the key cap reads F');
  assert((await page.locator('.ctl-row').count()) === 1, 'one axis row');
  assert((await page.locator('.ctl-name').first().textContent()) === 'throttle', 'the axis is the throttle');
  // before Play the controls are disabled and say why
  assert(await page.locator('.ctl-slider').first().isDisabled(), 'the slider waits for Play');
  assert(/Press Play/.test((await page.locator('.ctl-hint').textContent()) ?? ''), 'the hint says Press Play');
  // while editing, the selected rocket shows a faint flame preview (one drawn thing)
  await page.waitForFunction(() => window.physixlab.componentFx.count === 1, null, { timeout: 10000 });
  await shot(page, 'powered-01-controls-idle');

  await play(page);
  const rocket = await compOf(page, 'Rocket', 'thruster');
  assert(!(await page.locator('.ctl-slider').first().isDisabled()), 'the slider is live while playing');
  await page.locator('.ctl-slider').first().fill('0.5');
  await page.waitForFunction(
    (id) => {
      const v = window.physixlab.sim.client.stateOf(id);
      return v && Math.abs(v[0] - 450) < 8;
    },
    rocket.id,
    { timeout: 20000 },
  );
  const half = await stateOf(page, rocket.id);
  near(half[0], 450, 15, 'half throttle on the slider gives half of the 900 N');
  assert(/\+0\.50/.test((await page.locator('.ctl-out').first().textContent()) ?? ''), 'the readout shows +0.50');
  // the reset button zeroes the axis again
  await page.locator('.ctl-reset').first().click();
  await page.waitForFunction(
    (id) => {
      const v = window.physixlab.sim.client.stateOf(id);
      return v && v[0] < 5;
    },
    rocket.id,
    { timeout: 20000 },
  );
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('powered: holding the F key cap fires the rocket; a flame is drawn and the climb follows the thrust', async () => {
  const page = await newPage('&scene=rocket-launch');
  await openControls(page);
  await play(page);
  const rocket = await compOf(page, 'Rocket', 'thruster');
  const key = page.locator('.ctl-key').first();
  const box = await key.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  assert(await page.evaluate(() => window.physixlab.sim.keys.has('KeyF')), 'the key cap holds F for the simulation');
  assert((await key.getAttribute('aria-pressed')) === 'true', 'the cap shows it is pressed');
  await page.waitForFunction(
    (id) => {
      const v = window.physixlab.sim.client.stateOf(id);
      return v && v[0] > 800;
    },
    rocket.id,
    { timeout: 20000 },
  );
  await page.waitForFunction(() => window.physixlab.componentFx.count >= 1, null, { timeout: 10000 });
  await page.waitForFunction((id) => window.physixlab.sim.poseOf(id).position[1] > 6, rocket.owner, {
    timeout: 30000,
  });
  await freezeShot(page, 'powered-02-rocket-firing');
  const climbing = await velocity(page, rocket.owner);
  assert(climbing[1] > 3, `the rocket climbs (${climbing[1].toFixed(1)} m/s)`);
  await page.mouse.up();
  assert(await page.evaluate(() => !window.physixlab.sim.keys.has('KeyF')), 'releasing the cap releases the key');
  await page.waitForFunction(() => window.physixlab.componentFx.count === 0, null, { timeout: 20000 });
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('powered: the powertrain car drives with the real keyboard and shows its engine gauges in the inspector', async () => {
  const page = await newPage('&scene=powertrain-car');
  await play(page);
  const car = await page.evaluate(() => window.physixlab.store.bodies().find((b) => /chassis/i.test(b.name)).id);
  // select the chassis: the inspector lists the engine with its live numbers
  await page.evaluate((id) => window.physixlab.store.setSelection([id]), car);
  await page.getByRole('tab', { name: 'Inspector' }).click();
  await page.waitForSelector('.panel.right .comp[data-type="engine"]');
  await page.keyboard.down('KeyW');
  await simTime(page, 3);
  const v = await velocity(page, car);
  const speed = Math.hypot(v[0], v[2]);
  assert(speed > 3, `W accelerates the car (${speed.toFixed(1)} m/s)`);
  const engine = await compOf(page, 'Powertrain car chassis', 'engine');
  const rpm = (await stateOf(page, engine.id))[0];
  assert(rpm > 1500, `the engine speeds up with the car (${rpm.toFixed(0)} rpm)`);
  const live = (await page.locator('.panel.right .comp[data-type="engine"] .comp-state').allTextContents()).join(' ');
  assert(/rpm/.test(live), `the engine card shows its live readouts: ${live}`);
  await freezeShot(page, 'powered-03-powertrain-car');
  await page.keyboard.up('KeyW');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('powered: servo arm - the dial gauge and the key-driven target', async () => {
  const page = await newPage('&scene=servo-arm');
  await openControls(page);
  assert((await page.locator('.ctl-key').count()) >= 2, 'the servo arm lists its keys');
  await play(page);
  const joint = await page.evaluate(() => {
    const j = window.physixlab.store.joints().find((j) => j.components.some((c) => c.type === 'servo'));
    return { id: j.id, comp: j.components.find((c) => c.type === 'servo').id };
  });
  const key = await page.evaluate((id) => window.physixlab.store.joint(id).components[0].params, joint.id);
  const hold = key.keyPlus;
  await page.keyboard.down(hold);
  await simTime(page, 1.6);
  await page.keyboard.up(hold);
  const s = await stateOf(page, joint.comp);
  assert(s && Math.abs(s[0]) > 5, `the servo moved (${s?.[0]?.toFixed?.(1)} deg)`);
  await page.waitForFunction(() => window.physixlab.componentFx.count >= 1, null, { timeout: 10000 });
  await freezeShot(page, 'powered-04-servo-arm');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('powered: the helicopter scene lifts off from the keyboard and its rotor blur is drawn', async () => {
  const page = await newPage('&scene=helicopter');
  await openControls(page);
  assert((await page.locator('.ctl-row').count()) === 2, 'pitch and roll axes are listed');
  await play(page);
  const heli = await compOf(page, 'Helicopter', 'rotor');
  await page.keyboard.down('KeyR');
  await page.waitForFunction((id) => window.physixlab.sim.poseOf(id).position[1] > 2.2, heli.owner, {
    timeout: 90000,
  });
  const y = (await pose(page, heli.owner)).position[1];
  assert(y > 2.2, `the helicopter has lifted off (${y.toFixed(2)} m)`);
  const blades = await stateOf(page, heli.id);
  assert(blades[0] > 300, `the rotor is up to speed (${blades[0].toFixed(0)} rpm)`);
  await freezeShot(page, 'powered-05-helicopter');
  await page.keyboard.up('KeyR');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('powered: the Add component menu offers the powered parts and a shaft field suggests the names in use', async () => {
  const page = await newPage('&scene=powertrain-car');
  const car = await page.evaluate(() => window.physixlab.store.bodies().find((b) => /chassis/i.test(b.name)).id);
  await page.evaluate((id) => window.physixlab.store.setSelection([id]), car);
  await page.getByRole('tab', { name: 'Inspector' }).click();
  await page.waitForSelector('.panel.right .comp[data-type="engine"]');
  await page.click('.panel.right .comp-add');
  await page.waitForSelector('.comp-menu');
  const names = await page.locator('.comp-menu .comp-item .comp-item-name').allTextContents();
  for (const want of ['Engine', 'Brake', 'Clutch', 'Gearbox', 'Differential', 'Propeller'])
    assert(
      names.some((n) => n.includes(want)),
      `the menu offers ${want}: ${names.join(', ')}`,
    );
  await page.keyboard.press('Escape');
  // a shaft field is a text input tied to a datalist of the shaft names the scene already uses
  const input = page.locator('.panel.right .comp[data-type="engine"] input.comp-text').first();
  await input.focus();
  const listId = await input.getAttribute('list');
  assert(!!listId, 'the field has a suggestion list');
  const options = await page.evaluate(
    (id) => [...document.querySelectorAll(`#${id} option`)].map((o) => o.value),
    listId,
  );
  assert(options.length > 0, `the list holds the shaft names in use: ${options.join(', ')}`);
  await shot(page, 'powered-06-inspector');
  assert(page.errors.length === 0, `no errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('powered: the jet car draws an exhaust that grows with the afterburner, the propeller cart a blade blur', async () => {
  const page = await newPage('&scene=jet-car');
  await play(page);
  const jet = await compOf(page, 'Jet car chassis', 'jet');
  await page.keyboard.down('KeyW');
  await page.waitForFunction(
    (id) => {
      const v = window.physixlab.sim.client.stateOf(id);
      return v && v[1] > 90;
    },
    jet.id,
    { timeout: 60000 },
  );
  assert(await page.evaluate(() => window.physixlab.componentFx.count >= 1), 'an exhaust flame is drawn');
  await freezeShot(page, 'powered-07-jet-exhaust');
  await page.keyboard.down('ShiftLeft');
  await page.waitForFunction(
    (id) => {
      const v = window.physixlab.sim.client.stateOf(id);
      return v && v[2] === 1;
    },
    jet.id,
    { timeout: 30000 },
  );
  await simTime(page, (await page.evaluate(() => window.physixlab.sim.client.stats.simTime)) + 0.6);
  await freezeShot(page, 'powered-08-jet-afterburner');
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  await page.close();

  const cart = await newPage('&scene=propeller-cart');
  await play(cart);
  const prop = await compOf(cart, 'Propeller cart chassis', 'propeller');
  await cart.keyboard.down('KeyW');
  await cart.waitForFunction(
    (id) => {
      const v = window.physixlab.sim.client.stateOf(id);
      return v && v[0] > 2000;
    },
    prop.id,
    { timeout: 60000 },
  );
  assert(await cart.evaluate(() => window.physixlab.componentFx.count >= 1), 'the propeller blur is drawn');
  await freezeShot(cart, 'powered-09-propeller-blur');
  await cart.keyboard.up('KeyW');
  assert(cart.errors.length === 0, `no errors: ${cart.errors.join(' | ')}`);
  await cart.close();
});
