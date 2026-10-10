# 17 · Data, export, persistence, sharing, API, PWA (package DT)

Depends on: foundation (asset store, migrations), time (replays), visuals (thumbnails), maps/gallery (local gallery UI is MP-50 — DT provides the storage layer).

Honest scope: there is no backend. "Cloud saves/accounts" are provided as **folder sync via the File System Access API** (works with Dropbox/Google Drive/iCloud/OneDrive desktop folders) plus export/import; "multiplayer/collab" is **peer-to-peer WebRTC with copy/paste signalling and BroadcastChannel for same-device tabs**. Document this clearly.

## Export
- [ ] DT-1 — Export glTF/GLB (scene with materials, hierarchy, optional simulated animation baked from a recording), OBJ (+MTL), STL (binary, selection or all), scene JSON (existing), PNG screenshot at chosen resolution (up to 4k, transparent option), offscreen thumbnails; tests for exporters (re-import via importers from SH round-trips)
- [x] DT-2 — Video & GIF: record the viewport to WebM/MP4 (MediaRecorder with codec detection) and animated GIF (own or small dependency encoder, with size/fps limits), fixed-timestep deterministic capture mode (simulate frame-by-frame for smooth output), turntable recorder (orbit 360° of the scene or selection) (tests/captureGif.test.ts › LZW round trips through a reference decoder, GIF89a header/dimensions/delays/trailer; tests/captureScheduler.test.ts › exact frame times, cumulative step plan, limits, turntable path; e2e/tests/data-capture.mjs › 1 s deterministic GIF through `capture.gif` has GIF89a + 10 frames + 100 cs and two captures give identical frame hashes and byte-identical files, Esc cancel, record.stop, turntable GIF, WebM via MediaRecorder; src/app/capture/*, src/ui/captureDialog.ts, src/ui/extensions/capture.ts — video is real-time, see LIMITATIONS)
- [ ] DT-3 — CSV/JSON/clipboard export hooks used by telemetry/analysis; "export report" (HTML page with scene screenshot, parameters, charts) for lab reports

## Persistence
- [ ] DT-10 — IndexedDB storage layer (scenes, assets, thumbnails, prefabs, replays, settings snapshots) replacing localStorage with automatic migration of existing data, quota usage meter and cleanup UI, graceful fallback to memory with a warning
- [ ] DT-11 — Restore points: automatic timed snapshots + before-risky-operation snapshots, labelled, browsable with thumbnails and diff summary, restore/delete; limits configurable
- [ ] DT-12 — Crash recovery: detect unclean shutdown (heartbeat), on next start offer to recover the last autosave/restore point; worker crash handling (auto-restart sim worker with the document, friendly banner)
- [ ] DT-13 — Folder sync (File System Access API): choose a folder, scenes auto-saved/loaded as `.physicslab.json` files, watch for external changes with conflict prompt; feature-detected with a clear fallback message elsewhere

## Sharing
- [x] DT-20 — Shorter share links: compact binary encoding (field dictionary, quantised floats, delta-coded repeats, assets deduped) + deflate + base64url; show size; measured ≥ 40 % shorter than the v1 link on the bundled scenes; very large scenes fall back to "download file" with explanation (tests/shareLink.test.ts › every bundled template and map ≥ 40 % shorter, 45–83 %, round-trips; e2e/tests/data.mjs › DT-20; src/app/share/*; numbers keep 6 significant digits, entity ids are renamed e0… on load — see LIMITATIONS)
- [ ] DT-21 — Link previews: share dialog creates a thumbnail PNG and "copy as image + link", Open Graph-compatible metadata template documented for hosts that can render it; QR code for the link
- [ ] DT-22 — Embed/viewer mode: `?embed=1&scene=…` or `#s=…` minimal chrome (play/pause/reset, camera), autoplay option, locked editing; an "Embed" dialog generates the iframe snippet with options; cross-origin message API (`postMessage`) to control playback; tested in e2e
- [ ] DT-23 — Peer-to-peer collaboration: WebRTC data-channel session with copy/paste (or QR) signalling and BroadcastChannel for same-device tabs; live sync of document ops (CRDT-lite op log with conflict resolution by timestamps/ids), shared selection cursors, host-authoritative simulation; e2e test with two pages in the same browser context

## API, plugins, automation
- [ ] DT-30 — Public API: stable, versioned, typed `window.physicslab` surface (scene CRUD, simulation control, queries, events, camera, tools, export, assets) documented in `docs/API.md` (generated from TS where practical) with runnable examples; semver for the API
- [ ] DT-31 — Plugin system: load a plugin from URL/file/pasted code into a sandbox (iframe sandbox or worker) with a capability-limited API to register commands, panels (declarative UI), components, shapes, templates; plugin manager UI (enable/disable/remove), permission prompt, error isolation; two example plugins shipped and tested
- [ ] DT-32 — Scripted scenes: a "Scene script" dialog where users write JS against the Builder DSL (`body(), joint(), soft(), array(), …`) to generate/regenerate scenes, run in a sandboxed worker with limits; examples gallery; results undoable as one command
- [x] DT-33 — Headless batch mode: Node CLI (`npm run cli -- run scene.json --steps N --out result.csv --sweep gravity=…`) built on `PhysicsWorld` with parameter sweeps, deterministic seeds, CSV/JSON output, exit codes; documented; tested (tests/cli.test.ts › sweeps vs ½gt², determinism, exit codes, real launcher run; src/cli/batch.ts, src/cli/main.ts, scripts/cli.mjs; docs/CLI.md)

## Platform
- [ ] DT-40 — PWA: web manifest, icons (maskable), service worker with versioned precache + runtime cache, offline start verified in e2e (go offline, reload, app works), update-available prompt, install button, share-target (open `.physicslab.json` files)
- [ ] DT-41 — Desktop packaging: documented install-as-app via PWA on desktop OSes plus an optional, tested-to-build Tauri or Electron wrapper config in `desktop/` that wraps `dist/` (clearly separate, not required to run the app); build instructions verified to the extent possible in this environment, otherwise marked `[~]` with what was verified
- [ ] DT-42 — Smaller download: Rapier wasm served as a separate cached asset (not base64 in the worker), code-splitting of heavy features (exporters, importers, CSG, GIF encoder, circuit editor, plugin host, education content, locales) loaded on demand, bundle-size budget enforced in CI (`scripts/check-size.mjs`), measured before/after in `docs/PERFORMANCE.md`; first load < 1.2 MB gzip target (excluding lazily loaded features) or the actual number documented honestly

## Implementation notes — DT-2

Commands (File menu, command palette): `record.start` (video), `record.stop`, `capture.gif`, `capture.turntable`; each opens the Record dialog (format WebM/MP4/GIF, width, fps, duration, deterministic, restart, turntable, orbit target, freeze simulation). A red-dot indicator with progress, Stop and Cancel is shown while capturing; Esc cancels without saving. All capture code (dialog, session, GIF encoder) is behind dynamic `import()` from the command handlers.

* `src/app/capture/gif.ts`: own GIF89a encoder (median-cut on a 5-5-5 histogram, per-frame local palettes, variable-width LZW with an open-addressing dictionary). Encoded frame by frame with a yield between frames (no worker).
* `src/app/capture/scheduler.ts`: options, per-format limits with clear messages, `planFrames` (cumulative step rounding), `gifDelays`, frame hashing. `turntable.ts`: camera path. `download.ts`: shared save helper; `window.__downloadHook` stores the file in `window.__lastDownload` for tests (the exporter session has a similar helper; unify on merge).
* `src/app/capture/session.ts`: deterministic mode holds the simulation paused, calls `SimController.step(n)` per planned frame, waits until the worker reports the step count, and copies the canvas inside the viewport's new `afterRender` hook (the only shared-file edit besides one CSS import in main.ts, both marked `-- DT-2 --`). Real-time mode samples renders by wall clock.
* Honest gaps (docs/LIMITATIONS.md): video timing is wall-clock (MediaRecorder); deterministic covers physics and camera, not wall-clock effects; GIF is 256 colours/frame without dithering. Not verified: MP4 recording (the headless Chromium reports support, but only WebM was recorded in e2e); the e2e machine was heavily loaded, so a 10-frame deterministic GIF took ~45 s there.
* `npm run format:check` reports `src/ui/icons.ts`, which is not part of this change.
