/**
 * CM-A cameras: modes and transitions, orthographic views, lens, bookmarks, cinematic shots, split screen / PiP,
 * minimap — driven through the real UI and the camera rig.
 */
import { assert, near, newPage, nextFrame, shot } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Other packages' extensions may report their own load problems on a busy integration branch: only our errors count.
const noErrors = (page) => {
  const own = page.errors.filter((e) => !/\[extension \.\.\/extensions\/(?!camera)/.test(e));
  assert(own.length === 0, own.join('\n'));
};

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
  noErrors(page);
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
  noErrors(page);
  await page.close();
});

test('camera: the view cube works in an orthographic view (click +X: the camera goes to the right-hand view)', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(() => window.physicslab.cameraRig.update_settings({ motion: 'reduce' }));
  await page.evaluate(() => window.physicslab.cameraRig.viewPreset('front'));
  await page.waitForFunction(() => window.physicslab.camera.position.z > 100);
  await nextFrame(page);
  const r = await page.evaluate(() => {
    const b = window.physicslab.viewport.dom.getBoundingClientRect();
    return { right: b.right, top: b.top };
  });
  // the helper is 128 px wide, 12 px from the top-right corner; +X sits at three quarters of its width, half way down
  await page.mouse.click(r.right - 12 - 128 + 96, r.top + 12 + 64);
  await page.waitForFunction(
    () => {
      const c = window.physicslab.camera;
      const t = window.physicslab.viewport.controls.target;
      return c.position.x - t.x > 100 && Math.abs(c.position.z - t.z) < 2 && c.ortho;
    },
    null,
    { timeout: 20000 },
  );
  noErrors(page);
  await page.close();
});

test('camera: first person, third person and chase follow the selected body', async () => {
  const page = await newPage('&scene=car');
  // "Camera follows selection" glides the orbit target to the body after a handover: switch it off to see the handover itself
  await page.evaluate(() => window.physicslab.prefs.set({ followSelection: false }));
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
  // leaving a driven mode hands the orbit controls the same view: no jump. Wait until the chase camera has settled
  // (software GL is slow), then switch and check the camera did not move.
  await page.waitForFunction(
    () => {
      const p = window.physicslab.camera.position;
      const w = window;
      const last = w.__lastCam;
      w.__lastCam = [p.x, p.y, p.z];
      return !!last && Math.hypot(p.x - last[0], p.y - last[1], p.z - last[2]) < 0.002;
    },
    null,
    { timeout: 60000, polling: 400 },
  );
  const before = await page.evaluate(() => window.physicslab.camera.position.toArray());
  await page.evaluate(() => window.physicslab.cameraRig.setMode('orbit'));
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => window.physicslab.camera.position.toArray());
  assert(
    Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]) < 0.5,
    `orbit handover ${before} → ${after}`,
  );
  noErrors(page);
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
  noErrors(page);
  await page.close();
});

