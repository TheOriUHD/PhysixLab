# Embedding PhysicsLab, link previews and QR codes (DT-21, DT-22)

## 1. The viewer (`?embed=1`)

Open the app with `embed=1` and it boots a minimal viewer instead of the editor: no panels, menus, toolbox, status bar,
shortcuts or autosave, only the scene and (optionally) a slim bar with play / pause, reset, camera reset and the
simulated clock. Nothing is persisted either: the viewer never touches the editor's autosave, scene library or
preferences, even though it runs on the same origin.

| Parameter | Meaning |
|---|---|
| `embed=1` | Turns the viewer on. |
| `scene=<id>` | Opens a bundled example scene (`car`, `wreck`, …; the ids of the *File → Example scenes* menu). Without `scene` and without a hash the `car` scene is shown. An unknown id is reported in the viewer and as an `error` event. |
| `#s=<payload>` / `#scene=<payload>` | A share link (compact v2, or v1). Wins over `scene=`. Make one with *File → Share…* or `app.persistence.shareInfo()`. |
| `autoplay=1` | Start the simulation as soon as the scene is loaded. |
| `controls=0` | Hide the bar (the parent can still drive playback with messages). |
| `camera=orbit\|fixed` | `orbit` (default): right-drag orbits, middle-drag pans, wheel zooms. `fixed`: the camera is locked. |
| `view=px,py,pz,tx,ty,tz` | Opening camera position and target (the Embed dialog fills this from your current view). |
| `interact=1` | Viewers may grab and throw bodies **while the simulation runs**. Still no editing: nothing can be selected, moved while stopped, deleted or changed, and editor keyboard shortcuts do not exist. Keys that drive the scene (motor / thruster bindings, e.g. W A S D in the car) work either way once the viewer has focus. |
| `origin=https://a.example,https://b.example` | Allow-list of parent origins for the message API (see below). |

Editing is locked by construction: the viewer never builds the editor UI or the input controller; with `interact=1`
only a pointer press that grabs a body of a running simulation reaches it, and the selection is cleared whenever it
changes.

Not implemented: `bg=transparent|light|dark`. The renderer has an opaque sky and no alpha buffer; see
`docs/LIMITATIONS.md`.

### The Embed dialog

*File → Embed in a web page…* (command `file.embed`) builds the snippet from options (size, start playing, bar, camera
lock, grabbing, current camera) with a live preview and a copy button. The scene travels inside the link (a
`#s=` payload), so the embed shows the scene as it was when you made the snippet. If the scene is too large for a
link the dialog says so and offers nothing to copy; host the scene file and use your own page instead.

```html
<iframe src="https://YOUR-HOST/physicslab/?embed=1&amp;autoplay=1#s=…" width="640" height="400"
        style="border:0;max-width:100%" title="PhysicsLab simulation" loading="lazy"
        allow="fullscreen" allowfullscreen></iframe>
```

The preview inside the dialog is a real second viewer on the same origin, so it shares the page's thread: on a slow
machine the dialog is sluggish for a moment while the preview boots.

## 2. The `postMessage` API (protocol version 1)

All messages are plain objects with `type: 'physicslab'`. The viewer ignores everything else.

**Parent to viewer** (`iframe.contentWindow.postMessage(msg, viewerOrigin)`):

```js
{ type: 'physicslab', v: 1, id: 'optional-correlation-id', cmd: 'play' }
```

| `cmd` | Extra fields | Effect |
|---|---|---|
| `hello` | | Answers with `ready` (use it when you missed the first `ready`). |
| `play`, `pause` | | Start / pause (`play` builds the physics world on first use). |
| `reset` | | Stop and return to the edit pose (the scene as loaded). |
| `step` | `count?` (integer 1-600, default 1) | Advance fixed steps; leaves the simulation paused. |
| `loadScene` | exactly one of `template: '<id>'`, `share: '<link or s=… payload>'`, `document: {…scene JSON…}` | Replace the scene (sanitised like any opened file). |
| `setCamera` | `reset: true`, or `position: [x,y,z]` and / or `target: [x,y,z]` | Move the camera; `reset` returns to the opening view. |
| `getState` | | Answers with `state`. |

**Viewer to parent:**

