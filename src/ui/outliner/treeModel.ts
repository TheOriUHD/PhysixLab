/**
 * UI-A (UI-20/21): the outliner's pure model — flattening the entity hierarchy into rows, filtering, sorting,
 * range selection, drop planning, solo and tag helpers. No DOM, no store: everything takes plain entities so it
 * can be unit-tested and used for thousands of rows.
 */
import type { Entity } from '../../model/types';
import { isBody, isGroup, isJoint, isLight, isSoft, parentOf } from '../../model/types';

export type SortMode = 'manual' | 'name' | 'nameDesc' | 'type' | 'material' | 'tag';

export const SORT_LABELS: Record<SortMode, string> = {
  manual: 'Scene order',
  name: 'Name A–Z',
  nameDesc: 'Name Z–A',
  type: 'Type',
  material: 'Material',
  tag: 'Colour tag',
};

/** Row types of the flattened list. */
export interface EntityRow {
  type: 'entity';
  id: string;
  entity: Entity;
  depth: number;
  /** Direct members (groups only). */
  members: number;
  folded: boolean;
}
export interface HeaderRow {
  type: 'header';
  id: string;
  label: string;
  count: number;
}
export type Row = EntityRow | HeaderRow;

export interface Filter {
  /** Case-insensitive substring of the name. */
  text: string;
  /** Kind or sub-type keys (any match): 'body', 'box', 'group', 'soft', 'jelly', 'light', 'point', 'joint', 'hinge' … */
  type: string;
  /** Body material preset. */
  material: string;
  /** Tag (also matches a colour tag key). */
  tag: string;
  locked: boolean | null;
  hidden: boolean | null;
  /** Has a component: 'any' or a component type id. */
  component: string;
}

export const emptyFilter = (): Filter => ({
  text: '',
  type: '',
  material: '',
  tag: '',
  locked: null,
  hidden: null,
  component: '',
});

export const filterActive = (f: Filter): boolean =>
  !!(f.text || f.type || f.material || f.tag || f.locked !== null || f.hidden !== null || f.component);

/**
 * Search box syntax: free words filter by name, `key:value` tokens set the structured filters —
 * `type:box material:steel tag:wheel is:locked is:hidden has:component has:spring`.
 * Unknown keys are treated as part of the name text.
 */
export function parseQuery(query: string, base: Filter = emptyFilter()): Filter {
  const f: Filter = { ...base, text: '' };
  const words: string[] = [];
  for (const w of query.trim().split(/\s+/)) {
    if (!w) continue;
    const m = /^(type|material|mat|tag|is|has):(.*)$/i.exec(w);
    if (!m) {
      words.push(w);
      continue;
    }
    const key = m[1].toLowerCase();
    const val = m[2].toLowerCase();
    if (key === 'type') f.type = val;
    else if (key === 'material' || key === 'mat') f.material = val;
    else if (key === 'tag') f.tag = val;
    else if (key === 'is') {
      if (val === 'locked') f.locked = true;
      else if (val === 'unlocked') f.locked = false;
      else if (val === 'hidden') f.hidden = true;
      else if (val === 'visible') f.hidden = false;
      else words.push(w);
    } else if (key === 'has') f.component = !val || val === 'component' || val === 'components' ? 'any' : val;
  }
  f.text = words.join(' ').toLowerCase();
  return f;
}

/** Keys an entity answers to in the type filter (its kind first, then its concrete type). */
export function typeKeys(e: Entity): string[] {
  if (isBody(e)) return ['body', e.shape.type];
  if (isSoft(e)) return ['soft', e.type];
  if (isLight(e)) return ['light', e.lightType];
  if (isJoint(e)) return ['joint', e.type];
  return [e.kind];
}

export function tagsOf(e: Entity): readonly string[] {
  return e.tags ?? [];
}

export function materialOf(e: Entity): string {
  return isBody(e) ? e.material.preset : '';
}

export function componentsOf(e: Entity): readonly { type: string }[] {
  return isBody(e) || isJoint(e) ? e.components : [];
}

