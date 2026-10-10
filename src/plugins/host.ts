/**
 * DT-31: runs plugins. Every plugin lives in its own sandbox (src/sandbox) and can only reach the app through the
 * handlers built here, each gated by the permissions the user granted. Registrations a plugin makes (commands, panels,
 * templates) are tracked and removed again when it is disabled, removed or crashes — one plugin failing never affects
 * the app or other plugins.
 */
import type { App } from '../app/app';
import type { PhysixLabApi } from '../api/types';
import { registerCommand } from '../app/registry/commands';
import { registerPanel, type PanelDef } from '../app/registry/panels';
import { registerTemplate } from '../model/content';
import { Sandbox, SandboxError } from '../sandbox/sandbox';
import dslPrelude from '../scripting/dslPrelude.mjs?raw';
import { buildFromOps, type ScriptResult } from '../scripting/replay';
import { callbackIds, renderTree, validateTree, type UiNode } from './declarative';
import { parseManifest, type Permission, type PluginManifest } from './manifest';
import pluginPrelude from './pluginPrelude.mjs?raw';
import type { PluginRecord, PluginStore } from './store';

export type PluginState = 'starting' | 'running' | 'disabled' | 'error';

export interface PluginInfo {
  manifest: PluginManifest;
  state: PluginState;
  error?: string;
  granted: Permission[];
  origin: string;
  commands: string[];
  panels: string[];
  templates: string[];
}

const PRELUDE = `${dslPrelude}\n${pluginPrelude}\nreturn buildPlugin(api);`;
const START_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 3000;

/** API method → permission needed. Anything not listed is not callable. */
const METHOD_PERMS: Record<string, Permission> = {
  'scene.get': 'scene.read',
  'scene.toJSON': 'scene.read',
  'scene.name': 'scene.read',
  'scene.entities': 'scene.read',
  'scene.entity': 'scene.read',
  'scene.selection': 'scene.read',
  'scene.load': 'scene.write',
  'scene.clear': 'scene.write',
  'scene.setName': 'scene.write',
  'scene.add': 'scene.write',
  'scene.addBody': 'scene.write',
  'scene.update': 'scene.write',
  'scene.remove': 'scene.write',
  'scene.select': 'scene.write',
  'scene.undo': 'scene.write',
  'scene.redo': 'scene.write',
  'simulation.mode': 'simulation',
  'simulation.play': 'simulation',
  'simulation.pause': 'simulation',
  'simulation.toggle': 'simulation',
  'simulation.step': 'simulation',
  'simulation.reset': 'simulation',
  'simulation.timeScale': 'simulation',
  'simulation.stats': 'simulation',
  'query.pose': 'scene.read',
  'query.velocity': 'scene.read',
  'query.raycast': 'scene.read',
  'view.get': 'view',
  'view.set': 'view',
  'view.frameAll': 'view',
  'view.frameSelection': 'view',
};
const EVENT_PERMS: Record<string, Permission> = {
  'scene:change': 'scene.read',
  'selection:change': 'scene.read',
  'sim:mode': 'simulation',
  'sim:broken': 'simulation',
};
const ID = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_EVENT_SUBS = 20;
const MAX_ARG_CHARS = 4_000_000;
const MAX_PLUGINS = 30;
const MAX_COMMANDS = 50;
const MAX_PANELS = 5;
const MAX_TEMPLATES = 20;

interface Instance {
  rec: PluginRecord;
  state: PluginState;
  error?: string;
  sandbox: Sandbox | null;
  cleanups: (() => void)[];
  commands: string[];
  panels: Map<string, { refresh: () => void }>;
  templates: string[];
}

/** Callback ids ({ __cb: n }) anywhere in a raw tree from the sandbox. */
function wireCallbackIds(v: unknown, out: number[] = [], depth = 0): number[] {
  if (depth > 12 || typeof v !== 'object' || v === null) return out;
  const cb = (v as { __cb?: unknown }).__cb;
  if (typeof cb === 'number') out.push(cb);
  for (const x of Object.values(v)) wireCallbackIds(x, out, depth + 1);
  return out;
}

