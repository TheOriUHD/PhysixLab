/** VZ-B: highlight upgrades (VZ-40). */
import { assert, newPage, nextFrame, shot } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('highlight: selecting a joint outlines its bodies; bbox and axes decor follow the selection', async () => {
  const page = await newPage('&scene=car&quality=low');
  const ids = await page.evaluate(() => {
    const a = window.physicslab;
    const j = a.store.all().find((e) => e.kind === 'joint' && e.bodyA && e.bodyB);
    a.store.setSelection([j.id]);
    return [j.bodyA, j.bodyB];
  });
  await nextFrame(page);
  await nextFrame(page);
  const r = await page.evaluate(() => {
    const v = window.physicslab.viewport;
    return {
      linked: v.outlineLinked.selectedObjects.length,
      linkedOn: v.outlineLinked.enabled,
      sel: v.outline.enabled,
    };
  });
  assert(r.linked === 2 && r.linkedOn, `both ends of the joint glow (${JSON.stringify(r)}) ${ids}`);
  await page.evaluate(() => {
    const a = window.physicslab;
    a.prefs.set({ highlight: { ...a.prefs.value.highlight, bbox: true, axes: true, palette: 'colorblind' } });
    const b = a.store.bodies().find((x) => x.name === 'Chassis');
    a.store.setSelection([b.id]);
  });
  await nextFrame(page);
  await nextFrame(page);
  const d = await page.evaluate(() => {
    const g = window.physicslab.viewport.decor.group;
    return { visible: g.visible, shown: g.children.filter((c) => c.visible).length };
  });
  assert(d.visible && d.shown === 2, `box + axes drawn for the selected body (${JSON.stringify(d)})`);
  await shot(page, 'vz40-highlight');
  assert(page.errors.length === 0, page.errors.join(' | '));
});
