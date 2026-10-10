/**
 * ED-1 — pure selection logic (no DOM, no three.js, no engine): lasso / brush hit tests over projected points,
 * "select similar", invert, name / tag / kind filters, group children and joint-graph walking (connected, grow,
 * shrink). Everything takes plain entities and ids and returns ids, so it is unit-testable with small fixtures.
 *
 * Rules shared by every function: hidden entities are never selected (locked ones are — locking only protects
 * against moving), and results keep a stable order (existing selection first, then document order).
 */
import { childIndex, descendantIds } from '../groups';
import type { BodyEntity, Entity, JointEntity } from '../types';
import { isBody, isGroup, isJoint, parentOf } from '../types';

// ── screen-space hit tests ────────────────────────────────────────────────────────────────────────────────────

export type ScreenPt = readonly [number, number];

/** One selectable thing as the viewport sees it: its id and the projected sample points (the first is its centre). */
export interface ScreenTarget {
  id: string;
  samples: readonly ScreenPt[];
}

/** Even-odd point-in-polygon test (the polygon is implicitly closed). Fewer than three vertices contain nothing. */
export function pointInPolygon(x: number, y: number, poly: readonly ScreenPt[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ids of the targets with at least one sample point inside the lasso polygon (order of `targets`). */
export function lassoHits(targets: Iterable<ScreenTarget>, poly: readonly ScreenPt[]): string[] {
  const out: string[] = [];
  for (const t of targets) if (t.samples.some(([x, y]) => pointInPolygon(x, y, poly))) out.push(t.id);
  return out;
}

/** Ids of the targets with at least one sample point within `radius` pixels of (cx, cy). */
export function brushHits(targets: Iterable<ScreenTarget>, cx: number, cy: number, radius: number): string[] {
  const r2 = radius * radius;
  const out: string[] = [];
  for (const t of targets) if (t.samples.some(([x, y]) => (x - cx) ** 2 + (y - cy) ** 2 <= r2)) out.push(t.id);
  return out;
}

export type SelectMode = 'replace' | 'add' | 'subtract';

/** Modifier keys to mode: Ctrl / Cmd subtracts, Shift adds, nothing replaces. */
export function modeFromModifiers(m: { shift?: boolean; ctrl?: boolean; meta?: boolean }): SelectMode {
  if (m.ctrl || m.meta) return 'subtract';
  return m.shift ? 'add' : 'replace';
}

/** Combine the current selection with newly picked ids. Order: existing members first, then new ones. */
export function combineSelection(current: readonly string[], picked: readonly string[], mode: SelectMode): string[] {
  if (mode === 'replace') return [...new Set(picked)];
  if (mode === 'add') return [...new Set([...current, ...picked])];
  const drop = new Set(picked);
  return current.filter((id) => !drop.has(id));
}

// ── similarity ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface SimilarCriteria {
  shape?: boolean;
  material?: boolean;
  size?: boolean;
  tag?: boolean;
  kind?: boolean;
  layer?: boolean;
}

const SIZE_TOLERANCE = 0.01; // relative

const sameSize = (a: BodyEntity, b: BodyEntity): boolean =>
  a.shape.size.every(
    (v, i) => Math.abs(v - b.shape.size[i]) <= SIZE_TOLERANCE * Math.max(Math.abs(v), Math.abs(b.shape.size[i]), 1e-6),
  );

const sameMaterial = (a: BodyEntity, b: BodyEntity): boolean =>
  a.material.preset === b.material.preset && a.material.color.toLowerCase() === b.material.color.toLowerCase();

/** Bodies share a tag when they have one in common (two untagged bodies count as sharing "no tag"). */
const shareTag = (a: BodyEntity, b: BodyEntity): boolean =>
  a.tags.length === 0 && b.tags.length === 0 ? true : a.tags.some((t) => b.tags.includes(t));

function matchesSeed(c: Entity, seed: Entity, k: SimilarCriteria): boolean {
  if (k.kind && c.kind !== seed.kind) return false;
  if (!(k.shape || k.material || k.size || k.tag || k.layer)) return true;
  if (!isBody(c) || !isBody(seed)) return false;
  if (k.shape && c.shape.type !== seed.shape.type) return false;
  if (k.material && !sameMaterial(c, seed)) return false;
  if (k.size && !sameSize(c, seed)) return false;
  if (k.tag && !shareTag(c, seed)) return false;
  if (k.layer && c.layer !== seed.layer) return false;
  return true;
}

/**
 * Every visible entity that matches at least one seed on all of the enabled criteria. With no criterion enabled only
 * the (visible) seeds are returned. Shape / material / size / tag / layer apply to bodies; `kind` compares the entity
 * kind (body, soft, light, group, joint, path).
 */
export function selectSimilar(
  entities: readonly Entity[],
  seedIds: readonly string[],
  criteria: SimilarCriteria,
): string[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const seeds = seedIds.map((id) => byId.get(id)).filter((e): e is Entity => !!e && !e.hidden);
  if (!seeds.length) return [];
  const none = !Object.values(criteria).some(Boolean);
  const out: string[] = [];
  for (const c of entities) {
    if (c.hidden) continue;
    if (seeds.some((s) => s.id === c.id || (!none && matchesSeed(c, s, criteria)))) out.push(c.id);
  }
  return out;
}

// ── invert / filter ────────────────────────────────────────────────────────────────────────────────────────────

/** Every visible entity that is not in the selection. */
export function invertSelection(entities: readonly Entity[], selection: readonly string[]): string[] {
  const sel = new Set(selection);
  return entities.filter((e) => !e.hidden && !sel.has(e.id)).map((e) => e.id);
}

export interface EntityFilter {
  /** Name text: a substring (case-insensitive) unless `regex`. Empty = any name. */
  name?: string;
  regex?: boolean;
  /** Exact tag (case-insensitive) a body must carry. Empty = any. */
  tag?: string;
  /** Entity kind ('body', 'joint', 'group' …). Empty / undefined = any. */
  kind?: Entity['kind'] | '';
  /** Shape type of a body ('box', 'sphere' …). Empty = any. */
  shape?: string;
  layer?: string;
  bodyType?: BodyEntity['bodyType'] | '';
}

/** Is the filter's name pattern a valid regular expression? (Always true when `regex` is off.) */
export function filterIsValid(f: EntityFilter): boolean {
  if (!f.regex || !f.name) return true;
  try {
    new RegExp(f.name, 'i');
    return true;
  } catch {
    return false;
  }
}

/** Does the filter constrain nothing? Such a filter matches nothing on purpose (it would just be "select all"). */
export const filterIsEmpty = (f: EntityFilter): boolean =>
  !f.name && !f.tag && !f.kind && !f.shape && !f.layer && !f.bodyType;

/** Ids of the visible entities that satisfy every non-empty part of the filter. An empty or invalid filter matches nothing. */
export function filterEntities(entities: readonly Entity[], f: EntityFilter): string[] {
  if (filterIsEmpty(f) || !filterIsValid(f)) return [];
  const re = f.regex && f.name ? new RegExp(f.name, 'i') : null;
  const needle = f.name?.toLowerCase() ?? '';
  const tag = f.tag?.trim().toLowerCase() ?? '';
  const out: string[] = [];
  for (const e of entities) {
    if (e.hidden) continue;
    if (f.kind && e.kind !== f.kind) continue;
    if (re ? !re.test(e.name) : needle && !e.name.toLowerCase().includes(needle)) continue;
    if (tag || f.shape || f.layer || f.bodyType) {
      if (!isBody(e)) continue;
      if (tag && !e.tags.some((t) => t.toLowerCase() === tag)) continue;
      if (f.shape && e.shape.type !== f.shape) continue;
      if (f.layer && e.layer !== f.layer) continue;
      if (f.bodyType && e.bodyType !== f.bodyType) continue;
    }
    out.push(e.id);
  }
  return out;
}

// ── groups ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The members of the selected groups: direct children by default, every descendant with `deep`. Visible members only;
 * sub-groups are returned as members (and expanded with `deep`). Empty when no group is selected.
 */
export function groupChildren(entities: readonly Entity[], selection: readonly string[], deep = false): string[] {
  const index = childIndex(entities);
  const byId = new Map(entities.map((e) => [e.id, e]));
  const out = new Set<string>();
  for (const id of selection) {
    if (!isGroup(byId.get(id))) continue;
    for (const c of deep ? descendantIds(index, id) : (index.get(id) ?? [])) out.add(c);
  }
  return entities.filter((e) => out.has(e.id) && !e.hidden && parentOf(e) !== undefined).map((e) => e.id);
}

// ── joint graph ────────────────────────────────────────────────────────────────────────────────────────────────

/** body id → ids of the bodies joined to it (either direction; joints to the world add no neighbour). */
export function jointAdjacency(entities: readonly Entity[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let s = adj.get(a);
    if (!s) adj.set(a, (s = new Set()));
    s.add(b);
  };
  for (const j of entities) {
    if (!isJoint(j) || !j.bodyA || !j.bodyB || j.bodyA === j.bodyB) continue;
    link(j.bodyA, j.bodyB);
    link(j.bodyB, j.bodyA);
  }
  return adj;
}

/** Body ids that ids stand for (a joint stands for both of its bodies). */
function seedBodies(byId: Map<string, Entity>, ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const e = byId.get(id);
    if (isBody(e)) out.push(e.id);
    else if (isJoint(e)) for (const b of [e.bodyA, e.bodyB]) if (b) out.push(b);
  }
  return out;
}

