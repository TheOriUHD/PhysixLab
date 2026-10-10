/**
 * DT-31 / DT-32: the sandbox is PROVABLY isolated. Hostile code tries every way out it can think of while a canary
 * HTTP server on another port counts requests; the count must stay zero. A positive control proves the canary works.
 * Also: scene scripts through the real dialog (examples, undo, errors, infinite loop).
 */
import { createServer } from 'node:http';
import { assert, newPage } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function canary() {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/javascript' });
    res.end('globalThis.__escaped = true;');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { hits, port: server.address().port, close: () => server.close() };
}

/** Hostile code: every attempt is recorded with console.log("name: outcome"); nothing is allowed to succeed. */
const hostile = (port) => `
const URL_ = 'http://127.0.0.1:${port}/leak?';
const out = [];
const attempt = async (name, fn) => {
  try { const r = await fn(); out.push(name + ': RAN ' + String(r)); }
  catch (e) { out.push(name + ': blocked (' + (e && e.name) + ')'); }
};
const G = (function () { return this; })() || globalThis;
await attempt('fetch', () => fetch(URL_ + 'fetch'));
await attempt('globalThis.fetch', () => globalThis.fetch(URL_ + 'gfetch'));
await attempt('Function-this fetch', () => Function('return this')().fetch(URL_ + 'fn'));
await attempt('proto fetch', () => Object.getPrototypeOf(Object.getPrototypeOf(globalThis)).fetch(URL_ + 'proto'));
await attempt('Reflect fetch', () => Reflect.get(globalThis, 'fetch')(URL_ + 'reflect'));
await attempt('XMLHttpRequest', () => { const x = new XMLHttpRequest(); x.open('GET', URL_ + 'xhr'); x.send(); });
await attempt('WebSocket', () => new WebSocket('ws://127.0.0.1:${port}/ws'));
await attempt('EventSource', () => new EventSource(URL_ + 'es'));
await attempt('importScripts', () => importScripts(URL_ + 'is.js'));
await attempt('dynamic import http', () => import(URL_ + 'dyn.js'));
await attempt('dynamic import data', () => import('data:text/javascript,globalThis.__escaped=true'));
await attempt('Worker http', () => new Worker(URL_ + 'w.js'));
await attempt('Worker blob', () => new Worker(URL.createObjectURL(new Blob(['fetch("' + URL_ + 'wb")']))));
await attempt('SharedWorker', () => new SharedWorker(URL_ + 'sw.js'));
await attempt('sendBeacon', () => navigator.sendBeacon(URL_ + 'beacon', 'x'));
await attempt('indexedDB', () => indexedDB.open('x'));
await attempt('caches', () => caches.open('x'));
await attempt('localStorage', () => localStorage.getItem('x'));
await attempt('BroadcastChannel', () => new BroadcastChannel('physicslab'));
await attempt('WebAssembly', () => new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
await attempt('postMessage parent', () => postMessage('hi'));
await attempt('window/document/parent/top', () => {
  const t = [typeof window, typeof document, typeof parent, typeof top];
  if (t.every((x) => x === 'undefined')) throw new TypeError('none exist');
  return t.join();
});
await attempt('location', () => location.href);
// Walk the whole global prototype chain looking for anything network-ish that survived.
const survivors = [];
for (let o = globalThis; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
  for (const n of Object.getOwnPropertyNames(o))
    if (/^(fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|Worker|SharedWorker|indexedDB|caches|localStorage|sessionStorage|BroadcastChannel|navigator|RTCPeerConnection|WebTransport)$/.test(n)) {
      let v; try { v = o[n]; } catch { continue; }
      if (v !== undefined) survivors.push(n);
    }
out.push('survivors: ' + JSON.stringify(survivors));
console.log(JSON.stringify(out));
`;

