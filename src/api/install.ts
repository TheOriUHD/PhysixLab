/**
 * DT-30: connects the public API to the running `App` and publishes it as `window.physicslab`.
 *
 * `window.physicslab` is a Proxy: the documented, versioned members (see ./types.ts) come from the API object;
 * every other property falls through to the `App` instance (functions are bound to it), so the debugging handle
 * that the e2e tests and DevTools sessions rely on (`physicslab.store`, `.editor`, …) keeps working. Those internal
 * members are NOT part of the stable surface.
 */
import type { App } from '../app/app';
import { commandRegistry, runCommand } from '../app/registry/commands';
import { listTools } from '../app/registry/tools';
import { createApi, type ApiHost } from './create';
import type { ApiEvents, PhysicsLabApi } from './types';

const API_EVENTS: ReadonlySet<string> = new Set<keyof ApiEvents>([
  'scene:change',
  'selection:change',
  'sim:mode',
  'sim:broken',
  'toast',
]);

export function hostOf(app: App): ApiHost {
  return {
    store: app.store,
    sim: app.sim,
    editor: { addShape: (type, at, over) => app.editor.addShape(type, at, over) },
    loadDocument: (doc) => app.loadDocument(doc),
    newScene: () => app.newScene(),
    view: {
      get: () => app.viewport.getView(),
      set: (v) => app.viewport.setView(v),
    },
    frameAll: () => app.frameAll(),
    frameSelection: () => app.frameSelection(),
    tools: {
      list: () => listTools('toolbox').map((t) => ({ id: t.id, label: t.label ?? t.title ?? t.id })),
      current: () => app.prefs.value.tool,
      set: (id) => app.setTool(id),
    },
    commands: {
      list: () => commandRegistry.list().map((c) => ({ id: c.id, label: c.label, category: c.category })),
      run: (id) => runCommand(id, app, 'api'),
    },
    snapshotPng: () =>
      new Promise<Blob>((resolve, reject) => {
        // The canvas does not keep its buffer between frames, so read it right after the next frame was drawn.
        const off = app.on('frame', () => {
          off();
          app.viewport.dom.toBlob(
            (b) => (b ? resolve(b) : reject(new Error('The viewport could not be captured'))),
            'image/png',
          );
        });
      }),
    onSimMode: (fn) => app.sim.on('mode', fn),
    onSimBroken: (fn) => app.sim.on('broken', fn),
    onToast: (fn) => app.on('toast', fn),
  };
}

export function createAppApi(app: App): PhysicsLabApi {
  const api = createApi(hostOf(app));
  // Unknown event names fall back to the App's own emitter (frame, view, scene, …) so old callers keep working.
  const on = ((event: string, handler: (p: never) => void) =>
    API_EVENTS.has(event)
      ? api.on(event as keyof ApiEvents, handler as never)
      : (app.on as (e: string, h: (p: never) => void) => () => void)(event, handler)) as PhysicsLabApi['on'];
  return { ...api, on };
}

/** The object to assign to `window.physicslab`. */
export function publishApi(app: App): App & PhysicsLabApi {
  const api = createAppApi(app);
  return new Proxy(app, {
    get(target, prop) {
      if (prop in api) return (api as unknown as Record<string | symbol, unknown>)[prop];
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
    has: (target, prop) => prop in api || prop in target,
  }) as unknown as App & PhysicsLabApi;
}
