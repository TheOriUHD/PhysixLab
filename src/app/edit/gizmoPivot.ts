/**
 * How the pivot mode (`Prefs.pivotMode`) reaches the transform gizmo: where its handle sits and whether each item
 * turns / scales about its own pivot (individual origins, group pivot) or all about one shared point.
 */
import { Vector3 } from 'three';
import type { GizmoItem } from '../../render/gizmo';
import { aabbCentre, selectionBounds } from '../../model/edit/bounds';
import { isGroup } from '../../model/types';
import type { App } from '../app';
import { pivotState } from './pivotState';

export interface GizmoPivotPolicy {
  /** World point the handle sits on; null = the median of the items. */
  handle: Vector3 | null;
  /** Each item transforms about its own pivot (`item.pivot` or its position) instead of the shared point. */
  individual: boolean;
}

/** Pivot a group member is turned about in "group pivot" mode: the position of the group it is in. */
export function groupPivotOf(app: App, id: string): Vector3 | undefined {
  const e = app.store.get(id);
  const parent = e && 'parent' in e && e.parent !== undefined ? app.store.get(e.parent) : undefined;
  return isGroup(parent) ? new Vector3(...parent.position) : undefined;
}

export function gizmoPivotPolicy(app: App, items: readonly GizmoItem[]): GizmoPivotPolicy {
  const mode = app.prefs.value.pivotMode;
  // A joint or a path control point has no use for pivots.
  if (items.some((i) => i.id.includes('#') || !!app.store.joint(i.id))) return { handle: null, individual: false };
  switch (mode) {
    case 'cursor':
      return { handle: new Vector3(...pivotState.cursor), individual: false };
    case 'bounds': {
      const box = selectionBounds(
        app.store.all(),
        items.map((i) => i.id),
      );
      return { handle: box ? new Vector3(...aabbCentre(box)) : null, individual: false };
    }
    case 'origins':
    case 'group':
      return { handle: null, individual: true };
    default:
      return { handle: null, individual: false };
  }
}
