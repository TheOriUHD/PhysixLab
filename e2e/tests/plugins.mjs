/** DT-31: plugins — install through the real manager UI, permissions, declarative panels, isolation and error containment. */
import { createServer } from 'node:http';
import { assert, newPage } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const install = (page, source, granted) =>
  page.evaluate(
    async ([source, granted]) => {
      const { pluginHost } = await import('/src/plugins/manager.ts');
      return (await pluginHost(window.physicslab).install(source, 'test', granted)).state;
    },
    [source, granted],
  );
const hasCommand = (page, id) => page.evaluate((id) => window.physicslab.actions.list().some((c) => c.id === id), id);
const wait = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 30000 });

test('Plugins: install an example through the manager UI (permission prompt), use its command, panel and template', async () => {
  const page = await newPage();
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette .palette-input');
  await page.keyboard.type('plugins');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.plg-list', { timeout: 20000 });
  await page.getByRole('button', { name: 'Install “Gravity presets”' }).click();
  // The permission prompt names what is asked and says what is never granted.
  await page.waitForSelector('.plg-perm');
  const prompt = await page.locator('.modal').last().innerText();
  assert(prompt.includes('scene.write') && /network, storage or page access/.test(prompt), `prompt: ${prompt}`);
  await page.locator('.modal').last().getByRole('button', { name: 'Install plugin' }).click();
  await page.waitForSelector('.plg-item.running', { timeout: 30000 });
  await page.keyboard.press('Escape'); // close the manager so the panel is clickable
  assert(await hasCommand(page, 'plugin.gravity-presets.gravity-moon'), 'command registered');
  await page.evaluate(() => window.physicslab.actions.run('plugin.gravity-presets.gravity-moon'));
  await wait(page, () => Math.abs(window.physicslab.scene.settings().gravity[1] + 1.62) < 1e-6);
  // Declarative panel: appears as a tab, renders buttons from the plugin's tree, and clicking calls back into the sandbox.
  await page.evaluate(() => window.physicslab.actions.run('panel.plugin-gravity-presets-gravity'));
  await page.waitForSelector('.plg-panel button:has-text("Mars")', { timeout: 20000 });
  await page.click('.plg-panel button:has-text("Mars")');
  await wait(page, () => Math.abs(window.physicslab.scene.settings().gravity[1] + 3.72) < 1e-6);
  assert(page.errors.length === 0, page.errors.join('; '));
});

test('Plugins: second example — batch command is ONE undo step, stats panel, template registered; survives a reload', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physicslab.scene.clear());
  const src = await page.evaluate(async () => (await import('/src/plugins/manager.ts')).EXAMPLE_PLUGINS[1].source);
  assert(
    (await install(page, src, ['ui', 'scene.read', 'scene.write', 'view'])) === 'running',
    'domino tools should run',
  );
  await page.evaluate(() => window.physicslab.actions.run('plugin.domino-tools.domino-line'));
  await wait(page, () => window.physicslab.scene.entities({ kind: 'body' }).length === 12);
  await page.evaluate(() => window.physicslab.scene.undo());
  assert((await page.evaluate(() => window.physicslab.scene.entities().length)) === 0, 'one undo removes all dominoes');
  const tpl = await page.evaluate(
    async () =>
      (await import('/src/model/content/index.ts')).getTemplate('plugin-domino-tools-domino-arc')?.build().entities
        .length,
  );
  assert(tpl > 20, `template from the plugin DSL: ${tpl}`);
  await page.evaluate(() => window.physicslab.actions.run('panel.plugin-domino-tools-stats'));
  await page.waitForSelector('.plg-panel .plg-table', { timeout: 20000 });
  // Reload: the plugin is remembered and started again.
  await page.reload();
  await page.waitForFunction(() => !!window.physicslab?.viewport, null, { timeout: 30000 });
  await wait(page, () => window.physicslab.actions.list().some((c) => c.id === 'plugin.domino-tools.domino-line'));
});

