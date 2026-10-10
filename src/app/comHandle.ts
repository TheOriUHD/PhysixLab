/**
 * JT-33: the viewport handle of a body's centre-of-mass override. While a body is in "edit centre of mass" mode the
 * move gizmo sits on its centre of mass instead of its origin; dragging it writes `comOverride` (in the body's local
 * frame, one undo step per drag). The mode ends when the selection changes or the simulation starts.
 */
import { Quaternion, Vector3 } from 'three';
import { qrot, qrotInv, vadd, vsub } from '../core/math';
import type { GizmoItem, GizmoUpdate } from '../render/gizmo';
import type { App } from './app';

export const COM_SUFFIX = '@com';

export class ComHandle {
  /** The body whose centre of mass is being edited, or null. */
  bodyId: string | null = null;

  constructor(private app: App) {}

  set(id: string | null): void {
    this.bodyId = id;
    this.app.gizmos.refresh();
    this.app.emit('comEdit', id);
  }

  /** The gizmo item for the handle, or null when the mode is off (it also switches itself off when it no longer applies). */
  item(): GizmoItem | null {
    const { app } = this;
    const id = this.bodyId;
    if (!id) return null;
    const sel = app.store.selection;
    const b = app.store.body(id);
    if (!b || sel.length !== 1 || sel[0] !== id || app.sim.active || b.bodyType === 'static' || b.locked) {
      this.bodyId = null;
      app.emit('comEdit', null);
      return null;
    }
    const pose = app.sim.poseOf(id);
    if (!pose) return null;
    const world = vadd(pose.position, qrot(pose.rotation, b.comOverride ?? [0, 0, 0]));
    return {
      id: id + COM_SUFFIX,
      position: new Vector3(...world),
      quaternion: new Quaternion(...pose.rotation),
      size: new Vector3(1, 1, 1),
    };
  }

  /** Apply a gizmo drag of the handle; returns true when the update was ours. */
  apply(u: GizmoUpdate): boolean {
    if (!u.id.endsWith(COM_SUFFIX)) return false;
    const id = u.id.slice(0, -COM_SUFFIX.length);
    const pose = this.app.sim.poseOf(id);
    if (!pose) return true;
    const local = qrotInv(pose.rotation, vsub(u.position, pose.position));
    this.app.store.update(id, { comOverride: local }, 'Move centre of mass');
    return true;
  }
}