test('Sandbox: hostile code cannot reach the network, storage, DOM or other threads (canary server sees 0 requests)', async () => {
  const c = await canary();
  try {
    const page = await newPage();
    // Positive control: the same canary IS reachable from the page itself, so a count of 0 means something.
    await page.evaluate(
      (port) => fetch(`http://127.0.0.1:${port}/control`, { mode: 'no-cors' }).then(() => undefined),
      c.port,
    );
    assert(
      c.hits.length === 1 && c.hits[0] === '/control',
      `canary must see the control request, saw ${JSON.stringify(c.hits)}`,
    );
    c.hits.length = 0;

    await page.evaluate(() => {
      localStorage.setItem('probe', 'secret');
      document.cookie = 'probe=secret';
      window.name = 'secret';
    });
    const result = await page.evaluate(async (code) => {
      const { Sandbox } = await import('/src/sandbox/sandbox.ts');
      const dslPrelude = (await import('/src/scripting/dslPrelude.mjs?raw')).default;
      const logs = [];
      const sb = await Sandbox.create({ handlers: {}, onLog: (_l, t) => logs.push(t) });
      let error = null;
      try {
        await sb.run(code, `${dslPrelude}\nreturn build(api);`, 20000);
      } catch (e) {
        error = String(e.message);
      }
      sb.dispose();
      return { logs, error, frames: document.querySelectorAll('iframe').length };
    }, hostile(c.port));
    await page.waitForTimeout(800); // late requests would show up now
    assert(result.error === null, `hostile script should finish normally, got ${result.error}`);
    const out = JSON.parse(result.logs[result.logs.length - 1]);
    const ran = out.filter((l) => l.includes(': RAN '));
    assert(ran.length === 0, `these escape attempts did not throw: ${ran.join(' | ')}`);
    const survivors = JSON.parse(out.find((l) => l.startsWith('survivors: ')).slice(11));
    assert(survivors.length === 0, `network/storage globals survived the lockdown: ${survivors}`);
    assert(c.hits.length === 0, `CANARY RECEIVED REQUESTS: ${JSON.stringify(c.hits)}`);
    assert(result.frames === 0, 'the sandbox iframe must be removed after dispose');
    const intact = await page.evaluate(() => ({
      ls: localStorage.getItem('probe'),
      name: window.name,
      escaped: typeof globalThis.__escaped,
    }));
    assert(
      intact.ls === 'secret' && intact.name === 'secret' && intact.escaped === 'undefined',
      `page state changed: ${JSON.stringify(intact)}`,
    );
  } finally {
    c.close();
  }
});

test('Sandbox: the iframe is opaque-origin and CSP-locked even if the worker lockdown were bypassed', async () => {
  const c = await canary();
  try {
    const page = await newPage();
    // Re-create the exact container the sandbox uses and try, from inside its document, what the worker could not.
    const r = await page.evaluate(async (port) => {
      const src = (await import('/src/sandbox/sandbox.ts')).__srcdocForTests;
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.srcdoc = src.replace(
        '</script></body>',
        `
        var res = {};
        try { res.origin = String(location.origin); } catch (e) { res.origin = 'err'; }
        try { localStorage.getItem('x'); res.storage = 'accessible'; } catch (e) { res.storage = 'blocked'; }
        try { res.parentDom = String(parent.document.title); } catch (e) { res.parentDom = 'blocked'; }
        fetch('http://127.0.0.1:${port}/iframe-fetch').then(function () { res.fetch = 'ran'; }, function () { res.fetch = 'blocked'; });
        var img = new Image(); img.src = 'http://127.0.0.1:${port}/iframe-img.png';
        import('http://127.0.0.1:${port}/iframe-import.js').then(function () { res.imp = 'ran'; }, function () { res.imp = 'blocked'; });
        setTimeout(function () { parent.postMessage({ t: 'probe', res: res }, '*'); }, 600);
        </script></body>`,
      );
      const got = new Promise((resolve) =>
        window.addEventListener('message', (e) => {
          if (e.data && e.data.t === 'probe') resolve(e.data.res);
        }),
      );
      document.body.appendChild(frame);
      const res = await got;
      frame.remove();
      return res;
    }, c.port);
    await page.waitForTimeout(500);
    assert(r.origin === 'null', `iframe origin should be opaque, got ${r.origin}`);
    assert(r.storage === 'blocked', 'iframe must not reach web storage');
    assert(r.parentDom === 'blocked', 'iframe must not reach the app DOM');
    assert(r.fetch === 'blocked' && r.imp === 'blocked', `CSP must block fetch/import: ${JSON.stringify(r)}`);
    assert(c.hits.length === 0, `CANARY RECEIVED REQUESTS from the iframe: ${JSON.stringify(c.hits)}`);
  } finally {
    c.close();
  }
});

