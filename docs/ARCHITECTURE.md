# PhysicsLab — architecture & design decisions

How the code is organised, why, and where to look. For *adding* something (a shape, a command, a map …) read
`docs/EXTENDING.md`; for the engineering rules every contributor follows, `docs/DEV_RULES.md`; for what the engine
cannot do exactly, `docs/LIMITATIONS.md`.

## 1. Principles

1. **Genuine physics.** Results come from a real solver with real units (kg, m, s, N), not scripted behaviour. Every
   physics feature is verified against an analytic expectation in Node, with the same engine the browser runs.
2. **Responsive.** The UI and the renderer stay at display rate however heavy the simulation is: the simulation lives in
   a Web Worker and the page only exchanges transferable buffers with it.
3. **Never lose work.** Every edit is undoable, *Reset* always returns to the authored layout, scenes are autosaved, and
   every file / link / autosave is validated and upgraded on load.
4. **One source of truth, clear seams.** *What the user built* (the document), *how it behaves* (the simulation) and *how
   it looks* (renderer, UI) are separate; each can grow without touching the others.
5. **Extension by registration.** Everything that is a kind of thing — shapes, components, commands, tools, panels,
   inspector sections, menu entries, templates, prefabs, maps — is a registry entry, and the UI is *generated* from
   the registries. A feature package adds files and one registration call, and edits no shared switch statement.

## 2. Layers and data flow

```
┌────────────────────────────────── main thread ───────────────────────────────────┐
│  ui/*  ◄── generated from ──  app/registry (commands · tools · panels · menus …)   │
│   │                                  ▲                                             │
│   ▼                                  │ registrations: app/builtin, ui/builtin,     │
│  app/App  ──►  app/Editor  ──►  model/SceneStore (document)   ui/extensions        │
│   │ ▲                                    │ change events        model/content       │
│   ▼ │                                    ▼                      (templates,         │
│  render/* (three.js)  ◄── poses ──  app/SimController           prefabs, maps)     │
│                                          │ ▲                                       │
└──────────────────────────────────────────┼─┼───────────────────────────────────────┘
                                 ops / ticks │ │ frames (Float32Array, transferred) + events
┌──────────────────────────────────────────▼─┼───────────────────────────────────────┐
│  physics/sim.worker.ts ──► physics/PhysicsWorld ──► Rapier (WebAssembly)            │
│                    components · events · queries · snapshots · RNG                   │
└────────────────────────────────────── worker thread ─────────────────────────────┘
```

Nothing in `model/` refers to the engine, the renderer or the DOM; nothing outside `physics/world/` knows Rapier
exists. The document, the registries' data half (shapes, components, content) and the sanitising code run unchanged
in the page, in the worker and in the Node unit tests.

## 3. Source map

| Folder | What lives there |
|---|---|
| `src/core/` | tiny shared pieces: `Emitter` (typed events), `Registry<T>` (every registry is one), math, the seeded RNG |
| `src/model/` | the document: types, factory, `SceneStore`, serialisation + sanitising, migrations, limits, asset store, shape / component registries, `builder.ts` (the DSL the content is written in), `mapKit.ts` |
| `src/model/shapes/`, `components/`, `sanitize/`, `assets/` | one file per built-in shape / component definition; the per-kind sanitisers; the asset codec |
| `src/model/content/` | **content registries** and the built-in templates, prefabs and maps; auto-collected (§5) |
| `src/physics/` | the worker, the client, the protocol; `world/` is the simulation (§7), `components/` the component runtimes |
| `src/render/` | three.js: viewport, body / soft / joint / light / path / group views, overlays, gizmo, picking |
| `src/app/` | orchestration: `App`, `SimController`, `Editor`, `InputController`, persistence, prefs, scene commands |
| `src/app/registry/` | **the UI registries** (§6): commands, tools, panels, inspector sections, menus, help, keymap, shortcuts |
| `src/app/builtin/` | the built-in commands and tools that need no DOM, registered through those registries |
| `src/ui/` | vanilla-TypeScript UI: shell, topbar, toolbox, panel regions, library panels, outliner, inspector, telemetry, dialogs |
| `src/ui/builtin/` | the built-in menus, panels, dialog commands; loader of `src/ui/extensions/` |
| `src/ui/palette/` | the command palette: fuzzy matcher, ranking, recent items, item sources, the dialog |
| `src/ui/extensions/` | drop-in UI extensions, loaded at start-up (empty in the product) |
| `tests/` | Vitest: the real engine in Node. `tests/examples/` are the tested examples of `EXTENDING.md` |
| `e2e/` | headless Chromium (playwright-core) driving the real app; `e2e/tests/*.mjs` are discovered automatically |

