# PhysicsLab public API (`window.physicslab`)

A stable, versioned, typed surface for scripts, bookmarklets, tests, embedding pages and plugins. The TypeScript
definitions are the source of truth: [`src/api/types.ts`](../src/api/types.ts) (every member has a doc comment). A unit
test fails if a member is missing from this page, and every example below is executed in the real app by
`e2e/tests/api.mjs`.

**Versioning (semver).** `physicslab.apiVersion` is `MAJOR.MINOR.PATCH` (currently `1.0.0`). New members → MINOR, bug
fixes → PATCH, removing or changing the meaning of a documented member → MAJOR. Check it before relying on newer
members: `const [major] = physicslab.apiVersion.split('.').map(Number)`.

**Data in, data out.** Entities, documents and vectors are plain JSON. Everything you read is a deep copy; everything
you write is validated by the same sanitisers as opening a file (bad numbers are repaired, unknown kinds rejected), so
a script cannot corrupt the editor. Edits are undoable; `scene.batch` groups several into one undo step.

**What is *not* stable.** `window.physicslab` also still exposes the application's internals (`store`, `editor`,
`viewport`, `sim` …) because tests and DevTools use them. Anything not documented here may change without notice.

Not available here: network, storage or DOM access for sandboxed plugins and scene scripts — those get a message-based
subset of this API ([PLUGINS.md](PLUGINS.md)).

## Quick start

<!-- example: quick-start -->
```js
const id = physicslab.scene.addBody('box', [0, 4, 0], { name: 'Crate' });
physicslab.simulation.play();
await new Promise((r) => setTimeout(r, 300));
console.log(physicslab.query.pose(id).position);
physicslab.simulation.reset();
```

## `physicslab.scene`

| Member | What it does |
|---|---|
| `physicslab.scene.get()` | deep copy of the whole document |
| `physicslab.scene.toJSON(indent?)` | the document as JSON text |
| `physicslab.scene.load(docOrJson)` | replace the scene (validated, migrated); returns `{ name, entities }` |
| `physicslab.scene.clear()` | new empty scene |
| `physicslab.scene.name()` / `physicslab.scene.setName(name)` | scene name |
| `physicslab.scene.entities(filter?)` | copies of entities; filter `{ kind?, name?, tag? }` |
| `physicslab.scene.entity(id)` | one entity copy or `null` |
| `physicslab.scene.add(entities)` | add raw entity objects (validated), returns ids |
| `physicslab.scene.addBody(shape, position?, fields?)` | add a body from a shape id, returns its id |
| `physicslab.scene.update(id, fields)` | merge fields into an entity (validated); `false` if unknown |
| `physicslab.scene.remove(ids)` | delete entities |
| `physicslab.scene.select(ids)` / `physicslab.scene.selection()` | selection |
| `physicslab.scene.settings(patch?)` | read / patch scene settings (gravity, physicsHz …) |
| `physicslab.scene.undo()` / `physicslab.scene.redo()` | history; returns the step label or `null` |
| `physicslab.scene.batch(label, fn)` | run `fn`; all its edits are ONE undo step |

<!-- example: scene-crud -->
```js
const ids = physicslab.scene.batch('Tower', () =>
  [0, 1, 2].map((i) => physicslab.scene.addBody('box', [0, 0.5 + i, 0], { name: `Block ${i}` })),
);
physicslab.scene.update(ids[2], { name: 'Top block' });
physicslab.scene.settings({ gravity: [0, -3.7, 0] }); // Mars
console.log(physicslab.scene.entities({ kind: 'body' }).map((e) => e.name));
physicslab.scene.undo(); // removes the whole tower in one step
```

## `physicslab.simulation`

| Member | What it does |
|---|---|
| `physicslab.simulation.mode` | `'edit' \| 'paused' \| 'running'` |
| `physicslab.simulation.play()` / `.pause()` / `.toggle()` | run control |
| `physicslab.simulation.step(count?)` | advance fixed steps (starts a paused simulation) |
| `physicslab.simulation.reset()` | back to the authored layout |
| `physicslab.simulation.timeScale(value?)` | get / set the speed (0.05–8) |
| `physicslab.simulation.stats()` | `{ simTime, stepCount, bodies, awake, contacts }` or `null` |

## `physicslab.query`

| Member | What it does |
|---|---|
| `physicslab.query.pose(id)` | `{ position, rotation }` — live while simulating |
| `physicslab.query.velocity(id)` | `{ linear, angular }` while simulating, else `null` |
| `physicslab.query.raycast(origin, direction, maxDistance?)` | nearest hit `{ id, distance, point }` in the running simulation |

<!-- example: raycast -->
```js
physicslab.scene.clear();
const ball = physicslab.scene.addBody('sphere', [0, 6, 0], { name: 'Ball' });
physicslab.simulation.play();
await new Promise((r) => setTimeout(r, 400));
const hit = await physicslab.query.raycast([0, 50, 0], [0, -1, 0], 100);
console.log(hit?.id === ball ? 'ray hit the ball' : 'hit ' + hit?.id);
physicslab.simulation.reset();
```

## `physicslab.on(event, handler)`

Returns a function that unsubscribes. Events: `scene:change` `{ type, ids }`, `selection:change` `{ ids }`, `sim:mode`
`{ mode }`, `sim:broken` `{ id, force }`, `toast` `{ text, kind }`.

<!-- example: events -->
```js
const seen = [];
const off = physicslab.on('scene:change', (e) => seen.push(e.type));
physicslab.scene.addBody('box');
off();
physicslab.scene.addBody('box'); // not recorded
console.log(seen);
```

## `physicslab.view`, `physicslab.tools`, `physicslab.actions`

| Member | What it does |
|---|---|
| `physicslab.view.get()` / `physicslab.view.set({ position, target })` | camera |
| `physicslab.view.frameAll()` / `physicslab.view.frameSelection()` | frame the camera |
| `physicslab.tools.list()` / `.current()` / `.set(id)` | pointer tools |
| `physicslab.actions.list()` / `physicslab.actions.run(id)` | every registered command (command palette) by id, e.g. `edit.undo` |

## `physicslab.export`, `physicslab.assets`

| Member | What it does |
|---|---|
| `physicslab.export.json(indent?)` | scene JSON text |
| `physicslab.export.png()` | `Promise<Blob>` of the viewport |
| `physicslab.assets.list()` | `{ id, kind, name, bytes, refs }` per asset (no payload) |
| `physicslab.assets.add(input)` / `physicslab.assets.remove(id)` | asset store |

<!-- example: export -->
```js
const text = physicslab.export.json(2);
const png = await physicslab.export.png();
console.log(JSON.parse(text).format, png.type, physicslab.assets.list().length);
```