test('Scene script: an infinite loop is stopped, the page stays responsive, and a new run works', async () => {
  const page = await newPage();
  const r = await page.evaluate(async () => {
    const { runSceneScript } = await import('/src/scripting/run.ts');
    let frames = 0;
    let running = true;
    const tick = () => {
      if (running) {
        frames++;
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
    const t0 = performance.now();
    let err = null;
    try {
      await runSceneScript('while (true) {}', 1200);
    } catch (e) {
      err = e.message;
    }
    const ms = performance.now() - t0;
    running = false;
    const ok = await runSceneScript("body('b','box',[1,1,1],[0,1,0])", 5000);
    return { err, ms, frames, entities: ok.doc.entities.length, iframes: document.querySelectorAll('iframe').length };
  });
  assert(/longer than/.test(r.err), `expected a timeout message, got ${r.err}`);
  assert(r.ms < 20000, `stopped too slowly: ${r.ms} ms`);
  assert(r.frames >= 3, `the page froze while the script ran (${r.frames} frames)`);
  assert(r.entities === 1 && r.iframes === 0, JSON.stringify(r));
});

test('Scene script: errors report the user line; bad output is rejected, never applied', async () => {
  const page = await newPage();
  const r = await page.evaluate(async () => {
    const { runSceneScript } = await import('/src/scripting/run.ts');
    const grab = async (code) => {
      try {
        await runSceneScript(code, 4000);
        return 'ok';
      } catch (e) {
        return { message: e.message, line: e.line };
      }
    };
    return {
      thrown: await grab(
        "body('a','box',[1,1,1],[0,1,0]);\nbody('b','box',[1,1,1],[0,1,0]);\nthrow new Error('boom');",
      ),
      refErr: await grab('notDefinedAnywhere();'),
      bad: await grab("body('x','box',[1,1],[0,0,0])"),
      network: await grab("fetch('http://example.com')"),
      huge: await grab("for (let i = 0; i < 30000; i++) body('x','box',[1,1,1],[0,0,0]);"),
    };
  });
  assert(r.thrown.message.includes('boom') && r.thrown.line === 3, `thrown: ${JSON.stringify(r.thrown)}`);
  assert(r.refErr.message.includes('notDefinedAnywhere'), JSON.stringify(r.refErr));
  assert(/three numbers/.test(r.bad.message), JSON.stringify(r.bad));
  assert(r.network !== 'ok', 'fetch in a script must fail');
  assert(/Too many objects/.test(r.huge.message), JSON.stringify(r.huge));
});

test('Scene script dialog: open from the palette, run an example, one undo step, add mode', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physicslab.scene.clear());
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette .palette-input');
  await page.keyboard.type('scene script');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.dtb-code', { timeout: 20000 });
  await page.selectOption('.dtb-examples', 'pendulum-chain');
  const code = await page.inputValue('.dtb-code');
  assert(code.includes('Pendulum chain'), 'example should load into the editor');
  await page.click('text=Run — replace scene');
  await page.waitForSelector('.dtb-status.ok', { timeout: 30000 });
  const n1 = await page.evaluate(() => window.physicslab.scene.entities().length);
  assert(n1 >= 15, `pendulum chain should have bodies and hinges, got ${n1}`);
  await page.click('text=Run — add to scene');
  await page.waitForFunction((n) => window.physicslab.scene.entities().length >= 2 * n, n1, { timeout: 30000 });
  await page.evaluate(() => window.physicslab.scene.undo());
  const n2 = await page.evaluate(() => window.physicslab.scene.entities().length);
  assert(n2 === n1, `undo of the add run must restore ${n1}, got ${n2}`);
  await page.evaluate(() => window.physicslab.scene.undo());
  const n3 = await page.evaluate(() => window.physicslab.scene.entities().length);
  assert(n3 === 0, `undo of the replace run must restore the empty scene, got ${n3}`);
  assert(page.errors.length === 0, page.errors.join('; '));
});

test('Scene script: every shipped example runs in the real sandbox and then simulates', async () => {
  const page = await newPage();
  const r = await page.evaluate(async () => {
    const { runSceneScript } = await import('/src/scripting/run.ts');
    const { SCRIPT_EXAMPLES } = await import('/src/scripting/examples.ts');
    const out = {};
    for (const ex of SCRIPT_EXAMPLES) {
      const run = await runSceneScript(ex.code, 8000);
      out[ex.id] = { n: run.doc.entities.length, warnings: run.report.warnings.length };
    }
    return out;
  });
  for (const [id, v] of Object.entries(r)) assert(v.n > 2 && v.warnings === 0, `${id}: ${JSON.stringify(v)}`);
});