## 4. The document (`model/`)

Plain JSON: `SceneDocument { settings, entities[], assets }`, **format version 3**. An entity is one of

* a **body** — shape (`type`, `size`, `params`), optional compound `parts`, pose, material, damping, locks, thrust,
  flags, the per-body physics fields (`collision`, `drag`, mass / centre-of-mass / inertia overrides, sleep threshold,
  `tags`, `layer`), `parent`, and `components`;
* a **joint** — type, the two bodies, anchors, axis, limits, motor, spring, `components`;
* a **soft body** — jelly, balloon, cloth or cable: just the recipe (size, resolution, mass, stiffness as a natural
  frequency, damping ratio, pinning, tear strain);
* the editor-level kinds: a **group** (a folder with a pivot transform), a **light** (point / spot / directional / area,
  stored in physical units) and a **path** (a spline through control points).

Nothing in the document refers to the engine or the renderer.

* **`SceneStore`** keeps entities in a `Map` and treats every entity object as **immutable** — an edit replaces the
  object. A history snapshot is a shallow copy of the map (structural sharing), so 200 undo levels of a thousand-body
  scene cost almost nothing. Edits group (`begin` / `end`) so a gizmo drag or a slider scrub is one undo step. Undo /
  redo diff the maps and emit precise `add / remove / update / assets / settings / reset` events, which is all the
  renderer and the live simulation need to stay in step.
* **Groups** hold no data beyond a pivot. A member points at its group through `parent` and keeps its own *world* pose;
  `transformGroup` applies the rigid transform "old pivot frame → new pivot frame" to every descendant (bodies —
  including their world-space velocities —, soft bodies, lights, paths, sub-groups, the world-anchored ends of joints) in
  one undo step (`groups.ts`). Removing a group releases its members; duplicating one brings the whole subtree.
* **Lights** are in physical units (candela for point / spot, lux for the sun, nits for area lights); the renderer budgets
  8 real lights and 3 shadow casters (`MAX_REAL_LIGHTS`, `MAX_SHADOW_LIGHTS`). **Paths** are centripetal Catmull-Rom
  splines (`path.ts`), evaluated by parameter or by arc length so movers travel at constant speed; the renderer draws
  exactly the curve the physics evaluates.
* **Scene settings** (`SceneSettings`): gravity, ground, physics rate, solver iterations, air drag, the RNG `seed`,
  `substeps` (honoured by the world), and `environment`, `bounds`, `units` (storage only for now).

### Loading anything: `sanitizeDocument`, migrations, limits

Every document that enters the app — a file, the autosave, a library entry, a share link — goes through
`sanitizeDocument` (`serialize.ts`), the single entry point:

1. **Migration** (`migrations.ts`). Each persisted scene carries `version`. An ordered, contiguous chain `v → v+1 → … →
   SCENE_VERSION` of pure structural transforms runs *before* sanitising, so the sanitiser only understands the
   current format and files from any older release keep loading (history: v1 first release; v2 shape `params`, assets,
   per-body fields, compound parts, new settings; v3 group / light / path kinds, `parent`, `components`). A newer-than-
   supported file is rejected with a clear message ("reload the page …"), garbage with "not a PhysicsLab scene". Adding a
   format change: bump `SCENE_VERSION`, append a migration, keep a fixture of the old format in `tests/fixtures/`.
2. **Sanitising.** Unknown fields dropped, missing fields defaulted, numbers clamped, joints to missing bodies removed,
   grouping links that point nowhere (or loop) repaired, unknown shapes replaced by a box, unknown component types
   dropped, references repaired — each repair recorded in a `LoadReport` the UI shows as warnings.
3. **Limits** (`limits.ts` — the one file of limits): entities, string / id / tag lengths, coordinates, parts, assets,
   path points, lights. An over-size document is rejected with a message that says what to do.

`serializeDocument` is the mirror image (and garbage-collects unused assets); `SceneFormatError` messages are written for
the user and shown verbatim.

### Asset store (`assets.ts`, `sanitize/assets.ts`)

