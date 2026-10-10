# Scene scripts and the sandbox (DT-32, shared by DT-31)

**File → Scene script…** (or the command palette) opens a JavaScript editor. The script describes a scene with the
Builder DSL; **Run — replace scene** builds it in place of the current scene, **Run — add to scene** adds it. Either is
**one undo step**. `Ctrl+Enter` runs; the *Examples…* menu loads six scripts (domino spiral, pendulum chain, brick wall,
Newton's cradle, seeded rain of shapes, Moon gravity jelly).

```js
name('Tower');
settings({ gravity: [0, -3.7, 0] });
array(6, (i) => body('Block ' + i, 'box', [1, 0.5, 1], [0, 0.25 + i * 0.5, 0], { material: 'wood' }));
const arm = body('Arm', 'box', [3, 0.1, 0.1], [0, 4, 0]);
joint('hinge', null, arm, [0, 4, 0], [0, 0, 1]);
```

| DSL | |
|---|---|
| `body(name, shape, size, position, opts?)` | rigid body; `opts` are body fields (`material`, `bodyType`, `rotation`, `linearVelocity` …); returns a handle |
| `soft(name, type, position, opts?)` | soft body (`jelly`, `balloon`, `cloth`, `cable`) |
| `joint(type, a, b, point, axis?, opts?)` | joint at a world point; `a`/`b` are handles or `null` (the world) |
| `tether('spring' \| 'rope', a, pointA, b, pointB, opts?)` | spring / rope between two points |
| `array(n, fn)` · `grid(nx, ny, dx, dy, fn)` · `ring(n, r, fn)` · `range(a, b, step)` | generators |
| `rotX/rotY/rotZ(deg)` | quaternions for `rotation` |
| `random()` / `seed(n)` / `Math.random` | **deterministic** random numbers: the same script always builds the same scene |
| `name(text)` · `settings(patch)` · `console.log` | scene name, scene settings, output shown under the editor |

**What a script can do.** It *records* DSL calls. The recording goes back to the page, which replays it on the real
`Builder` and passes the result through `sanitizeDocument` (the gate every scene file passes). So a script can never
create anything a hand-written scene file could not: unknown shapes are rejected or repaired, numbers are clamped, the
object limit applies. Limits: 3 s run time (then the sandbox is killed), 20 000 DSL calls, 100 000 characters of code.
Errors show with the line of your code.

## The sandbox (also used by plugins, see [PLUGINS.md](PLUGINS.md))

Untrusted code runs in four nested layers (`src/sandbox/`):

1. an `<iframe sandbox="allow-scripts">` — opaque origin: no access to the page's DOM, cookies, storage or IndexedDB,
   cannot navigate or open windows;
2. a `Content-Security-Policy` of `default-src 'none'` in that document — no `fetch`, XHR, WebSocket, beacon, image,
   frame or dynamic `import()` of anything but its own `blob:` worker (which inherits the policy);
3. a dedicated Worker whose global scope has all network, storage, messaging and nested-worker APIs **removed**
   (`workerRuntime.mjs`), so a runaway loop only burns that thread and `dispose()` kills it;
4. a `MessagePort` as the only way out, answered from an explicit allow-list of host handlers, with a call budget.

`e2e/tests/sandbox.mjs` proves it: hostile code tries `fetch`, XHR, WebSocket, EventSource, `importScripts`, dynamic
`import()` (http and data:), workers, `sendBeacon`, IndexedDB, Cache, localStorage, BroadcastChannel, WebAssembly,
`postMessage`, the page DOM and prototype-chain tricks while a **canary HTTP server counts requests (must be zero —
and a positive control shows the canary does see requests from the page itself)**; the container iframe is also attacked
directly with the worker lockdown out of the picture (CSP and opaque origin alone must hold).

Known limits, stated honestly: a script can use CPU for its time budget and allocate memory until the browser kills the
worker (the page survives); there is no way to stop `while(true){}` other than killing the worker, which is what the
timeout does. Chromium is the verified browser.
