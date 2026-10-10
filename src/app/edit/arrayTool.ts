/**
 * ED-12: the Array tool's state and commands, for the Array panel (`ui/extensions/ed-array.ts`) and the linked-array
 * inspector section. The arithmetic is `model/edit/arrays.ts`; this file turns it into undoable store edits and keeps
 * the wireframe preview in the viewport.
 *
 *   • The *sources* are the selected objects (top-level ones: a group brings its members). While the panel is shown
 *     the preview outlines every copy; Apply makes them as one undo step.
 *   • Independent bodies: plain clones, selected afterwards.
 *   • Linked array: a group holding the copies and the definition (`GroupEntity.array`). `updateLinkedArray` rebuilds
 *     the copies from the sources (after the sources changed) and `setLinkedSpec` after the parameters changed —
 *     both one undo step. The copies are generated, so edits made to them directly are replaced by a rebuild; use
 *     "Make independent" to keep them.
 */
import { Emitter } from '../../core/events';
import { topLevel } from '../../model/groups';
import { budgetMessage, fitsEntityBudget } from '../../model/edit/entityBudget';
import { getSymmetry } from './symmetryHost';
import {
  arrayProblem,
  buildLinkedArray,
  instantiateArray,
  newPlacements,
  previewSegments,
  referencePoint,
  regenerateArray,
  sourceBoxes,
} from '../../model/edit/arrays';
import { defaultSpec, type ArrayKind, type ArraySpec } from '../../model/edit/arraySpec';
import type { Entity, GroupEntity, PathEntity } from '../../model/types';
import { isGroup, isPath, isPosed } from '../../model/types';
import { ArrayGhostView } from '../../render/editGhosts';
import type { App } from '../app';

export type ArrayMode = 'independent' | 'linked';

interface ToolEvents extends Record<string, unknown> {
  change: undefined;
}

const hasArray = (e: Entity | undefined): e is GroupEntity & { array: NonNullable<GroupEntity['array']> } =>
  isGroup(e) && !!e.array;

export class ArrayTool extends Emitter<ToolEvents> {
  spec: ArraySpec = defaultSpec('linear');
  mode: ArrayMode = 'independent';
  /** Source objects (the selection when it was last changed by the user). */
  sources: string[] = [];
  /** False right after Apply until the user selects something again (the new copies are selected, not sources). */
  armed = true;
  /** The panel is the visible tab, so the preview is drawn. */
  visible = false;
  private ghost: ArrayGhostView | null = null;
  private ignoreSelection = false;
  private pending = false;

  constructor(readonly app: App) {
    super();
    app.store.on('selection', () => this.onSelection());
    app.store.on('change', () => this.queueRefresh());
    this.onSelection();
  }

  // ── sources and parameters ──────────────────────────────────────────────────────────────────────────────────

  private onSelection(): void {
    if (this.ignoreSelection) return;
    this.armed = true;
    this.pickSources();
    this.queueRefresh();
  }

  private pickSources(): void {
    const store = this.app.store;
    let ids = topLevel(
      (id) => store.get(id),
      store.selection.filter((id) => isPosed(store.get(id))),
    ).filter((id) => !hasArray(store.get(id)));
    if (this.spec.kind === 'path') {
      // The path to follow is not itself arrayed: take it from the selection when nothing else names one.
      const pathsSelected = ids.filter((id) => isPath(store.get(id)));
      if (pathsSelected.length && ids.length > pathsSelected.length) {
        if (!store.path(this.spec.pathId)) this.spec = { ...this.spec, pathId: pathsSelected[0] };
        ids = ids.filter((id) => !pathsSelected.includes(id));
      }
    }
    this.sources = ids;
  }

  setKind(kind: ArrayKind): void {
    if (kind === this.spec.kind) return;
    this.spec = defaultSpec(kind);
    if (this.spec.kind === 'path') this.spec = { ...this.spec, pathId: this.defaultPath() };
    this.seedFromSources();
    this.pickSources();
    this.changed();
  }

