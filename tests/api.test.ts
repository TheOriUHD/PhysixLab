import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createApi, type ApiHost } from '../src/api/create';
import { API_VERSION, type PhysicsLabApi } from '../src/api/types';
import { createBody } from '../src/model/factory';
import { SceneStore } from '../src/model/store';
import type { BodyEntity } from '../src/model/types';
import type { Vec3 } from '../src/core/math';

function fakeHost(): { host: ApiHost; api: PhysicsLabApi; store: SceneStore; log: string[] } {
  const store = new SceneStore();
  const log: string[] = [];
  let mode: 'edit' | 'paused' | 'running' = 'edit';
  const modeListeners = new Set<(m: typeof mode) => void>();
  const setMode = (m: typeof mode) => {
    mode = m;
    modeListeners.forEach((f) => f(m));
  };
  const host: ApiHost = {
    store,
    sim: {
      get mode() {
        return mode;
      },
      timeScale: 1,
      play: () => setMode('running'),
      pause: () => setMode('paused'),
      toggle: () => setMode(mode === 'running' ? 'paused' : 'running'),
      step: () => setMode('paused'),
      reset: () => setMode('edit'),
      poseOf: (id) => {
        const b = store.body(id);
        return b ? { position: b.position, rotation: b.rotation } : null;
      },
      velocityOf: () => null,
      client: { stats: null, raycast: () => Promise.resolve(null) },
    },
    editor: {
      addShape: (type, at, over) => {
        const b = createBody({
          name: store.uniqueName('Body'),
          shape: { type: type, size: [1, 1, 1] },
          position: at ?? [0, 1, 0],
          ...over,
        });
        store.add([b], 'Add');
        return b;
      },
    },
    loadDocument: (d) => store.load(d),
    newScene: () => store.clear(),
    view: { get: () => ({ position: [1, 2, 3] as Vec3, target: [0, 0, 0] as Vec3 }), set: () => undefined },
    frameAll: () => log.push('frameAll'),
    frameSelection: () => log.push('frameSelection'),
    tools: {
      list: () => [{ id: 'select', label: 'Select' }],
      current: () => 'select',
      set: (id) => log.push(`tool:${id}`),
    },
    commands: { list: () => [], run: (id) => (log.push(`cmd:${id}`), true) },
    snapshotPng: () => Promise.resolve(new Blob([])),
    onSimMode: (fn) => (modeListeners.add(fn), () => modeListeners.delete(fn)),
    onSimBroken: () => () => undefined,
    onToast: () => () => undefined,
  };
  return { host, api: createApi(host), store, log };
}