export function matches(e: Entity, f: Filter): boolean {
  if (f.text && !e.name.toLowerCase().includes(f.text)) return false;
  if (f.type && !typeKeys(e).some((k) => k.toLowerCase() === f.type.toLowerCase())) return false;
  if (f.material && materialOf(e).toLowerCase() !== f.material.toLowerCase()) return false;
  if (f.tag) {
    const t = f.tag.toLowerCase();
    if (!tagsOf(e).some((x) => x.toLowerCase() === t) && (e.colorTag ?? '') !== t) return false;
  }
  if (f.locked !== null && (isJoint(e) ? false : e.locked) !== f.locked) return false;
  if (f.hidden !== null && e.hidden !== f.hidden) return false;
  if (f.component) {
    const cs = componentsOf(e);
    if (f.component === 'any' ? !cs.length : !cs.some((c) => c.type.toLowerCase() === f.component.toLowerCase()))
      return false;
  }
  return true;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function comparator(mode: SortMode): ((a: Entity, b: Entity) => number) | null {
  switch (mode) {
    case 'manual':
      return null;
    case 'name':
      return (a, b) => collator.compare(a.name, b.name);
    case 'nameDesc':
      return (a, b) => collator.compare(b.name, a.name);
    case 'type':
      return (a, b) =>
        collator.compare(typeKeys(a).join('/'), typeKeys(b).join('/')) || collator.compare(a.name, b.name);
    case 'material':
      return (a, b) => collator.compare(materialOf(a), materialOf(b)) || collator.compare(a.name, b.name);
    case 'tag':
      return (a, b) => collator.compare(a.colorTag ?? '~', b.colorTag ?? '~') || collator.compare(a.name, b.name);
  }
}

export interface BuildOptions {
  folded: ReadonlySet<string>;
  filter: Filter;
  sort: SortMode;
}

/**
 * Flatten the scene into display rows. Without a filter: the group tree (members under their group, folded
 * groups hide theirs), then a "Joints & constraints" section. With a filter: a flat list of matches, so a hit
 * inside a folded group is still found. An object whose `parent` is not a group stays at the top level.
 */
export function buildRows(entities: readonly Entity[], opts: BuildOptions): Row[] {
  const cmp = comparator(opts.sort);
  const order = (list: Entity[]): Entity[] => (cmp ? list.sort(cmp) : list);
  const objects = entities.filter((e) => !isJoint(e));
  const joints = entities.filter(isJoint);
  const rows: Row[] = [];
  if (filterActive(opts.filter)) {
    const hits = order(entities.filter((e) => matches(e, opts.filter)));
    for (const e of hits) rows.push({ type: 'entity', id: e.id, entity: e, depth: 0, members: 0, folded: false });
    return rows;
  }
  const folders = new Set<string>();
  for (const o of objects) if (isGroup(o)) folders.add(o.id);
  const kids = new Map<string, Entity[]>();
  const roots: Entity[] = [];
  for (const o of objects) {
    const p = parentOf(o);
    if (p !== undefined && folders.has(p)) {
      const l = kids.get(p);
      if (l) l.push(o);
      else kids.set(p, [o]);
    } else roots.push(o);
  }
  // Iterative walk (deep hierarchies must not overflow the stack); `onPath` guards against hand-made cycles.
  const walk = (start: Entity[]) => {
    const stack: { e: Entity; depth: number; path: Set<string> }[] = [];
    const push = (list: Entity[], depth: number, path: Set<string>) => {
      for (let i = list.length - 1; i >= 0; i--) stack.push({ e: list[i], depth, path });
    };
    push(start, 0, new Set());
    while (stack.length) {
      const { e, depth, path } = stack.pop()!;
      const children = path.has(e.id) ? [] : (kids.get(e.id) ?? []);
      const folded = isGroup(e) && opts.folded.has(e.id);
      rows.push({ type: 'entity', id: e.id, entity: e, depth, members: children.length, folded });
      if (isGroup(e) && !folded && children.length) push(order([...children]), depth + 1, new Set(path).add(e.id));
    }
  };
  walk(order(roots));
  if (joints.length) {
    rows.push({ type: 'header', id: '#joints', label: 'Joints & constraints', count: joints.length });
    for (const j of order(joints))
      rows.push({ type: 'entity', id: j.id, entity: j, depth: 0, members: 0, folded: false });
  }
  return rows;
}

/** Ids from `anchor` to `target` inclusive over the entity rows (header rows are skipped). */
export function rangeIds(rows: readonly Row[], anchor: string | null, target: string): string[] {
  const ids = rows.filter((r): r is EntityRow => r.type === 'entity').map((r) => r.id);
  const b = ids.indexOf(target);
  const a = anchor === null ? b : ids.indexOf(anchor);
  if (b < 0) return [];
  if (a < 0) return [target];
  return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
}

// ── drag & drop ─────────────────────────────────────────────────────────────────────────────────────

export type DropZone = 'before' | 'inside' | 'after';

/** Zone of a row for a pointer at `fraction` (0 top – 1 bottom) of its height. */
export function dropZone(fraction: number, targetIsGroup: boolean): DropZone {
  if (targetIsGroup) return fraction < 0.25 ? 'before' : fraction > 0.75 ? 'after' : 'inside';
  return fraction < 0.5 ? 'before' : 'after';
}

export interface DropPlan {
  /** Entities that actually move (cycles, joints and the target itself removed), in display order. */
  ids: string[];
  /** The new parent: a group id, or null for the top level. */
  parent: string | null;
  /** New global entity order when the drop also reorders; null = membership change only. */
  order: string[] | null;
}

/**
 * What dropping `dragged` on `targetId` does. `zone` 'inside' makes the target group their parent (appended last);
 * 'before' / 'after' put them next to the target under the target's parent (reordering is only offered when
 * `reorder` is true, i.e. in scene-order sort without a filter). `rows` resolves "after an unfolded group" to
 * "first member of that group". Returns null if nothing would change.
 */
export function planDrop(
  entities: readonly Entity[],
  rows: readonly Row[],
  dragged: readonly string[],
  targetId: string,
  zone: DropZone,
  reorder: boolean,
): DropPlan | null {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const target = byId.get(targetId);
  if (!target) return null;
  let where = zone;
  let anchorId = targetId;
  let parent: string | null;
  if (where === 'after') {
    // After an unfolded group that shows members, the next visible row is its first member.
    const i = rows.findIndex((r) => r.type === 'entity' && r.id === targetId);
    const row = rows[i];
    const next = rows[i + 1];
    if (row?.type === 'entity' && isGroup(target) && !row.folded && next?.type === 'entity' && next.depth > row.depth) {
      where = 'before';
      anchorId = next.id;
    }
  }
  if (where === 'inside') {
    if (!isGroup(target)) return null;
    parent = target.id;
  } else {
    if (isJoint(target)) return null;
    const anchor = byId.get(anchorId)!;
    const p = parentOf(anchor);
    parent = p !== undefined && isGroup(byId.get(p)) ? p : null;
  }
  // Moving set: draggable (not joints), not the anchor, not an ancestor of the new parent (cycle).
  const ancestors = new Set<string>();
  for (let cur: string | null = parent, guard = 0; cur !== null && guard < 10_000; guard++) {
    if (ancestors.has(cur)) break;
    ancestors.add(cur);
    const e = byId.get(cur);
    const up: string | undefined = e ? parentOf(e) : undefined;
    cur = up ?? null;
  }
  const dragSet = new Set(dragged);
  const ids = entities
    .filter((e) => dragSet.has(e.id) && !isJoint(e) && e.id !== anchorId && !ancestors.has(e.id))
    .map((e) => e.id);
  if (!ids.length) return null;
  let order: string[] | null = null;
  if (reorder && where !== 'inside')
    order = reorderedOrder(
      entities.map((e) => e.id),
      ids,
      anchorId,
      where,
    );
  const reparent = ids.some((id) => (parentOf(byId.get(id)!) ?? null) !== parent);
  const moved = order !== null && order.some((id, i) => id !== entities[i].id);
  if (!reparent && !moved) return null;
  return { ids, parent, order: moved ? order : null };
}

/** `order` with `moving` taken out and re-inserted (keeping their relative order) before / after `anchor`. */
export function reorderedOrder(
  order: readonly string[],
  moving: readonly string[],
  anchor: string,
  where: 'before' | 'after',
): string[] {
  const mv = new Set(moving);
  const rest = order.filter((id) => !mv.has(id));
  const at = rest.indexOf(anchor);
  if (at < 0) return [...order];
  const inOrder = order.filter((id) => mv.has(id));
  rest.splice(where === 'before' ? at : at + 1, 0, ...inOrder);
  return rest;
}

// ── solo ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Patches that make `toggle` the soloed entities. Solo isolates: everything unrelated to a soloed entity (apart
 * from its ancestors, members and — for joints — both ends) is hidden and marked `soloHid`; clearing the last solo
 * shows exactly the entities that solo hid. Entities the user had hidden stay hidden.
 */