test('camera: a cinematic shot flies the camera along a path, scrubs, loops and records a WebM', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(() => {
    const a = window.physicslab;
    a.addPath();
    const p = a.store.paths()[0];
    // a straight 40 m rail 6 m above the ground
    a.store.update(p.id, {
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      points: [
        [0, 6, 0],
        [20, 6, 0],
        [40, 6, 0],
      ],
      tension: 1,
    });
    a.store.setSelection([p.id]);
    a.prefs.set({ rightTab: 'camera' });
  });
  await page.waitForSelector('.cam-panel');
  await page.click('.cam-panel .section-head:has-text("Cinematic shots")');
  await page.click('.cam-shots >> text=New shot');
  await page.waitForSelector('.cam-shot-detail .cam-scrub');
  const sh = await page.evaluate(() => window.physicslab.store.cameras.shots[0]);
  assert(sh && sh.keys.length === 2 && sh.duration === 8, `shot ${JSON.stringify(sh)}`);
  // scrub to the middle: the camera is half way along the rail, looking along it (+X)
  await page.evaluate(() => {
    const el = document.querySelector('.cam-scrub');
    el.value = '4';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(
    () => {
      const p = window.physicslab.camera.position;
      return Math.abs(p.x - 20) < 0.5 && Math.abs(p.y - 6) < 0.5;
    },
    null,
    { timeout: 20000 },
  );
  const f = await page.evaluate(() => {
    const a = window.physicslab;
    const v = new a.camera.position.constructor(0, 0, -1).applyQuaternion(a.camera.quaternion);
    return [v.x, v.y, v.z];
  });
  assert(f[0] > 0.99, `looks along the path ${f}`);
  // playing advances the time; it stops at the end (no loop)
  await page.evaluate(() => {
    const pl = window.physicslab.cameraRig.player;
    pl.seek(7.5);
    pl.play();
  });
  await page.waitForFunction(() => !window.physicslab.cameraRig.player.playing, null, { timeout: 30000 });
  assert((await page.evaluate(() => window.physicslab.cameraRig.player.t)) === 8, 'ended at the last frame');
  await shot(page, 'cm-shot-panel');
  // looping wraps around instead of stopping
  await page.evaluate(() => {
    const a = window.physicslab;
    const s = a.store.cameras.shots[0];
    a.store.setCameras({ ...a.store.cameras, shots: [{ ...s, loop: true }] }, 'loop');
    a.cameraRig.player.seek(7.9);
    a.cameraRig.player.play();
  });
  await page.waitForFunction(
    () => window.physicslab.cameraRig.player.t < 4 && window.physicslab.cameraRig.player.playing,
    null,
    { timeout: 30000 },
  );
  await page.evaluate(() => window.physicslab.cameraRig.player.close());
  assert((await page.evaluate(() => window.physicslab.cameraRig.override)) === null, 'closing releases the camera');
  noErrors(page);
  await page.close();
});

test('camera: recording a shot delivers a video file', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(() => {
    const a = window.physicslab;
    a.addPath();
    const p = a.store.paths()[0];
    a.store.update(p.id, {
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      points: [
        [0, 6, 0],
        [20, 6, 0],
        [40, 6, 0],
      ],
      tension: 1,
    });
    a.store.setSelection([p.id]);
    const s = {
      id: 'cs_t',
      name: 'Fly by',
      pathId: p.id,
      duration: 1,
      loop: false,
      keys: [
        { t: 0, u: 0, fov: 48, ease: 'linear' },
        { t: 1, u: 1, fov: 48, ease: 'linear' },
      ],
      look: { mode: 'tangent', bodyId: '', point: [0, 1, 0] },
    };
    a.store.setCameras({ ...a.store.cameras, shots: [s] }, 'shot');
  });
  const download = page.waitForEvent('download', { timeout: 60000 });
  const ok = await page.evaluate(async () => {
    const a = window.physicslab;
    const pl = a.cameraRig.player;
    if (!pl.open('cs_t')) return false;
    return pl.record('webm');
  });
  assert(ok, 'recording started');
  const file = await download;
  assert(/Fly_by\.webm$/.test(file.suggestedFilename()), `file name ${file.suggestedFilename()}`);
  noErrors(page);
  await page.close();
});

