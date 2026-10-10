import { Emitter } from '../core/events';
import { vadd, type Vec3 } from '../core/math';
import { newDocument, uid } from './factory';
import { SCENE_FORMAT, SCENE_VERSION } from './migrations';
import type { Asset, BodyEntity, Entity, JointEntity, SceneDocument, SceneSettings, SoftEntity } from './types';
import { isBody, isJoint, isSoft } from './types';

export type SceneChange =
  | { type: 'add'; ids: string[] }
  | { type: 'remove'; ids: string[]; removed: Entity[] }
  | { type: 'update'; ids: string[]; keys: Set<string> }
  | { type: 'settings'; keys: Set<string> }
  | { type: 'reset' };

interface StoreEvents extends Record<string, unknown> {
  change: SceneChange;
  selection: string[];
  history: undefined;
  meta: undefined;
}

interface Snapshot {
  entities: Map<string, Entity>;
  settings: SceneSettings;
  name: string;
  selection: string[];
  label: string;
}

const HISTORY_LIMIT = 200;

/** Dynamic-key property read used for shallow change detection (entities / settings are plain objects). */
const prop = (o: object, k: string): unknown => (o as Record<string, unknown>)[k];

/**
 * Holds the scene document. All entity objects are treated as immutable: every edit
 * replaces the entity (and any nested array it touches), so a history snapshot is just a
 * shallow copy of the entity map — cheap even for scenes with thousands of objects.
 */
export class SceneStore extends Emitter<StoreEvents> {
  private entities = new Map<string, Entity>();
  settings: SceneSettings = newDocument().settings;
  /** Binary payloads (see the asset store section of types.ts); replaced, never mutated, so history can share it. */
  assets: Record<string, Asset> = {};
  name = 'Untitled scene';
  selection: string[] = [];
  /** Increments on every document mutation (used for autosave / dirty tracking). */
  revision = 0;

  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private batchDepth = 0;
  private batchBase: Snapshot | null = null;
  private batchChanged = false;

  // ---- reads --------------------------------------------------------------------------------

  get(id: string): Entity | undefined {
    return this.entities.get(id);
  }
  body(id: string | null | undefined): BodyEntity | undefined {
    const e = id ? this.entities.get(id) : undefined;
    return isBody(e) ? e : undefined;
  }
  joint(id: string): JointEntity | undefined {
    const e = this.entities.get(id);
    return isJoint(e) ? e : undefined;
  }
  all(): Entity[] {
    return [...this.entities.values()];
  }
  bodies(): BodyEntity[] {
    return this.all().filter(isBody);
  }
  joints(): JointEntity[] {
    return this.all().filter(isJoint);
  }
  softs(): SoftEntity[] {
    return this.all().filter(isSoft);
  }
  soft(id: string | null | undefined): SoftEntity | undefined {
    const e = id ? this.entities.get(id) : undefined;
    return isSoft(e) ? e : undefined;
  }
  get size(): number {
    return this.entities.size;
  }
  has(id: string): boolean {
    return this.entities.has(id);
  }
  jointsOf(bodyId: string): JointEntity[] {
    return this.joints().filter((j) => j.bodyA === bodyId || j.bodyB === bodyId);
  }

  toDocument(): SceneDocument {
    return {
      format: SCENE_FORMAT,
      version: SCENE_VERSION,
      name: this.name,
      settings: this.settings,
      entities: this.all(),
      assets: this.assets,
    };
  }

  // ---- history ------------------------------------------------------------------------------

  private snapshot(label: string): Snapshot {
    return {
      entities: new Map(this.entities),
      settings: this.settings,
      name: this.name,
      selection: [...this.selection],
      label,
    };
  }

  /** Group several mutations into one undo step. Nestable. */
  begin(label: string): void {
    if (this.batchDepth++ === 0) {
      this.batchBase = this.snapshot(label);
      this.batchChanged = false;
    }
  }

  end(): void {
    if (--this.batchDepth === 0) {
      if (this.batchChanged && this.batchBase) this.pushHistory(this.batchBase);
      this.batchBase = null;
    }
  }

  transact<T>(label: string, fn: () => T): T {
    this.begin(label);
    try {
      return fn();
    } finally {
      this.end();
    }
  }

  private pushHistory(base: Snapshot): void {
    this.past.push(base);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    this.emit('history', undefined);
  }

  /** Called before every mutation. */
  private touch(label: string): void {
    this.revision++;
    if (this.batchDepth > 0) {
      this.batchChanged = true;
    } else {
      this.pushHistory(this.snapshot(label));
    }
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  get undoLabel(): string {
    return this.past[this.past.length - 1]?.label ?? '';
  }
  get redoLabel(): string {
    return this.future[this.future.length - 1]?.label ?? '';
  }

  undo(): string | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(this.snapshot(prev.label));
    this.restore(prev);
    this.emit('history', undefined);
    return prev.label;
  }

