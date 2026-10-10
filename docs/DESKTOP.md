# PhysicsLab as a desktop app

Two routes, both optional. The web app is the product; nothing below is needed to use it.

1. **Install it from the browser (PWA)** — recommended. No download, updates itself, works offline.
2. **Electron wrapper in `desktop/`** — a separate package that puts the same build in its own native window.

## 1. Install from the browser (PWA)

PhysicsLab ships a web manifest (`public/manifest.webmanifest`), icons (192, 512, maskable 512, SVG), and a
hand-written service worker (`scripts/vite/sw.template.cjs`, written to `dist/sw.js` by the build). The worker
is registered **only in production builds**, never by `npm run dev` or in tests. Once the first visit has finished
downloading (a toast says "PhysicsLab is ready to work offline"), the app starts without a network, including the
physics worker and the Rapier WebAssembly file.

The install prompt needs a secure origin (https, or `localhost`) and a host that serves the files of `dist/`
as they are (any static host; the build is relative to its own folder, so a sub-path such as
`https://user.github.io/physicslab/` works).

| OS / browser | Steps |
| --- | --- |
| **Windows, macOS, Linux — Chrome or Edge** | Open the site. Use **Help ▸ Install PhysicsLab as an app…** (the entry appears when the browser says the page is installable), or the install icon at the right end of the address bar, or the browser menu ▸ **Install PhysicsLab** (Chrome: *Cast, save and share ▸ Install page as app*; Edge: *Apps ▸ Install this site as an app*). PhysicsLab then opens in its own window and appears in the Start menu / Launchpad / application launcher. |
| **macOS — Safari 17+** | Open the site, **File ▸ Add to Dock…**, confirm the name. (Safari never fires the install event, so the in-app menu entry stays hidden; the browser's own command is the way.) |
| **Linux — Firefox** | Firefox desktop does not install web apps. Use Chrome/Edge/Chromium, or the Electron wrapper below. |
| **Android / iOS** | Browser menu ▸ **Install app** / **Add to Home Screen**. |

Uninstall like any other app (Windows Settings ▸ Apps, `chrome://apps`, Dock ▸ Remove), or from the app window's
menu (`⋮` ▸ *Uninstall PhysicsLab…*).

**Updates.** The browser checks for a new `sw.js` on each visit and every hour. A new version downloads in the
background and a banner appears: *"A new version of PhysicsLab is ready."* with **Reload** and **Later**. Nothing
reloads by itself; the scene is autosaved either way.

**Opening scene files.** Where the OS supports PWA file handling (Chrome / Edge on Windows, macOS, Linux, ChromeOS),
the installed app registers for `.physicslab.json` / `.json`: double-click or *Open with ▸ PhysicsLab* imports the
scene (with the usual "Replace current scene?" confirmation). On platforms with a Web Share Target for files
(Android, ChromeOS, recent Windows) *Share ▸ PhysicsLab* does the same via the service worker. Both go through the
normal import path, so the same sanitising and migration apply.

**Offline limits.** Only PhysicsLab's own files are cached. Features that load something from another site (none
of the built-in ones do) would not work offline.

### What is verified

* `e2e/tests/pwa.mjs` (headless Chromium against a production build served by a static server): the manifest and
  icons decode with the declared sizes; after the first visit the whole precache is in the cache; with the browser
  offline **and** the server shut down, a reload boots the app, loads a scene and simulates (worker + wasm from
  the cache); an updated build shows the banner, does not reload by itself, **Reload** activates the new worker and
  deletes the old cache; a multipart POST to `share-target` is imported on the next open; the same works from a
  sub-path deployment.
* `tests/pwa.test.ts`: precache list and version generation, the worker's routing and cache naming.
* **Not verifiable here:** the actual browser install dialogs, Add to Dock, OS file association and the native
  share sheet need a real desktop/phone; the manifest declares them, the steps above follow the browsers'
  documented behaviour.

## 2. Electron wrapper (`desktop/`)

A separate package (own `package.json`, own `node_modules`; excluded from the root lint, format and type checks)
that wraps the production build in a native window. `desktop/main.cjs` serves `dist/` from a privileged `app://`
origin (so module workers, WebAssembly, WebGL and IndexedDB behave as on https) and opens external links in the
system browser. The window shows the normal PhysicsLab UI; scene export still downloads through the OS save
dialog and import uses the normal file picker.

```bash
npm ci && npm run build              # repository root: produces dist/
cd desktop
npm install                          # Electron + @electron/packager (downloads the Electron binary)
npm start                            # open the app in a window
npm run smoke                        # headless check: boot, simulate 0.5 s, print "SMOKE OK {...}", exit 0 / 1
npm run pack                         # desktop/out/PhysicsLab-<platform>-<arch>/ for the current OS
npm run pack -- --platform=win32 --arch=x64   # other targets (downloads that Electron; best run on that OS)
```

On a headless Linux machine run it under a virtual display with software GL:

```bash
xvfb-run -a ./node_modules/.bin/electron . --smoke --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
```

(`--no-sandbox` is only needed when running as root, as in containers.) The packaged output is a plain folder; wrap
it into an installer with your platform's tool (electron-builder, WiX, `.dmg`, AppImage …); that and code signing /
notarisation are intentionally not part of this repo.

### What is verified (Linux x64, Electron 33.4.11)

* `npm install` in `desktop/` works; `npm run smoke` boots the app from `dist/`, loads the default scene
  (31 bodies) and the simulation advances (`SMOKE OK`).
* `npm run pack` produces `desktop/out/PhysicsLab-linux-x64` (268 MB unpacked, of which the web app is 5 MB) and the
  **packaged binary** passes the same smoke test.
* **Not verified:** Windows and macOS packages (cannot be built or run in this environment), installers, code
  signing and auto-update. Tauri was not chosen because the Rust/WebKitGTK toolchain it needs is not set up here and
  could not have been verified; Electron bundles its own Chromium, so the app behaves exactly as in Chrome.
