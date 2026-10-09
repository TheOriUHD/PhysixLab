# PhysicsLab — architecture & design decisions

## Goals that shaped the design

1. **Genuine physics**: simulation results must come from a real solver with meaningful units (kg, m, s, N), not scripted behaviour.
2. **Responsiveness**: the UI and rendering must stay at display rate even when the simulation is heavy.
3. **Never lose work**: every edit undoable, reset always returns to the authored layout, scenes autosaved.
4. **Clear seams** between *what the user built* (document), *how it behaves* (simulation) and *how it looks* (rendering/UI), so each can grow independently.

## Layers

```
┌───────────────────────────── main thread ─────────────────────────────┐
│ ui/*  ──►  app/App  ──►  app/Editor ──►  model/SceneStore (document)  │
│                │ ▲                              │ change events        │
│                ▼ │                              ▼                      │
│        render/* (three.js)   ◄── poses ──  app/SimController           │
│                                                 │ ▲                    │
└─────────────────────────────────────────────────┼─┼────────────────────┘
                                         ops/ticks│ │frames (Float32Array, transferred)
┌─────────────────────────────────────────────────▼─┼────────────────────┐
│ physics/sim.worker.ts ──► physics/PhysicsWorld ──► Rapier (WebAssembly)│
└───────────────────────────── worker thread ───────────────────────────┘
```

### `model/` — the document (single source of truth)

Plain JSON: `SceneDocument { settings, entities[] }` where an entity is a **body** (shape, pose, material, damping, locks, thrust, flags) or a **joint** (type, two bodies, anchors, axis, limits, motor, spring). Nothing in the document refers to the engine or the renderer.

* `SceneStore` keeps entities in a `Map` and treats every entity object as **immutable** — an edit replaces the object. A history snapshot is therefore just a shallow copy of the map (structural sharing), so 200 undo levels of a thousand-body scene cost almost nothing. Edits can be grouped (`begin`/`end`) so a gizmo drag or slider scrub is one undo step. Undo/redo diff the maps and emit precise `add / remove / update` events, so the renderer and the live simulation update incrementally.
* `serialize.ts` validates and upgrades anything loaded (files, autosave, share links): unknown fields dropped, missing fields defaulted, bad numbers clamped, joints referring to missing bodies removed.
* `templates.ts` (13 example scenes) and `prefabs.ts` (12 assemblies) are written with a small `Builder` DSL against the same public primitives users have — they are not special-cased anywhere.

### `physics/` — the simulation

* **`PhysicsWorld`** (pure TypeScript around Rapier) builds a Rapier world from a document, applies live edits, advances time and reports state. It has no DOM/worker dependency, so it runs identically in the worker and in the Node unit tests — which is how the physics is verified against analytic results.
* **Worker**: the world lives in a Web Worker. The main thread sends `tick` messages (wall-clock dt, time scale, pressed keys, run flag) and receives a frame: a `Float32Array` of poses/velocities/net forces/energy per body, a joint-state array (angle, speed, spring force, broken flag), optional contact points and statistics. Buffers are *transferred*, not copied. At most one tick is in flight; elapsed time accumulates meanwhile, so a slow simulation falls behind real time (the status bar shows the speed percentage) instead of stalling the UI.
* **Time stepping**: fixed step (60/120/240/480 Hz, default 120) with an accumulator; the last step's pose is interpolated so rendering is smooth at any display rate and slow motion (0.1×) stays smooth. A per-tick time budget bounds worst-case work.
* **Materials**: mass = density × volume (Rapier integrates mass properties of the real shape, including convex hulls). Pair friction uses the **average** of the two surface coefficients; pair restitution uses the **maximum** — so a "rubber ball with e = 0.85" bounces to ≈ e² of its drop height on any floor, which matches how restitution is usually quoted.
* **Joints** are Rapier impulse joints with explicit local *frames* so bodies may have any orientation when joined: for a hinge/slider the joint X-axis is rotated onto the requested world axis in each body's local frame, which makes the zero angle/position the pose at simulation start and keeps limits and motors intuitive. A rigid joint's anchor on body B is *derived* from A's anchor at build time, so a joint never starts violated; springs/ropes keep two independent anchors.
* **Motors** are Rapier's force-based joint motors: *velocity* mode drives toward a target speed with a gain (and a force cap), *position* mode is a spring-damper toward a target. They are updated every step from the current key state (`KeyboardEvent.code`), with a slew limiter for keyed position targets (steering returns to centre when released). A suspension is just a slider with a position motor.
* **Springs** use Rapier's spring joint (force-based: `F = k·x + c·v`, verified against `T = 2π√(m/k)`), plus per-step force measurement so a **break force** can snap them. Rapier does not expose rigid-joint constraint impulses, so only springs are breakable for now (stiff springs make breakable struts) — see `LIMITATIONS.md`.
* **Grabbing** applies a critically-damped spring force at the grab point (with gravity compensation and an acceleration cap) — a mouse-driven force, not teleportation, so a grabbed body still collides and drags attached mechanisms.
* **Energy accounting** is computed from engine state each frame: ½mv², rotational ½Σ Iᵢωᵢ² in the principal frame, gravitational −m g·r about the centre of mass, and ½kx² for springs.