  redo(): string | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(this.snapshot(next.label));
    this.restore(next);
    this.emit('history', undefined);
    return next.label;
  }

  private restore(s: Snapshot): void {
    const old = this.entities;
    const removed: Entity[] = [];
    const added: string[] = [];
    const updated: string[] = [];
    const keys = new Set<string>();
    for (const [id, e] of old) {
      const n = s.entities.get(id);
      if (!n) removed.push(e);
      else if (n !== e) {
        updated.push(id);
        for (const k of Object.keys(n) as (keyof Entity)[]) {
          if (prop(n, k) !== prop(e, k)) keys.add(k);
        }
      }
    }
    for (const id of s.entities.keys()) if (!old.has(id)) added.push(id);
    const settingsChanged = s.settings !== this.settings;
    const settingsKeys = new Set<string>();
    if (settingsChanged) {
      for (const k of Object.keys(s.settings) as (keyof SceneSettings)[]) {
        if (prop(s.settings, k) !== prop(this.settings, k)) settingsKeys.add(k);
      }
    }
    this.revision++;
    this.entities = new Map(s.entities);
    this.settings = s.settings;
    this.name = s.name;
    if (removed.length) this.emit('change', { type: 'remove', ids: removed.map((e) => e.id), removed });
    if (added.length) this.emit('change', { type: 'add', ids: added });
    if (updated.length) this.emit('change', { type: 'update', ids: updated, keys });
    if (settingsChanged) this.emit('change', { type: 'settings', keys: settingsKeys });
    this.setSelection(
      s.selection.filter((id) => this.entities.has(id)),
      true,
    );
    this.emit('meta', undefined);
  }

  // ---- mutations ----------------------------------------------------------------------------

  /** Replace the whole document (load / new). Clears history. */
  load(doc: SceneDocument): void {
    this.entities = new Map();
    for (const e of doc.entities) this.entities.set(e.id, e);
    this.settings = doc.settings;
    this.assets = doc.assets;
    this.name = doc.name;
    this.selection = [];
    this.past = [];
    this.future = [];
    this.revision++;
    this.emit('change', { type: 'reset' });
    this.emit('selection', []);
    this.emit('history', undefined);
    this.emit('meta', undefined);
  }

  clear(): void {
    this.load(newDocument(this.name));
  }

  setName(name: string): void {
    if (name === this.name) return;
    this.touch('Rename scene');
    this.name = name;
    this.emit('meta', undefined);
  }

  add(list: Entity[], label = 'Add', select = true): void {
    if (!list.length) return;
    this.touch(label);
    for (const e of list) this.entities.set(e.id, e);
    this.emit('change', { type: 'add', ids: list.map((e) => e.id) });
    if (select) this.setSelection(list.map((e) => e.id));
  }

  /** Remove entities, plus every joint that referenced a removed body. */
  remove(ids: string[], label = 'Delete'): void {
    const set = new Set(ids.filter((id) => this.entities.has(id)));
    if (!set.size) return;
    for (const j of this.joints()) {
      if ((j.bodyA && set.has(j.bodyA)) || (j.bodyB && set.has(j.bodyB))) set.add(j.id);
    }
    this.touch(label);
    const removed: Entity[] = [];
    for (const id of set) {
      removed.push(this.entities.get(id)!);
      this.entities.delete(id);
    }
    // Bodies grouped under a removed entity are released rather than left pointing at nothing.
    const released: string[] = [];
    for (const e of this.entities.values()) {
      if (!isBody(e) || e.parent === undefined || !set.has(e.parent)) continue;
      const { parent: _gone, ...rest } = e;
      this.entities.set(e.id, rest);
      released.push(e.id);
    }
    this.emit('change', { type: 'remove', ids: [...set], removed });
    if (released.length) this.emit('change', { type: 'update', ids: released, keys: new Set(['parent']) });
    const sel = this.selection.filter((id) => !set.has(id));
    if (sel.length !== this.selection.length) this.setSelection(sel);
  }

  update<T extends Entity>(id: string, patch: Partial<T>, label = 'Edit'): void {
    // The assertion is needed: `Partial<T>` for a generic `T` is not assignable to `Partial<Entity>`.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    this.updateMany([[id, patch as Partial<Entity>]], label);
  }

  updateMany(patches: Iterable<[string, Partial<Entity>]>, label = 'Edit'): void {
    const ids: string[] = [];
    const keys = new Set<string>();
    const next: [string, Entity][] = [];
    for (const [id, patch] of patches) {
      const cur = this.entities.get(id);
      if (!cur) continue;
      let changed = false;
      for (const k of Object.keys(patch)) {
        if (prop(cur, k) !== prop(patch, k)) {
          changed = true;
          keys.add(k);
        }
      }
      if (!changed) continue;
      next.push([id, { ...cur, ...patch } as Entity]);
      ids.push(id);
    }
    if (!ids.length) return;
    this.touch(label);
    for (const [id, e] of next) this.entities.set(id, e);
    this.emit('change', { type: 'update', ids, keys });
  }

  updateSettings(patch: Partial<SceneSettings>, label = 'Change settings'): void {
    const keys = new Set<string>();
    for (const k of Object.keys(patch)) if (prop(this.settings, k) !== prop(patch, k)) keys.add(k);
    if (!keys.size) return;
    this.touch(label);
    this.settings = { ...this.settings, ...patch };
    this.emit('change', { type: 'settings', keys });
  }

  /** Reorder: move entity to a new index in the draw/outliner order. */
  reorder(id: string, toIndex: number): void {
    const list = this.all();
    const from = list.findIndex((e) => e.id === id);
    if (from < 0) return;
    this.touch('Reorder');
    const [e] = list.splice(from, 1);
    list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, e);
    this.entities = new Map(list.map((x) => [x.id, x]));
    this.emit('change', { type: 'reset' });
  }

  // ---- selection ----------------------------------------------------------------------------

  setSelection(ids: string[], silent = false): void {
    const next = ids.filter((id) => this.entities.has(id));
    const same = next.length === this.selection.length && next.every((id, i) => id === this.selection[i]);
    this.selection = next;
    if (!same || silent) this.emit('selection', next);
  }

  toggleSelection(id: string): void {
    this.setSelection(this.selection.includes(id) ? this.selection.filter((x) => x !== id) : [...this.selection, id]);
  }

  selectedBodies(): BodyEntity[] {
    return this.selection.map((id) => this.entities.get(id)).filter(isBody);
  }

  // ---- composite operations -----------------------------------------------------------------

  /**
   * Clone entities. Joints are cloned only when both of their bodies are part of the clone
   * set (or attached to the world), so duplicated assemblies keep their mechanisms intact.
   */
  clone(ids: string[], offset: Vec3 = [0, 0, 0]): Entity[] {
    return cloneEntities(this.all(), ids, offset);
  }

  duplicate(ids: string[], offset: Vec3 = [0.5, 0, 0.5]): string[] {
    const copies = this.clone(ids, offset);
    if (!copies.length) return [];
    this.add(copies, 'Duplicate');
    return copies.map((c) => c.id);
  }

  uniqueName(base: string): string {
    const names = new Set(this.all().map((e) => e.name));
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }
}