```js
{ type: 'physicslab', v: 1, event: 'ready', capabilities: [...], state }   // once, after the scene is loaded
{ type: 'physicslab', v: 1, event: 'state', reason: 'play', state, id? }    // reply to a command; also sent when play / pause / reset happens by any means
{ type: 'physicslab', v: 1, event: 'error', code, message, id? }            // codes: bad-message, bad-scene, failed
```

`state` is `{ mode: 'edit'|'paused'|'running', time /* simulated seconds */, sceneName, bodies, camera: { position, target } }`.
`id`, when you send one, is echoed on the reply to that command.

Example host:

```js
const frame = document.querySelector('iframe');
const VIEWER = 'https://YOUR-HOST';
addEventListener('message', (e) => {
  if (e.source !== frame.contentWindow || e.origin !== VIEWER) return;
  if (e.data?.type === 'physicslab' && e.data.event === 'ready') {
    frame.contentWindow.postMessage({ type: 'physicslab', cmd: 'play' }, VIEWER);
  }
});
```

### Security model

* The viewer only accepts messages whose `event.source` is `window.parent`; a message posted by the viewer itself or by
  any other window is dropped.
* With `origin=…` only messages whose `event.origin` is in the list are accepted (exact match; a sandboxed frame's
  opaque `"null"` origin never matches). A message from any other origin gets **no reply**, not even an error.
  Without `origin=` any parent may control playback and load scenes into the viewer: that is the point of an embed,
  and there is nothing in the viewer to steal (no accounts, no storage access).
* Replies go to the sender's origin. The unsolicited `ready` goes to the parent origin when the browser exposes it
  (`location.ancestorOrigins`, else the referrer); if neither is known and no allow-list is set it is sent with
  target `*` (it contains only the scene name and counts). With an allow-list and an unknown parent origin it is not
  sent: send `hello` after loading and you get `ready` as the reply.
* Every field is validated (types, ranges, string and size limits); malformed messages get an `error` reply and change
  nothing. Loaded scenes go through the same sanitising as files.
* Versioning: `v` is optional in commands; a command with another `v` is rejected. New commands and fields will be
  added without bumping `v`; a breaking change bumps it.

## 3. Share dialog, preview image, QR code (DT-21)

*File → Share with preview and QR code…* (command `file.shareDialog`; the one-click *Copy share link* stays):

* the link with its size, and "N % shorter" than the previous (v1) link format;
* a PNG thumbnail of the viewport (up to 640 px), *Download image*;
* *Copy image + link*: one clipboard item with `image/png` and `text/plain`, which chat apps paste as a picture with
  its link. Browsers without `ClipboardItem` (or that refuse the write) copy the link only, and the toast says so;
* a QR code of the link (byte mode, error correction M, or L when the link does not fit M), *Download QR (SVG)*. The
  encoder is `src/app/share/qr.ts` (pure, versions 1-40, up to 2953 bytes at L / 2331 at M). When the link is longer
  than that the dialog says so and offers the scene as a file instead; links beyond the 32 kB link limit offer the file
  only;
* *Copy Open Graph tags*, see below.

### Open Graph metadata template

A static page cannot give each scene its own preview card: the scene lives in the URL fragment (`#s=…`), which
servers and crawlers never see. A host that wants preview cards (a blog, a forum, a gallery) therefore serves a small
landing page per scene, with the meta tags in its `<head>`, that redirects to (or embeds) the viewer:

```html
<meta property="og:type" content="website">
<meta property="og:site_name" content="PhysicsLab">
<meta property="og:title" content="Drivable car">
<meta property="og:description" content="An interactive physics scene - open the link to play with it.">
<meta property="og:url" content="https://YOUR-HOST/scenes/drivable-car">
<meta property="og:image" content="https://YOUR-HOST/scenes/drivable-car.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="640">
<meta property="og:image:height" content="360">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Drivable car">
<meta name="twitter:image" content="https://YOUR-HOST/scenes/drivable-car.png">
```

1. In the share dialog press *Download image* and upload the PNG to your host (the image URL must be absolute and
   public).
2. Press *Copy Open Graph tags*, paste them into the landing page and replace `YOUR-HOST/preview.png` with the image URL.
3. Make the landing page open the scene: a `<meta http-equiv="refresh" content="0; url=…">` or a link to the share link /
   `?embed=1` viewer URL.

`buildOpenGraphTags` in `src/app/share/openGraph.ts` generates exactly this (HTML-escaped).
