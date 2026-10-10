/** DT-22 embed / viewer mode: minimal chrome, locked editing, the postMessage API from a cross-origin host page. */
import { createServer } from 'node:http';
import { assert, currentBrowser, newPage, screenOf, sleep } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/**
 * A host page on another origin (a tiny loopback server on its own port) that embeds `src` in an iframe and records
 * every message the viewer sends. Served by a real server rather than page.route(): Chromium treats an intercepted
 * document as a public page and then refuses to let it frame a loopback server.
 */
async function hostPage(srcOrFn) {
  let src = '';
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><body style="margin:0"><iframe id="v" src="${src}" style="width:900px;height:600px;border:0"></iframe><script>
        window.msgs = [];
        addEventListener('message', (e) => { if (e.data && e.data.type === 'physicslab') window.msgs.push({ origin: e.origin, data: e.data }); });
        window.send = (m) => document.getElementById('v').contentWindow.postMessage(m, '*');
      </script>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const hostOrigin = `http://127.0.0.1:${server.address().port}`;
  src = typeof srcOrFn === 'function' ? srcOrFn(hostOrigin) : srcOrFn;
  const page = await currentBrowser().newPage({ viewport: { width: 1000, height: 700 } });
  const close = page.close.bind(page);
  page.close = async () => {
    await close();
    server.close();
  };
  page.hostOrigin = hostOrigin;
  await page.goto(`${hostOrigin}/`, { waitUntil: 'commit' });
  return page;
}

/** Send a command carrying a fresh id and wait for the reply with that id. */
async function ask(host, msg) {
  const id = `t${Math.random().toString(36).slice(2, 8)}`;
  await host.evaluate(([m, id]) => window.send({ type: 'physicslab', v: 1, id, ...m }), [msg, id]);
  const handle = await host.waitForFunction((id) => window.msgs.find((m) => m.data.id === id), id, { timeout: 30000 });
  return (await handle.jsonValue()).data;
}

const appOrigin = async () => {
  const p = await newPage('&embed=1&scene=car');
  const origin = new URL(p.url()).origin;
  await p.close();
  return origin;
};

test('DT-22 embed viewer shows minimal chrome: no panels / menus / toolbox, only the slim bar', async () => {
  const p = await newPage('&embed=1&scene=car');
  const chrome = await p.evaluate(() => ({
    panels: document.querySelectorAll('aside, .panel, .dock, .topbar, .menubar, .toolbox, .viewbar, .statusbar').length,
    bar: !!document.querySelector('.embed-bar'),
    buttons: document.querySelectorAll('.embed-bar button').length,
    bodies: window.physicslab.store.bodies().length,
    canvas: !!document.querySelector('canvas.viewport-canvas'),
  }));
  assert(chrome.panels === 0, `no editor chrome (${chrome.panels} found)`);
  assert(chrome.bar && chrome.buttons === 3, `slim bar with play / reset / camera (${JSON.stringify(chrome)})`);
  assert(chrome.canvas && chrome.bodies > 3, 'the car scene is shown');
  // Bar buttons work: play, then pause.
  await p.click('.embed-play');
  await p.waitForFunction(() => window.physicslab.sim.mode === 'running');
  await p.click('.embed-play');
  await p.waitForFunction(() => window.physicslab.sim.mode === 'paused');
  await p.click('.embed-reset');
  await p.waitForFunction(() => window.physicslab.sim.mode === 'edit');
  await p.close();
});

test('DT-22 embed options: autoplay, controls=0, camera=fixed, share payload, unknown scene reported', async () => {
  const a = await newPage('&embed=1&scene=car&autoplay=1&controls=0&camera=fixed');
  await a.waitForFunction(() => window.physicslab.sim.mode === 'running', null, { timeout: 30000 });
  const o = await a.evaluate(() => ({
    bar: !!document.querySelector('.embed-bar'),
    orbit: window.physicslab.viewport.controls.enabled,
  }));
  assert(!o.bar && o.orbit === false, `controls=0 hides the bar, camera=fixed locks orbit (${JSON.stringify(o)})`);
  await a.close();

  const maker = await newPage();
  const hash = await maker.evaluate(async () => {
    window.physicslab.store.setName('Embedded share');
    return new URL((await window.physicslab.persistence.shareInfo()).url).hash;
  });
  await maker.close();
  const s = await newPage(`&embed=1${hash}`);
  const name = await s.evaluate(() => window.physicslab.store.name);
  assert(name === 'Embedded share', `scene from #s= opened (${name})`);
  await s.close();

  const bad = await newPage('&embed=1&scene=no-such-scene');
  const note = await bad.locator('.embed-notice').textContent();
  assert(/no-such-scene/.test(note ?? ''), `unknown scene explained: ${note}`);
  await bad.close();
});