`doc.assets` holds large binary payloads once, by id: meshes, textures, heightmaps, audio samples, opaque blobs (typed
arrays as base64). Bodies refer to an asset (`meshId`); the store de-duplicates by a 128-bit content hash of the whole
payload, ref-counts, and collects unreferenced assets on every save. `SceneStore.addAsset / getAsset / removeAsset` are
undoable (history snapshots share the map), removal unlinks references in the same undo step, and sanitising enforces the
caps (16 MB per asset, 64 MB and 256 assets per scene, 1 M vertices, a data-URL whitelist), dropping damaged assets with a
warning. Share links are refused above 150 kB with a message pointing at file export. The physics worker is sent only
referenced assets. (Nothing draws or collides with mesh assets yet — `LIMITATIONS.md`.)

### Shape registry (`shapeRegistry.ts`, `shapes/*.ts`)

`ShapeType` is a plain string; **a shape is one `ShapeDef`**: id, label, icon, palette category, default size, size fields
and normalisation, a declarative parameter schema (stored in `ShapeSpec.params`), analytic volume / bounding radius /
half height, convex points, the Rapier collider factory (`colliders(RAPIER, spec)` returns several for a compound shape)
and the three.js geometry factory. The palette, the number keys, the inspector fields, the world, the renderer and the
loader all call the registry — no switch on a shape id remains. The factories receive Rapier and a `GeometryKit` as
arguments, so the registry itself imports neither (and the worker bundle carries no three.js). The physics worker has its
own copy of the registry: shapes are registered from `shapes/index.ts`, which both threads import.

### Compound bodies (`compound.ts`)

A body may have `parts` — each a shape spec with a local pose, an optional material override and a `sensor` flag — and the
world builds one Rapier body with a collider per part. Mass, centre of mass, inertia, energy, picking, outlines and colour
modes all work for compounds; scaling a compound scales its parts.

## 5. Registries

One small class — `Registry<T>` (`core/registry.ts`) — underlies all of them: `register(def)` returns the function that
unregisters, ids are validated and unique, `list()` is sorted by `order` then registration order, `onChange` and a
`revision` counter let derived data (the keymap, the tab strips) follow. Malformed definitions throw a descriptive error
at registration time.

| Registry | Where | Consumers |
|---|---|---|
| shapes | `model/shapeRegistry.ts` | palette, 1–9 keys, inspector, world, renderer, loader |
| components (definition) | `model/componentRegistry.ts` | Add-component menu, inspector editors, sanitiser, clone / undo |
| components (runtime) | `physics/components/registry.ts` | `ComponentHost` in the world |
| templates / prefabs / maps | `model/content/registry.ts` | Scenes, Prefabs and Maps tabs, File menu, command palette |
| commands | `app/registry/commands.ts` | keymap, menus, toolbox, palette, shortcut help |
| tools | `app/registry/tools.ts` | toolbox / view bar, pointer dispatch, hints, tool commands |
| panels | `app/registry/panels.ts` | the three docked regions, "Show …" commands |
| inspector sections | `app/registry/inspectorSections.ts` | the inspector |
| menus + entries | `app/registry/menus.ts` | the menu bar and the viewport context menu |
| help entries | `app/registry/help.ts` | the shortcut help dialog (gestures; commands contribute theirs) |

Joint types are the one remaining closed union (`JointType`); `EXTENDING.md` lists the places a new one touches and
`tests/jointTypes.test.ts` guards them.

### Content: templates, prefabs, maps (`model/content/`)

`templates` (whole example scenes), `prefabs` (assemblies dropped into the scene) and `maps` (levels with a category,
difficulty, tags, objective, spawn point, opening camera and a thumbnail hook) are written with the `Builder` DSL against
the same public primitives a user has. `content/index.ts` is the module to import: it re-exports the registry API and
imports every other file of the folder with `import.meta.glob` (eager), so **adding content means dropping a file** that
calls `registerTemplate` / `registerPrefab` / `registerMap`. The built-ins go through exactly those calls
(`content/builtin.ts` registers the example scenes of `templates.ts` and the prefabs of `prefabs.ts`; `map-empty-arena.ts`
and `map-sandbox-box.ts` are maps). `mapKit.ts` builds walled arenas and draws a top-down SVG thumbnail from the
document itself, which the Maps tab shows until a rendered one is plugged in. Tests loop over everything registered
(`tests/templates.test.ts`, `tests/maps.test.ts`).

## 6. Components (`model/componentRegistry.ts`, `physics/components/`)