const visibleBodyIds = (entities: readonly Entity[]): Set<string> =>
  new Set(entities.filter((e) => isBody(e) && !e.hidden).map((e) => e.id));

/** Visible joints whose bodies are all in `bodies` (a joint to the world needs only its one body). */
function jointsAmong(entities: readonly Entity[], bodies: ReadonlySet<string>): JointEntity[] {
  return entities.filter(
    (e): e is JointEntity =>
      isJoint(e) &&
      !e.hidden &&
      (!!e.bodyA || !!e.bodyB) &&
      (!e.bodyA || bodies.has(e.bodyA)) &&
      (!e.bodyB || bodies.has(e.bodyB)),
  );
}

/**
 * Flood fill through joints, both directions: every visible body reachable from the seeds (bodies, or joints standing
 * for their two bodies), seeds included. Hidden bodies are neither returned nor walked through. Results are in
 * document order; with `includeJoints` the joints between the reached bodies follow.
 */
export function connectedByJoints(
  entities: readonly Entity[],
  seedIds: readonly string[],
  includeJoints = false,
): string[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const visible = visibleBodyIds(entities);
  const adj = jointAdjacency(entities);
  const seen = new Set<string>();
  const stack = seedBodies(byId, seedIds).filter((b) => visible.has(b));
  for (const s of stack) seen.add(s);
  while (stack.length) {
    const b = stack.pop()!;
    for (const n of adj.get(b) ?? []) {
      if (!visible.has(n) || seen.has(n)) continue;
      seen.add(n);
      stack.push(n);
    }
  }
  const joints = includeJoints ? new Set(jointsAmong(entities, seen).map((j) => j.id)) : new Set<string>();
  return entities.filter((e) => seen.has(e.id) || joints.has(e.id)).map((e) => e.id);
}

