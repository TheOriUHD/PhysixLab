/**
 * DT-40 PWA end-to-end tests. Service workers only exist in production builds, so these tests do not use the
 * runner's dev server: they build the app once into a temp directory (`vite build`, ~5 s) and serve it with a tiny
 * static node server on a random port (127.0.0.1 counts as a secure context, so service workers work).
 *
 *   - offline start: wait for the install + complete precache, go offline (browser offline emulation AND the
 *     static server shut off), reload: the app boots and the physics worker + Rapier wasm run from the cache
 *   - update flow: serve a changed build (new sw.js version), the "new version" banner appears, nothing reloads by
 *     itself, "Reload" activates the new worker and the old cache is deleted
 *   - share target: a multipart POST to <scope>share-target is stashed by the worker and imported on the next open
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { assert, currentBrowser, root, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

let built; // { dirA, dirB, version, versionB, count }
function buildOnce() {
  if (built) return built;
  const base = mkdtempSync(join(tmpdir(), 'physicslab-pwa-'));
  const dirA = join(base, 'a');
  const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const r = spawnSync(process.execPath, [vite, 'build', '--outDir', dirA, '--emptyOutDir'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
  });
  if (r.status !== 0) throw new Error(`vite build failed:\n${r.stdout}\n${r.stderr}`);
  const swSrc = readFileSync(join(dirA, 'sw.js'), 'utf8');
  const meta = /const BUILD = (\{.*?\});/.exec(swSrc);
  if (!meta) throw new Error('dist/sw.js has no BUILD block');
  const { version, precache } = JSON.parse(meta[1]);
  // Build B = the same files with a different worker version, i.e. "a new deployment".
  const dirB = join(base, 'b');
  cpSync(dirA, dirB, { recursive: true });
  const versionB = `${version}-next`;
  writeFileSync(join(dirB, 'sw.js'), swSrc.replace(`"version":"${version}"`, `"version":"${versionB}"`));
  built = { base, dirA, dirB, version, versionB, count: precache.length };
  process.once('exit', () => rmSync(base, { recursive: true, force: true }));
  return built;
}

/** Static server whose document root can be swapped while running (to "deploy" a new version). */
async function serve(dir, prefix = '/') {
  const state = { dir, hits: 0, down: false };
  const server = createServer((req, res) => {
    state.hits++;
    // `down` = the host is unreachable (also for the worker's own fetches, which context.setOffline does not cover)
    if (state.down) return req.socket.destroy();
    const u = new URL(req.url, 'http://x');
    if (!u.pathname.startsWith(prefix)) return res.writeHead(404).end('outside the app prefix');
    u.pathname = '/' + u.pathname.slice(prefix.length);
    let file = normalize(join(state.dir, decodeURIComponent(u.pathname)));
    if (!file.startsWith(state.dir)) return res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return res.writeHead(404).end('not found');
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${server.address().port}${prefix}`;
  state.stop = () => server.close();
  return state;
}

async function openApp(server, query = '?nowelcome') {
  const ctx = await currentBrowser().newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(server.url + query);
  await page.waitForFunction(() => !!window.physicslab && window.physicslab.viewport, null, { timeout: 30000 });
  return { ctx, page, errors };
}

/** Wait until the worker controls the page and the whole precache list of `version` is in its cache. */
async function waitOfflineReady(page, version, count) {
  await page.waitForFunction(
    async ({ version, count }) => {
      if (!navigator.serviceWorker.controller) return false;
      if (!(await caches.keys()).includes(`pl-v${version}`)) return false;
      return (await (await caches.open(`pl-v${version}`)).keys()).length >= count;
    },
    { version, count },
    { timeout: 60000 },
  );
}

test('pwa: manifest and icons are served and valid', async () => {
  const b = buildOnce();
  const server = await serve(b.dirA);
  try {
    const { ctx, page } = await openApp(server);
    const m = await page.evaluate(async () => {
      const link = document.querySelector('link[rel=manifest]');
      const man = await (await fetch(link.href)).json();
      const sizes = {};
      for (const i of man.icons.filter((i) => i.type === 'image/png')) {
        const img = new Image();
        img.src = new URL(i.src, link.href).href;
        await img.decode();
        sizes[i.src] = [img.naturalWidth, img.naturalHeight];
      }
      return { man, sizes, theme: document.querySelector('meta[name=theme-color]')?.content };
    });
    assert(m.man.display === 'standalone' && m.man.name === 'PhysicsLab', 'standalone PhysicsLab manifest');
    assert(m.man.start_url === './' && m.man.scope === './', 'relative start_url/scope (sub-path deployable)');
    assert(
      m.man.icons.some((i) => i.purpose === 'maskable'),
      'maskable icon declared',
    );
    assert(m.sizes['icons/icon-192.png']?.join('x') === '192x192', `192 icon decodes: ${JSON.stringify(m.sizes)}`);
    assert(m.sizes['icons/icon-512.png']?.join('x') === '512x512', '512 icon decodes');
    assert(m.sizes['icons/icon-maskable-512.png']?.join('x') === '512x512', 'maskable icon decodes');
    assert(m.theme === m.man.theme_color, 'theme-color meta matches the manifest');
    assert(
      m.man.file_handlers?.[0]?.accept?.['application/json']?.includes('.physicslab.json'),
      'file handler declared',
    );
    await ctx.close();
  } finally {
    server.stop();
  }
});

test('pwa: installs, precaches everything and starts + simulates offline', async () => {
  const b = buildOnce();
  const server = await serve(b.dirA);
  try {
    const { ctx, page, errors } = await openApp(server);
    await waitOfflineReady(page, b.version, b.count);
    const cached = await page.evaluate(
      async (v) => (await (await caches.open(`pl-v${v}`)).keys()).map((r) => r.url),
      b.version,
    );
    assert(
      cached.some((u) => u.endsWith('.wasm')),
      'the Rapier wasm is precached',
    );
    assert(
      cached.some((u) => /sim\.worker-.*\.js$/.test(u)),
      'the physics worker script is precached',
    );
    assert(
      cached.some((u) => u.endsWith('/index.html')),
      'index.html is precached',
    );

    server.down = true;
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => !!window.physicslab && window.physicslab.viewport, null, { timeout: 30000 });
    const bodies = await page.evaluate(() => window.physicslab.store.bodies().length);
    assert(bodies > 0, 'the offline app loaded a scene');
    await page.keyboard.press('Space'); // simulate: needs the worker + wasm, both from the cache
    await simTime(page, 0.3);
    assert(errors.length === 0, `no page errors: ${errors.join(' | ')}`);
    await ctx.close();
  } finally {
    server.stop();
  }
});

test('pwa: update-available banner, never auto-reloads, Reload activates the new version', async () => {
  const b = buildOnce();
  const server = await serve(b.dirA);
  try {
    const { ctx, page } = await openApp(server);
    await waitOfflineReady(page, b.version, b.count);
    await page.evaluate(() => (window.__beforeUpdate = true));
    assert((await page.locator('.pwa-update').count()) === 0, 'no banner before an update exists');

    server.dir = b.dirB; // "deploy" the new version
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await page.waitForSelector('.pwa-update', { timeout: 30000 });
    assert(/new version/i.test(await page.locator('.pwa-update').innerText()), 'banner says a new version is ready');
    await page.waitForTimeout(800);
    assert(await page.evaluate(() => window.__beforeUpdate === true), 'the page was not reloaded by itself');
    // the old version keeps serving until the user decides
    const keys = await page.evaluate(() => caches.keys());
    assert(keys.includes(`pl-v${b.version}`), 'old cache still present while the update waits');

    await page.locator('.pwa-update [data-pwa=reload]').click();
    await page.waitForFunction(() => window.__beforeUpdate === undefined && !!window.physicslab?.viewport, null, {
      timeout: 30000,
    });
    await page.waitForFunction(
      async ({ a, bv }) => {
        const k = await caches.keys();
        return k.includes(`pl-v${bv}`) && !k.includes(`pl-v${a}`);
      },
      { a: b.version, bv: b.versionB },
      { timeout: 30000 },
    );
    assert((await page.locator('.pwa-update').count()) === 0, 'banner gone after the reload');
    await ctx.close();
  } finally {
    server.stop();
  }
});

test('pwa: a shared .physicslab.json (Web Share Target POST) is imported on open', async () => {
  const b = buildOnce();
  const server = await serve(b.dirA);
  try {
    const { ctx, page } = await openApp(server);
    await waitOfflineReady(page, b.version, b.count);
    const status = await page.evaluate(async () => {
      const doc = window.physicslab.store.toDocument();
      doc.name = 'Shared via PWA';
      const fd = new FormData();
      fd.append('scene', new File([JSON.stringify(doc)], 'shared.physicslab.json', { type: 'application/json' }));
      const res = await fetch('share-target', { method: 'POST', body: fd, redirect: 'manual' });
      return { type: res.type };
    });
    assert(status.type === 'opaqueredirect', `the worker answers the share POST with a redirect (${status.type})`);
    await page.goto(`${server.url}?shared=1&nowelcome`);
    await page.waitForFunction(() => window.physicslab?.store?.name === 'Shared via PWA', null, { timeout: 30000 });
    assert(!page.url().includes('shared='), 'the ?shared flag is removed from the address bar');
    await ctx.close();
  } finally {
    server.stop();
  }
});

test('pwa: works when deployed under a sub-path (GitHub Pages style)', async () => {
  const b = buildOnce();
  const server = await serve(b.dirA, '/physics/lab/');
  try {
    const { ctx, page, errors } = await openApp(server);
    await waitOfflineReady(page, b.version, b.count);
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope);
    assert(scope === server.url, `worker scope is the sub-path (${scope})`);
    server.down = true;
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => !!window.physicslab && window.physicslab.viewport, null, { timeout: 30000 });
    await page.keyboard.press('Space');
    await simTime(page, 0.3);
    assert(errors.length === 0, `no page errors: ${errors.join(' | ')}`);
    await ctx.close();
  } finally {
    server.stop();
  }
});