test('camera: split screen shrinks the main view and shows other cameras; a dashcam picture-in-picture renders and moves', async () => {
  const page = await newPage('&scene=car');
  const id = await chassisId(page);
  await page.evaluate((id) => {
    const a = window.physicslab;
    a.store.setSelection([id]);
    const c = a.store.cameras;
    a.store.setCameras({ ...c, split: 2 }, 'split');
  }, id);
  await page.waitForSelector('.cm-view.pane');
  const rects = await page.evaluate(() => {
    const a = window.physicslab;
    const host = a.shell.viewportHost.getBoundingClientRect();
    const pane = document.querySelector('.cm-view.pane').getBoundingClientRect();
    const stage = a.shell.stage.getBoundingClientRect();
    return { host: [host.width, host.height], pane: [pane.width, pane.height], stage: [stage.width, stage.height] };
  });
  near(rects.host[0] + rects.pane[0], rects.stage[0], 3, 'two halves fill the stage');
  near(rects.host[1], rects.stage[1], 1, 'full height');
  // the pane paints real pixels: not a single flat colour
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.cm-view.pane canvas');
      if (!c || c.width < 10) return false;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let min = 255;
      let max = 0;
      for (let i = 0; i < d.length; i += 4 * 97) {
        min = Math.min(min, d[i]);
        max = Math.max(max, d[i]);
      }
      return max - min > 40;
    },
    null,
    { timeout: 30000 },
  );
  await shot(page, 'cm-split2');
  // a dashcam on the car, then four-way split with picture-in-picture
  await page.evaluate((id) => {
    const a = window.physicslab;
    const c = a.store.cameras;
    const pip = {
      id: 'pip_t',
      mode: 'mount',
      subject: id,
      ref: '',
      fov: 70,
      offset: [0.6, 0.5, 0],
      yaw: 0,
      pitch: -5,
      x: 0.6,
      y: 0.5,
      w: 0.3,
    };
    a.store.setCameras({ ...c, split: 4, pips: [pip] }, 'views');
  }, id);
  await page.waitForSelector('.cm-view.pip');
  await page.waitForTimeout(3000);
  await shot(page, 'cm-split4-pip');
  // drag the window by its title bar, then resize it: the new geometry is saved in the scene
  const before = await page.evaluate(() => JSON.stringify(window.physicslab.store.cameras.pips[0]));
  const bar = await page.locator('.cm-view.pip .cm-view-bar').boundingBox();
  await page.mouse.move(bar.x + 40, bar.y + 8);
  await page.mouse.down();
  await page.mouse.move(bar.x + 140, bar.y + 70, { steps: 4 });
  await page.mouse.up();
  const after = await page.evaluate(() => JSON.stringify(window.physicslab.store.cameras.pips[0]));
  assert(before !== after, 'the window moved and was saved');
  const grip = await page.locator('.cm-view.pip .cm-view-grip').boundingBox();
  await page.mouse.move(grip.x + 8, grip.y + 8);
  await page.mouse.down();
  await page.mouse.move(grip.x + 80, grip.y + 8, { steps: 4 });
  await page.mouse.up();
  const w2 = await page.evaluate(() => window.physicslab.store.cameras.pips[0].w);
  assert(w2 > JSON.parse(after).w, `resized ${w2}`);
  // closing removes it; back to a single view restores the full-size main view
  await page.click('.cm-view.pip .cm-view-close');
  await page.waitForFunction(() => !document.querySelector('.cm-view.pip'));
  await page.evaluate(() => {
    const a = window.physicslab;
    a.store.setCameras({ ...a.store.cameras, split: 1 }, 'split');
  });
  await page.waitForFunction(() => !document.querySelector('.cm-view.pane'));
  const full = await page.evaluate(() => {
    const a = window.physicslab;
    const h = a.shell.viewportHost.getBoundingClientRect();
    const s = a.shell.stage.getBoundingClientRect();
    return Math.abs(h.width - s.width) < 2 && Math.abs(h.height - s.height) < 2;
  });
  assert(full, 'main view back to full size');
  noErrors(page);
  await page.close();
});