A **component** is a behaviour attached to a body or a joint (`{ id, type, enabled, params }` in `components`). It has two
halves registered under the same `type`:

* the **definition** (`ComponentDef`, `model/components/*.ts`): label, icon, category, `appliesTo`, a declarative **field
  schema** (`number`, `bool`, `enum`, `vec3`, `color`, `key`, `text`, `entity`, `path`, `curve`), optional `check` (an
  inspector warning), `unique`, `state` labels. The schema drives *everything*: defaults, sanitising of whatever a file
  carries (`sanitizeParams`: every field coerced, unknown keys dropped, entity / path references repaired or cleared when
  their target is deleted), and the inspector (`ui/inspector/componentFields.ts` builds one editor per field kind,
  `components.ts` the section: Add menu with search, enable switch, reorder, remove, live gauges). Cloning gives a
  component new ids and re-points references at the copies cloned with it.
* the **runtime** (`ComponentRuntime`, `physics/components/*.ts`): `create(ctx)`, `prestep`, `poststep`, `onEvent`,
  `paramsChanged` (adopt new values in place; without it the component is re-created), `dispose`, `saveState` /
  `loadState` (survive snapshots). A `ComponentHost` per world attaches components when bodies / joints are added,
  `sync`s live edits, and runs them every fixed step in a **deterministic order** (bodies in the order they joined the
  world, then joints, each owner's components in array order; prestep after the built-in thrusters and the grab, poststep
  after the engine step). It routes sensor and contact events to the components of the bodies involved and isolates faults:
  a component that throws is switched off and reports one `component` event named `error`, which the page toasts.

`ctx` (`components/context.ts`) is the only way a runtime touches the world: typed parameter readers, body / joint handles
(`applyForce` / `applyImpulse` / `applyTorque`, `setVelocity`, `driveTo` for kinematic bodies, `teleport`), `ctx.path`,
`ctx.raycast`, `ctx.contacts`, `ctx.watchContacts`, `ctx.emit`, `ctx.input.key / axis`, `ctx.random()`, `ctx.state.set /
setJson` (published to the page), `ctx.time / dt / step`. Forces are applied as impulses `F·dt` over the fixed step, so they
never fight the engine's persistent force accumulators. The two reference components, `constantForce` and `sineMover`, are
verified against analytic results (`tests/components.test.ts`).

## 7. Simulation (`physics/`)

* **`PhysicsWorld`** is pure TypeScript around Rapier: it builds a world from a document, applies live edits, advances time
  and reports state, with no DOM or worker dependency — so it runs identically in the worker and in Vitest, which is how
  the physics is verified.
* **Module layout.** `physics/world.ts` re-exports the public API; the implementation is split by concern under
  `physics/world/`. `PhysicsWorld` (`physicsWorld.ts`) is a thin façade that owns one `WorldState` (`state.ts`: Rapier world,
  body / joint / soft records, grab state, accumulators) and delegates to function modules taking the state first:
  `colliders` (shape → colliders), `bodies`, `bodyFields` (collision groups, mass overrides), `joints` (construction,
  motors, measurement, spring breakage), `soft`, `settings` (gravity, step rate, sub-steps, ground), `edits` (live remove /
  update / teleport), `forces` (thrusters, grab spring, impulse, explosion), `dynamics` (quadratic drag, emulated sleep
  threshold), `ops` (`SimOp` dispatch), `stepping` (fixed-step accumulator, pre / post hooks), `readback` (poses, joints,
  contacts), `events` (contact / sensor events), `queries` (ray casts, contact lists), `snapshot`, `energy`, `stats`.
  Hot loops (stepping, readback) write into caller-supplied buffers.
* **Worker.** The main thread sends `tick` messages (wall-clock dt, time scale, pressed keys, analog axes, run flag) and
  receives a frame: a `Float32Array` of poses / velocities / net forces / energy per body, a joint-state array, optional
  contact points and statistics, plus events. Buffers are *transferred*, not copied. At most one tick is in flight; elapsed
  time accumulates meanwhile, so a slow simulation falls behind real time (the status bar shows the speed percentage)
  instead of stalling the UI.