  /** Radial arrays start about the vertical axis through the scene origin; nothing else needs seeding. */
  private seedFromSources(): void {
    /* kept for symmetry with future per-kind defaults */
  }

  private defaultPath(): string {
    const store = this.app.store;
    const sel = store.selection.find((id) => isPath(store.get(id)));
    return sel ?? store.paths()[0]?.id ?? '';
  }

  setSpec(spec: ArraySpec): void {
    this.spec = spec;
    this.changed();
  }

  setMode(mode: ArrayMode): void {
    this.mode = mode;
    this.changed();
  }

  paths(): PathEntity[] {
    return this.app.store.paths();
  }

  private changed(): void {
    this.queueRefresh();
    this.emit('change', undefined);
  }

  // ── preview ─────────────────────────────────────────────────────────────────────────────────────────────────

  private queueRefresh(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.refresh();
    });
  }

  /** Why the array cannot be made right now (null = it can). */
  problem(): string | null {
    if (this.app.sim.active) return 'Stop the simulation to build an array.';
    if (!this.armed || !this.sources.length) return 'Select the objects to repeat.';
    return arrayProblem(this.app.store.all(), this.sources, this.spec);
  }

  /** How many new top-level copies Apply would make (0 when it cannot). */
  copyCount(): number {
    if (this.problem()) return 0;
    const all = this.app.store.all();
    const ref = referencePoint(all, this.sources);
    return newPlacements(this.spec, ref, (id) => this.app.store.path(id)).length;
  }

  /** Redraw the wireframe preview (or remove it). */
  refresh(): void {
    const show = this.visible && !this.problem();
    if (!show) {
      this.ghost?.hide();
      this.app.viewport.needsRender = true;
      this.emit('change', undefined);
      return;
    }
    const all = this.app.store.all();
    const ref = referencePoint(all, this.sources);
    const placements = newPlacements(this.spec, ref, (id) => this.app.store.path(id));
    const boxes = sourceBoxes(all, this.sources);
    const seg = previewSegments(boxes, placements, ref);
    this.ghost ??= new ArrayGhostView(this.app.viewport.helpers);
    this.ghost.show(seg.positions);
    this.app.viewport.needsRender = true;
    this.emit('change', undefined);
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    this.refresh();
  }

  /** Is the preview currently drawn? (for tests) */
  get previewVisible(): boolean {
    return !!this.ghost?.lines.visible;
  }

  dispose(): void {
    this.ghost?.dispose();
    this.ghost = null;
  }

  // ── apply ───────────────────────────────────────────────────────────────────────────────────────────────────

  /** Make the array. Returns the ids selected afterwards (the group, or the new top-level copies). */
  apply(): string[] {
    const why = this.problem();
    if (why) {
      this.app.toast(why, 'warn');
      return [];
    }
    const store = this.app.store;
    const all = store.all();
    const sources = [...this.sources];
    const spec = this.spec;
    const first = store.get(sources[0]);
    let selected: string[];
    const pathOf = (id: string) => store.path(id);
    const sym = getSymmetry(this.app);
    const ref = referencePoint(all, sources);
    if (this.mode === 'linked') {
      const { group, entities } = buildLinkedArray(
        all,
        sources,
        spec,
        store.uniqueName(`${first?.name ?? 'Object'} array`),
      );
      const over = fitsEntityBudget(store, entities.length + 1, 'This array');
      if (over) {
        this.app.toast(over, 'warn');
        return [];
      }
      store.transact('Array (linked)', () =>
        sym.suspended(() => store.add([group, ...entities], 'Array (linked)', false)),
      );
      selected = [group.id];
      this.app.toast(
        `Linked array: ${entities.filter((e) => isPosed(e)).length} object(s) in "${group.name}". Edit it in the Inspector.`,
        'success',
      );
    } else {
      const used = new Set(all.map((e) => e.name));
      const rename = (name: string, index: number): string => {
        const base = name.replace(/ \d+$/, '');
        let n = index + 2;
        let candidate = `${base} ${n}`;
        while (used.has(candidate)) candidate = `${base} ${++n}`;
        used.add(candidate);
        return candidate;
      };
      const placements = newPlacements(spec, ref, pathOf);
      const inst = instantiateArray(all, sources, placements, ref, { rename });
      const over = fitsEntityBudget(store, inst.entities.length, 'This array');
      if (over) {
        this.app.toast(over, 'warn');
        return [];
      }
      // The copies are the user's own layout: symmetry mode must not add mirror partners for each one.
      store.transact('Array', () => sym.suspended(() => store.add(inst.entities, 'Array', false)));
      selected = inst.roots;
      this.app.toast(`Array: ${inst.roots.length} new object(s).`, 'success');
    }
    this.ignoreSelection = true;
    try {
      store.setSelection(selected);
    } finally {
      this.ignoreSelection = false;
    }
    this.armed = false;
    this.refresh();
    return selected;
  }

  cancel(): void {
    this.armed = false;
    this.refresh();
  }
}

