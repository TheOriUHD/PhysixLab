/**
 * ED-22 — user prefab actions that need the running app: the library singleton, save / update from the
 * selection, insertion as ONE undo step, and the drop position under the pointer.
 */
import type { Quat, Vec3 } from '../../core/math';
import { remapAssetRefs } from '../../model/assets';
import {
  PrefabPackError,
  capturePrefab,
  instantiatePrefab,
  rebindVariables,
  type StoredPrefab,
  type VariableValue,
} from '../../model/edit/userPrefab';
import { selectionBounds } from '../../model/edit/bounds';
import { LIMITS } from '../../model/limits';
import { isLight, type Asset, type AssetInput, type Entity } from '../../model/types';
import type { App } from '../app';
import { surfaceDropPose } from './surfaceDrop';
import { PrefabLibrary } from './prefabLibrary';
import { lazyPrefabStorage, openPrefabStorage } from './prefabStorage';
import { makeThumbnail } from './prefabThumbnail';

// ── the library of this app ─────────────────────────────────────────────────────────────────────────

const libraries = new WeakMap<App, PrefabLibrary>();

/** The user prefab library of `app` (created on first use; reads its storage in the background). */
export function prefabLibrary(app: App): PrefabLibrary {
  let lib = libraries.get(app);
  if (!lib) {
    lib = new PrefabLibrary(lazyPrefabStorage(() => openPrefabStorage()));
    libraries.set(app, lib);
  }
  return lib;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ── save / update ───────────────────────────────────────────────────────────────────────────────────

/** Selected, non-trivial entities that a prefab can be made from (ids). */
export function capturableSelection(app: App): string[] {
  return app.store.selection.filter((id) => app.store.has(id));
}

/** Capture the selection as a new prefab (with thumbnail) and store it. Returns null (after a toast) on failure. */
export async function saveSelectionAsPrefab(app: App, name: string, tags: string[]): Promise<StoredPrefab | null> {
  const ids = capturableSelection(app);
  try {
    const p = capturePrefab(app.store.all(), ids, name, { tags, assets: app.store.assets });
    if (!p) {
      app.toast('Select the objects to save as a prefab first.', 'warn');
      return null;
    }
    p.thumbnail = makeThumbnail(p.entities);
    const saved = await prefabLibrary(app).save(p);
    app.toast(`Saved prefab “${saved.name}” (${saved.entities.length} objects)`, 'success');
    return saved;
  } catch (e) {
    app.toast(message(e), 'error');
    return null;
  }
}

/** Replace the stored entities of a prefab with the current selection; id, name, tags, variants and nesting stay. */
export async function updatePrefabFromSelection(app: App, id: string): Promise<StoredPrefab | null> {
  const lib = prefabLibrary(app);
  const cur = lib.get(id);
  if (!cur) return null;
  try {
    const fresh = capturePrefab(app.store.all(), capturableSelection(app), cur.name, {
      assets: app.store.assets,
      tags: cur.tags,
    });
    if (!fresh) {
      app.toast('Select the objects that should replace this prefab first.', 'warn');
      return null;
    }
    const saved = await lib.update(id, {
      entities: fresh.entities,
      assets: fresh.assets,
      variables: rebindVariables(cur.entities, fresh.entities, cur.variables),
      thumbnail: makeThumbnail(fresh.entities),
    });
    const lost =
      cur.variables.reduce((n, v) => n + v.bindings.length, 0) -
      saved.variables.reduce((n, v) => n + v.bindings.length, 0);
    app.toast(
      lost > 0
        ? `Updated “${saved.name}”; ${lost} variable binding(s) lost their object and were removed`
        : `Updated “${saved.name}” from the selection`,
      lost > 0 ? 'warn' : 'success',
    );
    return saved;
  } catch (e) {
    app.toast(message(e), 'error');
    return null;
  }
}

// ── placement ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Where (and turned how) an inserted prefab goes: on the surface under the pointer — or under the lower middle of
 * the view without one — through the shared snap-to-surface helper (ED-15), so the grid / vertex / bounds snaps, the
 * Ctrl inversion and "align to surface normal" behave exactly as for shapes. The prefab is treated as the bounding
 * box of its stored entities (its base sits on y = 0 of its own frame, so the anchor lands on the surface).
 */
export function dropPose(
  app: App,
  prefab: StoredPrefab,
  pointer?: { clientX: number; clientY: number },
  rotation?: Quat,
): { position: Vec3; rotation: Quat } {
  const rect = app.viewport.dom.getBoundingClientRect();
  const e = pointer ?? { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height * 0.6 };
  const box = selectionBounds(
    prefab.entities,
    prefab.entities.map((x) => x.id),
  );
  const pose = surfaceDropPose(app, e.clientX, e.clientY, box ? { min: box.min, max: box.max } : { halfHeight: 0.5 }, {
    rotation,
    invert: !!(pointer as { ctrlKey?: boolean } | undefined)?.ctrlKey,
  });
  return { position: pose.position, rotation: pose.rotation };
}

// ── insert ──────────────────────────────────────────────────────────────────────────────────────────

export interface InsertOptions {
  variantId?: string;
  variableValues?: Record<string, VariableValue>;
  at?: Vec3;
  rotation?: Quat;
  /** Pointer position for the drop point (a drag-and-drop). */
  pointer?: { clientX: number; clientY: number };
}

const stripAsset = (a: Asset): AssetInput => {
  const { id: _id, hash: _hash, bytes: _bytes, ...rest } = a;
  return rest;
};

/**
 * Insert a user prefab as one undo step and select the new objects. Returns the inserted entities (empty after a
 * toast when nothing could be inserted: simulation running, scene full, prefab gone).
 */
export function insertUserPrefab(app: App, id: string, opts: InsertOptions = {}): Entity[] {
  const lib = prefabLibrary(app);
  const prefab = lib.get(id);
  if (!prefab) {
    app.toast('That prefab no longer exists.', 'warn');
    return [];
  }
  if (app.sim.active) {
    app.toast('Stop the simulation (Space) to insert prefabs.', 'warn');
    return [];
  }
  const { store } = app;
  const room = LIMITS.maxEntities - store.all().length;
  try {
    const placed = opts.at ? null : dropPose(app, prefab, opts.pointer, opts.rotation);
    const res = instantiatePrefab(prefab, lib.get, {
      variantId: opts.variantId,
      variableValues: opts.variableValues,
      at: opts.at ?? placed?.position,
      rotation: placed?.rotation ?? opts.rotation,
      takenNames: store.all().map((e) => e.name),
      maxEntities: Math.max(0, room),
    });
    let entities = res.entities;
    const warnings = [...res.warnings];
    // Lights are capped per scene: keep what fits.
    const lightRoom = LIMITS.maxLights - store.lights().length;
    let seen = 0;
    const kept = entities.filter((e) => !isLight(e) || ++seen <= lightRoom);
    if (kept.length !== entities.length) {
      warnings.push(
        `Only ${LIMITS.maxLights} lights fit in a scene; ${entities.length - kept.length} light(s) were left out.`,
      );
      entities = kept;
    }
    store.transact(`Insert ${prefab.name}`, () => {
      // Assets: stored once (content-deduplicated by the store), references follow the ids the store hands out.
      const idMap = new Map<string, string>();
      for (const a of Object.values(res.assets)) idMap.set(a.id, store.addAsset(stripAsset(a)));
      const linked = idMap.size ? remapAssetRefs(entities, (aid) => idMap.get(aid)) : entities;
      store.add(linked, `Insert ${prefab.name}`);
      entities = linked;
    });
    app.toast(`${prefab.name} inserted`, 'success');
    for (const w of warnings) app.toast(w, 'warn');
    return entities;
  } catch (e) {
    app.toast(message(e instanceof PrefabPackError || e instanceof Error ? e : 'Could not insert the prefab'), 'error');
    return [];
  }
}