* **Protocol v2** (`protocol.ts`, documented at its top): `tick` carries pressed `keys` **and analog `axes`**; the frame
  carries an **events channel** — `contact` (ids, point, normal, impulse, approach speed, materials; off until switched
  on; aggregated per pair, rate-limited, filtered), `sensor` enter / exit, `component` events, `jointBroken` — plus
  `componentState` (numbers / JSON components publish; only changes are sent), request / response **queries** (`raycast`,
  answered by id; `SimClient.raycast` wraps it in a Promise), a seeded **RNG** (`SceneSettings.seed`, mulberry32 in
  `core/rng.ts`, used by every stochastic feature) and a **custom channel** (`registerCustomChannel` in `custom.ts`, with a
  shipped `diagnostics` channel). `ready` announces `PROTOCOL_VERSION` so a stale worker bundle is detected.
* **Snapshots** (`SimOp 'snapshot'` / `'restore'`, `world/snapshot.ts`): the engine serialises its whole state (rigid bodies,
  colliders, joints, contact caches, **soft bodies**) and the snapshot adds what the engine cannot know — the definition each
  body was built from, handles per id, joint frames and measurements, motor caches, emulated sleep counters, clock,
  accumulator, RNG state, paths and component state. The result is plain data, structured-cloneable: run N steps →
  snapshot → run M → restore → run M again gives bit-identical results (`tests/protocol2.test.ts`), even in a different
  world. Not captured: the mouse grab, pending events, the per-pair rate-limit memory, key / axis input.
* **Time stepping.** Fixed step (60 / 120 / 240 / 480 Hz, default 120) with an accumulator, optionally divided into
  `substeps` engine steps; the last step's pose is interpolated so rendering is smooth at any display rate and slow motion
  (0.1×) stays smooth. A per-tick time budget bounds worst-case work.
* **Materials.** Mass = density × volume (Rapier integrates mass properties of the real shape, convex hulls included). Pair
  friction is the **average** of the two surface coefficients, pair restitution the **maximum** — so a rubber ball with
  e = 0.85 bounces to ≈ e² of its drop height on any floor, which matches how restitution is usually quoted.
* **Joints** are Rapier impulse joints with explicit local *frames*, so bodies may have any orientation when joined: for a
  hinge / slider the joint X axis is rotated onto the requested world axis in each body's frame, which makes zero angle /
  position the pose at simulation start. A rigid joint's anchor on body B is *derived* from A's at build time, so a joint
  never starts violated; springs and ropes keep two independent anchors. **Motors** are Rapier's force-based motors
  (velocity mode: a target speed with a gain and a force cap; position mode: a spring-damper), updated every step from the
  key state, with a slew limiter for keyed position targets. **Springs** (`F = k·x + c·v`, verified against `T = 2π√(m/k)`)
  also measure force each step so a break force can snap them; rigid joints are not breakable yet (`LIMITATIONS.md`).
* **Grabbing** applies a critically-damped spring force at the grab point (gravity-compensated, acceleration-capped) — a
  force, not teleportation, so a grabbed body still collides and drags attached mechanisms.
* **Energy accounting** is computed from engine state each frame: ½mv², rotational ½ΣIᵢωᵢ² in the principal frame,
  gravitational −m g·r about the centre of mass, ½kx² for springs.
* **Soft bodies** are built with the engine's generators (lattice, surface membrane, grid, chain); pinning and rotation
  become particle operations; each frame returns *all particle positions* in one transferred buffer, and topology is sent only
  when it changes (after a tear the engine splits the body into pieces, which the worker merges back into the owning
  entity's block). Grabbing applies a spring to the nearest particle. Soft bodies interact with rigid bodies and the
  ground through the contact solver; they cannot be attached to joints yet.

## 8. Rendering (`render/`)

* `Viewport` — renderer, orbit navigation (right-drag orbit, middle pan, zoom-to-cursor), the sun with a snapped shadow
  frustum, image-based lighting from a procedural PMREM environment, shader grid, gradient sky, MSAA + outline pass,
  optional GTAO. Quality presets trade shadows / AO / pixel ratio for speed.
* `BodyViews` — one mesh per body (a group of part meshes for a compound); geometries are shared unit shapes scaled by the
  body size, cached by the shape's geometry key. **Colour modes** (material, body type, speed, kinetic energy, net force,
  sleep state) turn the simulation into a heat map. `SoftViews` shows a light proxy in edit mode and a dynamic particle
  mesh while simulating. `JointViews` draws gizmos over the geometry (hinge rings, slider rails with limit stops, ball
  spheres, weld cubes, spring coils coloured by tension, sagging ropes).
