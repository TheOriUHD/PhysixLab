# PhysicsLab

An advanced 3D physics sandbox that runs entirely in your browser. Build mechanisms, vehicles, structures and experiments out of rigid bodies, joints, motors and springs — then press **Simulate** and watch them obey real rigid-body physics. Grab things while they move, change gravity mid-run, plot energy, drive a car.

**What makes it different from a "falling cubes" demo**

* **A real physics engine.** [Rapier](https://rapier.rs) (Rust → WebAssembly) running in a dedicated Web Worker, with a fixed timestep, render interpolation, continuous collision detection and sleeping. Mass comes from *density × volume* with real-world material densities.
* **A construction workflow, not a toy.** Eight primitive shapes (box, sphere, cylinder, capsule, cone, ramp, N-gon prism, icosahedron), move / rotate / scale gizmos with grid and angle snapping, multi-select, duplicate, copy/paste, lock/hide, drag-and-drop placement, full undo/redo.
* **Real mechanisms.** Six joint types — weld, hinge, slider, ball, spring-damper, rope — with limits, **motors** (velocity or position mode, force-capped, bindable to keyboard keys) and **springs with break force**. The bundled car is built from nothing but these: independent spring-damper suspension (slider + position motor), steered front wheels (hinge + keyed position motor), rear-wheel drive (keyed velocity motors).
* **Soft bodies.** Jelly lattices, balloons, cloth (pin an edge, two corners or four corners) and cables, from the engine's particle/constraint soft-body solver — deformable, drag-able with the mouse, and **tearable**: give a cloth a tear strain and a wrecking ball rips it, the torn pieces simulate on independently.
* **A lab, not just a viewport.** Live energy chart (kinetic, rotational, gravitational, spring, total), per-object plots (speed, height, joint angle, spring force…), velocity / net-force / contact / centre-of-mass overlays, motion trails, a ruler, colour-by-speed / energy / force / sleep state, adjustable time scale (0.1×–4×), single-stepping, adjustable gravity (Moon, Mars, Jupiter, zero-g, any vector), air drag, solver quality.
* **Safe to experiment.** Every edit is undoable. *Reset* always returns to the layout you built. Your scene is autosaved; scenes can be saved to a library, exported/imported as JSON, or shared as a link (the whole scene is compressed into the URL — no server involved).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

Requires a modern desktop browser with WebGL 2 and WebAssembly (Chrome, Edge, Firefox, Safari).

## Using it

| | |
|---|---|
| **Add** | click a shape tile (or press `1`–`8`), or drag it into the scene |
| **Move** | drag a body on the ground plane (hold `Shift` to lift), or use the gizmo (`W` move · `E` rotate · `R` scale · `Q` select-only) |
| **Connect** | pick a joint (or press `J`), click body A, then body B (or empty ground to pin to the world). Select the joint to add limits, a motor or spring settings |
| **Simulate** | `Space` start/pause · `.` step · `Shift+Space` stop & return to the editable layout |
| **Interact** | while running, drag a body to throw it · `B` blast · `T` fire projectiles |
| **Measure** | `M`, click two points |
| **Camera** | right-drag orbit · middle-drag pan · scroll zoom · `F` frame selection · `Home` frame all · `C` follow selection |
| **Undo** | `Ctrl+Z` / `Ctrl+Shift+Z` |

Press the keyboard icon in the top bar for the full list. The **Scenes** tab has 16 worked examples (drivable car, wrecking ball, lever launcher, piston press, double pendulum, Newton's cradle, springs & dampers, friction lab, zero-g billiards, domino run, Jenga, rope bridge, 300-ball pit, jelly playground, cloth drape & hammock, tearing banner) and **Prefabs** has 12 insertable assemblies.

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

* `src/model` — the scene **document**: plain JSON entities (bodies, joints), materials, shape maths, example scenes, prefabs, an immutable store with structural-sharing undo history, validation / migration on load.
* `src/physics` — `PhysicsWorld` (pure TS around Rapier; runs identically in the worker and in Node tests), the worker entry, the message protocol and the main-thread `SimClient`.
* `src/render` — three.js viewport (PBR + shadows + environment, optional GTAO, outline pass), body / joint views, diagnostic overlays, gizmo wrapper, picking.
* `src/app` — `App` (wiring), `SimController` (edit / running / paused state machine and live-edit sync), `Editor` (commands), input handling, persistence.
* `src/ui` — panels, inspector, outliner, telemetry charts, menus, dialogs.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for design decisions (why a worker, why the document is the source of truth, how live edits work, how joints are framed, the physics model), and [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) for what is deliberately *not* done yet.

## Tests

```bash
npm test            # 65+ unit/physics tests (Vitest, runs the real Rapier engine in Node)
npm run test:e2e    # drives the real UI in headless Chromium (starts its own dev server)
E2E_SHOTS=1 npm run test:e2e   # …and writes screenshots to e2e/out/
```

The physics tests check the engine against analytic results: free fall, momentum conservation, restitution, friction-angle thresholds, pendulum and spring-mass periods, motor torque and speed, joint limits, spring breaking, energy conservation (double pendulum to 0.2 % over 4 s), determinism, and live add / edit / remove of bodies. Every example scene has a behavioural test (the car drives, steers and reverses; the cradle transfers momentum; the tower stands until it is hit; the banner tears; cloth drapes over a sphere without penetrating it; …).