### `render/` — three.js

* `Viewport` — renderer, orbit navigation (right-drag orbit, middle pan, zoom-to-cursor), sun with a snapped shadow frustum that follows the camera, image-based lighting from a procedural PMREM environment, shader grid, gradient sky, MSAA + outline pass, optional GTAO, a view-axis helper. Quality presets trade shadows/AO/pixel ratio for speed.
* `BodyViews` — one mesh per body; geometries are shared unit shapes scaled by the body size (capsules/hulls cached by shape key). **Colour modes** (material, body type, speed, kinetic energy, net force, sleep state) turn the simulation into a heat map.
* `JointViews` — gizmos drawn on top of geometry: hinge rings + axis, slider rails with limit stops and a live carriage, ball spheres, weld cubes, spring coils (colour = tension/compression) and sagging ropes.
* `Overlays` — fat-line velocity / net-force arrows, contact points + normals coloured by force, centres of mass, additive motion trails.
* `Gizmo` — wraps three's `TransformControls` with a pivot object so any number of bodies can be moved/rotated together, a single body resized, or a joint anchor/axis edited.

### `app/` — orchestration

* `SimController` owns the **edit / running / paused** state machine. *Edit* has no simulated world (the viewport shows the document); *Simulate* builds a worker world from the document; *Reset* discards it. While a world exists, document changes are mirrored into it as ops: structural and property edits (add, delete, material, motor, gravity…) apply to **both** the document and the live world; *pose* edits made while simulating (dragging a paused body, typing a position) apply to the live world only, so Reset still returns to what was built. "Use current simulation state as the starting layout" in the Edit menu promotes the live poses into the document.
* Simulation-only bodies (projectiles) live in an `ephemeral` map: they exist in the live world and renderer but never in the document.
* `Editor` holds the verbs (add shape, add joint with smart defaults — a cylinder's own axis for wheel hinges, otherwise the horizontal axis facing the camera — duplicate with internal joints, paste, delete, capture state).
* `input.ts` — pointer/keyboard state machine: select/marquee, drag-move on the ground plane (Shift = vertical), grab in a running sim, joint/measure/blast/shoot tools, shortcuts, and forwarding of key state to motors/thrusters.
* `persistence.ts` — debounced autosave, named library (localStorage), JSON import/export, deflate-compressed share links in the URL hash.

### `ui/`

Vanilla TypeScript with a tiny `h()` hyperscript helper — no framework to keep the bundle small and the render loop uncontested. The inspector rebuilds its DOM only when the *kind* of selection changes and otherwise refreshes values in place, so typing and scrubbing never lose focus; live readouts refresh at ~11 Hz from the frame buffer. Number fields scrub by dragging their axis label.

## Why these choices

| Decision | Reason |
|---|---|
| Rapier (WASM) | Proven, fast, deterministic solver with joints, motors, springs, CCD and sleeping; the WASM build runs in a worker without extra headers. |
| Physics in a worker | Heavy scenes cannot drop frames of UI/rendering; the protocol (poses out, ops in) also keeps the engine swappable. |
| Document as source of truth | Undo, persistence, sharing and "Reset" all fall out of it; the engine is a *derived* view. |
| Immutable entities | Cheap history, trivially correct change detection for incremental renderer/worker sync. |
| three.js without a scene framework | Full control of the render loop, overlays and picking; a small surface to maintain. |
| No UI framework | The DOM is small and mostly static; a framework would add weight and a second reactivity model next to the document store. |

## Extending

* **New shape**: add to `ShapeType`, `defaultSize/normalizeSize/volume/hullPoints` in `model/shapes.ts`, a collider branch in `PhysicsWorld.makeCollider`, a geometry branch in `bodyViews.ts`, an icon.
* **New joint type**: add to `JointType`, build it in `PhysicsWorld.addJoint`, draw it in `jointViews.ts`, add inspector sections.
* **New analysis**: put the quantity in the frame buffer (`protocol.ts`), plot it in `ui/telemetry.ts` or colour by it in `bodyViews.ts`.
* **Different engine / GPU compute**: replace `PhysicsWorld` behind the same ops/frame protocol (`physics/protocol.ts`); nothing else knows Rapier exists.