* `GroupViews` / `LightViews` / `PathViews` — the editor-level objects (dashed bounds + pivot; a real three.js light plus
  an icon sprite and a wire sketch; the exact spline with draggable control points). `ViewSync` keeps every view in step
  with the store.
* `Overlays` (velocity / force arrows, contact points, centres of mass, trails), `Gizmo` (three's `TransformControls` with a
  pivot object so many bodies move together, one is resized, or a joint anchor / axis is edited), `Picker`.

## 9. Orchestration (`app/`)

* **`App`** (`app/app.ts`, exposed as `window.physicslab`) is the façade the UI talks to. It owns the long-lived objects
  (store, simulation controller, editor, viewport, views, gizmo) and forwards commands to small collaborators: `prefsSync`
  (preferences → renderer / simulation / gizmo, tool hints), `viewSync`, `gizmoController`, `measureTool`, `placement`
  (picking, where new objects go), `cameraControl`, `sceneCommands` (add shape / soft body / prefab, load scene / template /
  map), `projectiles`, `frameLoop`.
* **`SimController`** owns the **edit / running / paused** state machine. *Edit* has no simulated world; *Simulate* builds a
  worker world from the document; *Reset* discards it. While a world exists, document changes are mirrored into it as ops:
  structural and property edits apply to **both** the document and the live world; *pose* edits made while simulating apply
  to the live world only, so Reset still returns to what was built. "Use current simulation state as the starting layout"
  promotes the live poses into the document. Simulation-only bodies (projectiles) live in an `ephemeral` map.
* **`Editor`** holds the verbs (add shape / light / path / group, add a joint with smart defaults, duplicate with internal
  joints, group / ungroup, paste, delete, capture state); **`persistence`** does debounced autosave, the named library,
  JSON import / export and deflate-compressed share links in the URL hash.
* **`InputController`** is only the pointer / key *plumbing*: it forwards held keys to running motors and thrusters, hands
  every other key to the **keymap** (§10) and every primary-button press to the **tool of the active mode**
  (`toolForMode(prefs.tool).pointerDown`), and keeps the gesture state (marquee, drag-move, grab).

## 10. The generated UI

The shell never lists its own buttons, tabs or menu items. Each is a registration, read by a generator:

* **Commands** (`app/registry/commands.ts`) are the unit of "something the user can do": id, label, category, icon,
  keywords, shortcut(s), `enabled(app)`, `checked(app)`, `run({ app, source, event })`. The **keymap**
  (`keymap.ts`, shortcut syntax in `shortcuts.ts`) is derived from them and indexed by key; a clash between two commands'
  shortcuts is an error at registration. `runCommand` is the single entry point (it isolates failures into a toast).
* **Menus** (`menus.ts`): menus and entries are separate registrations; an entry points at a command (so its label, shortcut,
  disabled and check state follow it), a heading, or a function producing items. `resolveMenu` runs each time a menu opens.
  The menu bar and the viewport context menu are both just menus.
* **Tools** (`tools.ts`): a tool registers its toolbox / view-bar button, its command and shortcut, its pointer handler
  and its hint in one object; buttons that merely mirror a command (the overlay toggles) reference it. `ui/toolbox.ts`
  renders the two bars.
* **Panels** (`panels.ts`, `ui/panelRegion.ts`): left (Add, Prefabs, Maps, Scenes — `ui/libraryPanels.ts`), right (Inspector,
  Outliner, World) and bottom (the telemetry dock: Energy, Selection) are regions that render their tab strip from the
  registry, build each panel once, and fall back to the first tab when the stored tab id no longer exists. Tab strips are
  ARIA tab lists with arrow-key navigation.
* **Inspector sections** (`inspectorSections.ts`, `ui/inspector/sections.ts`): the inspector asks every registered section
  whether it applies to the selection and builds those that do, in order; the per-kind panels, the Organise row and the
  Components section are ordinary registrations. The inspector rebuilds its DOM only when the *kind* of selection changes
  and otherwise refreshes values in place, so typing and scrubbing never lose focus.
* **Help** (`help.ts`): the keyboard-shortcut dialog is generated from the commands that have shortcuts plus a few registered
  gesture rows ("drag to throw a body").
