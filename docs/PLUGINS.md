# Plugins (DT-31)

**File → Plugins…** opens the plugin manager: install from pasted code, a file, a URL or the two shipped examples
(*Gravity presets*, *Domino tools*), enable / disable / remove, see each plugin's state, error and granted permissions.
Installed plugins are remembered (localStorage) and started when the app starts.

A plugin is one JavaScript file that begins with a manifest comment, then uses the global `plugin` object:

```js
/* @physicslab-plugin
{ "id": "hello", "name": "Hello", "version": "1.0.0",
  "description": "Says hello", "permissions": ["ui", "scene.read"] }
*/
await plugin.registerCommand({
  id: 'count', label: 'Count objects',
  run: async () => plugin.toast('There are ' + (await plugin.scene.entities()).length + ' objects'),
});
await plugin.registerPanel({
  id: 'panel', label: 'Hello', region: 'right',
  render: async () => ({ type: 'column', children: [
    { type: 'heading', text: 'Hello' },
    { type: 'button', label: 'Count', onClick: () => plugin.toast('clicked') },
  ] }),
});
```

## Permissions

The manifest is read as data *before* any code runs; the install dialog lists the permissions and the user can untick
any of them. Only what is granted works; everything else rejects with a message naming the permission.

| Permission | Allows |
|---|---|
| `ui` | `registerCommand`, `registerPanel`, `registerTemplate`, `toast`, `refresh` |
| `scene.read` | `plugin.scene.get/toJSON/name/entities/entity/selection/settings()`, `plugin.query.*`, scene events |
| `scene.write` | `plugin.scene.load/clear/setName/add/addBody/update/remove/select/undo/redo/batch`, settings patch |
| `simulation` | `plugin.simulation.*`, simulation events |
| `view` | `plugin.view.*` |

**Never available, whatever the manifest says:** network, storage, the page's DOM, other windows, nested workers.

## API of `plugin`

Same data model and semantics as [`window.physicslab`](API.md) (`plugin.scene`, `plugin.simulation`, `plugin.query`,
`plugin.view`), but every call is asynchronous (it crosses the sandbox boundary) — `await` it. Additions:
`plugin.scene.batch(label, [['addBody', 'box', [0,1,0]], ['update', id, {…}]])` (one undo step),
`plugin.on(event, handler)` (events of the public API; delivered coalesced, at most one in flight),
`plugin.registerCommand({ id, label, category?, description?, run })` → palette command `plugin.<pluginId>.<id>`,
`plugin.registerPanel({ id, label, region?, render })` → a dock tab,
`plugin.registerTemplate({ id, name, category?, blurb?, build(dsl) })` → an example scene in the Scenes tab, built
with the [Builder DSL](SCRIPTING.md) at registration time,
`plugin.toast(text, kind?)`, `plugin.refresh()` (re-render this plugin's panels).

### Declarative panels

`render()` returns a tree of plain objects: `column` / `row` (`children`), `heading`, `text`, `muted` (`text`), `divider`,
`button` (`label`, `primary`, `onClick`), `number` (`label`, `value`, `min`, `max`, `step`, `onChange(v)`), `checkbox`
(`label`, `value`, `onChange(v)`), `select` (`label`, `value`, `options`, `onChange(v)`), `progress` (`label`, `value` 0–1),
`table` (`columns`, `rows`). The host validates the tree (≤ 400 elements, depth ≤ 8, text ≤ 500 chars) and builds the DOM
itself with `textContent` — a plugin cannot inject markup. The panel re-renders when shown, after a callback ran, and on
`plugin.refresh()`.

## Isolation and error containment

Each plugin has its own sandbox (see [SCRIPTING.md](SCRIPTING.md)): opaque-origin iframe + CSP + a locked-down worker.
Failures stay contained: a plugin that throws while starting, hangs (callbacks have a 3 s limit; the sandbox is then
killed), floods the host (100 000 call budget) or returns an invalid panel ends in the **error** state with its message;
its commands, panels and templates are removed; the app and other plugins keep running (`e2e/tests/plugins.mjs`). A
callback that merely throws shows a warning toast.

Tested (`tests/plugins.test.ts`, `e2e/tests/plugins.mjs`): installing through the real UI with the permission prompt,
command + panel + template, one-undo-step batch, reload persistence, permission enforcement (including a declined
permission staying declined), a hostile plugin with *all* permissions against a canary server (0 requests), crash and
hang containment, disable/remove cleanup, no markup injection.

**Not supported (honest scope):** plugin-defined *components* and *shapes*. Components run inside the physics worker
every step and shapes build Rapier colliders; neither can be handed to untrusted code without giving up the isolation.
Plugins can contribute scenes (templates built from existing shapes) instead.