test('DT-22 embed postMessage API: ready, play / pause / step / reset / getState / loadScene / setCamera', async () => {
  const origin = await appOrigin();
  const host = await hostPage(`${origin}/?nowelcome&embed=1&scene=car`);
  await host.waitForFunction(() => window.msgs.some((m) => m.data.event === 'ready'), null, { timeout: 30000 });
  const ready = await host.evaluate(() => window.msgs.find((m) => m.data.event === 'ready'));
  assert(ready.origin === origin && ready.data.v === 1, `ready from the viewer origin (${JSON.stringify(ready.origin)})`);
  assert(ready.data.capabilities.includes('loadScene') && ready.data.state.mode === 'edit', 'ready carries capabilities + state');

  let r = await ask(host, { cmd: 'getState' });
  assert(r.event === 'state' && r.state.mode === 'edit' && r.state.bodies > 3, `getState round trip (${JSON.stringify(r)})`);
  r = await ask(host, { cmd: 'play' });
  assert(r.state.mode === 'running', 'play');
  for (let i = 0; i < 120 && r.state.time < 0.4; i++) {
    await sleep(500);
    r = await ask(host, { cmd: 'getState' });
  }
  assert(r.state.time >= 0.4, `the clock runs while playing (${r.state.time})`);
  r = await ask(host, { cmd: 'pause' });
  assert(r.state.mode === 'paused' && r.state.time > 0, `pause keeps the clock (${r.state.time})`);
  const t0 = r.state.time;
  r = await ask(host, { cmd: 'step', count: 5 });
  assert(r.state.mode === 'paused', 'step stays paused');
  await sleep(500);
  r = await ask(host, { cmd: 'getState' });
  assert(r.state.time > t0, `step advanced the clock (${t0} -> ${r.state.time})`);
  r = await ask(host, { cmd: 'reset' });
  assert(r.state.mode === 'edit' && r.state.time === 0, 'reset');
  r = await ask(host, { cmd: 'setCamera', position: [30, 20, 30], target: [0, 0, 0] });
  assert(Math.abs(r.state.camera.position[0] - 30) < 1e-3, `setCamera (${JSON.stringify(r.state.camera)})`);
  r = await ask(host, { cmd: 'setCamera', reset: true });
  assert(r.event === 'state', 'camera reset accepted');
  const nameBefore = r.state.sceneName;
  r = await ask(host, { cmd: 'loadScene', template: 'wreck' });
  assert(r.event === 'state' && r.state.sceneName !== nameBefore && r.state.bodies > 0, `loadScene template (${nameBefore} -> ${r.state.sceneName})`);
  r = await ask(host, { cmd: 'loadScene', template: 'nope' });
  assert(r.event === 'error' && /nope/.test(r.message), `unknown template -> error (${JSON.stringify(r)})`);
  r = await ask(host, { cmd: 'explode' });
  assert(r.event === 'error' && r.code === 'bad-message', 'unknown command -> error');
  r = await ask(host, { cmd: 'step', count: -3 });
  assert(r.event === 'error' && r.code === 'bad-message', 'invalid payload -> error');
  r = await ask(host, { cmd: 'setCamera', position: [1, 'x', 3] });
  assert(r.event === 'error', 'invalid vector -> error');
  await host.close();
});

