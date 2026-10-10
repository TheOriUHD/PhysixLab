/** VZ-B: visual skins (VZ-42) — the detailed car on the drivable-car template. */
import { assert, newPage, shot, simTime, sleep } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const carInfo = (page) =>
  page.evaluate(() => {
    const a = window.physicslab;
    const chassis = a.store.bodies().find((b) => b.name === 'Chassis');
    const wheels = a.store.bodies().filter((b) => b.tags.includes('car-wheel'));
    return {
      chassisId: chassis.id,
      chassisSkin: !!a.bodies.get(chassis.id)?.skin,
      wheelSkins: wheels.map((w) => !!a.bodies.get(w.id)?.skin),
      wheelIds: wheels.map((w) => w.id),
    };
  });

const view = (page, position, target) =>
  page.evaluate(([p, t]) => window.physicslab.viewport.setView({ position: p, target: t }), [position, target]);

test('skin: the car template draws the detailed skin and drives with W', async () => {
  const page = await newPage('&scene=car&quality=low');
  await page.waitForTimeout(600);
  const info = await carInfo(page);
  assert(info.chassisSkin, 'chassis BodyView has a skin');
  assert(
    info.wheelSkins.length === 4 && info.wheelSkins.every(Boolean),
    `all four wheels are skinned ${info.wheelSkins}`,
  );
  await shot(page, 'vz42-car-default');
  const views = [
    ['three-quarter', [4.2, 1.5, 3.6], [0, 0.7, 0]],
    ['side', [0, 0.8, 5.5], [0, 0.65, 0]],
    ['front', [5.2, 0.7, 0.2], [0, 0.65, 0]],
    ['rear', [-4.6, 1.2, -2.6], [0, 0.65, 0]],
  ];
  for (const [name, p, t] of views) {
    await view(page, p, t);
    await page.waitForTimeout(500);
    await shot(page, `vz42-car-${name}`);
  }

  await page.evaluate(() => window.physicslab.sim.play());
  await simTime(page, 0.8);
  const x0 = await page.evaluate((id) => window.physicslab.sim.poseOf(id).position[0], info.chassisId);
  await page.keyboard.down('KeyW');
  await simTime(page, 2.8);
  const r = await page.evaluate(
    ({ id, wheels }) => {
      const a = window.physicslab;
      return {
        x: a.sim.poseOf(id).position[0],
        spin: wheels.map((w) => Math.hypot(...a.sim.velocityOf(w).angular)),
      };
    },
    { id: info.chassisId, wheels: info.wheelIds },
  );
  await shot(page, 'vz42-car-driving');
  await page.keyboard.up('KeyW');
  assert(r.x - x0 > 1, `the car moved +X (${x0.toFixed(2)} -> ${r.x.toFixed(2)})`);
  assert(
    r.spin.some((w) => w > 1),
    `wheels spin (${r.spin.map((s) => s.toFixed(1))})`,
  );
  assert(page.errors.length === 0, `no page errors: ${page.errors.join(' | ')}`);
  await page.close();
});

test('skin: the tail-lights brighten with the brake key and the struts follow the wheels', async () => {
  const page = await newPage('&scene=car&quality=low');
  await page.waitForTimeout(500);
  const id = (await carInfo(page)).chassisId;
  await page.evaluate(() => window.physicslab.sim.play());
  await simTime(page, 0.8);
  const read = () =>
    page.evaluate((id) => {
      const h = window.physicslab.bodies.get(id).skin.root.userData.car;
      return { tail: h.tail.emissiveIntensity, struts: Array.from(h.strutLength) };
    }, id);
  const idle = await read();
  await page.keyboard.down('KeyS');
  await sleep(700);
  const braking = await read();
  await shot(page, 'vz42-car-brake');
  await page.keyboard.up('KeyS');
  assert(braking.tail > idle.tail * 3, `tail-light intensity ${idle.tail.toFixed(2)} -> ${braking.tail.toFixed(2)}`);
  assert(
    idle.struts.every((l) => l > 0.2 && l < 0.6),
    `strut lengths are plausible ${idle.struts.map((l) => l.toFixed(2))}`,
  );
  await page.close();
});

test('skin: the inspector offers the skin of a box and switches it off (undoable)', async () => {
  const page = await newPage('&scene=car&quality=low');
  await page.waitForTimeout(500);
  const id = (await carInfo(page)).chassisId;
  await page.evaluate((id) => window.physicslab.store.setSelection([id]), id);
  await page.waitForTimeout(300);
  const sel = page.locator('select[data-skin-select]');
  assert((await sel.count()) === 1, 'Skin select is in the inspector');
  await sel.selectOption('');
  await page.waitForTimeout(300);
  assert(await page.evaluate((id) => !window.physicslab.bodies.get(id).skin, id), 'skin removed');
  await page.evaluate(() => window.physicslab.store.undo());
  await page.waitForTimeout(300);
  assert(await page.evaluate((id) => !!window.physicslab.bodies.get(id).skin, id), 'undo restores the skin');
  await page.close();
});