test('Plugins: permissions are enforced — a plugin without scene.write cannot change the scene', async () => {
  const page = await newPage();
  await page.evaluate(() => window.physicslab.scene.clear());
  const toasts = await page.evaluateHandle(() => {
    const t = [];
    window.physicslab.on('toast', (e) => t.push(e.text));
    return t;
  });
  const src = `/* @physicslab-plugin
{ "id": "nosy", "name": "Nosy", "version": "1.0.0", "permissions": ["ui", "scene.read"] }
*/
try { await plugin.scene.addBody('box'); plugin.toast('RAN'); } catch (e) { plugin.toast('DENIED ' + e.message); }
try { await plugin.simulation.play(); plugin.toast('RAN2'); } catch (e) { plugin.toast('DENIED2'); }
try { await plugin.api.scene.get(); } catch (e) { plugin.toast('NOAPI'); }
`;
  assert((await install(page, src, ['ui', 'scene.read'])) === 'running', 'plugin should start');
  await page.waitForTimeout(500);
  const got = await toasts.jsonValue();
  assert(
    got.some((t) => t.includes('DENIED') && t.includes('scene.write')),
    `toasts: ${got}`,
  );
  assert(
    got.some((t) => t.includes('DENIED2')) &&
      got.some((t) => t.includes('NOAPI')) &&
      !got.some((t) => t.includes('RAN')),
    `toasts: ${got}`,
  );
  assert((await page.evaluate(() => window.physicslab.scene.entities().length)) === 0, 'scene must be untouched');
  // A granted subset is what counts, not what the manifest asks for.
  const asks = src
    .replace('"permissions": ["ui", "scene.read"]', '"permissions": ["ui", "scene.read", "scene.write"]')
    .replace('"nosy"', '"nosy2"');
  await install(page, asks, ['ui', 'scene.read']);
  await page.waitForTimeout(500);
  assert(
    (await page.evaluate(() => window.physicslab.scene.entities().length)) === 0,
    'declined permission must stay declined',
  );
});

test('Plugins: hostile plugin with every permission still cannot reach network/storage/DOM (canary sees 0 requests)', async () => {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'access-control-allow-origin': '*' });
    res.end('');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const page = await newPage();
    await page.evaluate(() => {
      localStorage.setItem('physicslab.secret', 'x');
      document.title = 'intact';
    });
    const src = `/* @physicslab-plugin
{ "id": "evil", "name": "Evil", "version": "1.0.0", "permissions": ["ui","scene.read","scene.write","simulation","view"] }
*/
const U = 'http://127.0.0.1:${port}/';
const tries = {
  fetch: () => fetch(U + 'f'), xhr: () => { const x = new XMLHttpRequest(); x.open('GET', U + 'x'); x.send(); },
  ws: () => new WebSocket('ws://127.0.0.1:${port}/'), imp: () => import(U + 'i.js'), worker: () => new Worker(U + 'w.js'),
  ls: () => localStorage.getItem('physicslab.secret'), idb: () => indexedDB.open('x'), doc: () => document.title,
  win: () => window.name, top: () => top.location.href, beacon: () => navigator.sendBeacon(U + 'b'),
  proto: () => Function('return this')().fetch(U + 'p'),
};
const report = [];
for (const [k, f] of Object.entries(tries)) { try { await f(); report.push(k + ':RAN'); } catch (e) { report.push(k + ':blocked'); } }
await plugin.toast('REPORT ' + report.join(','));
`;
    const toasts = await page.evaluateHandle(() => {
      const t = [];
      window.physicslab.on('toast', (e) => t.push(e.text));
      return t;
    });
    assert(
      (await install(page, src, ['ui', 'scene.read', 'scene.write', 'simulation', 'view'])) === 'running',
      'evil plugin starts (it just fails to escape)',
    );
    await page.waitForTimeout(1500);
    const report = (await toasts.jsonValue()).find((t) => t.includes('REPORT'));
    assert(report && !report.includes(':RAN'), `escape attempts: ${report}`);
    assert(hits.length === 0, `CANARY RECEIVED: ${JSON.stringify(hits)}`);
    assert((await page.evaluate(() => document.title)) === 'intact', 'page intact');
  } finally {
    server.close();
  }
});

