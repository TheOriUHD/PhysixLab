/**
 * Numeric transform entry on the selection (ED-14): rotate by an angle, and move the centre of a multi-selection.
 *
 * The rules (also in the inspector tooltips):
 *   • Position fields of ONE object edit that object. An entry may be absolute (`3`, `=3`, `150cm`) or relative to the
 *     field (`+0.5`, `*2`, `/4`, `- 1`, `x+1`).
 *   • With SEVERAL objects selected the Position fields show the CENTRE of the selection (mean position). An absolute
 *     entry moves the whole selection rigidly so that its centre is the typed value on that axis; a relative entry
 *     shifts the centre the same way. Objects keep their spacing; use Align (ED-10) to give them all the same value.
 *   • A relative entry in a Rotation field (`+15`) does not add to the Euler angle: it TURNS the object by that many
 *     degrees about the field's axis — the world axis in World space, the object's own axis in Local space (the X key
 *     switches). With several objects selected World space swings the selection round its centre as one rigid body,
 *     Local space turns each object about its own centre.
 *   • "Rotate by" (X / Y / Z + angle) does the same for any selection.
 * Locked and hidden objects are left alone; group members move with their group; one undo step per entry.
 */
import { topLevel } from '../../model/groups';
import { moveCentre, rotateBy, type PoseItem, type TransformSpace } from '../../model/edit/rotateBy';
import { isPosed } from '../../model/types';
import type { App } from '../app';

/** The poses of the editable top-level entities among `ids` (members of a selected group are carried by the group). */
export function editablePoses(app: App, ids: readonly string[]): PoseItem[] {
  const { store, sim } = app;
  const ok = ids.filter((id) => {
    const e = store.get(id);
    return isPosed(e) && !e.locked && !e.hidden && !(sim.active && !store.body(id));
  });
  const roots = topLevel((id) => store.get(id), ok);
  const out: PoseItem[] = [];
  for (const id of roots) {
    const pose = sim.poseOf(id);
    const e = store.get(id);
    if (pose) out.push({ id, position: pose.position, rotation: pose.rotation });
    else if (isPosed(e)) out.push({ id, position: e.position, rotation: e.rotation });
  }
  return out;
}

function apply(app: App, label: string, items: PoseItem[]): boolean {
  if (!items.length) return false;
  app.store.transact(label, () => {
    for (const it of items) app.editor.setPose(it.id, it.position, it.rotation);
  });
  return true;
}

/** Turn the selection by `angleDeg` about world/local axis `axis` (0 = X, 1 = Y, 2 = Z). */
export function rotateSelectionBy(
  app: App,
  ids: readonly string[],
  axis: 0 | 1 | 2,
  angleDeg: number,
  space: TransformSpace = app.prefs.value.space,
): boolean {
  if (!Number.isFinite(angleDeg) || angleDeg === 0) return false;
  const items = editablePoses(app, ids);
  return apply(app, `Rotate ${angleDeg}°`, rotateBy(items, axis, angleDeg, space));
}

/** Move the selection rigidly so that the centre of its editable members has coordinate `target` on `axis`. */
export function moveSelectionCentre(app: App, ids: readonly string[], axis: 0 | 1 | 2, target: number): boolean {
  if (!Number.isFinite(target)) return false;
  return apply(app, 'Move', moveCentre(editablePoses(app, ids), axis, target));
}
