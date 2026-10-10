/**
 * Group hierarchy helpers (pure, no store): who is under whom, and the patches that carry a group's members when
 * the group's pivot moves.
 *
 * Members keep their own *world* pose in the document; a group stores only a pivot (`position` / `rotation`). Moving
 * a group therefore means applying one rigid transform — "old pivot frame → new pivot frame" — to every descendant,
 * which `groupTransformPatches` turns into the patches `SceneStore.transformGroup` applies in one undo step.
 */
import { qconj, qmul, qnorm, qrot, vadd, vsub, type Quat, type Vec3 } from '../core/math';
import { LIMITS } from './limits';
import type { Entity, GroupEntity, PosedEntity } from './types';
import { isGroup, isJoint, isPosed, parentOf } from './types';

export interface Pose {
  position: Vec3;
  rotation: Quat;
}

/** parent id → ids of the entities directly under it. */
export function childIndex(entities: Iterable<Entity>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const e of entities) {
    const p = parentOf(e);
    if (p === undefined) continue;
    const list = index.get(p);
    if (list) list.push(e.id);
    else index.set(p, [e.id]);
  }
  return index;
}

/** Ids of every entity below `id` (children, their children …), nearest first. Cycle-safe and depth-limited. */
export function descendantIds(index: Map<string, string[]>, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let level = [id];
  for (let depth = 0; depth < LIMITS.maxGroupDepth && level.length; depth++) {
    const next: string[] = [];
    for (const parent of level) {
      for (const c of index.get(parent) ?? []) {
        if (seen.has(c)) continue;
        seen.add(c);
        out.push(c);
        next.push(c);
      }
    }
    level = next;
  }
  return out;
}

/** `ids` plus everything below any of them. */
export function withDescendants(entities: readonly Entity[], ids: Iterable<string>): Set<string> {
  const index = childIndex(entities);
  const set = new Set<string>(ids);
  for (const id of [...set]) for (const d of descendantIds(index, id)) set.add(d);
  return set;
}

/**
 * The ids of `ids` that are not below another member of `ids` — what a move or duplicate should act on.
 * `lookup` finds an entity by id (`store.get`), so no index of the whole scene is built.
 */
export function topLevel(lookup: (id: string) => Entity | undefined, ids: readonly string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    const seen = new Set<string>([id]);
    const self = lookup(id);
    let p = self ? parentOf(self) : undefined;
    while (p !== undefined && !seen.has(p)) {
      if (set.has(p)) return false;
      seen.add(p);
      const up = lookup(p);
      p = up ? parentOf(up) : undefined;
    }
    return true;
  });
}

/** Rigid transform that carries the frame `from` onto the frame `to`: p ↦ to.position + R·(p − from.position). */
export function frameDelta(from: Pose, to: Pose): { rot: Quat; point(p: Vec3): Vec3; dir(d: Vec3): Vec3 } {
  const rot = qnorm(qmul(to.rotation, qconj(from.rotation)));
  return {
    rot,
    point: (p) => vadd(to.position, qrot(rot, vsub(p, from.position))),
    dir: (d) => qrot(rot, d),
  };
}

/**
 * The patches that move group `groupId` to `to` and carry everything below it along: every posed descendant
 * (bodies, soft bodies, lights, paths, sub-groups) is moved by the same rigid transform, and joints anchored to
 * the world on one side — whose bodies are all being moved — have their world-frame anchors (and axis) follow.
 */
export function groupTransformPatches(
  entities: readonly Entity[],
  groupId: string,
  to: Pose,
): [string, Partial<Entity>][] {
  const group = entities.find((e): e is GroupEntity => e.id === groupId && isGroup(e));
  if (!group) return [];
  const delta = frameDelta(group, to);
  const index = childIndex(entities);
  const moved = new Set(descendantIds(index, groupId));
  const patches: [string, Partial<Entity>][] = [[groupId, { position: [...to.position], rotation: [...to.rotation] }]];
  const byId = new Map(entities.map((e) => [e.id, e]));
  for (const id of moved) {
    const e = byId.get(id);
    if (!e || !isPosed(e)) continue;
    patches.push([id, posePatch(e, delta)]);
  }
  for (const j of entities) {
    if (!isJoint(j) || (j.bodyA !== null && j.bodyB !== null)) continue;
    // Both bodies (if any) must travel with the group, otherwise the world anchor stays where it is.
    const bodies = [j.bodyA, j.bodyB].filter((b): b is string => b !== null);
    if (!bodies.length || !bodies.every((b) => moved.has(b))) continue;
    const patch: Partial<typeof j> = {};
    if (j.bodyA === null) {
      patch.anchorA = delta.point(j.anchorA);
      patch.axis = delta.dir(j.axis);
    }
    if (j.bodyB === null) patch.anchorB = delta.point(j.anchorB);
    patches.push([j.id, patch]);
  }
  return patches;
}

function posePatch(e: PosedEntity, delta: ReturnType<typeof frameDelta>): Partial<PosedEntity> {
  return { position: delta.point(e.position), rotation: qnorm(qmul(delta.rot, e.rotation)) };
}
