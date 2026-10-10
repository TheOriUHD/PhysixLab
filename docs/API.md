# PhysixLab public API (`window.physixlab`)

A stable, versioned, typed surface for scripts, bookmarklets, tests, embedding pages and plugins. The TypeScript
definitions are the source of truth: [`src/api/types.ts`](../src/api/types.ts) (every member has a doc comment). A unit
test fails if a member is missing from this page, and every example below is executed in the real app by
`e2e/tests/api.mjs`.

**Versioning (semver).** `physixlab.apiVersion` is `MAJOR.MINOR.PATCH` (currently `1.0.0`). New members → MINOR, bug
fixes → PATCH, removing or changing the meaning of a documented member → MAJOR. Check it before relying on newer
members: `const [major] = physixlab.apiVersion.split('.').map(Number)`.

**Data in, data out.** Entities, documents and vectors are plain JSON. Everything you read is a deep copy; everything
you write is validated by the same sanitisers as opening a file (bad numbers are repaired, unknown kinds rejected), so
a script cannot corrupt the editor. Edits are undoable; `scene.batch` groups several into one undo step.

**What is *not* stable.** `window.physixlab` also still exposes the application's internals (`store`, `editor`,
`viewport`, `sim` …) because tests and DevTools use them. Anything not documented here may change without notice.

Not available here: network, storage or DOM access for sandboxed plugins and scene scripts — those get a message-based
subset of this API ([PLUGINS.md](PLUGINS.md)).

## Quick start

<!-- example: quick-start -->
```js
const id = physixlab.scene.addBody('box', [0, 4, 0], { name: 'Crate' });
physixlab.simulation.play();
await new Promise((r) => setTimeout(r, 300));
console.log(physixlab.query.pose(id).position);
physixlab.simulation.reset();
```

## `physixlab.scene`

| Member | What it does |
|---|---|
| `physixlab.scene.get()` | deep copy of the whole document |
| `physixlab.scene.toJSON(indent?)` | the document as JSON text |
| `physixlab.scene.load(docOrJson)` | replace the scene (validated, migrated); returns `{ name, entities }` |
| `physixlab.scene.clear()` | new empty scene |
| `physixlab.scene.name()` / `physixlab.scene.setName(name)` | scene name |
| `physixlab.scene.entities(filter?)` | copies of entities; filter `{ kind?, name?, tag? }` |
| `physixlab.scene.entity(id)` | one entity copy or `null` |
| `physixlab.scene.add(entities)` | add raw entity objects (validated), returns ids |
| `physixlab.scene.addBody(shape, position?, fields?)` | add a body from a shape id, returns its id |
| `physixlab.scene.update(id, fields)` | merge fields into an entity (validated); `false` if unknown |
| `physixlab.scene.remove(ids)` | delete entities |
| `physixlab.scene.select(ids)` / `physixlab.scene.selection()` | selection |
| `physixlab.scene.settings(patch?)` | read / patch scene settings (gravity, physicsHz …) |
| `physixlab.scene.undo()` / `physixlab.scene.redo()` | history; returns the step label or `null` |
| `physixlab.scene.batch(label, fn)` | run `fn`; all its edits are ONE undo step |

<!-- example: scene-crud -->
```js
const ids = physixlab.scene.batch('Tower', () =>
  [0, 1, 2].map((i) => physixlab.scene.addBody('box', [0, 0.5 + i, 0], { name: `Block ${i}` })),
);
physixlab.scene.update(ids[2], { name: 'Top block' });
physixlab.scene.settings({ gravity: [0, -3.7, 0] }); // Mars
console.log(physixlab.scene.entities({ kind: 'body' }).map((e) => e.name));
physixlab.scene.undo(); // removes the whole tower in one step
```

## `physixlab.simulation`

| Member | What it does |
|---|---|
| `physixlab.simulation.mode` | `'edit' \| 'paused' \| 'running'` |
| `physixlab.simulation.play()` / `.pause()` / `.toggle()` | run control |
| `physixlab.simulation.step(count?)` | advance fixed steps (starts a paused simulation) |
| `physixlab.simulation.reset()` | back to the authored layout |
| `physixlab.simulation.timeScale(value?)` | get / set the speed (0.05–8) |
| `physixlab.simulation.stats()` | `{ simTime, stepCount, bodies, awake, contacts }` or `null` |

## `physixlab.query`

| Member | What it does |
|---|---|
| `physixlab.query.pose(id)` | `{ position, rotation }` — live while simulating |
| `physixlab.query.velocity(id)` | `{ linear, angular }` while simulating, else `null` |
| `physixlab.query.raycast(origin, direction, maxDistance?)` | nearest hit `{ id, distance, point }` in the running simulation |

<!-- example: raycast -->
```js
physixlab.scene.clear();
const ball = physixlab.scene.addBody('sphere', [0, 6, 0], { name: 'Ball' });
physixlab.simulation.play();
await new Promise((r) => setTimeout(r, 400));
const hit = await physixlab.query.raycast([0, 50, 0], [0, -1, 0], 100);
console.log(hit?.id === ball ? 'ray hit the ball' : 'hit ' + hit?.id);
physixlab.simulation.reset();
```

## `physixlab.on(event, handler)`

Returns a function that unsubscribes. Events: `scene:change` `{ type, ids }`, `selection:change` `{ ids }`, `sim:mode`
`{ mode }`, `sim:broken` `{ id, force }`, `toast` `{ text, kind }`.

<!-- example: events -->
```js
const seen = [];
const off = physixlab.on('scene:change', (e) => seen.push(e.type));
physixlab.scene.addBody('box');
off();
physixlab.scene.addBody('box'); // not recorded
console.log(seen);
```

## `physixlab.view`, `physixlab.tools`, `physixlab.actions`

| Member | What it does |
|---|---|
| `physixlab.view.get()` / `physixlab.view.set({ position, target })` | camera |
| `physixlab.view.frameAll()` / `physixlab.view.frameSelection()` | frame the camera |
| `physixlab.tools.list()` / `.current()` / `.set(id)` | pointer tools |
| `physixlab.actions.list()` / `physixlab.actions.run(id)` | every registered command (command palette) by id, e.g. `edit.undo` |

## `physixlab.export`, `physixlab.assets`

| Member | What it does |
|---|---|
| `physixlab.export.json(indent?)` | scene JSON text |
| `physixlab.export.png()` | `Promise<Blob>` of the viewport |
| `physixlab.assets.list()` | `{ id, kind, name, bytes, refs }` per asset (no payload) |
| `physixlab.assets.add(input)` / `physixlab.assets.remove(id)` | asset store |

<!-- example: export -->
```js
const text = physixlab.export.json(2);
const png = await physixlab.export.png();
console.log(JSON.parse(text).format, png.type, physixlab.assets.list().length);
```