export function soloPatches(entities: readonly Entity[], toggle: readonly string[]): [string, Partial<Entity>][] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const current = new Set(entities.filter((e) => e.solo).map((e) => e.id));
  const want = toggle.filter((id) => byId.has(id));
  const turnOn = want.some((id) => !current.has(id));
  const soloed = new Set(current);
  for (const id of want) {
    if (turnOn) soloed.add(id);
    else soloed.delete(id);
  }
  const kids = new Map<string, string[]>();
  for (const e of entities) {
    const p = parentOf(e);
    if (p === undefined) continue;
    const l = kids.get(p);
    if (l) l.push(e.id);
    else kids.set(p, [e.id]);
  }
  const keep = new Set<string>();
  if (soloed.size) {
    for (const id of soloed) {
      for (
        let cur: string | undefined = id, guard = 0;
        cur !== undefined && guard < 10_000 && !keep.has(cur);
        guard++
      ) {
        keep.add(cur);
        const e = byId.get(cur);
        cur = e ? parentOf(e) : undefined;
      }
      const stack = [id];
      const seen = new Set<string>();
      while (stack.length) {
        const c = stack.pop()!;
        if (seen.has(c)) continue;
        seen.add(c);
        keep.add(c);
        for (const k of kids.get(c) ?? []) stack.push(k);
      }
    }
    for (const e of entities)
      if (isJoint(e) && ((e.bodyA && keep.has(e.bodyA)) || (e.bodyB && keep.has(e.bodyB)))) keep.add(e.id);
  }
  const patches: [string, Partial<Entity>][] = [];
  for (const e of entities) {
    const isSolo = soloed.has(e.id);
    const patch: Partial<Entity> = {};
    if (!!e.solo !== isSolo) patch.solo = isSolo || undefined;
    if (soloed.size && !keep.has(e.id) && !e.hidden) {
      patch.hidden = true;
      patch.soloHid = true;
    } else if ((keep.has(e.id) || !soloed.size) && e.soloHid) {
      patch.hidden = false;
      patch.soloHid = undefined;
    }
    if (Object.keys(patch).length) patches.push([e.id, patch]);
  }
  return patches;
}