describe('DT-30 public API', () => {
  it('reports a semver version', () => {
    const { api } = fakeHost();
    expect(api.apiVersion).toBe(API_VERSION);
    expect(api.apiVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('scene CRUD: add, read copies, update (validated), remove, undo', () => {
    const { api, store } = fakeHost();
    const id = api.scene.addBody('box', [0, 3, 0], { name: 'Crate' });
    expect(api.scene.entity(id)).toMatchObject({ name: 'Crate', kind: 'body' });
    // read copies are detached from the store
    const copy = api.scene.entity(id) as BodyEntity;
    copy.name = 'Mutated';
    expect(store.get(id)!.name).toBe('Crate');

    expect(api.scene.update(id, { name: 'Renamed', position: [1, 2, 3] })).toBe(true);
    expect(store.body(id)).toMatchObject({ name: 'Renamed', position: [1, 2, 3] });
    // garbage is repaired by the same sanitisers as a file open
    api.scene.update(id, { position: ['x', null, 5] });
    expect(store.body(id)!.position.every((n) => Number.isFinite(n))).toBe(true);
    expect(api.scene.update('nope', {})).toBe(false);
    // id / kind cannot be changed
    api.scene.update(id, { id: 'hijack', kind: 'joint' });
    expect(store.get(id)?.kind).toBe('body');

    const added = api.scene.add([
      { kind: 'body', name: 'Ball', shape: { type: 'sphere', size: [1, 1, 1] }, position: [0, 5, 0] },
    ]);
    expect(added).toHaveLength(1);
    expect(api.scene.entities({ kind: 'body' })).toHaveLength(2);
    expect(api.scene.entities({ name: 'Ball' })).toHaveLength(1);
    api.scene.remove([id, 'ghost']);
    expect(store.has(id)).toBe(false);
    expect(api.scene.undo()).toBeTruthy();
    expect(store.has(id)).toBe(true);
  });

  it('rejects entities that cannot be valid', () => {
    const { api } = fakeHost();
    expect(() => api.scene.add([{ kind: 'wormhole' }])).toThrow(/rejected/);
    expect(() => api.scene.add([{ kind: 'joint', type: 'hinge', bodyA: 'missing', bodyB: null }])).toThrow(/rejected/);
    expect(() => api.scene.add(['str' as never])).toThrow(/plain objects/);
  });

  it('batch makes one undo step; load validates JSON; settings patch is sanitised', () => {
    const { api, store } = fakeHost();
    api.scene.batch('Three boxes', () => {
      for (let i = 0; i < 3; i++) api.scene.addBody('box', [i, 1, 0]);
    });
    expect(store.all()).toHaveLength(3);
    api.scene.undo();
    expect(store.all()).toHaveLength(0);

    const json = api.scene.toJSON();
    expect(api.scene.load(json)).toMatchObject({ entities: 0 });
    expect(() => api.scene.load('{ not json')).toThrow();

    api.scene.settings({ gravity: [0, -3, 0] });
    expect(api.scene.settings().gravity).toEqual([0, -3, 0]);
    api.scene.settings({ physicsHz: 1e9 });
    expect(api.scene.settings().physicsHz).toBeLessThan(1e6);
  });

  it('simulation control, selection and events', () => {
    const { api } = fakeHost();
    const seen: string[] = [];
    const offMode = api.on('sim:mode', (e) => seen.push(e.mode));
    const offSel = api.on('selection:change', (e) => seen.push(`sel:${e.ids.length}`));
    const offChange = api.on('scene:change', (e) => seen.push(`chg:${e.type}`));
    const id = api.scene.addBody('box');
    api.scene.select([id, 'ghost']);
    expect(api.scene.selection()).toEqual([id]);
    api.simulation.play();
    api.simulation.pause();
    api.simulation.reset();
    expect(seen).toEqual(expect.arrayContaining(['chg:add', 'sel:1', 'running', 'paused', 'edit']));
    offMode();
    offSel();
    offChange();
    api.simulation.play();
    expect(seen.filter((s) => s === 'running')).toHaveLength(1);
    expect(api.simulation.timeScale(100)).toBe(8);
    expect(() => api.on('nope' as never, () => undefined)).toThrow(/Unknown event/);
  });

  it('queries, view, tools, actions, assets, export', async () => {
    const { api, log } = fakeHost();
    const id = api.scene.addBody('box', [4, 5, 6]);
    expect(api.query.pose(id)?.position).toEqual([4, 5, 6]);
    expect(api.query.velocity(id)).toBeNull();
    expect(await api.query.raycast([0, 0, 0], [0, -1, 0])).toBeNull();
    expect(api.view.get().position).toEqual([1, 2, 3]);
    api.view.frameAll();
    api.tools.set('measure');
    api.actions.run('edit.undo');
    expect(log).toEqual(['frameAll', 'tool:measure', 'cmd:edit.undo']);
    const aid = api.assets.add({
      kind: 'blob',
      name: 'blob.bin',
      mime: 'application/octet-stream',
      data: 'AAAA',
    } as never);
    expect(api.assets.list().map((a) => a.id)).toContain(aid);
    expect(api.assets.remove(aid)).toBe(true);
    expect((JSON.parse(api.export.json()) as { format: string }).format).toBe('physicslab-scene');
    expect(await api.export.png()).toBeInstanceOf(Blob);
  });
});

describe('docs/API.md', () => {
  it('documents every member of the API', () => {
    const doc = readFileSync(new URL('../docs/API.md', import.meta.url), 'utf8');
    const { api } = fakeHost();
    const missing: string[] = [];
    for (const [group, value] of Object.entries(api)) {
      if (typeof value === 'function') {
        if (!doc.includes(`physicslab.${group}(`)) missing.push(group);
        continue;
      }
      if (typeof value !== 'object') continue;
      for (const key of Object.keys(value as object)) {
        const full = `physicslab.${group}.${key}`;
        const short = `.${key}`;
        if (!doc.includes(full) && !doc.includes(`${short}(`) && !doc.includes(`${short} `)) missing.push(full);
      }
    }
    expect(missing).toEqual([]);
  });
});
