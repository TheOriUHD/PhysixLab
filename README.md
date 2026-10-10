# PhysicsLab

An advanced 3D physics sandbox that runs entirely in your browser. Build mechanisms, vehicles, structures and experiments out of rigid bodies, joints, motors and springs — then press **Simulate** and watch them obey real rigid-body physics. Grab things while they move, change gravity mid-run, plot energy, drive a car.

**What makes it different from a "falling cubes" demo**

* **A real physics engine.** [Rapier](https://rapier.rs) (Rust → WebAssembly) running in a dedicated Web Worker, with a fixed timestep, render interpolation, continuous collision detection and sleeping. Mass comes from *density × volume* with real-world material densities.
* **A construction workflow, not a toy.** Eight primitive shapes (box, sphere, cylinder, capsule, cone, ramp, N-gon prism, icosahedron), move / rotate / scale gizmos with grid and angle snapping, multi-select, duplicate, copy/paste, lock/hide, drag-and-drop placement, full undo/redo.
* **Real mechanisms.** Six joint types — weld, hinge, slider, ball, spring-damper, rope — with limits, **motors** (velocity or position mode, force-capped, bindable to keyboard keys) and **springs with break force**. The bundled car is built from nothing but these: independent spring-damper suspension (slider + position motor), steered front wheels (hinge + keyed position motor), rear-wheel drive (keyed velocity motors).
* **Soft bodies.** Jelly lattices, balloons, cloth (pin an edge, two corners or four corners) and cables, from the engine's particle/constraint soft-body solver — deformable, drag-able with the mouse, and **tearable**: give a cloth a tear strain and a wrecking ball rips it, the torn pieces simulate on independently.
* **A lab, not just a viewport.** Live energy chart (kinetic, rotational, gravitational, spring, total), per-object plots (speed, height, joint angle, spring force…), velocity / net-force / contact / centre-of-mass overlays, motion trails, a ruler, colour-by-speed / energy / force / sleep state, adjustable time scale (0.1×–4×), single-stepping, adjustable gravity (Moon, Mars, Jupiter, zero-g, any vector), air drag, solver quality.
<!-- FX: effects -->
* **Effects that follow the physics.** Pooled, GPU-instanced particles with procedurally generated soft sprites: sparks, dust, wood chips, glass shards and rubber scuffs from real contact impulses (material-dependent, scaled by the impact energy), tyre smoke and persistent skid marks from wheels whose slip is estimated from the contact-point velocity, fireball / shock-ring / smoke / light-flash explosions for the Blast tool and hard projectile hits, debris chips with an optional capped, auto-cleaned physical-debris mode. Quality tiers, a master switch and per-effect switches live in the *Effects* panel; the effects are deterministic for the scene seed and freeze with the simulation.
<!-- FX: sound -->
* **Sound that follows the physics, with no sample files.** Everything is synthesised with WebAudio: collisions ring in the material's own voice (metal clangs with inharmonic partials, wood knocks, glass chimes and shatters, stone clacks, rubber thuds), scaled by the real impact energy, lower for bigger bodies; rolling bodies rumble and sliding ones scrape by speed and load; motorised joints and engines whine, rev and strain with their rpm and load; wind rushes past a camera following a fast body; explosions, shots, spawns, snapping joints and trampolines have their own sounds. Positioned relative to the camera, voice-limited, pitched down in slow motion, with master and per-category volumes and a mute (`Shift+M`, or the speaker in the top bar). Sound starts with your first click (browsers require it) and is off the moment you switch it off.
* **Zones and races.** Any body can be a trigger volume: drag a checkpoint, start / finish line, launch pad, teleporter, kill zone, gravity bubble, force field, spawner, coin or sound zone from the **Add** tab. Zones time laps with split times and a best lap (a whole vehicle counts as one racer), respawn or remove what falls out of the **world bounds** (kill planes, soft spring walls, a respawn policy with time penalties), and raise events for logic and scripts — try the *Drag strip* and *Zones playground* scenes.
* **Safe to experiment.** Every edit is undoable. *Reset* always returns to the layout you built. Your scene is autosaved; scenes can be saved to a library, exported/imported as JSON, or shared as a link (the whole scene is compressed into the URL — no server involved).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

### Hosting

It is a fully static site (no server): `npm run build` produces `dist/`, which any static host can serve.

* **Netlify / Cloudflare Pages / Vercel** work with private repos on free plans: import the repo (build command `npm run build`, output directory `dist` — `netlify.toml` already says so), or drag the built `dist/` folder onto [Netlify Drop](https://app.netlify.com/drop).
* **GitHub Pages**: `.github/workflows/pages.yml` is a manual workflow for when Pages is available (public repo or paid plan; set *Settings → Pages → Source* to *GitHub Actions*, then run it from the Actions tab).

Requires a modern desktop browser with WebGL 2 and WebAssembly (Chrome, Edge, Firefox, Safari).

## Using it

| | |
|---|---|
| **Add** | drag a tile (shape, soft body, prefab, zone or light) into the scene: a translucent **ghost** shows where it will land, and the object is created when you let go (`Esc`, a right click or letting go over a panel cancels). On a trackpad: click a tile (or press `1`–`9`), move over the scene and click to place; `Shift`+click places several. While placing: `Q` / `E` (or `R`) turn it 15° (`Shift` = 1°), `[` `]` lower / raise it, `X` aligns it to the surface, hold `Alt` for no snapping. Double-click a tile to add it at the centre of the view. On touch, long-press a tile and drag |
| **Move** | drag a body on the ground plane (hold `Shift` to lift), or use the gizmo (`W` move · `E` rotate · `R` scale · `Q` select-only) |
| **Connect** | pick a joint (or press `J`), click body A, then body B (or empty ground to pin to the world). Select the joint to add limits, a motor or spring settings |
| **Simulate** | `Space` start/pause · `.` step · `Shift+Space` stop & return to the editable layout |
| **Interact** | while running, drag a body to throw it · `B` blast · `T` fire projectiles |
| **Measure** | `M`, click two points |
| **Sound** | `Shift+M` mute / unmute (the speaker in the top bar) · volumes and test sounds in the *Effects* panel |
| **Camera, mouse** | right-drag orbit · middle-drag pan · wheel zoom towards the cursor · `Alt`-drag orbit · `Space`-drag pan · double-click an object to focus it, empty space to frame all |
| **Camera, trackpad** | two-finger swipe orbit · `Shift` / `Cmd` + swipe pan · pinch zoom towards the cursor · `Option` + swipe zoom · `Option`-drag orbit · `Space`-drag pan (Settings › Navigation: swipe = pan, speeds, inversions; the device is detected, or choose it) |
| **Camera, touch** | one finger on empty space orbits · two fingers pan, pinch zooms, twisting turns · double-tap focuses |
| **Camera, keyboard** | `←` `↑` `↓` `→` orbit (with a selection: `Alt` / `Option` + arrows) · `Shift` + arrows pan · `+` `−` zoom · `F` frame selection · `Home` frame all · `Alt` / `Option` + `1 3 7 9` front / side / top / iso (or the numpad) · `C` follow selection |
| **Hold a body** (while running) | drag to hold · `W` `S` / `↑` `↓` / `[` `]` push / pull (or scroll; touch: pinch) · `A` `D` / `Q` `E` turn in 15° steps (`Shift` 5°) · `F` freeze · `R` + drag turn freely |
| **Drive** | `V` drives the selected vehicle (or the only one): a chase camera, only the vehicle's keys, no editor. `C` chase / cockpit / orbit · `B` look behind · drag to look · `R` reset or flip upright · `P` pause · `Esc` / `Tab` leave |
| **Play mode** | `Shift+V` (or the eye button next to Drive): run the scene and fly through it with `W A S D Q E`, grab and throw things, `Esc` / `Tab` leave |
| **Which keys work now** | the pill at the bottom-left of the viewport names the input context (Edit · Simulating · Holding · Fly camera · Placing · Drive · Play); open it for the legend: what each key does *right now*, and which ones are paused and why |
| **Undo** | `Ctrl+Z` / `Ctrl+Shift+Z` |
| **Search** | `Ctrl+K` (`⌘K`) opens the command palette: every command, setting, example scene, saved scene, prefab and map in one fuzzy search box |

Press the keyboard icon in the top bar for the full list. The **Scenes** tab has 16 worked examples (drivable car, wrecking ball, lever launcher, piston press, double pendulum, Newton's cradle, springs & dampers, friction lab, zero-g billiards, domino run, Jenga, rope bridge, 300-ball pit, jelly playground, cloth drape & hammock, tearing banner) **Prefabs** has 12 insertable assemblies, and **Maps** has two walled arenas (an empty one and a sandbox with a heap of blocks).

### Driving the car

Load *Drivable car*, press **Simulate**, then **W / S** for throttle / reverse and **A / D** to steer. Select any joint to see how it is wired — e.g. the rear *axle* hinges are velocity-mode motors bound to W/S; the *steering* hinges are position-mode motors bound to A/D; the *suspension* sliders are position-mode motors acting as spring-dampers.

### Motor key bindings

Any hinge or slider motor can be bound to keys: select the joint → *Motor* → choose a mode → click a *Key* button and press a key. In **velocity** mode the key drives the joint at the target speed; in **position** mode the target slews toward the deflection while the key is held and returns to centre when released (steering, servos). Bodies can also carry a constant **thrust** (force + torque in local space) that is always on or active while a key is held.

## Architecture in one page

```
 UI panels (vanilla TS)  ──►  App  ──►  Editor commands ──►  SceneStore (immutable doc + undo)
                               │                                   │
                               │ events                            ▼
                         Viewport (three.js) ◄── poses ──  SimController ◄──► Physics Worker (Rapier WASM)
```

* `src/model` — the scene **document**: plain JSON entities (bodies, joints, soft bodies, groups, lights, paths), materials, the shape and component registries, the content library (`model/content`: example scenes, prefabs, maps), an immutable store with structural-sharing undo history, validation / migration on load.
* `src/physics` — `PhysicsWorld` (pure TS around Rapier; runs identically in the worker and in Node tests), the worker entry, the message protocol and the main-thread `SimClient`.
* `src/render` — three.js viewport (PBR + shadows + environment, optional GTAO, outline pass), body / joint views, diagnostic overlays, gizmo wrapper, picking. `render/fx` is the particle / impact / skid-mark / explosion system (`app.fx.emit(type, position, options)`).
* `src/audio` — the sound system: procedural synthesis, material / impact / event sounds, the WebAudio engine (`app.audio.playEvent(id, position)`); `src/app/audio` connects it to the simulation.
* `src/app` — `App` (wiring), `SimController` (edit / running / paused state machine and live-edit sync), `Editor` (commands), input handling, persistence, and `registry/`: the command, tool, panel, inspector-section and menu registries everything in the UI is generated from.
* `src/ui` — panels, inspector, outliner, telemetry charts, menus, dialogs, the command palette (`ui/palette`).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for design decisions (why a worker, why the document is the source of truth, how live edits work, how joints are framed, the physics model), [`docs/EXTENDING.md`](docs/EXTENDING.md) for how to add a shape, component, command, tool, panel, template, prefab, map or joint type (every example in it is compiled and tested), and [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) for what is deliberately *not* done yet.

## Tests

```bash
npm test            # 570+ unit/physics tests (Vitest, runs the real Rapier engine in Node)
npm run test:e2e    # drives the real UI in headless Chromium (starts its own dev server)
E2E_SHOTS=1 npm run test:e2e   # …and writes screenshots to e2e/out/
E2E_PORT=5231 E2E_FILTER=joint npm run test:e2e   # another port (default 5199), only matching tests
```

The physics tests check the engine against analytic results: free fall, momentum conservation, restitution, friction-angle thresholds, pendulum and spring-mass periods, motor torque and speed, joint limits, spring breaking, energy conservation (double pendulum to 0.2 % over 4 s), determinism, and live add / edit / remove of bodies. Every example scene has a behavioural test (the car drives, steers and reverses; the cradle transfers momentum; the tower stands until it is hit; the banner tears; cloth drapes over a sphere without penetrating it; …).
