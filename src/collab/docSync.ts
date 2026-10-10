/**
 * DT-23 — the thin adapter between a `SceneStore` and a collaboration `Replica` (see opLog.ts).
 *
 * Local -> remote: on every store `change`, `flushLocal` diffs the store against a **mirror** (the entity objects as
 * last synchronised) and turns the differences into operations: new entity -> add + one set per field, changed
 * field -> one set, removed entity -> del, changed scene settings / name -> cfg. Entities are immutable in the store,
 * so the diff is a reference comparison first and a per-field deep comparison only for entities that were replaced.
 *
 * Remote -> local: `applyRemote` applies validated operations to the replica, materialises the replica into a
 * document, runs it through the normal `sanitizeDocument` (peers are untrusted: unknown fields dropped, numbers
 * clamped, dangling references repaired) and writes only the differences into the store inside one `transact`.
 * While that happens `applying` is set and the mirror is refreshed afterwards, so the resulting store `change`
 * events produce no operations (no echo loop).
 *
 * Undo: a remote batch is one undo step labelled "Remote edit" on the receiving peer. Undo is therefore *local*
 * and non-collaborative: undoing a step restores the whole earlier document snapshot, and the difference is then
 * broadcast as ordinary new edits (it can revert a collaborator's later change). Documented in docs/COLLAB.md.
 */
import { newDocument } from '../model/factory';
import { SCENE_FORMAT, SCENE_VERSION } from '../model/migrations';
import { sanitizeDocument } from '../model/serialize';
import type { SceneStore } from '../model/store';
import type { Entity, SceneDocument } from '../model/types';
import type { Op, Replica } from './opLog';

export const NAME_KEY = '@name';

