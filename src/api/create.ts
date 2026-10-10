/**
 * DT-30: builds the public API object (see ./types.ts) over a narrow `ApiHost`. The host is satisfied by `App`
 * in the browser and by small fakes in unit tests; nothing here touches the DOM except `export.png`.
 *
 * Every value that goes in from the caller is validated through the same sanitisers as a file open
 * (`sanitizeDocument`), every value that comes out is a deep copy.
 */
import { uid } from '../model/factory';
import { parseDocument, sanitizeDocument, serializeDocument } from '../model/serialize';
import type { SceneChange, SceneStore } from '../model/store';
import type { Asset, AssetInput, BodyEntity, Entity, SceneDocument } from '../model/types';
import type { Vec3, Quat } from '../core/math';
import {
  API_VERSION,
  type ApiEvents,
  type EntityPatch,
  type PhysixLabApi,
  type SimMode,
  type Unsubscribe,
} from './types';

/** What the API needs from the app. `App` provides all of it; see `hostOf(app)` in ./install.ts. */
export interface ApiHost {
  store: SceneStore;
  sim: {
    readonly mode: SimMode;
    timeScale: number;
    play(): void;
    pause(): void;
    toggle(): void;
    step(count?: number): void;
    reset(): void;
    poseOf(id: string): { position: Vec3; rotation: Quat } | null;
    velocityOf(id: string): { linear: Vec3; angular: Vec3 } | null;
    client: {
      stats: { simTime: number; stepCount: number; bodies: number; awake: number; contacts: number } | null;
      raycast(origin: Vec3, dir: Vec3, maxDist: number): Promise<{ id: string; distance: number; point: Vec3 } | null>;
    };
  };
  editor: { addShape(type: string, at?: Vec3, over?: Partial<BodyEntity>): BodyEntity };
  loadDocument(doc: SceneDocument): void;
  newScene(): void;
  view: { get(): { position: Vec3; target: Vec3 }; set(v: { position: Vec3; target: Vec3 }): void };
  frameAll(): void;
  frameSelection(): void;
  tools: { list(): { id: string; label: string }[]; current(): string; set(id: string): void };
  commands: { list(): { id: string; label: string; category: string }[]; run(id: string): boolean };
  snapshotPng(): Promise<Blob>;
  onSimMode(fn: (m: SimMode) => void): Unsubscribe;
  onSimBroken(fn: (p: { id: string; force: number }) => void): Unsubscribe;
  onToast(fn: (t: { text: string; kind: string }) => void): Unsubscribe;
}

const clone = <T>(v: T): T => structuredClone(v);

/** Validate raw entity objects the way a file open does, against the entities already in the scene. */
function sanitizeNew(store: SceneStore, raws: EntityPatch[]): Entity[] {
  const base = store.toDocument();
  const known = new Set(base.entities.map((e) => e.id));
  const prepared = raws.map((r) => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) throw new Error('Entities must be plain objects');
    const id =
      typeof r['id'] === 'string' && r['id'] && !known.has(r['id'])
        ? r['id']
        : uid(typeof r['kind'] === 'string' ? r['kind'].slice(0, 4) : 'ent');
    return { ...clone(r), id };
  });
  const out = sanitizeDocument({ ...base, entities: [...base.entities, ...prepared] });
  const ids = new Set(prepared.map((p) => p.id));
  const added = out.entities.filter((e) => ids.has(e.id));
  if (added.length !== prepared.length)
    throw new Error('Some entities were rejected (unknown kind, or a joint referring to a missing body)');
  return added;
}

