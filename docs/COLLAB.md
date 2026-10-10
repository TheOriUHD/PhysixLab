# Peer-to-peer collaboration (DT-23)

*File > Collaborate...* (command `collab.open`, also in the palette) edits one scene together with other people. There is no server: browsers talk to each other.

## Using it

* **Host a session** shares the scene you have open. A room code appears (e.g. `K7Q2M9TX`).
* **Same browser, another tab/window:** type the room code in *Join in this browser* (BroadcastChannel; same browser profile and origin). Joining **replaces** the joiner's scene with the host's.
* **Another computer (WebRTC):** host clicks *Create invitation* and sends the `PLRTC1.…` code; the guest pastes it under *Connect another computer*, clicks *Create answer* and sends the answer code back; the host pastes it and clicks *Connect*. One invitation per guest. Codes are single-line, validated, and contain only a session description (network candidates), never your scene.
* A status chip in the viewport ("Hosting · 2 peers") reopens the dialog; *Leave* keeps your current scene.

## What is shared

| Thing | How |
|---|---|
| Document edits (add/delete/move/rename/materials/joints/settings/scene name) | operation log, last-writer-wins per field |
| Selection | each peer's selected objects are drawn as a coloured outline with the peer's name |
| Simulation | **host-authoritative**: the host's play/pause/reset (edit mode) is broadcast; guests follow and cannot override it |

## Design (`src/collab/`)

* `opLog.ts` — `Replica`: a CRDT-lite state of LWW registers (entity existence, entity field, scene key). A stamp is `(Lamport clock, site id)`; the larger stamp wins, so concurrent edits resolve identically everywhere. Applying is commutative, associative and **idempotent**: a duplicate/echo returns `false` and changes nothing, which is also what prevents relay loops. Delete beats a concurrent edit; a later re-add resurrects. Operations that arrive before their entity's `add` are held. Only registers are stored (bounded by document size, not history).
* `docSync.ts` — the thin adapter to `SceneStore`. Local: on every store `change`/`meta`, the store is diffed against a *mirror* of what was last synchronised and turned into operations. Remote: operations go into the replica, the replica is materialised and run through the normal `sanitizeDocument`, and only the differences are written to the store inside one `transact('Remote edit')`; a flag plus a refreshed mirror means remote application is never re-broadcast.
* `transport.ts` — `Link` interface; `BroadcastLink`, `WebRtcLink` (manual signalling, no trickle, no STUN/TURN), `LoopbackBus` (tests).
* `session.ts` — roles, hello/sync/ops/presence/sim/bye messages, the host as hub (relays between WebRTC guests), host-authoritative sim via a `SimBridge`.
* UI: `src/ui/extensions/collab.ts` (commands + menu), `collabDialog.ts`, `collabController.ts`, `collabCursors.ts`, `styles/collab.css`.

## Undo

Undo is **local and not collaborative**. A received batch is one undo step labelled "Remote edit" in the receiver's history; undoing restores that peer's earlier document snapshot and the resulting difference is broadcast as ordinary new edits (so it can revert a collaborator's later change). Edits go straight to the store, not through `Editor` commands, so collaborators' edits do not take the receiving user's undo *context* (selection, tool) into account.

## Security model

Peers are untrusted. Every message is size-capped (4 M chars), JSON-parsed defensively and validated field by field: site ids, entity ids (<= 64), field names (identifier syntax, no `__proto__`/`constructor`/`prototype`), clocks (integers), value size (256 KB), operation count per message (4000), fields per entity (128), entities per replica. The materialised document goes through `sanitizeDocument` (clamping, unknown fields/shapes dropped, references repaired), so a hostile peer can at worst put sanitised junk into the shared scene (like any collaborator). On WebRTC links a host binds each link to the site id of its first `hello` and drops messages claiming another id. Display names are stripped of control characters and `<>` and rendered via `textContent`; colours are derived locally from the site id. BroadcastChannel traffic is same-origin/same-profile, so the room code is a convenience, not a secret. Sim control is accepted only from the site that answered our `hello`.

## Limits

See `docs/LIMITATIONS.md` (DT-23): no server/TURN, manual signalling, assets are not synchronised, guests re-simulate rather than receive poses.
