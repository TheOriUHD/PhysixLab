/**
 * The component host: the one object that owns every live component of a world. It attaches runtimes when bodies and
 * joints are added, keeps them in step with live edits (`sync`: created, updated in place when the runtime allows it,
 * re-created otherwise, disposed), runs `prestep` / `poststep` for all of them in a deterministic order every fixed
 * step, routes events to the components of the bodies involved, and stores the state components publish.
 *
 * A component that throws is switched off for the rest of the session and reports a `component` event named
 * `error`; the simulation carries on. (Nothing a component does may be allowed to take the worker down.)
 */
import { componentDef } from '../../model/componentRegistry';
import type { ComponentSpec } from '../../model/types';
import type { ComponentStateEntry, SimEvent } from '../protocol';
import type { WorldState } from '../world/state';
import { ComponentCtx, BodyHandleImpl, JointHandleImpl, type BodyHandle, type JointHandle } from './context';
import { runtimeOf, type ComponentRuntime } from './registry';
// -- ZN: zones, races and the respawn machinery shared by the zone components and the world bounds
import { ZoneSystem } from '../zones/system';

interface CompRec {
  spec: ComponentSpec;
  ownerKind: 'body' | 'joint';
  ownerId: string;
  ctx: ComponentCtx;
  runtime: ComponentRuntime | null;
  /** The runtime's own state, present while the component is running. */
  state: unknown;
  running: boolean;
  faulted: boolean;
}

/** Sort offset that puts every joint after every body (body `seq` values stay far below it). */
const JOINTS_AFTER_BODIES = 1e12;

export class ComponentHost {
  private byOwner = new Map<string, CompRec[]>();
  /** Every component in execution order. */
  private ordered: CompRec[] = [];
  private dirtyOrder = false;
  private bodyHandles = new Map<string, BodyHandleImpl>();
  private jointHandles = new Map<string, JointHandleImpl>();

  // -- ZN: the zone system of this world (races, score, respawn points, spawning)
  readonly zones: ZoneSystem;

  constructor(private s: WorldState) {
    this.zones = new ZoneSystem(s, this);
  }

  // ---- handles -----------------------------------------------------------------------------

