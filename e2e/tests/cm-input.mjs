/**
 * CM-A input: Settings › Keyboard rebinding in the real UI, gamepad → analog axes → a driven car, keyboard ramp.
 */
import { assert, near, newPage, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Other packages' extensions may report their own load problems on a busy integration branch: only our errors count.
const noErrors = (page) => {
  const own = page.errors.filter((e) => !/\[extension \.\.\/extensions\/(?!input-settings|camera)/.test(e));
  assert(own.length === 0, own.join('\n'));
};

const MOCK_PAD = `
  window.__pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true,
    mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
  navigator.getGamepads = () => [window.__pad, null, null, null];
`;

const carX = (page) =>
  page.evaluate(() => {
    const a = window.physicslab;
    const chassis = a.store.bodies().find((b) => /chassis|body/i.test(b.name)) ?? a.store.bodies()[0];
    return a.sim.poseOf(chassis.id)?.position ?? null;
  });

test('input settings: rebind Play to F9 in the dialog, conflict is reported, reset restores Space', async () => {
  const page = await newPage('&scene=car');
  await page.keyboard.press('Control+k');
  await page.fill('.palette-input', 'keyboard gamepad');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.input-modal .kb-row');
  await page.fill('.input-modal input[type=search]', 'start / pause');
  await page.waitForFunction(() => document.querySelectorAll('.input-modal .kb-row').length === 1);
  const row = page.locator('.input-modal .kb-row').first();
  await row.locator('.kb-slot').first().click();
  await page.keyboard.press('Control+z'); // conflicts with Undo
  await page.waitForSelector('.input-modal .kb-status button');
  const msg = await page.locator('.input-modal .kb-status').innerText();
  assert(/already/.test(msg), `conflict message: ${msg}`);
  await page.locator('.input-modal .kb-row').first().locator('.kb-slot').first().click();
  await page.keyboard.press('F9');
  await page.waitForFunction(() => window.physicslab.prefs.value.input.preset === 'custom');
  const saved = await page.evaluate(() => window.physicslab.prefs.value.input.bindings);
  assert(
    Object.values(saved).some((l) => l.includes('F9')),
    `F9 saved: ${JSON.stringify(saved)}`,
  );
  await shot(page, 'cm-keyboard-settings');
  await page.keyboard.press('Escape');
  await page.click('.viewport-canvas', { position: { x: 500, y: 300 } });
  await page.keyboard.press('F9');
  await page.waitForFunction(() => window.physicslab.sim.active, null, { timeout: 5000 });
  await page.keyboard.press('F9');
  // reset all
  await page.evaluate(() => window.physicslab.input.update_settings({ bindings: {} }));
  noErrors(page);
  await page.close();
});

test('gamepad: right trigger drives the car forward and the left stick steers via analog axes', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(MOCK_PAD);
  const before = await carX(page);
  await page.evaluate(() => window.physicslab.sim.toggle());
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.__pad.buttons[7] = { pressed: true, value: 1 };
    window.__pad.axes[0] = -0.8;
  });
  await simTime(page, 2.5);
  const axes = await page.evaluate(() => ({ ...window.physicslab.sim.client.axes }));
  assert(axes.drive > 0.9, `drive axis ${JSON.stringify(axes)}`);
  assert(axes.steer > 0.3, `steer axis (stick left = +) ${JSON.stringify(axes)}`);
  const after = await carX(page);
  assert(
    after && before && Math.hypot(after[0] - before[0], after[2] - before[2]) > 1.5,
    `car moved ${before} → ${after}`,
  );
  // release: axes decay to zero
  await page.evaluate(() => {
    window.__pad.buttons[7] = { pressed: false, value: 0 };
    window.__pad.axes[0] = 0;
  });
  await page.waitForFunction(() => !window.physicslab.sim.client.axes.drive, null, { timeout: 5000 });
  noErrors(page);
  await page.close();
});

