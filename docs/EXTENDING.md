# Extending PhysicsLab

PhysicsLab grows by **adding files**, not by editing shared ones (rule 4 of `docs/DEV_RULES.md`). Everything a feature
package contributes — a shape, a component, a command, a tool, a panel, an inspector section, a menu entry, a
template, a prefab, a map — is *registered* with a small typed registry, and the rest of the app (the palette, the
inspector, the menus, the toolbox, the keyboard, the library tabs, the shortcut help, the loader) is generated from
those registries. This guide shows, for each of them, the smallest example that works.

**Every example below is a real file in `tests/examples/`.** It is type-checked and linted with the rest of the code,
exercised against the real registries and the real engine by `tests/extending.test.ts` (and, for the two that need a
DOM, loaded into the running app by `e2e/tests/registry.mjs`), and this guide must show exactly that file — the
imports are rewritten for the folder the example says it belongs in. If you change an example, run
`npm run docs:sync` and the guide follows; `npm test` fails if it does not.

| I want to add… | It is registered with | Put the file in | Anything else to edit? |
|---|---|---|---|
| a **shape** | `ShapeDef` (`src/model/shapeRegistry.ts`) | `src/model/shapes/<id>.ts` | one entry in `BUILTIN_SHAPES` (`shapes/index.ts`) |
| a **component** | `ComponentDef` + `ComponentRuntime` | `src/model/components/<type>.ts` **and** `src/physics/components/<type>.ts` | one entry in each `index.ts` |
| a **command** (action, shortcut, palette entry) | `registerCommand` | `src/ui/extensions/<name>.ts` | no |
| a **tool** (toolbox button, pointer mode) | `registerTool` | `src/ui/extensions/<name>.ts` | no |
| a **panel** (a tab on the left, right or bottom) | `registerPanel` | `src/ui/extensions/<name>.ts` | no |
| an **inspector section** | `registerInspectorSection` | `src/ui/extensions/<name>.ts` | no |
| a **menu** or **menu entry** | `registerMenu`, `registerMenuEntry` | `src/ui/extensions/<name>.ts` | no |
| a **template**, **prefab** or **map** | `registerTemplate`, `registerPrefab`, `registerMap` | `src/model/content/<name>.ts` | no |
| a **particle effect** (sparks, smoke, confetti …) | `registerParticleType`, then `app.fx.emit` | `src/ui/extensions/<name>.ts` | no |
| a **sound** or a **material's sound** | `registerSoundEvent`, `registerSoundMaterial`, then `app.audio.playEvent` | `src/ui/extensions/<name>.ts` | no |
| a **guided tour** or a **context hint** | `registerTour`, `registerHint` (`src/ui/tour`) | `src/ui/extensions/<name>.ts` | no |
| a **joint type** | *(a closed union for now)* | seven places, listed below | yes — see the checklist |

Why two folders for the same kind of thing? **Content** (`src/model/content/`) is pure data built from the public
primitives and is loaded with `import.meta.glob` before anything else. **UI extensions** (`src/ui/extensions/`) need
the built-in commands, menus and panels to exist first, so they are loaded right after them (a file that throws is
reported with a toast and skipped; the rest of the app starts normally). **Shapes and components** must also exist in
the physics worker, which only imports their `index.ts` files — that is why they are listed there instead.

Ids start with a lowercase letter and join words with `.`, `-` or `_` (`edit.undo`, `view.snapGrid`, `empty-arena`).
Registering an id twice, a malformed definition, or a shortcut that another command already owns throws with a
message that names the culprit — at start-up, never later in front of a user. Every `register…` function returns the
function that unregisters again, which is what tests (and anything temporary) use.

---

## How to add a shape

A shape is one `ShapeDef`: label, icon, palette category, default size, parameter schema, analytic volume, bounding
radius, half height, the convex points (if it has them), the Rapier collider(s) and the three.js geometry. The
palette tile, the number key, the inspector fields, the physics world, the renderer, picking, saving and loading
all read the registry — nothing else changes.

<!-- example: spire-shape.ts -->
```ts
// File: src/model/shapes/spire.ts   (then add `spire` to BUILTIN_SHAPES in src/model/shapes/index.ts)
import type { Vec3 } from '../../core/math';
import type { ShapeDef } from '../shapeRegistry';
import {
  clampDims,
  halfDiagonal,
  hullCollider,
  hullGeometry,
  unitSpec,
  WIDTH_HEIGHT_DEPTH,
} from './helpers';

/** Square spire: the base lies in the XZ plane at the bottom of the size box, the apex is above its centre. */
function spirePoints([x, y, z]: Vec3): Vec3[] {
  const hx = x / 2,
    hy = y / 2,
    hz = z / 2;
  return [
    [-hx, -hy, -hz],
    [hx, -hy, -hz],
    [-hx, -hy, hz],
    [hx, -hy, hz],
    [0, hy, 0],
  ];
}

export const spire: ShapeDef = {
  id: 'spire',
  label: 'Spire',
  icon: 'cone',
  category: 'structural',
  blurb: 'Square spire: roofs, spikes, monuments',
  defaultSize: [1, 1, 1],
  params: [],
  sizeFields: WIDTH_HEIGHT_DEPTH,
  normalizeSize: (size) => clampDims(size),
  volume: ({ size }) => (size[0] * size[1] * size[2]) / 3,
  boundingRadius: ({ size }) => halfDiagonal(size),
  halfHeight: ({ size }) => size[1] / 2,
  convexPoints: ({ size }) => spirePoints(size),
  colliders: (R, { size }) => hullCollider(R, spirePoints(size), size),
  geometry: (T, spec) => hullGeometry(T, spirePoints(unitSpec(spec).size)),
};
```

Then add `spire` to `BUILTIN_SHAPES` in `src/model/shapes/index.ts` (the position in that array is the position in
the palette; the first nine also answer to the 1–9 keys). Register shapes there, **not** with a `registerShape()`
call from a main-thread-only module: the physics worker has its own copy of the registry and would simulate an
unknown shape as a box.

