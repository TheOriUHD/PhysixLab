/** DT-30: the public API — every example in docs/API.md runs against the real app, and the window handle keeps working. */
import { readFileSync } from 'node:fs';
import { assert, newPage } from '../helpers.mjs';
import { root } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const doc = readFileSync(`${root}/docs/API.md`, 'utf8');
const examples = [...doc.matchAll(/<!-- example: (\S+) -->\r?\n```js\r?\n([\s\S]*?)\r?\n```/g)].map((m) => ({
  name: m[1],
  code: m[2],
}));

test('API: docs/API.md has runnable examples', async () => {
  assert(examples.length >= 5, `expected at least 5 examples, found ${examples.length}`);
});

for (const ex of examples) {
  test(`API: example "${ex.name}" from docs/API.md runs`, async () => {
    const page = await newPage();
    const result = await page.evaluate(async (code) => {
      const logs = [];
      const fn = new (Object.getPrototypeOf(async function () {}).constructor)('physixlab', 'console', code);
      await fn(window.physixlab, { log: (...a) => logs.push(a.map(String).join(' ')) });
      return logs;
    }, ex.code);
    assert(Array.isArray(result), 'example did not finish');
    assert(page.errors.length === 0, `console errors: ${page.errors.join('; ')}`);
  });
}

test('API: window.physixlab is versioned, typed data in/out, and still exposes the app internals', async () => {
  const page = await newPage();
  const r = await page.evaluate(() => {
    const p = window.physixlab;
    const id = p.scene.addBody('box', [0, 3, 0], { name: 'Probe' });
    const copy = p.scene.entity(id);
    copy.name = 'tampered';
    return {
      version: p.apiVersion,
      name: p.scene.entity(id).name,
      internals: typeof p.store.toDocument === 'function' && typeof p.editor.addShape === 'function',
      appMethod: typeof p.frameAll === 'function',
      legacyOn: typeof p.on('frame', () => {}) === 'function',
      invalid: (() => {
        try {
          p.scene.add([{ kind: 'wormhole' }]);
          return 'accepted';
        } catch {
          return 'rejected';
        }
      })(),
    };
  });
  assert(/^1\.\d+\.\d+$/.test(r.version), `version ${r.version}`);
  assert(r.name === 'Probe', 'API reads must be copies');
  assert(r.internals && r.appMethod && r.legacyOn, 'app internals must stay reachable');
  assert(r.invalid === 'rejected', 'invalid entities must be rejected');
});

test('API: simulation control, queries and events work on the live app', async () => {
  const page = await newPage();
  const r = await page.evaluate(async () => {
    const p = window.physixlab;
    p.scene.clear();
    const id = p.scene.addBody('sphere', [0, 5, 0], { name: 'Ball' });
    const modes = [];
    p.on('sim:mode', (e) => modes.push(e.mode));
    p.simulation.play();
    const t0 = performance.now();
    while (!((p.simulation.stats()?.simTime ?? 0) > 0.4) && performance.now() - t0 < 20000)
      await new Promise((res) => setTimeout(res, 50));
    const y = p.query.pose(id).position[1];
    const v = p.query.velocity(id);
    const stats = p.simulation.stats();
    p.simulation.reset();
    return { y, vy: v?.linear[1], bodies: stats?.bodies, modes, back: p.query.pose(id).position[1] };
  });
  assert(r.y < 5, `ball should have fallen, y=${r.y}`);
  assert(r.vy < 0, 'velocity should be downwards');
  assert(r.bodies >= 1, 'stats');
  assert(r.modes.includes('running') && r.modes.includes('edit'), `modes ${r.modes}`);
  assert(Math.abs(r.back - 5) < 1e-6, 'reset returns to the authored pose');
});
