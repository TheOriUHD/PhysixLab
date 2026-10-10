# Data platform (package DT-A)

Storage, recovery, sync and sharing. There is **no backend**: "cloud" means a folder your own sync client keeps
(Dropbox, Google Drive, iCloud, OneDrive), and sharing means a link that carries the whole scene.

## Storage layer — `src/app/storage/`

A small async key/value API grouped in **collections**, backed by IndexedDB (database `physixlab`), with an in-memory
fallback when IndexedDB is unavailable (the app then shows a warning that work is kept in memory only).

```ts
import { getStorage } from '../app/storage';

const s = await getStorage();                   // StorageBackend (never rejects: falls back to memory)
await s.put('scenes', 'my-id', { name: 'x' });  // any structured-cloneable value
const v = await s.get<MyType>('scenes', 'my-id');
const ids = await s.keys('scenes');             // sorted
const all = await s.list<MyType>('scenes');     // [{ key, value }] sorted by key
await s.delete('scenes', 'my-id');
await s.clear('thumbnails');
```

Collections (`COLLECTIONS` in `types.ts`): `scenes`, `assets`, `thumbnails`, `prefabs`, `replays`, `settings`,
`snapshots`, `meta`. A new collection = one entry in that list (and nothing else; the object stores are created from it
on the next database upgrade — bump `DB_VERSION` in `idb.ts` when you add one).

* `put` rejects with `StorageError` (`code: 'quota' | 'unavailable' | 'failed'`); the message is written for the user.
* `storageUsage()` returns bytes per collection plus the browser's origin usage / quota (`navigator.storage.estimate`).
  *File → Storage…* shows it as a meter with per-collection cleanup, and can ask the browser for persistent storage.
* **Migration.** On first start with the new layer, `physixlab:autosave:v1` and `physixlab:library:v1` are copied
  into IndexedDB (`meta/autosave`, `scenes/<id>`), verified by reading back, and only then removed from localStorage.
  A damaged library value is left in place rather than deleted. A marker (`meta/migrated-localstorage`) stops a rerun.
* **What stays in localStorage**, deliberately: UI preferences (`physixlab:prefs:v1`, panel state) — tiny and needed
  synchronously before the first paint — and the crash-detection session record (it must be written while the page is
  unloading, which IndexedDB cannot guarantee).
* `Persistence` keeps its synchronous API (`library()`, `loadAutosave()` …) over an in-memory cache filled by
  `await persistence.init()`; writes are queued and flushed in order (`persistence.flush()`).

## Restore points — `storage/restorePoints.ts`, *File → Restore points…*

Labelled snapshots in the `snapshots` collection: **automatic** (every N minutes, only when the scene changed, identical
content skipped), **before** a risky operation (`riskyOperation('Before …')` — currently every scene replacement:
opening a template/map/library scene/file, new scene, restoring another point) and **manual**. Limits (interval, max
automatic, max before, total bytes) are editable in the dialog; manual points are never pruned by count, and the newest
point always survives the size cap. Each card shows a viewport thumbnail, age, kind, object count and a diff summary
against the current scene ("+3 added, −1 removed, 5 changed"). Restoring takes a "before restoring" point first.

## Crash recovery — `storage/recovery.ts`, `data/platform.ts`

A session record (`physixlab:session:v1`) is refreshed every 4 s and marked clean on `pagehide`/`beforeunload`. A
record that is not clean with a heartbeat older than 12 s is a crashed or killed session (a fresh heartbeat from another
id means a second tab is open, not a crash). On such a start the autosave opens as usual; if it is missing the newest
restore point opens; a banner explains what happened and links to the restore-point browser.

**Worker crash.** `SimClient` emits `crash` when the physics worker throws an uncaught error or does not answer a tick
for 10 s. The page terminates and respawns the worker, returns to the authored layout (the document is untouched) and
shows a banner. Limits: a crash is not detected while the tab is in the background (no ticks are sent then).

## Folder sync — `storage/folderSync.ts`, *File → Folder sync…*

Needs the File System Access API (Chromium browsers). Other browsers get a clear message pointing at *Export*/*Import*.
The chosen directory handle is remembered in IndexedDB; after a restart the browser asks for permission again
(*Reconnect*). Scenes are written as `<scene name>.physixlab.json` after each autosave. Browsers have no file-watching
API, so the folder is **polled every 3 s**; if a known file changed on disk (another computer synced a newer version) a
dialog offers *Load the folder version*, *Keep both*, *Keep mine (overwrite)* or *Decide later* — nothing is overwritten
before the choice.

## Table export and lab report — `src/app/export/dataExport.ts`, `report.ts`

`registerDataSource({ id, label, table(app) })` makes any set of numbers exportable as CSV (RFC 4180), JSON or
tab-separated clipboard text; the telemetry charts are registered sources. *Export report…* builds one standalone HTML
page (screenshot, scene parameters, object table, charts as inline SVG, optional notes) with no scripts and no external
resources.

## Share links — `src/app/share/`

See `docs/LIMITATIONS.md` ("Share links v2"). `#s=` links use `compact.ts` (quantised, delta-coded against frozen
defaults, entity ids replaced by positions, base64 asset payloads stored as bytes, then deflate + base64url); old
`#scene=` links still open. `tests/shareLink.test.ts` measures every bundled template and map against the v1 link and
fails below 40 % (currently 45–83 %). `src/app/share/defaults.ts` is generated
(`GEN_SHARE_DEFAULTS=1 npx vitest run tests/genShareDefaults.test.ts`): regenerate it while v2 is unreleased whenever
documents gain fields; **after the first public release never regenerate it** — old links were encoded against exactly
those values (stale defaults only cost a few bytes).
