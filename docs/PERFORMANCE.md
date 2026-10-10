# Performance

## Download size (DT-42)

Measured with `npm run build && npm run size` (gzip level 9, KiB). The budgets live in `scripts/size-budget.json` and are
enforced in CI; they were set from the first measurement plus a generous margin because many packages add code at the same
time — tighten them when the program settles.

| Part | Before DT-42 (foundation tip) | Now |
|---|---|---|
| Physics worker script | 4 402 KiB raw (the 3 MB wasm inlined as base64; ≈ 1 565 KiB gzip for the base64 alone) | ≈ 500 KiB raw / 129 KiB gzip |
| Rapier wasm | inside the worker script, decoded at start | separate hashed asset, 3 010 KiB raw / **1 148 KiB gzip**, browser-cached and precached by the service worker |
| Cold-start download (gzip) | ≈ 390 (main) + ≈ 1 700 (worker) ≈ **2 100 KiB** | main ≈ 590 + 30, worker 129, wasm 1 148, css 14 ≈ **1 910 KiB** *including* everything other packages added since |
| Repeat visits | worker re-parsed from base64 every start | wasm served from cache, compiled by the engine directly (`instantiateStreaming`) |

**Target of the checklist (first load < 1.2 MB gzip excluding lazy features): not met, stated honestly.** The Rapier
binary alone is 1.15 MB gzip and cannot shrink without a different engine build; the JavaScript part (main + worker +
css ≈ 760 KiB) is well under the target. Everything that is not needed to start is split off with `lazy()`
(`docs/EXTENDING.md`): the scene-script dialog and sandbox, the plugin manager and host, the PWA / collaboration / FX
extensions are separate chunks fetched on first use (`scripts/check-size.mjs` lists them as *lazy*). The heavy features
named in DT-42 that other packages own (exporters, importers, CSG, GIF encoder, circuit editor, education content,
locales) must adopt `lazy()` when they land; the budget script fails the build if the first-load JavaScript grows past
its limit, which is the pressure to do so.

## The start-up splash

`index.html` paints a splash with a progress bar before any script has arrived, and every number on that bar is real:

* **Download (78 % of the bar, production builds).** `scripts/vite/bootSplash.ts` records the decoded size of everything the first paint needs — the entry chunk, the chunks it imports, the physics worker and the Rapier wasm. The inline loader streams those files, counts the bytes it receives against those sizes (so host compression does not matter), and only then adds the entry script. The files are by then in the HTTP cache, so nothing is downloaded twice.
* **Start-up (22 %).** The app reports milestones through `src/app/bootProgress.ts`: the code is running, the physics worker finished initialising, the interface is built, the first scene is loaded, and finally the first frame has been drawn — which is what removes the splash.
* The bar never moves backwards. In `vite dev` there is no download phase, so the bar follows the milestones only. If the app cannot start, the failure screens remove the splash so their explanation is visible, and the splash gives up on its own after two minutes rather than trapping anyone behind it.