test('Plugins: a crashing or hanging plugin is contained; others keep working; its registrations are removed', async () => {
  const page = await newPage();
  const good = await page.evaluate(async () => (await import('/src/plugins/manager.ts')).EXAMPLE_PLUGINS[0].source);
  assert((await install(page, good, ['ui', 'scene.read', 'scene.write'])) === 'running', 'good plugin');
  const crash = `/* @physicslab-plugin
{ "id": "crasher", "name": "Crasher", "version": "1.0.0", "permissions": ["ui"] }
*/
await plugin.registerCommand({ id: 'half', label: 'Half registered', run() {} });
throw new Error('kaboom at start');
`;
  assert((await install(page, crash, ['ui'])) === 'error', 'crashing plugin ends in the error state');
  assert(!(await hasCommand(page, 'plugin.crasher.half')), 'registrations of a failed plugin are rolled back');
  const hang = `/* @physicslab-plugin
{ "id": "hanger", "name": "Hanger", "version": "1.0.0", "permissions": ["ui"] }
*/
await plugin.registerCommand({ id: 'spin', label: 'Spin forever', run() { while (true) {} } });
`;
  assert((await install(page, hang, ['ui'])) === 'running', 'hanger starts');
  await page.evaluate(() => window.physicslab.actions.run('plugin.hanger.spin'));
  for (let i = 0; i < 240; i++) {
    const state = await page.evaluate(async () => {
      const { pluginHost } = await import('/src/plugins/manager.ts');
      return pluginHost(window.physicslab)
        .list()
        .find((p) => p.manifest.id === 'hanger').state;
    });
    if (state === 'error') break;
    await page.waitForTimeout(250);
  }
  assert(
    !(await hasCommand(page, 'plugin.hanger.spin')),
    'hung plugin loses its commands ' +
      JSON.stringify(
        await page.evaluate(async () =>
          (await import('/src/plugins/manager.ts'))
            .pluginHost(window.physicslab)
            .list()
            .map((p) => [p.manifest.id, p.state, p.error]),
        ),
      ),
  );
  await page.evaluate(() => window.physicslab.actions.run('plugin.gravity-presets.gravity-mars'));
  await wait(page, () => Math.abs(window.physicslab.scene.settings().gravity[1] + 3.72) < 1e-6);
});

test('Plugins: disable and remove take commands and panels away; panel text is never interpreted as HTML', async () => {
  const page = await newPage();
  const src = `/* @physicslab-plugin
{ "id": "xss", "name": "Xss", "version": "1.0.0", "permissions": ["ui"] }
*/
await plugin.registerCommand({ id: 'noop', label: 'Noop', run() {} });
await plugin.registerPanel({ id: 'p', label: 'Xss', render: () => ({ type: 'column', children: [{ type: 'text', text: '<img src=x onerror="window.__pwned=1">' }, { type: 'script', src: 'x' }] }) });
`;
  await install(page, src, ['ui']);
  await page.evaluate(() => window.physicslab.actions.run('panel.plugin-xss-p'));
  await page.waitForSelector('.plg-panel .plg-error', { timeout: 20000 }); // unknown element type → clear message, nothing rendered
  assert(
    (await page.evaluate(() => window.__pwned)) === undefined && (await page.locator('.plg-panel img').count()) === 0,
    'no markup injection',
  );
  assert(await hasCommand(page, 'plugin.xss.noop'), 'command present');
  await page.evaluate(async () =>
    (await import('/src/plugins/manager.ts')).pluginHost(window.physicslab).disable('xss'),
  );
  assert(!(await hasCommand(page, 'plugin.xss.noop')), 'disable removes the command');
  await page.evaluate(async () =>
    (await import('/src/plugins/manager.ts')).pluginHost(window.physicslab).remove('xss'),
  );
  const n = await page.evaluate(
    async () => (await import('/src/plugins/manager.ts')).pluginHost(window.physicslab).list().length,
  );
  assert(n === 0, 'removed');
});