  bodyHandle(id: string): BodyHandle {
    let h = this.bodyHandles.get(id);
    if (!h) this.bodyHandles.set(id, (h = new BodyHandleImpl(this.s, id)));
    return h;
  }
  jointHandle(id: string): JointHandle {
    let h = this.jointHandles.get(id);
    if (!h) this.jointHandles.set(id, (h = new JointHandleImpl(this.s, id)));
    return h;
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  /** Number of components that exist (running or not). */
  get size(): number {
    let n = 0;
    for (const list of this.byOwner.values()) n += list.length;
    return n;
  }

  /** Ids of the components attached to an owner, in order. */
  componentsOf(ownerId: string): string[] {
    return (this.byOwner.get(ownerId) ?? []).map((c) => c.spec.id);
  }

  /** Whether a component is currently running (created and enabled). */
  isRunning(componentId: string): boolean {
    return this.find(componentId)?.running ?? false;
  }

  private find(componentId: string): CompRec | undefined {
    for (const list of this.byOwner.values()) for (const c of list) if (c.spec.id === componentId) return c;
    return undefined;
  }

  /**
   * Make the components of an owner match `specs` (the owner's `components` array): new ones are created, ones whose
   * parameters changed are updated in place (or re-created if their runtime cannot adopt new values), ones whose
   * `enabled` flag changed are started / stopped, and ones that disappeared are disposed. Safe to call with
   * the array the owner already has (nothing happens).
   */
  sync(ownerKind: 'body' | 'joint', ownerId: string, specs: readonly ComponentSpec[]): void {
    const existing = this.byOwner.get(ownerId) ?? [];
    if (!existing.length && !specs.length) return;
    const next: CompRec[] = [];
    // Components that went away (or changed type) are disposed before their successors are created, so a new
    // component never has its published state withdrawn by the one it replaces.
    for (const gone of existing)
      if (!specs.some((s) => s.id === gone.spec.id && s.type === gone.spec.type)) this.stop(gone);
    for (const spec of specs) {
      const old = existing.find((c) => c.spec.id === spec.id && c.spec.type === spec.type);
      if (!old) {
        const rec = this.make(ownerKind, ownerId, spec);
        if (spec.enabled) this.start(rec);
        next.push(rec);
        continue;
      }
      next.push(old);
      if (old.spec === spec) continue;
      const paramsChanged = old.spec.params !== spec.params;
      const enabledChanged = old.spec.enabled !== spec.enabled;
      old.spec = spec;
      old.ctx.spec = spec;
      if (enabledChanged) {
        if (spec.enabled) this.start(old);
        else this.stop(old);
      } else if (paramsChanged && old.running) {
        if (old.runtime?.paramsChanged)
          this.guard(old, 'paramsChanged', () => old.runtime!.paramsChanged!(old.state, old.ctx));
        else {
          this.stop(old);
          this.start(old);
        }
      }
    }
    if (next.length) this.byOwner.set(ownerId, next);
    else this.byOwner.delete(ownerId);
    this.dirtyOrder = true;
  }

  /** Dispose every component of an owner that is leaving the world. */
  detach(ownerId: string): void {
    // handles are handed out for any body or joint (`ctx.bodyById`), so forget them whether or not it had components
    this.bodyHandles.delete(ownerId);
    this.jointHandles.delete(ownerId);
    const list = this.byOwner.get(ownerId);
    if (!list) return;
    for (const c of list) this.stop(c);
    this.byOwner.delete(ownerId);
    this.dirtyOrder = true;
  }

  /** Dispose everything (the world is going away or being replaced). */
  disposeAll(): void {
    for (const list of this.byOwner.values()) for (const c of list) this.stop(c);
    this.byOwner.clear();
    this.ordered = [];
    this.bodyHandles.clear();
    this.jointHandles.clear();
    this.zones.clear(); // -- ZN
  }

  private make(ownerKind: 'body' | 'joint', ownerId: string, spec: ComponentSpec): CompRec {
    return {
      spec,
      ownerKind,
      ownerId,
      ctx: new ComponentCtx(this.s, this, ownerKind, ownerId, spec),
      runtime: runtimeOf(spec.type) ?? null,
      state: undefined,
      running: false,
      faulted: false,
    };
  }

  private start(rec: CompRec): void {
    if (rec.running || rec.faulted) return;
    rec.runtime = runtimeOf(rec.spec.type) ?? null;
    if (!rec.runtime) return; // a type this build has no runtime for (its def exists in the document model)
    this.guard(rec, 'create', () => {
      rec.state = rec.runtime!.create(rec.ctx);
      rec.running = true;
    });
  }

  private stop(rec: CompRec): void {
    if (rec.running) {
      this.guard(rec, 'dispose', () => rec.runtime?.dispose?.(rec.state, rec.ctx));
      rec.running = false;
      rec.state = undefined;
    }
    rec.ctx.release();
    this.clearState(rec); // a stopped component no longer reports; readouts must not show stale values
  }

  /** Run a runtime hook; a throw faults the component (switched off, `error` event) instead of the world. */
  private guard(rec: CompRec, phase: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      rec.running = false;
      rec.faulted = true;
      const message = String((err as { message?: unknown } | null)?.message ?? err);
      console.error(`[component ${rec.spec.type} on ${rec.ownerId}] ${phase} failed:`, err);
      this.s.events.push({
        kind: 'component',
        t: this.s.simTime,
        owner: rec.ownerId,
        component: rec.spec.id,
        type: rec.spec.type,
        name: 'error',
        data: { phase, message },
      });
    }
  }

  // ---- stepping ----------------------------------------------------------------------------

  /**
   * Every component in execution order: bodies first, in the order they joined the world (`BodyRec.seq`), then
   * joints in the order of the world's joint list, each owner's components in array order. The order comes from the
   * world, not from when a component happened to be added, so it is the same after a restore or a live edit.
   */
  private order(): CompRec[] {
    if (this.dirtyOrder) {
      const jointRank = new Map<string, number>();
      this.s.jointOrder.forEach((j, i) => jointRank.set(j.id, i));
      const rank = (list: CompRec[]): number =>
        list[0].ownerKind === 'body'
          ? (this.s.bodies.get(list[0].ownerId)?.seq ?? 0)
          : JOINTS_AFTER_BODIES + (jointRank.get(list[0].ownerId) ?? 0);
      this.ordered = [...this.byOwner.values()]
        .map((list) => ({ rank: rank(list), list }))
        .sort((a, b) => a.rank - b.rank)
        .flatMap((o) => o.list);
      this.dirtyOrder = false;
    }
    return this.ordered;
  }

  prestep(dt: number): void {
    for (const c of this.order()) {
      if (c.running && c.runtime?.prestep) this.guard(c, 'prestep', () => c.runtime!.prestep!(c.state, dt, c.ctx));
    }
  }

