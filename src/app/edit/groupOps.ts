/**
 * Group operations that go beyond move / rotate: scale about the pivot, weld into one rigid assembly, unweld.
 * Free functions over the store (one undo step each); the registrations are in `ui/extensions/ed-hierarchy.ts`.
 */
import type { Vec3 } from '../../core/math';
import { scaleGroupPatches } from '../../model/edit/groupScale';
import { planWeld, weldJointsAmong } from '../../model/edit/weld';
import { descendantIds, childIndex } from '../../model/groups';
import type { SceneStore } from '../../model/store';
import type { BodyEntity, Entity } from '../../model/types';
import { isBody } from '../../model/types';

/** The bodies below a group (any depth). */
export function groupBodies(store: SceneStore, groupId: string): BodyEntity[] {
  const all = store.all();
  const ids = new Set(descendantIds(childIndex(all), groupId));
  return all.filter((e): e is BodyEntity => isBody(e) && ids.has(e.id));
}

/** Scale a group by `factor` (along the group's own axes) about its pivot. One undo step. */
export function scaleGroup(
  store: SceneStore,
  groupId: string,
  factor: Vec3,
  label = 'Scale group',
): { changed: boolean; approximate: boolean } {
  if (!store.group(groupId)) return { changed: false, approximate: false };
  const { patches, approximate } = scaleGroupPatches(store.all(), groupId, factor);
  if (!patches.length) return { changed: false, approximate };
  store.updateMany(patches, label);
  return { changed: true, approximate };
}

// ---- gizmo drag: the factor is cumulative from the start of the drag, so it is applied to a snapshot ----------

let dragBase: { id: string; entities: Entity[] } | null = null;
let dragApproximate = false;

/** Scale from the gizmo (factor relative to the state when the drag began). Call within `store.begin` / `end`. */
export function scaleGroupDrag(store: SceneStore, groupId: string, factor: Vec3): void {
  if (!dragBase || dragBase.id !== groupId) dragBase = { id: groupId, entities: store.all() };
  const { patches, approximate } = scaleGroupPatches(dragBase.entities, groupId, factor);
  dragApproximate = approximate;
  // Back to the snapshot first when the factor returns to 1 (patches are empty then).
  if (!patches.length) {
    const restore = dragBase.entities.filter((e) => store.has(e.id)).map((e): [string, Partial<Entity>] => [e.id, e]);
    store.updateMany(restore, 'Scale group');
    return;
  }
  store.updateMany(patches, 'Scale group');
}

/** End of a gizmo drag; true when a non-uniform scale was only approximate for some member. */
export function endScaleGroupDrag(): boolean {
  const approx = dragApproximate && dragBase !== null;
  dragBase = null;
  dragApproximate = false;
  return approx;
}

// ---- weld ------------------------------------------------------------------------------------------------

/**
 * Join the bodies of a group (any depth) with `fixed` joints: a proximity spanning tree, n bodies → n−1 joints, no
 * static–static links, bodies already welded are respected. One undo step. Returns the number of joints added.
 */
export function weldGroup(store: SceneStore, groupId: string): number {
  const group = store.group(groupId);
  if (!group) return 0;
  const bodies = groupBodies(store, groupId);
  if (bodies.length < 2) return 0;
  const ids = new Set(bodies.map((b) => b.id));
  const existing = weldJointsAmong(store.all(), ids);
  const joints = planWeld(bodies, existing, group.name);
  if (!joints.length) return 0;
  store.add(joints, `Weld ${group.name}`, false);
  return joints.length;
}

/** Remove the weld joints made by `weldGroup` among the group's bodies (other fixed joints stay). One undo step. */
export function unweldGroup(store: SceneStore, groupId: string): number {
  const group = store.group(groupId);
  if (!group) return 0;
  const ids = new Set(groupBodies(store, groupId).map((b) => b.id));
  const welds = weldJointsAmong(store.all(), ids);
  if (!welds.length) return 0;
  store.remove(
    welds.map((j) => j.id),
    `Unweld ${group.name}`,
  );
  return welds.length;
}

/** Number of weld joints currently holding the group's bodies together. */
export function weldCount(store: SceneStore, groupId: string): number {
  return weldJointsAmong(store.all(), new Set(groupBodies(store, groupId).map((b) => b.id))).length;
}