test('DT-22 embed postMessage API ignores other senders and non-listed origins', async () => {
  const origin = await appOrigin();
  // 1) the viewer's own window is not its parent: a self-posted command is ignored
  const v = await newPage('&embed=1&scene=car');
  await v.evaluate(() => window.postMessage({ type: 'physicslab', cmd: 'play' }, '*'));
  await sleep(600);
  assert((await v.evaluate(() => window.physicslab.sim.mode)) === 'edit', 'self-posted command ignored (source is not the parent)');
  await v.close();
  // 2) an origin allow-list that does not include the host: silence
  const host = await hostPage(`${origin}/?nowelcome&embed=1&scene=car&origin=https://trusted.example`);
  await host.waitForFunction(() => !!document.getElementById('v'), null, { timeout: 30000 });
  await sleep(2500);
  await host.evaluate(() => window.send({ type: 'physicslab', v: 1, id: 'x1', cmd: 'play' }));
  await sleep(1500);
  const got = await host.evaluate(() => window.msgs.length);
  assert(got === 0, `allow-listed viewer stays silent for a foreign origin (${got} messages)`);
  await host.close();
  // 3) allow-list containing the host: works
  const ok = await hostPage((host) => `${origin}/?nowelcome&embed=1&scene=car&origin=${host}`);
  await ok.waitForFunction(() => window.msgs.some((m) => m.data.event === 'ready'), null, { timeout: 30000 }).catch(() => undefined);
  const r = await ask(ok, { cmd: 'getState' });
  assert(r.event === 'state', 'listed origin is served');
  await ok.close();
});

test('DT-22 embed locks editing: selection, drags and shortcuts do nothing; interact=1 only grabs while running', async () => {
  const p = await newPage('&embed=1&scene=car');
  const target = await p.evaluate(() => {
    const a = window.physicslab;
    const b = a.store.bodies().find((x) => x.bodyType === 'dynamic');
    return { id: b.id, position: [...b.position], n: a.store.size };
  });
  // Programmatic and real selection both end up empty.
  await p.evaluate((id) => window.physicslab.store.setSelection([id]), target.id);
  const sel = await p.evaluate(() => window.physicslab.store.selection.length);
  assert(sel === 0, 'selection is cleared immediately');
  const at = await screenOf(p, target.id);
  await p.mouse.move(at.x, at.y);
  await p.mouse.down();
  await p.mouse.move(at.x + 120, at.y + 30, { steps: 6 });
  await p.mouse.up();
  await p.keyboard.press('Delete');
  await p.keyboard.press('Control+a');
  const after = await p.evaluate((id) => {
    const a = window.physicslab;
    const b = a.store.body(id);
    return { position: [...b.position], n: a.store.size, sel: a.store.selection.length, rev: a.store.revision };
  }, target.id);
  assert(after.n === target.n && after.sel === 0, `nothing deleted or selected (${JSON.stringify(after)})`);
  assert(after.position.every((v, i) => v === target.position[i]), 'dragging did not move the body');
  await p.close();

  const q = await newPage('&embed=1&scene=car&interact=1');
  const info = await q.evaluate(() => {
    const b = window.physicslab.store.bodies().find((x) => x.bodyType === 'dynamic');
    return { id: b.id, position: [...b.position] };
  });
  const pt = await screenOf(q, info.id);
  await q.mouse.move(pt.x, pt.y);
  await q.mouse.down();
  await q.mouse.move(pt.x + 100, pt.y, { steps: 5 });
  await q.mouse.up();
  const moved = await q.evaluate((id) => [...window.physicslab.store.body(id).position], info.id);
  assert(moved.every((v, i) => v === info.position[i]), 'interact=1 still cannot edit while stopped');
  await q.click('.embed-play');
  await q.waitForFunction(() => window.physicslab.sim.mode === 'running');
  const pt2 = await screenOf(q, info.id);
  await q.mouse.move(pt2.x, pt2.y);
  await q.mouse.down();
  const grabbed = await q.waitForFunction(() => document.querySelector('.viewport-canvas.grabbing') || null, null, { timeout: 5000 }).then(() => true, () => false);
  await q.mouse.up();
  const docAfter = await q.evaluate((id) => [...window.physicslab.store.body(id).position], info.id);
  assert(docAfter.every((v, i) => v === info.position[i]), 'grabbing never writes to the document');
  assert(grabbed, 'interact=1 allows grabbing a body of the running simulation');
  await q.close();
});
