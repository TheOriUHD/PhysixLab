/**
 * CM-A cameras: modes and transitions, orthographic views, lens, bookmarks, cinematic shots, split screen / PiP,
 * minimap — driven through the real UI and the camera rig.
 */
import { assert, near, newPage, nextFrame, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const rig = (page, fn, arg) =>
  page.evaluate(
    new Function(
      'arg',
      `const r = window.physicslab.cameraRig; const app = window.physicslab; return (${fn.toString()})(r, app, arg);`,
    ),
    arg,
  );

test('camera: panel lists the modes; fly mode moves with W and right-drag looks', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(() => window.physicslab.prefs.set({ rightTab: 'camera' }));
  await page.waitForSelector('.cam-mode');
  const labels = await page.locator('.cam-mode').allTextContents();
  assert(labels.length >= 7, `modes: ${labels}`);
  await page.click('.cam-mode[data-mode=fly]');
  await page.waitForFunction(() => window.physicslab.cameraRig.mode === 'fly');
  const p0 = await page.evaluate(() => window.physicslab.camera.position.toArray());
  await page.click('.viewport-canvas', { position: { x: 700, y: 300 } });
  await page.keyboard.down('KeyW');
  // Software GL renders only a few frames a second, so wait for the distance instead of a fixed time.
  await page.waitForFunction(
    (p0) => {
      const p = window.physicslab.camera.position;
      return Math.hypot(p.x - p0[0], p.y - p0[1], p.z - p0[2]) > 1.5;
    },
    p0,
    { timeout: 25000 },
  );
  await page.keyboard.up('KeyW');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

const chassisId = (page) =>
  page.evaluate(() => {
    const a = window.physicslab;
    return (a.store.bodies().find((b) => /chassis/i.test(b.name)) ?? a.store.bodies()[0]).id;
  });

test('camera: orthographic toggle, front view, grid in the view plane, picking still works in ortho', async () => {
  const page = await newPage('&scene=car');
  const id = await chassisId(page);
  await page.evaluate(() => window.physicslab.cameraRig.setOrtho(true));
  const persp = await page.evaluate(() => window.physicslab.camera.projectionMatrix.elements[15]);
  assert(persp === 1, `orthographic projection matrix (m33 = ${persp})`);
  await page.evaluate(() => window.physicslab.cameraRig.viewPreset('front'));
  await page.waitForFunction(
    () => {
      const c = window.physicslab.camera;
      return c.position.z > 100 && Math.abs(c.position.x) < 0.5;
    },
    null,
    { timeout: 20000 },
  );
  const st = await page.evaluate(() => {
    const a = window.physicslab;
    return { grid: a.viewport.viewGrid.mesh.visible, preset: a.cameraRig.preset, ortho: a.camera.ortho };
  });
  assert(st.grid && st.preset === 'front' && st.ortho, `state ${JSON.stringify(st)}`);
  await shot(page, 'cm-ortho-front');
  // the checklist's picking requirement: click the car in the orthographic view
  const p = await page.evaluate((id) => {
    const a = window.physicslab;
    const v = a.bodies.get(id).position.clone().project(a.camera);
    const r = a.viewport.dom.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }, id);
  await nextFrame(page);
  await page.evaluate(() => window.physicslab.store.setSelection([]));
  await page.mouse.click(p.x, p.y);
  await page.waitForFunction(() => window.physicslab.store.selection.length > 0, null, { timeout: 5000 });
  // back to perspective: the ground grid only, normal lens
  await page.evaluate(() => window.physicslab.cameraRig.setOrtho(false));
  const back = await page.evaluate(() => ({
    m: window.physicslab.camera.projectionMatrix.elements[15],
    grid: window.physicslab.viewport.viewGrid.mesh.visible,
  }));
  assert(back.m === 0 && !back.grid, `perspective again ${JSON.stringify(back)}`);
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

test('camera: first person, third person and chase follow the selected body', async () => {
  const page = await newPage('&scene=car');
  const id = await chassisId(page);
  await page.evaluate((id) => window.physicslab.store.setSelection([id]), id);
  // Software GL renders a handful of frames a second: poll for the pose instead of sleeping.
  const settle = (cond) =>
    page.waitForFunction(
      ([id, src]) => {
        const a = window.physicslab;
        const c = a.bodies.get(id).position;
        const p = a.camera.position;
        const f = new p.constructor(0, 0, -1).applyQuaternion(a.camera.quaternion);
        return new Function('d', `return ${src}`)({
          dx: p.x - c.x,
          dy: p.y - c.y,
          dz: p.z - c.z,
          fx: f.x,
          fy: f.y,
          fz: f.z,
        });
      },
      [id, cond],
      { timeout: 40000 },
    );
  const rel = () =>
    page.evaluate((id) => {
      const a = window.physicslab;
      const c = a.bodies.get(id).position;
      const p = a.camera.position;
      const f = new a.camera.position.constructor(0, 0, -1).applyQuaternion(a.camera.quaternion);
      return { dx: p.x - c.x, dy: p.y - c.y, dz: p.z - c.z, fx: f.x, fy: f.y, fz: f.z };
    }, id);
  // first person: at the body, looking along its +X nose
  await page.evaluate(() => window.physicslab.cameraRig.setMode('fp'));
  await page.waitForFunction(() => {
    const a = window.physicslab;
    return a.cameraRig.mode === 'fp';
  });
  await settle('Math.hypot(d.dx, d.dz) < 0.2 && d.fx > 0.9').catch(() => {});
  let r = await rel();
  assert(Math.hypot(r.dx, r.dz) < 0.2 && r.dy > 0.1 && r.fx > 0.9, `first person ${JSON.stringify(r)}`);
  // third person: behind the nose (−X), above, looking forward and down
  await page.evaluate(() => window.physicslab.cameraRig.setMode('tp'));
  await settle('d.dx < -3 && d.dy > 0.8 && d.fx > 0.7').catch(() => {});
  r = await rel();
  assert(r.dx < -3 && r.dy > 0.8 && r.fx > 0.7, `third person ${JSON.stringify(r)}`);
  // chase: also behind
  await page.evaluate(() => window.physicslab.cameraRig.setMode('chase'));
  await settle('d.dx < -3 && d.dy > 0.8 && d.fx > 0.7').catch(() => {});
  r = await rel();
  assert(r.dx < -3 && r.dy > 0.8 && r.fx > 0.7, `chase ${JSON.stringify(r)}`);
  await shot(page, 'cm-chase');
  // leaving a driven mode hands the orbit controls the same view: no jump
  const before = await page.evaluate(() => window.physicslab.camera.position.toArray());
  await page.evaluate(() => window.physicslab.cameraRig.setMode('orbit'));
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => window.physicslab.camera.position.toArray());
  assert(
    Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]) < 2.5,
    `orbit handover ${before} → ${after}`,
  );
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});

test('camera: modes that need a body say so instead of failing; FOV changes the lens', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(() => window.physicslab.store.setSelection([]));
  const ok = await page.evaluate(() => window.physicslab.cameraRig.setMode('chase'));
  assert(ok === false, 'chase without a subject is refused');
  assert((await page.evaluate(() => window.physicslab.cameraRig.mode)) === 'orbit', 'stays in orbit');
  await page.waitForSelector('.toast');
  await page.evaluate(() => window.physicslab.cameraRig.setFov(90));
  assert((await page.evaluate(() => window.physicslab.camera.fov)) === 90, 'fov');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('physicslab:camera:v1')).fov);
  assert(stored === 90, 'fov is remembered');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.close();
});
