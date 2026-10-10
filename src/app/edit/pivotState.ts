/**
 * Editor-side pivot state that is not part of the scene document: the 3D cursor and the "edit group pivot only"
 * switch. (The pivot *mode* is a preference, `Prefs.pivotMode`.) Plain module state with change listeners, so the
 * gizmo glue, the cursor marker and the commands share it without growing `App`.
 */
import type { Vec3 } from '../../core/math';

export const pivotState = {
  /** World position of the 3D cursor. */
  cursor: [0, 0, 0] as Vec3,
  /** The cursor has been placed at least once (it is drawn from then on). */
  cursorPlaced: false,
  /** While on, dragging a selected group with the gizmo moves/turns only its pivot, not its members. */
  groupPivotOnly: false,
};

const listeners = new Set<() => void>();

/** Subscribe to cursor / switch changes; returns the unsubscribe function. */
export function onPivotState(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of [...listeners]) fn();
}

export function setCursor(p: Vec3): void {
  pivotState.cursor = [p[0], p[1], p[2]];
  pivotState.cursorPlaced = true;
  notify();
}

export function setGroupPivotOnly(on: boolean): void {
  if (pivotState.groupPivotOnly === on) return;
  pivotState.groupPivotOnly = on;
  notify();
}