Helpers for the common cases live in `src/model/shapes/helpers.ts` (`hullCollider` / `hullGeometry` for convex
shapes given as points, `single` for a one-collider shape, size fields, `clampDims` …). A compound shape returns
several colliders from `colliders()`. Hollow and concave shapes are built from several
convex parts that tile the solid without overlapping (so the engine's mass is exactly `density × volume`): `parts.ts`
has `boxPart` / `hullPart`, `meshKit.ts` the mesh side (`MeshBuilder` with crease-angle normals, `lathe`,
`extrudeOutline`) — `torus.ts` and `arch.ts` are worked examples, and `tests/primitiveShapes.test.ts` shows how to
prove a compound shape (mesh volume = analytic volume = engine mass, a ball through the hole). `tests/shapeRegistry.test.ts` runs every registered shape against the engine
(volume × density = integrated mass, bounding radius, mesh bounds); the example's own test also checks the centre
of mass of a real spire.

A shape can also carry three optional fields that the palette and the inspector pick up without further code:
`keywords` (extra search words: "donut" finds the torus), `quantities` (derived numbers the inspector shows and
edits — a gear's module, a rounded box's corner radius in metres; each maps a value to the size and parameters
that realise it, so undo, live resizing and the scale gizmo keep working) and `surface` (a painted texture over the
geometry's uvs, as the dice have; the painter itself is registered in `src/render/shapeSurface.ts`). A geometry
with a `color` attribute (`MeshBuilder.tint`) is drawn with vertex colours, as the wheel's dark tyre is. Convex
shapes with a fine rounded edge or a flat polygon almost parallel to a neighbour need the engine-safety rule in
`src/model/shapes/hull3.ts` (`firstSafeHull`): the engine's hull builder silently merges faces that meet at under
about 1.35° and mis-computes the mass of such hulls, so give it candidates from the most detailed to a plain one.

## How to add a component

A component is a behaviour attached to a body or a joint. It has two halves registered under the same `type`:
the **definition** (what the user sees and stores: label, fields, warnings) and the **runtime** (what the physics
worker does every step). The field schema drives the defaults, the sanitising of loaded files and the inspector
editors — you write no UI.

<!-- example: spin-component-def.ts -->
```ts
// File: src/model/components/spin.ts   (then add `spin` to BUILTIN_COMPONENTS in src/model/components/index.ts)
import type { ComponentDef } from '../componentRegistry';

export const spin: ComponentDef = {
  type: 'spin',
  label: 'Spin',
  icon: 'rotate',
  category: 'Movers',
  blurb: 'Turns the body at a steady rate about an axis — a turntable, a rotor, a rolling pin.',
  appliesTo: 'body',
  unique: true,
  fields: [
    { kind: 'vec3', key: 'axis', label: 'Axis', default: [0, 1, 0], step: 0.1, hint: 'World axis (normalised)' },
    { kind: 'number', key: 'speed', label: 'Speed', default: 2, min: -100, max: 100, step: 0.1, unit: 'rad/s' },
  ],
  state: [{ label: 'Spin rate', unit: 'rad/s', digits: 2 }],
  check: (owner) =>
    owner.kind === 'body' && owner.bodyType === 'static' ? 'A static body cannot spin. Make it dynamic.' : null,
};
```

<!-- example: spin-component-runtime.ts -->
```ts
// File: src/physics/components/spin.ts   (then add `spin` to the list in src/physics/components/index.ts)
import { vdot, vnorm, vscale } from '../../core/math';
import type { ComponentRuntime } from './registry';

export const spin: ComponentRuntime<null> = {
  type: 'spin',
  create: () => null,
  // The parameters are read fresh every step, so edits made while the simulation runs need no work here.
  paramsChanged: () => undefined,
  prestep(_state, _dt, ctx) {
    const body = ctx.body;
    if (!body || body.type !== 'dynamic') return;
    const axis = vnorm(ctx.vec3('axis'), [0, 1, 0]);
    body.setVelocity(body.linvel(), vscale(axis, ctx.num('speed')));
  },
  poststep(_state, _dt, ctx) {
    const body = ctx.body;
    if (body) ctx.state.set([vdot(body.angvel(), vnorm(ctx.vec3('axis'), [0, 1, 0]))]);
  },
};
```

Add `spin` to `BUILTIN_COMPONENTS` in `src/model/components/index.ts` and to the list in
`src/physics/components/index.ts`. A runtime touches the world only through `ctx` (bodies and joints by id, forces
as impulses, ray casts, contacts, events, inputs, the seeded random generator, published state); read parameters
fresh every step (`ctx.num`, `ctx.vec3` …) and `paramsChanged` can stay empty — edits then take effect while the
simulation runs without a rebuild. Test it with `worldOf([...])` against an analytic expectation, as the example's
test does (a body spinning at 3 rad/s reports exactly 3 rad/s).

## How to make a component survive time travel (`saveState` / `loadState`)

The recorder (package TM) takes a full-state snapshot of the world every few simulated steps and restores one whenever
the user rewinds, scrubs the timeline, steps back, loops a region or opens a replay. The engine bytes carry every
rigid body, joint, soft body and the RNG; **whatever your runtime keeps in its own state `S` is not in them**. If a
number in `S` survives from one step to the next (an accumulated time, a counter, an integrator, a latch, a queue of
pending spawns, a slewed command, a "previous value" used for a derivative), give the runtime two small functions:

```text
export const spawner: ComponentRuntime<{ n: number; cooldown: number }> = {
  type: 'spawner',
  create: () => ({ n: 0, cooldown: 0 }),
  prestep(s, dt, ctx) { /* … uses s.n, s.cooldown, ctx.random() … */ },
  // JSON-serialisable data only (it travels through postMessage and replay files): numbers, strings, arrays, plain objects.
  saveState: (s) => ({ n: s.n, cooldown: s.cooldown }),
  // `s` is a freshly created state; put the saved values back. `data` may come from an older build: check its shape.
  loadState(s, data) {
    const d = data as { n?: number; cooldown?: number } | null;
    s.n = d?.n ?? 0;
    s.cooldown = d?.cooldown ?? 0;
  },
};
```

Rules of thumb:

* **Save what cannot be recomputed from the world and the parameters.** State that is rebuilt from the bodies every
  step (forces, measured speeds) needs nothing. Never save references to engine objects, body handles or DOM.
* **Randomness comes from `ctx.random()`** (the world's seeded generator, saved with the snapshot) — never
  `Math.random()` or the clock. A component that does is caught by *Check determinism* (Replay tab) and by the test below.
* **Things you send to the engine and cache** ("already sent" flags, last motor target) must be restored too, or the
  restored world re-sends them on its first step and the engine restarts that constraint. The drive network's motor
  settings are the example (`saveMotors` / `loadMotors` in `components/drive/bindings.ts`, called from the host).
* **State that lives next to the components** (a world-level system like zones or the drive network) is saved from
  `ComponentHost.saveStates()` under an `@name` key; add yours there and in `loadStates`.

Prove it with the generic test: `tests/timelineScenes.test.ts` runs every bundled example scene, seeks back and
forward through its recording and demands the identical state hash. Add an example scene that uses your component (or a
focused test like the one in `tests/timeline.test.ts`: run, `seekTo` an earlier step, compare `stateHash`) and a missing
`saveState` shows up as a hash mismatch naming the scene.

## How to add a command

A command is one action with an id, a label, a category and a `run` function; it may have an icon, keywords,
shortcut(s), `enabled(app)` and `checked(app)`. Registering it is enough for it to be:

- **bound to its shortcut** (`Mod` = Ctrl or ⌘; `Shift+Space`; a single character matches by `key`, longer names are
  `KeyboardEvent.code`s — `Escape`, `Delete`, `ArrowUp`, `F5`; a typo such as `Esc` is rejected). Plain keys are
  ignored while a text field has focus; `allowWhileTyping: true` overrides that (the palette key does);
- **offered by the command palette** (Ctrl/⌘+K), found by label, category and `keywords`, shown with its shortcut,
  hidden while `enabled()` is false; `setting: true` lists a toggle or a choice under *Settings* with its On / Off
  state; `palette: false` keeps it out;
- **listed in the keyboard-shortcut help**, under its category.

Menus and the toolbox do not appear by themselves — a menu entry or a tool *points at* the command (below).
`run` receives `{ app, source, event }`; `source` says whether it came from a `'shortcut'`, `'menu'`, `'palette'`,
`'button'` or `'api'` call, so a command can, for instance, toast only for a key press. A command that throws or
rejects is reported to the user as a toast and never breaks the caller.

<!-- example: lift-command.ts -->
```ts
// File: src/ui/extensions/lift-selection.ts   (files in src/ui/extensions are loaded at start-up, nothing to edit)
import { registerCommand, registerMenuEntry } from '../../app/registry';

registerCommand({
  id: 'demo.liftSelection',
  label: 'Lift selection by 1 m',
  category: 'Edit',
  icon: 'move',
  description: 'Raise the selected objects one metre',
  keywords: ['raise', 'up', 'elevate'],
  shortcut: 'Mod+Shift+U',
  enabled: (app) => app.store.selection.length > 0 && !app.sim.active,
  run: ({ app }) => app.editor.translate(app.store.selection, [0, 1, 0]),
});

// Optional: also list it in the Edit menu (group "select", after "Rotate selection 90° about Y").
registerMenuEntry({ id: 'menu.edit.lift', menu: 'edit', group: 'select', order: 335, command: 'demo.liftSelection' });
```

The second call adds the command to the Edit menu. Entries are sorted by `order`; a separator is drawn wherever
`group` changes between neighbours; label, shortcut, disabled and check mark all follow the command. Instead of
`command` an entry can have a `heading`, or `items: (app) => MenuItem[]` for a list computed when the menu opens
(the File menu's example scenes are one). A new top-level menu is `registerMenu({ id, label, order })`; with
`bar: false` it is a popup only (the viewport's right-click menu is `context`).

## How to add a tool

A tool is a button in the toolbox (left) or the view bar (right) plus, usually, an interaction mode for the
pointer. One registration gives you the button (highlight, tooltip with the shortcut, `aria-pressed`), the command
`tool.<id>` with its shortcut (so the palette finds it too), the hint line under the viewport, and the pointer
handler. Buttons are sorted by `order` and separated where `group` changes. The viewport's cursor class
`tool-<mode>` is set while the mode is active (the stylesheet turns the joint, measure, blast and fire modes into a
crosshair; add a rule for yours if you want one).

<!-- example: dropper-tool.ts -->
```ts
// File: src/ui/extensions/dropper-tool.ts
import { registerTool } from '../../app/registry';

registerTool({
  id: 'dropper',
  group: 'build',
  order: 65,
  label: 'Ball dropper',
  title: 'Drop a ball where you click',
  icon: 'sphere',
  shortcut: 'D',
  activate: (app) => app.setTool('dropper'),
  isActive: (app) => app.prefs.value.tool === 'dropper',
  // Called for a primary-button press in the viewport while this tool is the active mode.
  pointerDown: (app, e) => {
    const p = app.picker.groundPoint(e, 0);
    if (p) app.editor.addShape('sphere', [p.x, 2, p.z]);
  },
  hint: () => 'Click the ground to drop a ball from 2 m',
});
```

`mode` defaults to the id; several tools can share one (move / rotate / scale are all gizmo modes of `select`). A
button that merely mirrors a command — the overlay toggles on the view bar — is
`{ id, group, order, icon, command: 'view.overlay.velocity' }` and defines no behaviour of its own.

## How to add a panel

A panel is a tab in one of the three docked regions: `left` (the library: Add, Prefabs, Maps, Scenes), `right`
(Inspector, Outliner, World) or `bottom` (the telemetry dock: Energy, Selection). The region draws the tab strip
from the registry, builds your view once, shows it when its tab is selected and follows the registry live — register
a panel at any time and it appears. `build(app, ctx)` returns `{ el, onShow?, toolbar?, dispose? }`: `onShow` runs
every time the tab becomes visible (rebuild stale content there), `toolbar` puts controls at the right end of the
tab strip while it is, and `ctx.active()` says whether the tab is the selected one right now. Registering a panel
also registers the command `panel.<id>` ("Show Stats"), which switches to it and opens its region. The tab
remembered in the preferences is looked up by id, so an id that no longer exists falls back to the first tab.

<!-- example: stats-panel.ts -->
```ts
// File: src/ui/extensions/stats-panel.ts
import { registerPanel } from '../../app/registry';
import { h } from '../dom';

registerPanel({
  id: 'stats',
  label: 'Stats',
  icon: 'info',
  region: 'right',
  order: 40,
  build: (app) => {
    const el = h('div', { class: 'panel-body' });
    const render = () => {
      const text = `${app.store.bodies().length} bodies, ${app.store.joints().length} joints`;
      el.replaceChildren(h('div', { class: 'empty-state' }, h('h4', null, text)));
    };
    app.store.on('change', render);
    render();
    return { el, onShow: render };
  },
});
```

## How to add an inspector section

The inspector asks every registered section whether it applies to the current selection (`appliesTo`) and appends
what the applicable ones build, ordered by `order`. The built-in sections use 100 (the panel of the selected kind),
200 (Organise) and 300 (Components); a section with `fallback: true` is shown only when no other applies (the
summary of a mixed selection). Register `ctx.updaters` (refresh values from the document on every change) and
`ctx.live` (refresh readouts from the running simulation) so typing and scrubbing never lose focus.

<!-- example: volume-section.ts -->
```ts
// File: src/ui/extensions/volume-section.ts
import { registerInspectorSection } from '../../app/registry';
import { shapeVolume } from '../../model/shapeRegistry';
import { isBody } from '../../model/types';
import { row, section } from '../controls';
import { h } from '../dom';

registerInspectorSection({
  id: 'volume',
  order: 150, // after the body panel (100), before "Organise" (200)
  appliesTo: (selection) => selection.length === 1 && isBody(selection[0]),
  build: (ctx, selection) => {
    const first = selection[0];
    if (!isBody(first)) return [];
    const readout = h('span', { class: 'readout' });
    // Updaters run on every document change, so the value follows edits made elsewhere (undo, the gizmo …).
    ctx.updaters.push(() => {
      const body = ctx.app.store.body(first.id);
      if (body) readout.textContent = `${shapeVolume(body.shape).toFixed(3)} m³`;
    });
    return [section('Volume', [row('Shape volume', readout)], { id: 'volume' })];
  },
});
```

## How to add a template, a prefab or a map

Content is registered with one call and listed by its tab (Scenes, Prefabs, Maps), the File menu (templates) and the
command palette. Drop the file into `src/model/content/` — `index.ts` imports every file in the folder, in
alphabetical order, so there is nothing else to edit. Build content with the `Builder` DSL
(`src/model/builder.ts`) from the same shapes, joints and materials the user has; nothing about it is special-cased.
Builders must be deterministic (no `Math.random`) and use only registered shapes. **They are tested for you:**
`tests/templates.test.ts` and `tests/maps.test.ts` loop over every registered template, prefab and map — it loads
without repairs, saves back unchanged, simulates without a non-finite number, a map has a thumbnail — and a
well-made content file adds a test of the one thing it promises, as the examples' do.

A **template** is a whole scene (`category`, `blurb`, `hint`, optional opening `view`, optional `follow`ed body).
This one promises that ice slides, wood creeps and rubber holds, and its test checks exactly that against
`s = ½·g·(sin θ − μ·cos θ)·t²`:

<!-- example: ramps-template.ts -->
```ts
// File: src/model/content/three-ramps.ts   (files in src/model/content are collected automatically)
import type { Vec3 } from '../../core/math';
import { Builder, rotX } from '../builder';
import { registerTemplate } from './';

const ANGLE = 30; // degrees: steeper than wood's friction angle (about 27°), shallower than rubber's (45°)

registerTemplate({
  id: 'three-ramps',
  name: 'Three ramps',
  category: 'Physics labs',
  blurb: 'A block on three 30° ramps of the same material: ice, wood and rubber.',
  hint: 'Press Play: the ice block shoots away, the wood block creeps, the rubber block holds. Change a friction.',
  view: { position: [0, 4, 10], target: [0, 1, 0] },
  build() {
    const b = new Builder('Three ramps');
    const rad = (ANGLE * Math.PI) / 180;
    // Ramp-local (y, z) → world offset from the ramp centre, for a ramp tilted about the x axis.
    const onRamp = (y: number, z: number): [number, number] => [
      y * Math.cos(rad) - z * Math.sin(rad),
      y * Math.sin(rad) + z * Math.cos(rad),
    ];
    ['ice', 'wood', 'rubber'].forEach((material, i) => {
      const x = (i - 1) * 3;
      const centre: Vec3 = [x, 1.5, 0];
      b.body(`${material} ramp`, 'box', [2, 0.1, 6], centre, { bodyType: 'static', material, rotation: rotX(ANGLE) });
      // The block rests on the upper end: half the ramp thickness plus half the block, 2 m up the slope.
      const [dy, dz] = onRamp(0.25, -2);
      b.body(`${material} block`, 'box', [0.6, 0.4, 0.6], [x, centre[1] + dy, dz], { material, rotation: rotX(ANGLE) });
    });
    return b.done();
  },
});
```

A **prefab** is a list of entities around the origin that the Prefabs tab drops into the current scene (they are
re-identified on insertion; `category` groups them in the tab):

<!-- example: domino-prefab.ts -->
```ts
// File: src/model/content/domino-trio.ts
import { Builder } from '../builder';
import { registerPrefab } from './';

registerPrefab({
  id: 'domino-trio',
  name: 'Domino trio',
  icon: 'box',
  blurb: 'Three dominoes and a ball to start them.',
  build() {
    const b = new Builder('Domino trio');
    for (let i = 0; i < 3; i++) b.body('Domino', 'box', [0.14, 0.8, 0.45], [i * 0.38, 0.4, 0], { material: 'wood' });
    b.body('Ball', 'sphere', [0.4, 0.4, 0.4], [-1.2, 0.2, 0], { material: 'steel', velocity: [3, 0, 0] });
    return b.doc.entities;
  },
});
```

A **map** adds what a level needs: `category`, `difficulty` (`sandbox`, `easy`, `medium`, `hard`, `expert`), `tags`,
an `objective`, a `spawn` point (position and heading) and an opening `camera`. `thumbnail` is a URL or a function
returning one — here `topDownThumbnail` draws the map from its own document; a rendered thumbnail plugs in the same
way. `addWalls` (`src/model/mapKit.ts`) builds a walled arena.

<!-- example: court-map.ts -->
```ts
// File: src/model/content/map-step-court.ts
import { Builder } from '../builder';
import { registerMap } from './';
import { addWalls, topDownThumbnail } from '../mapKit';

function build() {
  const b = new Builder('Step court');
  b.doc.settings.ground.halfSize = 8;
  addWalls(b, { halfX: 8, halfZ: 8, height: 2, thickness: 0.5, material: 'concrete' });
  // Three tiers of a step pyramid in the middle of the court.
  [4, 2.5, 1].forEach((side, tier) =>
    b.body(`Tier ${tier + 1}`, 'box', [side, 0.4, side], [0, 0.2 + tier * 0.4, 0], {
      bodyType: 'static',
      material: 'concrete',
    }),
  );
  return b.done();
}

registerMap({
  id: 'step-court',
  name: 'Step court',
  description: 'A walled court with a three-tier step pyramid in the middle.',
  category: 'Arenas',
  difficulty: 'easy',
  tags: ['steps', 'climb'],
  objective: 'Get something to rest on the top tier.',
  thumbnail: () => topDownThumbnail(build()),
  spawn: { position: [0, 0.5, 6], yaw: 0 },
  camera: { position: [0, 11, 14], target: [0, 0, 0] },
  build,
});
```

## How to add a particle effect

The visual-effects system (`src/render/fx/`, reachable as `app.fx`) is one pooled, GPU-instanced particle system that
every package shares. A **particle type** is data — a sprite from the procedural atlas (`soft`, `glow`, `spark`,
`smoke1`–`smoke3`, `chip`, `shard`, `shard2`, `ring`, `ringSoft`, `flame`, `star`, `crumb`, `dust`, `streak`), a lifetime,
a size and an opacity and a colour *over life*, a speed range and cone, gravity (a multiplier of the scene's gravity
vector: negative rises), drag, wind, an optional floor bounce — registered with `registerParticleType`. After that
`app.fx.emit('my.type', position, options)` creates particles: `options` can set the count, size scale, speed, life,
direction and spread, a colour tint, the emitter's velocity to inherit, and a `pattern` (`cone`, `sphere`, `disc`).
Counts follow the quality tier and the intensity setting and respect the particle budget; every `emit` draws from a
random stream seeded by the scene seed, so a scene plays out identically for the same seed. Effects freeze while the
simulation is paused and slow down with the time scale — a package passes nothing for that, `app.fx` is advanced by the
frame loop.

<!-- example: confetti-effect.ts -->
```ts
// File: src/ui/extensions/confetti.ts   (files in src/ui/extensions are loaded at start-up, nothing to edit)
import { registerCommand } from '../../app/registry';
import { registerParticleType } from '../../render/fx';

// A particle type is data: sprite, lifetime, size / opacity / colour over life, speed, gravity, drag, wind, floor bounce.
registerParticleType({
  id: 'demo.confetti',
  label: 'Confetti',
  blend: 'normal',
  sprites: ['chip', 'shard2'],
  life: [1.6, 2.6],
  size: [0.04, 0.09],
  sizeOverLife: [
    [0, 1],
    [0.85, 1],
    [1, 0],
  ],
  alphaOverLife: [
    [0, 1],
    [0.8, 1],
    [1, 0],
  ],
  colorOverLife: [
    [0, '#ff5964'],
    [0.5, '#ffd23f'],
    [1, '#35a7ff'],
  ],
  speed: [3, 9],
  spread: 0.9, // half-angle of the emission cone, radians
  gravity: 0.6, // × the scene's gravity
  drag: 1.2,
  wind: 0.8, // how strongly the wind carries it (0 … 1)
  spin: [4, 16],
  orient: 'billboard',
  bounce: 0.3, // restitution on the ground; it then lies there until it fades
  settle: true,
  count: 60,
  radius: 0.1,
});

registerCommand({
  id: 'demo.confetti',
  label: 'Confetti at the view centre',
  category: 'View',
  icon: 'sparkle',
  keywords: ['party', 'particles', 'effect'],
  // `app.fx.emit(type, position, options)` is the whole API: count, scale, speed, direction, spread, colour tint …
  run: ({ app }) => {
    const t = app.viewport.controls.target;
    app.fx.emit('demo.confetti', [t.x, 0.2, t.z], { count: 80 });
  },
});
```

Three more entry points, all in `src/render/fx`:

- `app.fx.explosion(position, { radius, energy })` — fireball, shock ring, embers, debris, smoke and a light flash (what
  the Blast tool uses; `app.fxDirector.blast(point, radius, strength)` also tells you whether effects are on).
- `app.fx.impact({ position, normal, speed, impulse, a, b, … })` — the material-dependent effects of one collision;
  `surfaceFor(presetId, colorHex)` builds the two surfaces, `impactBursts` is the recipe. A package that adds a
  **material** teaches the effects how it behaves with `registerFxSurface(presetId, { cls, hardness, brittle, dust,
  spark, chip, skid })` (hardness decides who sparks against / chips whom; `chip` is a particle type id; `skid` is the
  mark it leaves when it slides). A material nobody described is classified from its density, restitution, friction,
  metalness and opacity.
- `app.fx.setEnvironment({ wind, windAt, gravity, floorY })` — the wind particles feel (a constant, or a field sampled at
  each particle's position, which is what a wind zone should provide).

Contact events are shared through `app.contacts.acquire(owner, needs, handler)` (`src/app/contactFeed.ts`): the feed
switches the worker's contact events on for as long as anybody holds it and hands every consumer the events, so two
packages never fight over the configuration (the worker serves the most eager consumer; the feed hands each of the
others only what its own `minImpulse` / `pairInterval` allow, so switching the sound on never changes the effects). The **Effects panel** is a list of sections too:
`registerFxPanelSection({ id, order, build })` (`src/ui/fxPanel.ts`) adds one — an audio or camera-shake package puts
its settings there.

## How to add a sound

All sound is synthesised — there are no sample files — by the audio engine (`src/audio/`, reachable as `app.audio`). A
**sound event** is a recipe: *modes* (decaying sinusoids: frequency in Hz, loudness, seconds to fall 60 dB, optionally a
pitch glide or vibrato), *noise layers* (white / pink / brown noise through a low-, high- or band-pass filter that can
sweep, with an envelope) and *grains* (a spray of tiny modes: glass shattering, gravel). `registerSoundEvent` takes the
recipe, a `category` (which of the five volume sliders and voice budgets it belongs to: `impacts`, `rolling`, `engines`,
`ambience`, `ui`), whether it is `spatial`, a quantised `key` (equal keys share one rendered buffer, so keep the number of
distinct keys small) and a `gain`. After that `app.audio.playEvent(id, position, params)` plays it: the engine renders the
buffer on first use (a few milliseconds, spread over frames), pans and attenuates it by where `position` is relative to
the camera, bends its pitch with the simulation's time scale, and admits it to the voice pool — a louder newcomer steals
the quietest voice of its category, a quieter one is turned away.

A **material** teaches collisions how it rings: `registerSoundMaterial(presetId, profile)` gives the modes of a struck
object of that material (frequency ratios and loudness), how long the fundamental rings, how brittle and how hard it is;
a preset nobody described is classified from its density, restitution, friction, metalness and opacity. Bigger bodies
pitch lower, harder and faster hits are louder and brighter — none of that is the package's job.

<!-- example: tuning-fork-sound.ts -->
```ts
// File: src/ui/extensions/tuning-fork.ts   (files in src/ui/extensions are loaded at start-up, nothing to edit)
import { registerCommand } from '../../app/registry';
import { registerSoundEvent, registerSoundMaterial, soundProfileFor } from '../../audio';

// A sound is a recipe, not a sample: ringing modes (frequency Hz, loudness, seconds to fall 60 dB), noise layers and
// grains. The engine renders each distinct `key` once into a buffer and plays it with a gain, a pan and a pitch.
registerSoundEvent({
  id: 'demo.tuningFork',
  label: 'Tuning fork',
  category: 'impacts', // which volume slider and voice budget it belongs to
  spatial: true, // positioned relative to the camera (false: heard at the same level everywhere, like the interface)
  key: (p) => `demo|fork|l${Math.round((p.level ?? 0.5) * 4)}`, // equal keys share one rendered buffer
  gain: (p) => 0.05 + 0.2 * (p.level ?? 0.5),
  recipe: (p) => ({
    duration: 2.6,
    modes: [
      { freq: 440, gain: 1, t60: 2.2 }, // the fundamental rings for seconds…
      { freq: 440 * 6.27, gain: 0.1 + 0.2 * (p.level ?? 0.5), t60: 0.12 }, // …the strike's overtone dies at once
    ],
    noise: [{ color: 'white', gain: 0.15, t60: 0.01, filter: { type: 'highpass', freq: 3000 } }], // the tick of the blow
  }),
});

// A material is a profile too: how an object of it rings when struck (mode ratios and loudness, ring time, brightness).
registerSoundMaterial('titanium', { ...soundProfileFor('steel'), pitch: 1100, ring: 2.2, hardness: 0.9 });

registerCommand({
  id: 'demo.tuningFork',
  label: 'Strike a tuning fork',
  category: 'Sound',
  icon: 'speaker',
  keywords: ['sound', 'audio', 'note', 'a440'],
  // `app.audio.playEvent(id, position, params)` is the whole API: a position (null = not positioned), `size`, `level`, …
  run: ({ app }) => {
    const t = app.viewport.controls.target;
    app.audio.playEvent('demo.tuningFork', [t.x, t.y, t.z], { level: 0.7 });
  },
});
```

Where sounds come from in the app, so a package knows what already exists: contact events (`app.contacts`, shared with
the particle effects) become impact sounds; the ground contact and slip of every body become rolling and sliding noise;
every motorised hinge or slider, and every component whose published state (`ComponentDef.state`) has a speed in rpm,
°/s or rad/s — or, for jets and thrusters, a throttle percentage — becomes an engine voice; the body the camera follows
makes wind; a **component can ask for a sound** with `ctx.emit('sound', { id: 'explosion', params: { size: 5 } })` (and
`ignite` and `bounce` events play the launch and trampoline sounds). The mute key is `Shift+M` (`M` is the Measure
tool). The **Effects panel** carries the sound settings, as sections registered with `registerFxPanelSection`.

## How to add a guided tour

A tour is a spotlight walk-through of the real UI: the engine dims everything except the element a step points at,
shows a card with the step counter and **Back / Next / Skip tour**, and moves on by itself when the user does what
the step asks. The first-run onboarding tour (`src/ui/tour/onboarding.ts`) is built exactly this way, and the game
tutorials use the same engine. `registerTour` also adds the command `help.tour.<id>` (so the tour is in the command
palette) and a Help-menu entry; the user can leave at any time with **Skip tour** or `Esc`, and a step whose target
cannot be found is shown as a centred card instead of failing.

<!-- example: guided-tour.ts -->
```ts
// File: src/ui/extensions/inspector-tour.ts   (files in src/ui/extensions are loaded at start-up, nothing to edit)
import { registerHint, registerTour } from '../tour';

// A tour: Help → "Take the tour: Meet the Inspector" (and the palette command `help.tour.inspector-basics`).
registerTour({
  id: 'inspector-basics',
  title: 'Meet the Inspector',
  steps: [
    // No target: a centred card.
    { target: null, title: 'The Inspector', body: 'Everything about the selected object is edited on the right.' },
    {
      target: '.panel.right', // a CSS selector, or a function returning the element
      title: 'Pick something',
      body: 'Click an object in the 3D view. Keys look like this: [[Shift]] + click adds to the selection.',
      placement: 'left',
      onEnter: (app) => app.prefs.set({ showRight: true, rightTab: 'inspector' }),
      waitFor: { event: 'selection' }, // moves on by itself when the user does it ("Skip step" stays available)
    },
    {
      target: '.tbtn.play',
      title: 'Now run it',
      body: 'Press **Simulate** and watch what the numbers do.',
      until: (app) => app.sim.mode === 'running', // or poll any condition you like
    },
  ],
});

// A context hint: shown once, the first time the user adds anything to the scene.
registerHint({
  id: 'demo-first-add',
  trigger: { event: 'scene-change', type: 'add' },
  text: 'Added! The Inspector on the right edits it — try the **Mass** field.',
});
```

The API, all from `src/ui/tour`:

- `registerTour({ id, title, steps, menuLabel?, onEnd? })` → unregister function. `onEnd(app, 'completed' | 'skipped')`
  runs when the tour ends.
- A step: `target` (CSS selector, `() => HTMLElement | null`, or `null` for a centred card), `title`, `body` (plain text
  — `[[Ctrl+K]]` draws a key cap, `**bold**` makes bold text — or a DOM node you built; never raw HTML), and optionally
  `placement` (`'auto'` default, `'top' | 'bottom' | 'left' | 'right' | 'center'`), `padding`, `onEnter(app)` /
  `onExit(app)` (open the tab you are about to point at), and `allowInteraction`.
- Waiting for the user: `waitFor` is one of `{ event: 'click', selector? }`, `{ event: 'command', id? }` (a command id
  or a list of them), `{ event: 'selection', min? }`, `{ event: 'sim-mode', mode? }`, `{ event: 'scene-change', type? }`;
  `until: (app) => boolean` is polled about eight times a second for anything no event announces. A step that waits
  lets clicks through to the app and gets a **Skip step** button, so a tour can never get stuck.
- `startTour(id, app)`, `stopTour()`, `isTourRunning()`, `runningTourId()`, `onTourChange(fn)`, `getTour`, `listTours`.
- What the user finished or declined is remembered in `localStorage` (key `physicslab.guide.v1`, every access guarded),
  so a tour you offer on first run is not offered twice.

**Context hints** are the small cousin: `registerHint({ id, text, trigger?, when?, delayMs? })` shows a one-time card
above the status bar the first time `trigger` (any `waitFor` event) happens and `when(app)` holds. Hints are
remembered, wait while a tour or dialog is open, and can be switched off with the *Context hints* setting; there is a
rotating tip of the day too (`help.tip`, setting *Tip of the day*). Pass `?nowelcome` in the URL to keep every
unsolicited tour offer, hint and tip away (the test suite does).

The pure parts — step state machine, wait matching, card placement, persistence — are in `src/ui/tour/tourLogic.ts`
(no DOM), tested in `tests/tour.test.ts`; the spotlight itself is driven in a real browser by `e2e/tests/tour.mjs`.

## How to add a joint type

Joint types are the one extension point that is still a closed union (`JointType`), so adding one means touching
a handful of known places. `tests/jointTypes.test.ts` walks every type and checks each place, so a forgotten one
fails with the type's name instead of being drawn as a ball joint or dropped when a file loads. In order:

1. `src/model/types.ts` — add the id to `JointType` (and the fields it needs to `JointEntity`).
2. `src/model/factory.ts` — a label in `JOINT_LABELS` (the compiler asks for it) and defaults in `createJoint`.
3. `src/model/serialize.ts` — the `JOINTS` list, and the sanitising of every new field. A new *field* on existing
   data needs a migration in `src/model/migrations.ts` (see the comment at its top).
4. `src/physics/world/joints.ts` — `addJoint` builds the Rapier joint (the `switch` is exhaustive, so the compiler
   points at it), and the measurement / motor / breakage code reads the type if it behaves differently.
5. `src/render/jointViews.ts` — a colour in `JOINT_COLORS` and the gizmo that draws it; `src/ui/outliner.ts` — an icon
   (`src/ui/icons.ts` if it needs a new one).
6. `src/app/addCatalog.ts` — an entry in `JOINT_ITEMS`: that is the Add tab's tile *and* the command
   `Joint tool: …` in the palette.
7. `src/ui/inspector/joint.ts` — the type-specific sections; then a physics test against an analytic expectation
   in `tests/` and the new id in the list at the top of `tests/jointTypes.test.ts`.

A type whose two ends are *independent* points, like `spring` and `rope` (every other type derives end B from end A so
the joint never starts violated), is also named in two places no test enumerates: `rigid` in `addJoint`
(`src/physics/world/joints.ts`) and the gizmo's choice of which end it moves (`src/app/gizmoController.ts`). Both ask
`hasIndependentAnchors(type)` from `src/model/jointParams.ts` instead of listing types, so a new independent-anchor type
is added to `INDEPENDENT_ANCHOR_TYPES` there (and to `COUPLING_TYPES` when it joins two mechanisms that each have their
own support, to `AXIS_TYPES` / `AXIS_B_TYPES` when it reads `axis` / `params.axisB`).

**Type-specific settings live in `JointEntity.params`** (`src/model/jointParams.ts`: the `JointParams` interface, its
defaults and `sanitizeParams`), not in new top-level fields: cone-twist limits, the six `dof` rows of a 6-DOF joint,
ratio / radii / `axisB` / slip torque of gears and belts, the two pulley points, the screw pitch, the winch load rating,
the soft-weld stiffnesses. Add the field there with a default and a clamp in the sanitiser; a file written before the
field existed loads with the default (`tests/jointParamsSanitize.test.ts` fuzzes the sanitiser, and loads a joint with
no `params` at all).

**Types the engine has no joint for** (pulley, rack, gear, belt, winch, soft weld, and the limits / springs / motors of
cone-twist and 6-DOF) are solved in `src/physics/world/couplings.ts`: `addJoint` gives them an inert engine rope that
only carries the collide flag (or a generic joint holding the positions they do not touch), and `stepCouplings` adds
velocity-level rows (`λ = −(Ċ + bias)/(K + γ)`) as impulses on the two bodies before each engine step. A row sees only
its two bodies and this step's gravity, so the approximations in `docs/LIMITATIONS.md` ("Joint types without an engine
joint") apply to any new coupling. Coupling joints connect bodies that *each already have their own support* (a hinge
or slider to the world): give both ends `anchorA` / `anchorB` and `axis` / `params.axisB` explicitly.

**Tests and examples for a joint type**: the analytic physics goes in `tests/jointCouplings.test.ts` (Atwood
acceleration, gear ratio, rack travel, screw lead, winch rating, cone / 6-DOF limits, soft-weld sag), the example scene
in a content file (`src/model/content/joints-mechanisms.ts` has one per JT-A type) with
`tests/jointExamples.test.ts` running each scene headless and checking its outcome plus a save → load round trip.

```diff
-export type JointType = 'fixed' | 'hinge' | 'slider' | 'ball' | 'spring' | 'rope';
+export type JointType = 'fixed' | 'hinge' | 'slider' | 'ball' | 'spring' | 'rope' | 'cardan';
```

If what you want is a *behaviour* rather than a new constraint — a motor with a torque curve, a joint that breaks
under load, a gear coupling between two hinges — write a **component** with `appliesTo: 'joint'` instead: no
union to extend, and the inspector, undo, saving and the worker integration come for free.

## How to add a zone action

Zones (package ZN, `docs/ARCHITECTURE.md` §6a) are bodies with a `zone` component; what a zone *does* is its `action`.
Actions are not a registry yet, so a new one touches three known places (guarded by `tests/zonePresets.test.ts`, which
builds, saves, loads and runs a zone of every action):

1. `src/model/zones.ts` — an entry in `ZONE_ACTIONS` (id, label, one-line help, icon, colour) and, if it raises a new
   event, its name and payload in `ZoneEventData`.
2. `src/model/components/zone.ts` — the fields it needs, each with `showIf: only('myAction')` so the inspector shows them
   only for that action.
3. `src/physics/zones/actions.ts` — a case in `fire` (once per unit that enters; `ctx.zones` has the loss / respawn,
   rigid-move, spawn and score machinery, `zones.emit` raises the event) or in `applyField` (every step, for each body
   inside). Add a preset in `src/model/zonePresets.ts` for the Add tab and the command palette, and a physics test with an
   analytic expectation (`tests/zones.actions.test.ts` has one per action).

A behaviour that is not "something happens to the bodies that enter" — a force field with its own visuals, a fluid, a
surface — is a **component** (above), not a zone action.

---

## How to make a tile placeable (ghost placement)

A library tile that adds something to the scene shows a **ghost** while it is dragged or armed (`src/app/placementGhost.ts`).
To give a new kind of tile this behaviour, describe what it creates as a `Placeable` (`src/app/placeables.ts`: `bounds()` is
the solid it occupies relative to its pose origin, `entities()` is what the ghost draws, `commit(app, pose)` creates the real
thing as one undo step and `addAtViewCentre(app)` is the double-click) and bind the tile's element with
`bindPlaceable(app, el, placeable.id, () => placeable)` (`src/ui/placementTiles.ts`). Clicking arms it, dragging shows the
ghost, `app.placement.ghost.arm(placeable)` does the same from a command. Keys are handled in one place,
`app.placement.ghost.handleKey(e)`, and `legendEntries()` lists them.

## Testing an extension

- **Pure data and registries** (`registerCommand`, content, shortcuts) run in Node: register, assert, unregister
  with the function the `register…` call returned. `tests/uiRegistry.test.ts` shows the pattern with a fake `App`.
- **Physics** runs the real Rapier engine in Node: `worldOf([...])` and `run(world, seconds)` from
  `tests/helpers.ts`, asserted against an analytic result with an explicit tolerance.
- **The browser**: `e2e/tests/registry.mjs` loads an example into the running app with a dynamic import
  (`await import('/tests/examples/stats-panel.ts')` — the dev server serves the repository), then drives the real UI.
  Run it with `E2E_PORT=5231 E2E_FILTER=extension npm run test:e2e`.
- Before you finish: `npm run typecheck && npm run lint && npm test && npm run build`, then the e2e suite.

## Keeping the download small: `lazy()` (DT-42)

The first load is budgeted (`npm run size`, `scripts/check-size.mjs`, limits in `scripts/size-budget.json`, enforced
in CI). Anything heavy that most sessions never touch — exporters, importers, CSG, the GIF encoder, the circuit
editor, the plugin host, education content, locales — belongs in its own chunk that is fetched on first use:

```typescript
import { lazy } from '../../core/lazy';

const exporters = lazy(() => import('../../export/gltf')); // a separate chunk; nothing is fetched until first call

registerCommand({
  id: 'file.exportGlb',
  label: 'Export glTF…',
  run: async (app) => (await exporters()).exportGlb(app),
});
```

Rules of thumb: put the dynamic `import()` in the *command / panel body*, never at module top level; never
`import` the lazy module statically anywhere else (that pulls it back into the first load); show a spinner or toast
if the load can take a moment. `lazy()` runs the loader once, shares the promise and retries after a failure.
`npm run build && npm run size` prints every chunk, classified as first-load / worker / wasm / css / lazy.

---

## Registry cheat sheet

| Registry | Import | Functions |
|---|---|---|
| commands | `src/app/registry` | `registerCommand`, `unregisterCommand`, `getCommand`, `listCommands`, `runCommand(id, app, source)` |
| tools | `src/app/registry` | `registerTool`, `unregisterTool`, `getTool`, `listTools(region)`, `toolForMode`, `hintForMode` |
| panels | `src/app/registry` | `registerPanel`, `unregisterPanel`, `getPanel`, `listPanels(region)` |
| inspector sections | `src/app/registry` | `registerInspectorSection`, `unregisterInspectorSection`, `listInspectorSections`, `sectionsFor` |
| menus | `src/app/registry` | `registerMenu`, `registerMenuEntry`, `unregisterMenu`, `unregisterMenuEntry`, `resolveMenu` |
| shortcut help | `src/app/registry` | `registerHelp` (gestures), `helpSections` (generated) |
| templates / prefabs / maps | `src/model/content` | `register…`, `unregister…`, `get…`, `list…`, `onContentChange` |
| particle types / fx surfaces | `src/render/fx` | `registerParticleType`, `particleTypes`, `registerFxSurface`, `surfaceFor`; `app.fx.emit` |
| sound events / materials | `src/audio` | `registerSoundEvent`, `soundEvent`, `registerSoundMaterial`, `soundProfileFor`; `app.audio.playEvent` |
| tours / hints | `src/ui/tour` | `registerTour`, `startTour`, `stopTour`, `isTourRunning`, `registerHint` |
| shapes | `src/model/shapeRegistry` | `registerShape`, `getShape`, `listShapes`, `shapeDef` … |
| components | `src/model/componentRegistry` + `src/physics/components` | `registerComponent`, `registerRuntime`, `componentDef`, `listComponents` |

Every registry is built on `Registry<T>` (`src/core/registry.ts`): `register` (returns the unregister function),
`unregister`, `get`, `has`, `list` (sorted by `order`, then registration order), `onChange`, `revision`.
