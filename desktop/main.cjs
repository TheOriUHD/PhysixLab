/**
 * DT-41: optional desktop shell. Wraps the PhysixLab production build (../dist, or ./app-dist when packaged) in
 * an Electron window. The web app is unchanged: it is served from a privileged `app://physixlab/` origin (a
 * standard, secure scheme, so module workers, WebAssembly, WebGL, IndexedDB and fetch behave as on https) and
 * nothing here is needed to run PhysixLab in a browser.
 *
 *   npm start          open the window
 *   npm run smoke      headless check: boot the app, run the simulation, print the result, exit 0 / 1
 *   npm run pack       package for the current OS into desktop/out (see docs/DESKTOP.md)
 */
const { app, BrowserWindow, Menu, net, protocol, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SMOKE = process.argv.includes('--smoke');
const ORIGIN = 'app://physixlab';

/** Where the built web app lives: $PHYSIXLAB_DIST, a copy next to this file (packaged), or ../dist. */
function distDir() {
  const candidates = [process.env.PHYSIXLAB_DIST, path.join(__dirname, 'app-dist'), path.join(__dirname, '..', 'dist')];
  const found = candidates.find((d) => d && fs.existsSync(path.join(d, 'index.html')));
  if (!found) throw new Error('PhysixLab build not found. Run `npm run build` in the repository root first.');
  return found;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

function serveFile(root, request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(root, rel));
  if (file !== root && !file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response('Not found', { status: 404 });
  return net.fetch(pathToFileURL(file).href).then((res) => {
    const headers = new Headers(res.headers);
    headers.set('content-type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    return new Response(res.body, { status: res.status, headers });
  });
}

function createWindow(root) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: !SMOKE,
    backgroundColor: '#0b0e14', // the app's --bg: no white flash while it boots
    title: 'PhysixLab',
    icon: path.join(root, 'icons', 'icon-512.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Links to other sites open in the system browser; the window never navigates away from the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) e.preventDefault();
  });
  void win.loadURL(`${ORIGIN}/?nowelcome`);
  return win;
}

async function smoke(win) {
  const fail = (msg) => {
    process.stderr.write(`SMOKE FAIL: ${msg}\n`);
    app.exit(1);
  };
  const timer = setTimeout(() => fail('timed out after 60 s'), 60000);
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) process.stderr.write(`[renderer error] ${message}\n`);
  });
  try {
    await win.webContents.executeJavaScript(
      'new Promise((res, rej) => { const t = Date.now(); const i = setInterval(() => { if (window.physixlab && window.physixlab.viewport) { clearInterval(i); res(); } else if (Date.now() - t > 40000) { clearInterval(i); rej(new Error("app did not boot")); } }, 100); })',
    );
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    const result = await win.webContents.executeJavaScript(
      'new Promise((res, rej) => { const t = Date.now(); const i = setInterval(() => { const s = window.physixlab.sim.client.stats; if (s && s.simTime >= 0.5) { clearInterval(i); res({ simTime: s.simTime, bodies: window.physixlab.store.bodies().length, origin: location.origin, serviceWorker: "serviceWorker" in navigator }); } else if (Date.now() - t > 40000) { clearInterval(i); rej(new Error("simulation did not advance")); } }, 100); })',
    );
    clearTimeout(timer);
    process.stdout.write(`SMOKE OK ${JSON.stringify(result)}\n`);
    app.exit(0);
  } catch (e) {
    clearTimeout(timer);
    fail(String((e && e.message) || e));
  }
}

void app.whenReady().then(() => {
  const root = distDir();
  protocol.handle('app', (request) => serveFile(root, request));
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
  const win = createWindow(root);
  if (SMOKE) void smoke(win);
});

app.on('window-all-closed', () => app.quit());

function menuTemplate() {
  const mac = process.platform === 'darwin';
  return [
    ...(mac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
  ];
}