/** Structural equality of JSON-like values. */
export function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEq(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!(k in b)) return false;
    if (!deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

const rec = (o: object): Record<string, unknown> => o as Record<string, unknown>;

export class DocSync {
  private mirror = new Map<string, Entity>();
  private mirrorCfg: Record<string, unknown> = {};
  private applying = false;
  private off: (() => void) | null = null;
  /** Remote operations already in the replica whose materialise + sanitise + store write is still pending. */
  private dirty = new Set<string>();
  private dirtyCfg = false;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCommit = -Infinity;

  /** `onLocal` receives the operations produced by local edits (the session broadcasts them). */
  constructor(
    private readonly store: SceneStore,
    readonly replica: Replica,
    private readonly onLocal: (ops: Op[]) => void,
  ) {}

  /** Start following the store. Captures the current document as local operations (a host seeding its replica). */
  attach(): void {
    this.detach();
    const offs = [this.store.on('change', () => this.flush()), this.store.on('meta', () => this.flush())];
    this.off = () => offs.forEach((f) => f());
    this.flush();
  }

  detach(): void {
    this.off?.();
    this.off = null;
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = null;
  }

  /** Diff the store against the mirror and hand the resulting operations to `onLocal`. */
  flush(): Op[] {
    if (this.applying) return [];
    const ops: Op[] = [];
    const { store, replica, mirror } = this;
    const present = new Set<string>();
    for (const e of store.all()) {
      present.add(e.id);
      const m = mirror.get(e.id);
      if (m === e) continue;
      if (!m) {
        ops.push(...replica.localAdd(e.id, fieldsOf(e)));
      } else {
        const a = rec(m);
        const b = rec(e);
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
          if (k !== 'id' && !deepEq(a[k], b[k])) ops.push(replica.localSet(e.id, k, b[k]));
        }
      }
      mirror.set(e.id, e);
    }
    for (const id of [...mirror.keys()]) {
      if (present.has(id)) continue;
      ops.push(replica.localDel(id));
      mirror.delete(id);
    }
    const cfg = this.currentCfg();
    for (const k of new Set([...Object.keys(cfg), ...Object.keys(this.mirrorCfg)])) {
      if (!deepEq(cfg[k], this.mirrorCfg[k])) ops.push(replica.localCfg(k, cfg[k]));
    }
    this.mirrorCfg = cfg;
    if (ops.length) this.onLocal(ops);
    return ops;
  }

  private currentCfg(): Record<string, unknown> {
    return { ...rec(this.store.settings), [NAME_KEY]: this.store.name };
  }

  /** Replace the local document by an empty scene without producing operations (joining a session). */
  clearSilently(): void {
    this.applying = true;
    try {
      this.store.load(newDocument());
    } finally {
      this.applying = false;
    }
    this.mirror.clear();
    this.mirrorCfg = this.currentCfg();
  }

  /** Apply operations that arrived from a peer. Returns the operations that actually changed the replica (to relay). */
  applyRemote(ops: readonly Op[]): Op[] {
    this.flush(); // anything the user did meanwhile is captured (and broadcast) first
    const fresh = this.absorb(ops);
    this.commitRemote();
    return fresh;
  }

  /**
   * Like `applyRemote`, but the expensive part (materialise + sanitise + store write) runs at most once per
   * `minGapMs`: the first message after a quiet period is applied at once, a burst is coalesced into one trailing
   * commit. The replica is always up to date, so the returned fresh operations can be relayed immediately.
   */
  applyRemoteThrottled(ops: readonly Op[], minGapMs = 50): Op[] {
    const fresh = this.absorb(ops);
    if (!fresh.length || this.commitTimer) return fresh;
    const wait = this.lastCommit + minGapMs - Date.now();
    if (wait <= 0) this.commitRemote();
    else this.commitTimer = setTimeout(() => this.commitRemote(), wait);
    return fresh;
  }

  private absorb(ops: readonly Op[]): Op[] {
    const fresh: Op[] = [];
    for (const op of ops)
      if (this.replica.apply(op)) {
        fresh.push(op);
        if (op.k === 'cfg') this.dirtyCfg = true;
        else this.dirty.add(op.e);
      }
    return fresh;
  }

  /** Write any pending remote state into the store now. */
  commitRemote(): void {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = null;
    if (!this.dirty.size && !this.dirtyCfg) return;
    this.flush(); // local edits made since the last commit are stamped before we materialise
    const touched = this.dirty;
    this.dirty = new Set();
    this.dirtyCfg = false;
    this.lastCommit = Date.now();
    const { entities, cfg } = this.replica.materialize();
    const { [NAME_KEY]: name, ...settings } = cfg;
    const raw = {
      format: SCENE_FORMAT,
      version: SCENE_VERSION,
      name: typeof name === 'string' ? name : this.store.name,
      settings,
      entities,
      assets: Object.keys(this.store.assets).length ? this.store.assets : {},
    };
    let doc: SceneDocument;
    try {
      doc = sanitizeDocument(raw);
    } catch {
      return; // over a hard limit: keep the replica state, leave the local document alone
    }
    this.applying = true;
    try {
      this.store.transact('Remote edit', () => this.writeDiff(doc, touched));
    } finally {
      this.applying = false;
    }
    this.mirror = new Map(this.store.all().map((e) => [e.id, e]));
    this.mirrorCfg = this.currentCfg();
  }

  private writeDiff(doc: SceneDocument, touched: Set<string>): void {
    const { store } = this;
    const target = new Map(doc.entities.map((e) => [e.id, e]));
    const gone = store
      .all()
      .filter((e) => !target.has(e.id))
      .map((e) => e.id);
    if (gone.length) store.remove(gone, 'Remote edit');
    const added: Entity[] = [];
    const patches: [string, Partial<Entity>][] = [];
    for (const [id, t] of target) {
      const cur = store.get(id);
      if (!cur) {
        added.push(t);
        continue;
      }
      if (!touched.has(id)) continue;
      const a = rec(cur);
      const b = rec(t);
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(b)) if (k !== 'id' && !deepEq(a[k], b[k])) patch[k] = b[k];
      if (Object.keys(patch).length) patches.push([id, patch]);
    }
    if (added.length) store.add(added, 'Remote edit', false);
    if (patches.length) store.updateMany(patches, 'Remote edit');
    const sp: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec(doc.settings))) if (!deepEq(rec(store.settings)[k], v)) sp[k] = v;
    if (Object.keys(sp).length) store.updateSettings(sp, 'Remote edit');
    if (doc.name !== store.name) store.setName(doc.name);
  }
}

function fieldsOf(e: Entity): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (k !== 'id' && v !== undefined) out[k] = v;
  return out;
}