export class PluginHost {
  private readonly items = new Map<string, Instance>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly app: App,
    private readonly api: PhysixLabApi,
    private readonly store: PluginStore,
  ) {
    for (const rec of store.load()) this.items.set(rec.manifest.id, this.blank(rec));
  }

  private blank(rec: PluginRecord): Instance {
    return { rec, state: 'disabled', sandbox: null, cleanups: [], commands: [], panels: new Map(), templates: [] };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private changed(): void {
    for (const fn of [...this.listeners]) fn();
  }
  private persist(): void {
    this.store.save([...this.items.values()].map((i) => i.rec));
  }

  list(): PluginInfo[] {
    return [...this.items.values()].map((i) => ({
      manifest: i.rec.manifest,
      state: i.state,
      error: i.error,
      granted: [...i.rec.granted],
      origin: i.rec.origin,
      commands: [...i.commands],
      panels: [...i.panels.keys()],
      templates: [...i.templates],
    }));
  }

  /** Start every enabled plugin (app start-up). */
  async startAll(): Promise<void> {
    await Promise.all([...this.items.values()].filter((i) => i.rec.enabled).map((i) => this.start(i)));
  }

  /** Install (or update) a plugin with the permissions the user approved, and start it. */
  async install(source: string, origin: string, granted: Permission[]): Promise<PluginInfo> {
    const manifest = parseManifest(source);
    const grant = granted.filter((p) => manifest.permissions.includes(p));
    const prev = this.items.get(manifest.id);
    if (!prev && this.items.size >= MAX_PLUGINS) throw new Error(`At most ${MAX_PLUGINS} plugins can be installed`);
    if (prev) this.stop(prev);
    const rec: PluginRecord = { manifest, source, enabled: true, granted: grant, origin, installedAt: Date.now() };
    const inst = this.blank(rec);
    this.items.set(manifest.id, inst);
    this.persist();
    await this.start(inst);
    return this.info(inst);
  }

  async enable(id: string): Promise<void> {
    const i = this.items.get(id);
    if (!i) return;
    i.rec.enabled = true;
    this.persist();
    await this.start(i);
  }

  disable(id: string): void {
    const i = this.items.get(id);
    if (!i) return;
    i.rec.enabled = false;
    this.stop(i);
    this.persist();
    this.changed();
  }

  remove(id: string): void {
    const i = this.items.get(id);
    if (!i) return;
    this.stop(i);
    this.items.delete(id);
    this.persist();
    this.changed();
  }

  private info(i: Instance): PluginInfo {
    return this.list().find((p) => p.manifest.id === i.rec.manifest.id)!;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────────────────────

  private stop(i: Instance): void {
    for (const c of i.cleanups.splice(0)) {
      try {
        c();
      } catch (e) {
        console.warn('[plugins] cleanup failed', e);
      }
    }
    i.sandbox?.dispose();
    i.sandbox = null;
    i.commands = [];
    i.panels.clear();
    i.templates = [];
    i.state = 'disabled';
    i.error = undefined;
  }

  private fail(i: Instance, message: string): void {
    this.stop(i);
    i.state = 'error';
    i.error = message;
    this.app.toast(`Plugin “${i.rec.manifest.name}” stopped: ${message}`, 'error');
    this.changed();
  }

  private async start(i: Instance): Promise<void> {
    this.stop(i);
    i.state = 'starting';
    this.changed();
    try {
      let created: Sandbox | null = null;
      const sandbox = await Sandbox.create({
        handlers: this.handlersFor(i),
        onDispose: (reason) => {
          if (created && i.sandbox === created) this.fail(i, reason.message);
        },
        onLog: (level, text) =>
          (level === 'error' ? console.error : level === 'warn' ? console.warn : console.warn)(
            `[plugin ${i.rec.manifest.id}]`,
            text,
          ),
      });
      created = sandbox;
      i.sandbox = sandbox;
      await sandbox.run(i.rec.source, PRELUDE, START_TIMEOUT_MS);
      if (i.sandbox !== sandbox) return; // stopped meanwhile
      i.state = 'running';
      i.error = undefined;
      this.changed();
    } catch (e) {
      this.fail(i, e instanceof Error ? e.message : String(e));
    }
  }

  /** Call a plugin callback; a plugin that hangs or blows its budget is stopped, one that merely throws is reported. */
  private async callPlugin(i: Instance, cb: number, args: unknown[] = []): Promise<unknown> {
    const sb = i.sandbox;
    if (!sb || !sb.alive || i.state !== 'running') return null;
    try {
      return await sb.invoke(cb, args, CALL_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof SandboxError && e.kind !== 'error') {
        if (i.sandbox === sb) this.fail(i, e.message);
      } else {
        this.app.toast(`Plugin “${i.rec.manifest.name}”: ${e instanceof Error ? e.message : String(e)}`, 'warn');
      }
      return null;
    }
  }

  // ── what the sandbox may call ─────────────────────────────────────────────────────────────

  private handlersFor(i: Instance): Record<string, (...a: unknown[]) => unknown> {
    const granted = new Set(i.rec.granted);
    const need = (p: Permission, what: string) => {
      if (!granted.has(p))
        throw new Error(`Permission “${p}” was not granted (needed for ${what}). Ask for it in the manifest.`);
    };
    const pid = i.rec.manifest.id;
    const cbOf = (v: unknown): number => {
      const n = (v as { __cb?: unknown } | null)?.__cb;
      if (typeof n !== 'number') throw new Error('Expected a function');
      return n;
    };
    const text = (v: unknown, what: string, max = 80): string => {
      if (typeof v !== 'string' || !v.trim()) throw new Error(`${what} must be a non-empty string`);
      return v.slice(0, max);
    };
    const checkSize = (v: unknown) => {
      if (JSON.stringify(v).length > MAX_ARG_CHARS) throw new Error('The call carries too much data');
    };
    const handlers: Record<string, (...a: unknown[]) => unknown> = {};

    // The documented API, one handler per allowed method.
    const apiObj = this.api as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>;
    for (const [name, perm] of Object.entries(METHOD_PERMS)) {
      const [group, method] = name.split('.') as [string, string];
      handlers[`api.${name}`] = (...args) => {
        need(perm, name);
        if (args.length > 6) throw new Error('Too many arguments');
        checkSize(args);
        if (name === 'simulation.mode') return apiObj['simulation']['mode'];
        return apiObj[group][method](...args);
      };
    }
    // settings() reads, and writes when given a patch: the permission depends on the argument.
    handlers['api.scene.settings'] = (patch) => {
      need(patch === undefined || patch === null ? 'scene.read' : 'scene.write', 'scene.settings');
      return this.api.scene.settings(patch ?? undefined);
    };
    handlers['api.scene.batch'] = (label, calls) => {
      need('scene.write', 'scene.batch');
      if (!Array.isArray(calls) || calls.length > 5000) throw new Error('batch needs a list of at most 5000 calls');
      return this.api.scene.batch(text(label, 'batch label', 60), () => {
        const out: unknown[] = [];
        for (const c of calls as unknown[]) {
          const [method, ...args] = Array.isArray(c) ? (c as unknown[]) : [];
          const key = `scene.${String(method)}`;
          if (!Object.hasOwn(METHOD_PERMS, key) || METHOD_PERMS[key] !== 'scene.write')
            throw new Error(`batch cannot call “${String(method).slice(0, 30)}”`);
          out.push(apiObj['scene'][String(method)](...args));
        }
        return out;
      });
    };

    let subs = 0;
    handlers['events.subscribe'] = (event, cb) => {
      const perm = Object.hasOwn(EVENT_PERMS, String(event)) ? EVENT_PERMS[String(event)] : undefined;
      if (!perm) throw new Error(`Unknown event “${String(event).slice(0, 30)}”`);
      need(perm, `event ${String(event)}`);
      if (++subs > MAX_EVENT_SUBS) throw new Error(`At most ${MAX_EVENT_SUBS} event subscriptions per plugin`);
      const id = cbOf(cb);
      let busy = false;
      let latest: unknown = null;
      let pendingFire = false;
      const fire = async () => {
        if (busy) return;
        busy = true;
        while (pendingFire) {
          pendingFire = false;
          await this.callPlugin(i, id, [latest]);
        }
        busy = false;
      };
      const off = this.api.on(event as 'scene:change', (p) => {
        latest = p;
        pendingFire = true;
        void fire();
      });
      i.cleanups.push(off);
      return null;
    };

    handlers['register.command'] = (def) => {
      need('ui', 'registering a command');
      if (i.commands.length >= MAX_COMMANDS) throw new Error(`At most ${MAX_COMMANDS} commands per plugin`);
      const d = def as Record<string, unknown>;
      const cid = text(d['id'], 'command id', 40);
      if (!ID.test(cid)) throw new Error('command id must be lowercase letters, digits and dashes');
      const full = `plugin.${pid}.${cid}`;
      const run = cbOf(d['run']);
      const off = registerCommand({
        id: full,
        label: text(d['label'], 'command label', 60),
        category: typeof d['category'] === 'string' && d['category'] ? d['category'].slice(0, 30) : 'Plugins',
        icon: 'component',
        description:
          typeof d['description'] === 'string'
            ? d['description'].slice(0, 160)
            : `From the plugin “${i.rec.manifest.name}”`,
        keywords: [i.rec.manifest.name, 'plugin'],
        run: async () => {
          await this.callPlugin(i, run);
        },
      });
      i.cleanups.push(off);
      i.commands.push(full);
      return full;
    };

    handlers['register.panel'] = (def) => {
      need('ui', 'registering a panel');
      if (i.panels.size >= MAX_PANELS) throw new Error(`At most ${MAX_PANELS} panels per plugin`);
      const d = def as Record<string, unknown>;
      const panelId = text(d['id'], 'panel id', 40);
      if (!ID.test(panelId)) throw new Error('panel id must be lowercase letters, digits and dashes');
      const region = d['region'] === 'left' || d['region'] === 'bottom' ? d['region'] : 'right';
      const render = cbOf(d['render']);
      const full = `plugin.${pid}.${panelId}`;
      const def2: PanelDef = {
        id: full,
        label: text(d['label'], 'panel label', 24),
        icon: 'component',
        region,
        order: 900,
        title: `${i.rec.manifest.name}`,
        build: () => {
          const el = document.createElement('div');
          el.className = 'plg-panel';
          let stale: number[] = [];
          let token = 0;
          const refresh = () => {
            const mine = ++token;
            void this.callPlugin(i, render).then((wire) => {
              if (mine !== token || (!el.isConnected && !el.parentElement)) {
                i.sandbox?.forget(wireCallbackIds(wire));
                return;
              }
              try {
                const tree: UiNode = validateTree(wire);
                const ids = callbackIds(tree);
                const fire = (cb: number, args: unknown[]) => {
                  if (cb) void this.callPlugin(i, cb, args).then(refresh);
                };
                el.replaceChildren(renderTree(tree, fire));
                i.sandbox?.forget(stale.filter((s) => !ids.includes(s)));
                stale = ids;
              } catch (e) {
                i.sandbox?.forget(wireCallbackIds(wire));
                el.replaceChildren(
                  Object.assign(document.createElement('p'), {
                    className: 'plg-text plg-error',
                    textContent: `This panel is not valid: ${e instanceof Error ? e.message : String(e)}`,
                  }),
                );
              }
            });
          };
          i.panels.set(panelId, { refresh });
          refresh();
          return {
            el,
            onShow: refresh,
            dispose: () => {
              i.panels.delete(panelId);
              i.sandbox?.forget(stale);
            },
          };
        },
      };
      i.cleanups.push(registerPanel(def2));
      return full;
    };

    handlers['register.template'] = (def) => {
      need('ui', 'registering an example scene');
      if (i.templates.length >= MAX_TEMPLATES) throw new Error(`At most ${MAX_TEMPLATES} example scenes per plugin`);
      const d = def as Record<string, unknown>;
      const tid = text(d['id'], 'template id', 40);
      if (!ID.test(tid)) throw new Error('template id must be lowercase letters, digits and dashes');
      const name = text(d['name'], 'template name', 60);
      const built = buildFromOps(d['scene'] as ScriptResult, name);
      const doc = built.doc;
      const full = `plugin.${pid}.${tid}`;
      i.cleanups.push(
        registerTemplate({
          id: full,
          name,
          category: typeof d['category'] === 'string' && d['category'] ? d['category'].slice(0, 30) : 'Plugins',
          blurb: typeof d['blurb'] === 'string' ? d['blurb'].slice(0, 160) : `From the plugin “${i.rec.manifest.name}”`,
          hint: `Example scene from the plugin “${i.rec.manifest.name}”.`,
          build: () => structuredClone(doc),
        }),
      );
      i.templates.push(full);
      return full;
    };

    handlers['ui.toast'] = (t, kind) => {
      need('ui', 'showing a message');
      const k = kind === 'success' || kind === 'warn' || kind === 'error' ? kind : 'info';
      this.app.toast(`${i.rec.manifest.name}: ${String(t).slice(0, 200)}`, k);
      return null;
    };
    handlers['ui.refresh'] = () => {
      for (const p of i.panels.values()) p.refresh();
      return null;
    };
    return handlers;
  }
}