const tools = new WeakMap<App, ArrayTool>();
export function getArrayTool(app: App): ArrayTool {
  let t = tools.get(app);
  if (!t) {
    t = new ArrayTool(app);
    tools.set(app, t);
  }
  return t;
}

// ── linked arrays: commands on groups ───────────────────────────────────────────────────────────────────────────

/** Linked-array groups affected by the selection: selected arrays, and arrays whose source is selected. */
export function linkedArraysOf(app: App, ids: readonly string[] = app.store.selection): GroupEntity[] {
  const out = new Map<string, GroupEntity>();
  for (const g of app.store.groups()) {
    if (!g.array) continue;
    if (ids.includes(g.id) || g.array.sourceIds.some((s) => ids.includes(s))) out.set(g.id, g);
  }
  return [...out.values()];
}

/**
 * Rebuild the copies of a linked array (optionally with new parameters) in one undo step.
 * Returns false and toasts the reason when it cannot (sources deleted, no path, simulation running).
 */
export function rebuildLinkedArray(app: App, groupId: string, spec?: ArraySpec, label = 'Update array'): boolean {
  if (app.sim.active) {
    app.toast('Stop the simulation to edit an array.', 'warn');
    return false;
  }
  const store = app.store;
  let re: ReturnType<typeof regenerateArray>;
  try {
    re = regenerateArray(store.all(), groupId, spec);
  } catch (e) {
    app.toast((e as Error).message, 'warn');
    return false;
  }
  if (!re) return false;
  const over = budgetMessage(store.all().length - re.remove.length, re.add.length, 'This array');
  if (over) {
    app.toast(over, 'warn');
    return false;
  }
  const selection = store.selection.filter((id) => !re.remove.includes(id));
  const patch = re.group;
  store.transact(label, () => {
    store.remove(re.remove, label);
    store.add(re.add, label, false);
    store.update(groupId, patch, label);
  });
  store.setSelection(selection.length ? selection : [groupId]);
  return true;
}

/** Re-propagate the sources into the copies of every linked array the selection touches. */
export function updateLinkedArrays(app: App, ids: readonly string[] = app.store.selection): number {
  const groups = linkedArraysOf(app, ids);
  let n = 0;
  const store = app.store;
  store.begin(groups.length > 1 ? 'Update arrays' : 'Update array');
  try {
    for (const g of groups) if (rebuildLinkedArray(app, g.id)) n++;
  } finally {
    store.end();
  }
  return n;
}

/** Drop the definition: the group stays with its copies as ordinary objects. */
export function unlinkArray(app: App, groupId: string): void {
  const g = app.store.group(groupId);
  if (!g?.array) return;
  // `updateMany` merges keys, so the field is cleared by patching it to undefined (JSON drops it on save).
  app.store.updateMany([[groupId, { array: undefined }]], 'Make array independent');
}