  poststep(dt: number): void {
    for (const c of this.order()) {
      if (c.running && c.runtime?.poststep) this.guard(c, 'poststep', () => c.runtime!.poststep!(c.state, dt, c.ctx));
    }
  }

  /** Offer an event to the components of the bodies it concerns. */
  dispatch(ev: SimEvent): void {
    if (!this.byOwner.size) return;
    const ids: string[] = ev.kind === 'contact' ? [ev.a, ev.b] : ev.kind === 'sensor' ? [ev.sensor, ev.other] : [];
    for (const id of ids) {
      for (const c of this.byOwner.get(id) ?? []) {
        if (c.running && c.runtime?.onEvent) this.guard(c, 'onEvent', () => c.runtime!.onEvent!(c.state, ev, c.ctx));
      }
    }
  }

  /** `ctx.emit`: a `component` event for the page. */
  emit(ctx: ComponentCtx, name: string, data?: unknown): void {
    if (this.s.events.length > 4096) return; // a runaway component must not grow the queue without bound
    this.s.events.push({
      kind: 'component',
      t: this.s.simTime,
      owner: ctx.ownerId,
      component: ctx.componentId,
      type: ctx.type,
      name,
      ...(data !== undefined ? { data } : {}),
    });
  }

  // ---- published state ---------------------------------------------------------------------

  setState(ctx: ComponentCtx, values: ArrayLike<number> | null, json: unknown, isJson: boolean): void {
    const id = ctx.componentId;
    let rec = this.s.componentState.get(id);
    let changed = false;
    if (!rec) {
      rec = { entry: { owner: ctx.ownerId, type: ctx.type, values: null }, version: 0, sent: -1 };
      this.s.componentState.set(id, rec);
      changed = true;
    }
    if (!isJson && values) {
      const cur = rec.entry.values;
      if (!cur || cur.length !== values.length) {
        rec.entry.values = Float32Array.from(values);
        changed = true;
      } else {
        for (let i = 0; i < values.length; i++) {
          if (cur[i] !== Math.fround(values[i])) {
            cur[i] = values[i];
            changed = true;
          }
        }
      }
    } else if (isJson) {
      if (JSON.stringify(rec.entry.json) !== JSON.stringify(json)) {
        rec.entry.json = json;
        changed = true;
      }
    }
    if (changed) rec.version++;
  }

  private clearState(rec: CompRec): void {
    if (this.s.componentState.delete(rec.spec.id)) this.s.componentStateRemoved.push(rec.spec.id);
  }

  /** The state entries that changed since the last call, and the ids of the ones that went away. */
  drainState(): { changed: Record<string, ComponentStateEntry>; removed: string[] } {
    const changed: Record<string, ComponentStateEntry> = {};
    for (const [id, r] of this.s.componentState) {
      if (r.version === r.sent) continue;
      r.sent = r.version;
      changed[id] = {
        owner: r.entry.owner,
        type: r.entry.type,
        values: r.entry.values ? Float32Array.from(r.entry.values) : null,
        ...(r.entry.json !== undefined ? { json: r.entry.json } : {}),
      };
    }
    const removed = this.s.componentStateRemoved;
    this.s.componentStateRemoved = [];
    return { changed, removed };
  }

  // ---- snapshots ---------------------------------------------------------------------------

  /** What running components chose to save (`saveState`), by component id. */
  saveStates(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const c of this.order()) {
      if (c.running && c.runtime?.saveState) {
        try {
          out[c.spec.id] = c.runtime.saveState(c.state);
        } catch {
          /* a component that cannot save simply restarts from its defaults */
        }
      }
    }
    if (this.zones.hasState()) out['@zones'] = this.zones.save(); // -- ZN: standings, score, respawn points
    return out;
  }

  /** Give saved states back to the (re-created) components. */
  loadStates(saved: Record<string, unknown>): void {
    if ('@zones' in saved) this.zones.load(saved['@zones']); // -- ZN
    for (const c of this.order()) {
      if (c.running && c.runtime?.loadState && c.spec.id in saved) {
        this.guard(c, 'loadState', () => c.runtime!.loadState!(c.state, saved[c.spec.id], c.ctx));
      }
    }
  }

  /** A component's definition exists in the model but this worker has no runtime for it. */
  missingRuntimes(): string[] {
    return [
      ...new Set(
        this.order()
          .filter((c) => !c.runtime && componentDef(c.spec.type))
          .map((c) => c.spec.type),
      ),
    ];
  }
}