// ── tags ────────────────────────────────────────────────────────────────────────────────────────────

/** Every tag in the scene with its entity count, most used first. */
export function tagCounts(entities: readonly Entity[]): [string, number][] {
  const m = new Map<string, number>();
  for (const e of entities) for (const t of tagsOf(e)) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]));
}

/** Ids of entities carrying `tag` (a free tag or, with `color:` prefix, a colour tag). */
export function idsWithTag(entities: readonly Entity[], tag: string): string[] {
  if (tag.startsWith('color:')) {
    const c = tag.slice(6);
    return entities.filter((e) => e.colorTag === c).map((e) => e.id);
  }
  return entities.filter((e) => tagsOf(e).includes(tag)).map((e) => e.id);
}

/** `tags` with `tag` added / removed (no duplicates). */
export function withTag(tags: readonly string[] | undefined, tag: string, on: boolean): string[] {
  const t = (tags ?? []).filter((x) => x !== tag);
  return on ? [...t, tag] : t;
}

/** Selection-set bookkeeping: unique name for a new set. */
export function uniqueSetName(existing: readonly string[], wanted: string): string {
  const base = wanted.trim() || 'Selection';
  if (!existing.includes(base)) return base;
  for (let i = 2; ; i++) if (!existing.includes(`${base} ${i}`)) return `${base} ${i}`;
}