/**
 * One joint hop outwards: the selection plus every visible body joined to a selected body (a selected joint counts
 * as both of its bodies). Other selected entities are kept untouched.
 */
export function growByJoints(entities: readonly Entity[], selection: readonly string[]): string[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const visible = visibleBodyIds(entities);
  const adj = jointAdjacency(entities);
  const add = new Set<string>();
  for (const b of seedBodies(byId, selection)) for (const n of adj.get(b) ?? []) if (visible.has(n)) add.add(n);
  const out = [...selection];
  const have = new Set(out);
  for (const e of entities) if (add.has(e.id) && !have.has(e.id)) out.push(e.id);
  return out;
}

/**
 * One joint hop inwards: drops every selected body that is joined to a body outside the selection (the boundary of
 * the selected region). Bodies without such a neighbour — including bodies with no joints at all — and entities
 * that are not bodies stay. Selected joints whose body was dropped go too.
 */
export function shrinkByJoints(entities: readonly Entity[], selection: readonly string[]): string[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const adj = jointAdjacency(entities);
  const inSel = new Set(selection);
  const drop = new Set<string>();
  for (const id of selection) {
    if (!isBody(byId.get(id))) continue;
    for (const n of adj.get(id) ?? []) {
      if (!inSel.has(n)) {
        drop.add(id);
        break;
      }
    }
  }
  return selection.filter((id) => {
    if (drop.has(id)) return false;
    const e = byId.get(id);
    return !(isJoint(e) && ((e.bodyA && drop.has(e.bodyA)) || (e.bodyB && drop.has(e.bodyB))));
  });
}