/**
 * Clone entities. Joints are cloned only when every body they connect is part of the clone
 * set (or the joint attaches to the world), so duplicated assemblies keep their mechanisms.
 */
export function cloneEntities(all: Entity[], ids: string[], offset: Vec3 = [0, 0, 0]): Entity[] {
  const idSet = new Set(ids);
  const bodies = all.filter((e): e is BodyEntity => isBody(e) && idSet.has(e.id));
  const bodyIds = new Set(bodies.map((b) => b.id));
  const map = new Map<string, string>();
  const out: Entity[] = [];
  for (const b of bodies) {
    const nid = uid('b');
    map.set(b.id, nid);
    out.push({ ...b, id: nid, position: vadd(b.position, offset) });
  }
  // A copy grouped under another copy follows that copy; otherwise it stays in the original group.
  for (const c of out) {
    if (isBody(c) && c.parent !== undefined && map.has(c.parent)) c.parent = map.get(c.parent);
  }
  for (const s of all) {
    if (isSoft(s) && idSet.has(s.id)) out.push({ ...s, id: uid('s'), position: vadd(s.position, offset) });
  }
  for (const j of all) {
    if (!isJoint(j)) continue;
    const aOk = j.bodyA === null || bodyIds.has(j.bodyA);
    const bOk = j.bodyB === null || bodyIds.has(j.bodyB);
    const touches = bodyIds.has(j.bodyA ?? '') || bodyIds.has(j.bodyB ?? '');
    if (!(aOk && bOk && (idSet.has(j.id) || touches))) continue;
    // World-anchored sides carry world coordinates — shift them with the copy.
    out.push({
      ...j,
      id: uid('j'),
      bodyA: j.bodyA ? map.get(j.bodyA)! : null,
      bodyB: j.bodyB ? map.get(j.bodyB)! : null,
      anchorA: j.bodyA ? j.anchorA : vadd(j.anchorA, offset),
      anchorB: j.bodyB ? j.anchorB : vadd(j.anchorB, offset),
    });
  }
  return out;
}