test('camera: minimap shows the scene, follows the camera and moves it when clicked', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(() => {
    const a = window.physicslab;
    a.store.setCameras(
      { ...a.store.cameras, minimap: { ...a.store.cameras.minimap, enabled: true, range: 30 } },
      'minimap',
    );
  });
  await page.waitForSelector('.cm-minimap-canvas', { state: 'visible' });
  // the map paints the car (non-uniform pixels) and the camera wedge
  await page.waitForFunction(
    () => {
      const c = document.querySelector('.cm-minimap-canvas');
      if (!c || c.width < 10) return false;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 53) seen.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
      return seen.size > 6;
    },
    null,
    { timeout: 30000 },
  );
  await shot(page, 'cm-minimap');
  // clicking east of the centre moves what the camera looks at east
  const before = await page.evaluate(() => window.physicslab.viewport.controls.target.toArray());
  const box = await page.locator('.cm-minimap-canvas').boundingBox();
  await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.5);
  await page.waitForFunction((x0) => window.physicslab.viewport.controls.target.x > x0 + 5, before[0], {
    timeout: 10000,
  });
  // turn-with-camera mode: the map keeps the view direction up
  await page.evaluate(() => {
    const a = window.physicslab;
    a.store.setCameras({ ...a.store.cameras, minimap: { ...a.store.cameras.minimap, rotate: true } }, 'minimap');
  });
  await page.waitForTimeout(800);
  await shot(page, 'cm-minimap-rotated');
  // the toggle command works
  await page.evaluate(async () => {
    const { runCommand } = await import('/src/app/registry/commands.ts');
    runCommand('camera.minimap', window.physicslab, 'api');
  });
  await page.waitForFunction(() => !window.physicslab.store.cameras.minimap.enabled);
  noErrors(page);
  await page.close();
});

test('camera: shake from a blast and the setting / reduced motion that silence it', async () => {
  const page = await newPage('&scene=car');
  const wobble = async () => {
    const samples = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const a = window.physicslab;
          const out = [];
          const base = a.camera.quaternion.clone();
          let n = 0;
          const step = () => {
            out.push(base.angleTo(a.camera.quaternion));
            if (++n < 6) requestAnimationFrame(step);
            else resolve(out);
          };
          requestAnimationFrame(step);
        }),
    );
    return Math.max(...samples);
  };
  await page.evaluate(() => window.physicslab.sim.toggle());
  await page.waitForFunction(() => window.physicslab.sim.active);
  const calm = await wobble();
  await page.evaluate(() => window.physicslab.cameraRig.shake(1));
  const shaken = await wobble();
  assert(shaken > calm + 0.004, `shake wobbles the view (${calm} → ${shaken})`);
  // the amplitude decays
  await page.waitForTimeout(6000);
  assert((await wobble()) < shaken, 'shake dies down');
  // shake setting 0 and reduced motion both silence it
  await page.evaluate(() => window.physicslab.cameraRig.update_settings({ shake: 0 }));
  await page.evaluate(() => window.physicslab.cameraRig.shake(1));
  assert((await wobble()) < 0.004, 'no shake when the setting is 0');
  await page.evaluate(() => window.physicslab.cameraRig.update_settings({ shake: 1, motion: 'reduce' }));
  await page.evaluate(() => window.physicslab.cameraRig.shake(1));
  assert((await wobble()) < 0.004, 'no shake with reduced motion');
  // reduced motion also cuts transitions: a view preset arrives at once
  await page.evaluate(() => window.physicslab.cameraRig.viewPreset('top'));
  await nextFrame(page);
  const top = await page.evaluate(() => window.physicslab.camera.position.y);
  assert(top > 100, `preset applied instantly under reduced motion (y = ${top})`);
  noErrors(page);
  await page.close();
});