* **Command palette** (`ui/palette/`, Ctrl/⌘+K, also the topbar button): one search box over every enabled command, setting,
  example scene, saved scene, prefab and map, collected from the registries each time it opens. `fuzzy.ts` scores the best
  alignment of the query's letters in a label (a dynamic programme, checked against brute force in the tests: prefix, word
  start and consecutive-run bonuses, gap penalties); `search.ts` requires every word of the query to match — fuzzily in the
  label, but only as a whole word in keywords, group or description, so long sentences do not match scattered letters —
  and boosts recent items; `history.ts` remembers the last eight in `localStorage`. The dialog is an ARIA combobox +
  listbox with `aria-activedescendant` (focus stays in the input), a live region for the result count, focus restored on
  close, and refuses to open over a modal.
* **Extension loader** (`ui/builtin/index.ts`): after the built-ins are registered, `loadExtensions()` imports every file
  of `src/ui/extensions/` (a lazy `import.meta.glob`); a file that throws is reported and skipped.

`main.ts` boots in this order: register the built-ins (commands, tools, help, menus, panels, inspector sections), load the
extensions, build the shell and the three panel regions, the toolbox and the topbar, wire the input, load the initial scene
(a share link, else the autosave, else the car; `?scene=<template id>` overrides), then start the frame loop.

### The rest of `ui/`

Vanilla TypeScript with a tiny `h()` hyperscript helper — no framework, to keep the bundle small and the render loop
uncontested. The outliner is a tree (groups fold, drag to re-parent); the telemetry charts draw straight from the frame
buffer; live readouts refresh at ~11 Hz. Number fields scrub by dragging their axis label. Design tokens live in
`styles/app.css`, icons in `ui/icons.ts`.

## 11. Verification

* **Unit tests** (`tests/`, Vitest, environment `node`) run the real Rapier engine and assert against analytic results:
  free fall, `T = 2π√(m/k)`, terminal velocity `√(m g / c)`, momentum conservation, the engine's snapshot / restore
  determinism. Registries are tested without a DOM (`uiRegistry`, `palette`, `content`, `maps`, `registry`); the migration
  chain with fixtures of old files; the sanitiser with fuzzed documents; **every registered template, prefab and map** is
  loaded, simulated and round-tripped automatically.
* **End-to-end tests** (`e2e/`) drive the real UI in headless Chromium with real mouse and keyboard input, and also load the
  examples of `EXTENDING.md` into the running app.
* The gate before any change is `npm run typecheck && npm run lint && npm test && npm run build`, then the e2e suite.

## 12. Why these choices

| Decision | Reason |
|---|---|
| Rapier (WASM) | Proven, fast, deterministic solver with joints, motors, springs, CCD and sleeping; the WASM build runs in a worker without extra headers. |
| Physics in a worker | Heavy scenes cannot drop frames of UI / rendering; the protocol (poses out, ops in) also keeps the engine swappable. |
| Document as source of truth | Undo, persistence, sharing and Reset all fall out of it; the engine is a *derived* view. |
| Immutable entities | Cheap history, trivially correct change detection for incremental renderer / worker sync. |
| Registries, with the UI generated from them | A feature package adds files and a registration call; shared files stay small, merges stay trivial, and menus / palette / keyboard / help can never disagree about what exists. |
| Commands as the unit of action | One definition serves the key, the menu, the button and the palette; labels, enabled and checked states are computed in one place. |
| Content folder collected by `import.meta.glob` | "Drop a file" is the whole procedure for a template, prefab or map, and the tests find it automatically. |
| three.js without a scene framework | Full control of the render loop, overlays and picking; a small surface to maintain. |
| No UI framework | The DOM is small and mostly static; a framework would add weight and a second reactivity model next to the document store. |
| Migration chain + sanitiser as the only entry | Old files keep loading, hostile files cannot corrupt the app, and every repair is reported to the user. |

## 13. Extending

See `docs/EXTENDING.md`: *how to add a shape / component / command / tool / panel / inspector section / menu entry /
template / prefab / map / joint type*, each with a minimal example that is compiled and tested. Other seams:

* **A new entity kind** (group / light / path are the examples): a type in `model/types.ts`, a factory and sanitiser
  (`model/sanitize/kinds.ts`, dispatched from `serialize.ts`), a view manager under `render/`, an outliner icon / title, an
  inspector section registration, and a migration if the version changes.
* **A new analysis**: put the quantity in the frame buffer (`protocol.ts`), plot it in `ui/telemetry.ts` or colour by it in
  `bodyViews.ts`; a new chart tab is a bottom-region panel.
* **A different engine / GPU compute**: replace `PhysicsWorld` behind the same ops / frame protocol; nothing else knows
  Rapier exists.
