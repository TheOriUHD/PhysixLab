/** VZ-B: impact damage visuals (VZ-41). */
import { assert, newPage, shot } from '../helpers.mjs';

/** Console errors of this page, minus other packages' extension-load noise. */
const ownErrors = (page) => page.errors.filter((e) => !/\[extension /.test(e));

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('damage: a hard landing damages the body, the shader shows it, reset clears it', async () => {
  const page = await newPage('&scene=&quality=low');
  const id = await page.evaluate(async () => {
    const a = window.physixlab;
    a.newScene();
    const { createBody } = await import('/src/model/factory.ts');
    const b = createBody({
      name: 'Crate',
      shape: { type: 'box', size: [1, 1, 1] },
      position: [0, 14, 0],
      material: 'glass',
    });
    a.store.add([b]);
    a.sim.play();
    return b.id;
  });
  await page.waitForFunction((id) => window.physixlab.damage.damageOf(id) > 0.2, id, { timeout: 60000 });
  const d = await page.evaluate((id) => {
    const a = window.physixlab;
    const v = a.bodies.get(id);
    return {
      model: a.damage.damageOf(id),
      view: v.damage,
      uniform: v.pieces[0].material.userData.damage.uniforms.uDamage.value,
    };
  }, id);
  assert(d.view === d.model && d.uniform === d.model, `view and shader follow the model ${JSON.stringify(d)}`);
  await shot(page, 'vz41-damage');
  await page.evaluate(() => window.physixlab.sim.reset());
  const after = await page.evaluate((id) => window.physixlab.damage.damageOf(id), id);
  assert(after === 0, `reset clears damage (${after})`);
  assert(ownErrors(page).length === 0, ownErrors(page).join(' | '));
});