test('camera: top-down and orbit-point modes constrain the orbit controls', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(() => window.physicslab.cameraRig.update_settings({ motion: 'reduce' }));
  await page.evaluate(() => window.physicslab.cameraRig.setMode('top'));
  await page.waitForFunction(
    () => {
      const c = window.physicslab.camera;
      const t = window.physicslab.viewport.controls.target;
      return c.position.y - t.y > 10 && Math.hypot(c.position.x - t.x, c.position.z - t.z) < 0.5;
    },
    null,
    { timeout: 15000 },
  );
  const top = await page.evaluate(() => {
    const a = window.physicslab;
    const c = a.viewport.controls;
    return { rotate: c.enableRotate, pan: c.enablePan, polar: [c.minPolarAngle, c.maxPolarAngle] };
  });
  assert(!top.rotate && top.pan && top.polar[1] === 0, `top-down locks rotation ${JSON.stringify(top)}`);
  // back to orbit restores free rotation
  await page.evaluate(() => window.physicslab.cameraRig.setMode('orbit'));
  const orbit = await page.evaluate(() => {
    const c = window.physicslab.viewport.controls;
    return { rotate: c.enableRotate, max: c.maxPolarAngle };
  });
  assert(orbit.rotate && orbit.max > 1.5, `orbit again ${JSON.stringify(orbit)}`);
  // orbit point: a double-click picks the centre; panning is off and the pivot is kept
  await page.evaluate(() => window.physicslab.cameraRig.setMode('point'));
  const pan = await page.evaluate(() => window.physicslab.viewport.controls.enablePan);
  assert(pan === false, 'panning is off in orbit-point mode');
  await page.mouse.dblclick(420, 600);
  await page.waitForFunction(
    () => {
      const p = window.physicslab.cameraRig.pivot;
      const t = window.physicslab.viewport.controls.target;
      return p.distanceTo(t) < 0.3;
    },
    null,
    { timeout: 15000 },
  );
  const piv = await page.evaluate(() => window.physicslab.cameraRig.pivot.toArray());
  assert(Math.hypot(piv[0], piv[2]) > 1.5 && Math.abs(piv[1]) < 3, `pivot moved to the clicked ground ${piv}`);
  noErrors(page);
  await page.close();
});

test('camera: bookmarks save with a thumbnail, recall by click and by Shift+digit, and live in the saved scene', async () => {
  const page = await newPage('&scene=car');
  await page.evaluate(() => window.physicslab.prefs.set({ rightTab: 'camera' }));
  await page.waitForSelector('.cam-bookmarks', { state: 'attached' });
  const home = await page.evaluate(() => window.physicslab.viewport.getView());
  await page.click('.cam-panel >> text=Save current view');
  await page.waitForSelector('.cam-card .cam-thumb');
  const b0 = await page.evaluate(() => window.physicslab.store.cameras.bookmarks[0]);
  assert(b0 && /^data:image\/jpeg;base64,/.test(b0.thumb ?? ''), `thumbnail ${String(b0?.thumb).slice(0, 30)}`);
  // move somewhere else, then recall with the keyboard
  await page.evaluate(() => {
    const a = window.physicslab;
    a.cameraRig.update_settings({ motion: 'reduce' });
    a.viewport.setView({ position: [30, 20, 30], target: [0, 0, 0] });
  });
  await page.click('.viewport-canvas', { position: { x: 700, y: 250 } });
  await page.keyboard.press('Shift+Digit1');
  await page.waitForFunction((h) => Math.abs(window.physicslab.camera.position.x - h.position[0]) < 0.5, home, {
    timeout: 15000,
  });
  // save into slot 2 with Ctrl+Shift+2, rename through the UI model, and keep it through save / load
  await page.evaluate(() => window.physicslab.viewport.setView({ position: [-12, 8, 6], target: [0, 1, 0] }));
  await page.keyboard.press('Control+Shift+Digit2');
  await page.waitForFunction(() => window.physicslab.store.cameras.bookmarks.length === 2);
  const saved = await page.evaluate(async () => {
    const a = window.physicslab;
    const doc = a.store.toDocument();
    const text = JSON.stringify(doc);
    a.store.clear();
    const { parseDocument } = await import('/src/model/serialize.ts');
    a.store.load(parseDocument(text));
    return a.store.cameras.bookmarks.map((b) => ({ name: b.name, position: b.position }));
  });
  assert(saved.length === 2 && saved[1].position[0] === -12, `after reload ${JSON.stringify(saved)}`);
  // undo removes the second bookmark again (bookmarks are document edits)
  await page.evaluate(() => {
    const a = window.physicslab;
    a.store.setCameras({ ...a.store.cameras, bookmarks: a.store.cameras.bookmarks.slice(0, 1) }, 'x');
    a.store.undo();
  });
  assert((await page.evaluate(() => window.physicslab.store.cameras.bookmarks.length)) === 2, 'undo restores');
  noErrors(page);
  await page.close();
});