export function createApi(host: ApiHost): PhysixLabApi {
  const store = host.store;
  const find = (id: string): Entity | null => store.get(id) ?? null;

  const scene: PhysixLabApi['scene'] = {
    get: () => clone(store.toDocument()),
    toJSON: (indent) => serializeDocument(store.toDocument(), indent),
    load(docOrJson) {
      const doc = typeof docOrJson === 'string' ? parseDocument(docOrJson) : sanitizeDocument(clone(docOrJson));
      host.loadDocument(doc);
      return { name: doc.name, entities: doc.entities.length };
    },
    clear: () => host.newScene(),
    name: () => store.name,
    setName: (n) => store.setName(String(n)),
    entities(filter) {
      return store
        .all()
        .filter(
          (e) =>
            (!filter?.kind || e.kind === filter.kind) &&
            (filter?.name === undefined || e.name === filter.name) &&
            (!filter?.tag || ('tags' in e && Array.isArray(e.tags) && e.tags.includes(filter.tag))),
        )
        .map(clone);
    },
    entity: (id) => {
      const e = find(id);
      return e ? clone(e) : null;
    },
    add(entities) {
      const list = sanitizeNew(store, entities);
      store.add(list, 'Add (API)');
      return list.map((e) => e.id);
    },
    addBody(shape, position, fields = {}) {
      const body = host.editor.addShape(shape, position, clone(fields));
      return body.id;
    },
    update(id, fields) {
      const cur = find(id);
      if (!cur) return false;
      const { id: _i, kind: _k, ...rest } = fields as Record<string, unknown>;
      void _i;
      void _k;
      const base = store.toDocument();
      const merged = { ...cur, ...clone(rest) };
      const out = sanitizeDocument({ ...base, entities: base.entities.map((e) => (e.id === id ? merged : e)) });
      const next = out.entities.find((e) => e.id === id);
      if (!next) throw new Error('The update made the entity invalid');
      store.updateMany([[id, next]], 'Edit (API)');
      return true;
    },
    remove: (ids) =>
      store.remove(
        ids.filter((i) => store.has(i)),
        'Delete (API)',
      ),
    select: (ids) => store.setSelection(ids.filter((i) => store.has(i))),
    selection: () => [...store.selection],
    settings(patch) {
      if (patch) {
        const base = store.toDocument();
        const merged = sanitizeDocument({ ...base, settings: { ...clone(base.settings), ...clone(patch) } });
        // Only forward the keys the caller named, taken from the sanitised result.
        const clean: Record<string, unknown> = {};
        for (const k of Object.keys(patch)) clean[k] = (merged.settings as unknown as Record<string, unknown>)[k];
        store.updateSettings(clean, 'Change settings (API)');
      }
      return clone(store.settings);
    },
    undo: () => store.undo(),
    redo: () => store.redo(),
    batch(label, fn) {
      store.begin(label);
      try {
        return fn();
      } finally {
        store.end();
      }
    },
  };

  const simulation: PhysixLabApi['simulation'] = {
    get mode() {
      return host.sim.mode;
    },
    play: () => host.sim.play(),
    pause: () => host.sim.pause(),
    toggle: () => host.sim.toggle(),
    step: (n = 1) => host.sim.step(Math.max(1, Math.floor(n))),
    reset: () => host.sim.reset(),
    timeScale(v) {
      if (v !== undefined && Number.isFinite(v)) host.sim.timeScale = Math.min(8, Math.max(0.05, v));
      return host.sim.timeScale;
    },
    stats() {
      const s = host.sim.client.stats;
      return s
        ? { simTime: s.simTime, stepCount: s.stepCount, bodies: s.bodies, awake: s.awake, contacts: s.contacts }
        : null;
    },
  };

  const query: PhysixLabApi['query'] = {
    pose: (id) => {
      const p = host.sim.poseOf(id);
      return p ? clone(p) : null;
    },
    velocity: (id) => {
      const v = host.sim.velocityOf(id);
      return v ? { linear: [...v.linear], angular: [...v.angular] } : null;
    },
    async raycast(origin, direction, maxDistance = 100) {
      if (host.sim.mode === 'edit') return null;
      const hit = await host.sim.client.raycast(origin, direction, maxDistance);
      return hit ? { id: hit.id, distance: hit.distance, point: [...hit.point] } : null;
    },
  };

  const assets: PhysixLabApi['assets'] = {
    list: () =>
      Object.values(store.assets).map((a: Asset) => ({
        id: a.id,
        kind: a.kind,
        name: a.name,
        bytes: a.bytes,
        refs: store.assetRefCount(a.id),
      })),
    add: (input: AssetInput) => store.addAsset(clone(input), 'Add asset (API)'),
    remove: (id) => store.removeAsset(id, 'Remove asset (API)'),
  };

  const api: PhysixLabApi = {
    apiVersion: API_VERSION,
    scene,
    simulation,
    query,
    view: {
      get: () => clone(host.view.get()),
      set: (v) => host.view.set(clone(v)),
      frameAll: () => host.frameAll(),
      frameSelection: () => host.frameSelection(),
    },
    tools: { list: () => host.tools.list(), current: () => host.tools.current(), set: (id) => host.tools.set(id) },
    actions: { list: () => host.commands.list(), run: (id) => host.commands.run(id) },
    export: { json: (indent) => serializeDocument(store.toDocument(), indent), png: () => host.snapshotPng() },
    assets,
    on<K extends keyof ApiEvents>(event: K, handler: (payload: ApiEvents[K]) => void): Unsubscribe {
      const h = handler as (p: unknown) => void;
      switch (event) {
        case 'scene:change':
          return store.on('change', (c: SceneChange) =>
            h({ type: c.type, ids: 'ids' in c ? [...c.ids] : [] } satisfies ApiEvents['scene:change']),
          );
        case 'selection:change':
          return store.on('selection', (ids) => h({ ids: [...ids] }));
        case 'sim:mode':
          return host.onSimMode((mode) => h({ mode }));
        case 'sim:broken':
          return host.onSimBroken((p) => h({ id: p.id, force: p.force }));
        case 'toast':
          return host.onToast((t) => h(t));
        default:
          throw new Error(`Unknown event "${String(event)}"`);
      }
    },
  };
  return api;
}