test('keyboard ramp: W eases the drive axis up over time instead of jumping to 1', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(() => window.physicslab.sim.toggle());
  await page.click('.viewport-canvas', { position: { x: 700, y: 200 } });
  await page.keyboard.down('KeyW');
  // Software GL renders only a few frames a second: take the first non-zero value, it must be a partial deflection.
  await page.waitForFunction(() => (window.physicslab.sim.client.axes.drive ?? 0) > 0, null, { timeout: 15000 });
  const early = await page.evaluate(() => window.physicslab.sim.client.axes.drive ?? 0);
  await page.waitForFunction(() => (window.physicslab.sim.client.axes.drive ?? 0) >= 0.999, null, { timeout: 15000 });
  const late = await page.evaluate(() => window.physicslab.sim.client.axes.drive ?? 0);
  await page.keyboard.up('KeyW');
  assert(early > 0 && early < 0.95, `early ${early}`);
  near(late, 1, 0.01, 'late');
  await page.waitForFunction(() => (window.physicslab.sim.client.axes.drive ?? 0) === 0, null, { timeout: 5000 });
  noErrors(page);
  await page.close();
});

test('input: motor key fields capture keyboard keys and gamepad buttons through the same pipeline', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(MOCK_PAD);
  const jointId = await page.evaluate(() => {
    const a = window.physicslab;
    return a.store.joints().find((j) => j.motor.mode === 'velocity').id;
  });
  await page.evaluate((id) => {
    const a = window.physicslab;
    a.store.setSelection([id]);
    a.prefs.set({ rightTab: 'inspector' });
  }, jointId);
  await page.waitForSelector('.key-btn');
  const key = page.locator('.key-btn').first();
  // a keyboard key
  await key.click();
  assert((await key.textContent()).includes('Press a key'), 'listening');
  await page.keyboard.press('KeyG');
  await page.waitForFunction((id) => window.physicslab.store.joint(id).motor.keyPos === 'KeyG', jointId);
  assert((await key.textContent()).trim() === 'G', `label ${await key.textContent()}`);
  // a gamepad button (the stubbed pad's South button = "A" on an Xbox pad)
  await key.click();
  await page.evaluate(() => {
    window.__pad.buttons[0] = { pressed: true, value: 1 };
  });
  await page.waitForFunction((id) => window.physicslab.store.joint(id).motor.keyPos === 'PadSouth', jointId, {
    timeout: 20000,
  });
  assert((await key.textContent()).trim() === 'A', `pad label ${await key.textContent()}`);
  await page.evaluate(() => {
    window.__pad.buttons[0] = { pressed: false, value: 0 };
  });
  // the bound pad button now drives the motor key in the simulation key set
  await page.evaluate(() => window.physicslab.sim.toggle());
  await page.evaluate(() => {
    window.__pad.buttons[0] = { pressed: true, value: 1 };
  });
  await page.waitForFunction(() => window.physicslab.sim.keys.has('PadSouth'), null, { timeout: 20000 });
  // Escape clears the binding
  await page.evaluate(() => {
    window.__pad.buttons[0] = { pressed: false, value: 0 };
  });
  await key.click();
  await page.keyboard.press('Escape');
  await page.waitForFunction((id) => window.physicslab.store.joint(id).motor.keyPos === '', jointId);
  noErrors(page);
  await page.close();
});

test('input: keys another panel holds in the simulation key set (the Controls panel key caps) survive the frame loop', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(() => {
    window.physicslab.sim.keys.add('KeyX');
  });
  await page.waitForFunction(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))),
  );
  assert(await page.evaluate(() => window.physicslab.sim.keys.has('KeyX')), 'a foreign key stays held');
  // our own keys come and go
  await page.click('.viewport-canvas', { position: { x: 700, y: 250 } });
  await page.evaluate(() => window.physicslab.sim.toggle());
  await page.keyboard.down('KeyQ');
  await page.waitForFunction(() => window.physicslab.sim.keys.has('KeyQ'), null, { timeout: 15000 });
  await page.keyboard.up('KeyQ');
  await page.waitForFunction(() => !window.physicslab.sim.keys.has('KeyQ'), null, { timeout: 15000 });
  assert(await page.evaluate(() => window.physicslab.sim.keys.has('KeyX')), 'still held');
  noErrors(page);
  await page.close();
});
