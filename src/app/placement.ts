/** Picking and placement helpers: what is under the pointer, and where new objects should appear. */
import type { Vec3 } from '../core/math';
import type { ShapeType } from '../model/types';
import type { PickHit } from '../render/picking';
import type { App } from './app';
import { dropPoseForShape } from './edit/surfaceDrop';

export class Placement {
  constructor(private app: App) {}

  /** Pick a body or joint under the pointer. */
  pickEntity(
    ev: { clientX: number; clientY: number },
    opts: { bodies?: boolean; joints?: boolean } = {},
  ): PickHit | null {
    const { app } = this;
    const targets = [];
    if (opts.joints !== false) targets.push(...app.joints.pickables());
    // Joint gizmos draw on top, so give them priority when they are hit.
    if (targets.length) {
      const j = app.picker.pick(ev, targets);
      if (j) {
        const b = opts.bodies !== false ? app.picker.pick(ev, app.bodies.pickables()) : null;
        // Prefer a body only if it is clearly in front of the joint handle.
        if (!b || b.distance > j.distance - 0.15) return j;
        return b;
      }
    }
    if (opts.bodies === false) return null;
    return app.picker.pick(ev, [
      ...app.bodies.pickables(),
      ...app.softs.pickables(),
      // groups, lights and paths are editor objects: they are picked like bodies (the nearest hit wins)
      ...app.groupViews.pickables(),
      ...app.lightViews.pickables(),
      ...app.pathViews.pickables(),
    ]);
  }

  /** Point where something new should be placed when the user clicks "add" (centre of the view). */
  viewCenterPlacement(shapeType: ShapeType, size: Vec3): Vec3 {
    const rect = this.app.viewport.dom.getBoundingClientRect();
    return this.placementAt(
      { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height * 0.6 },
      shapeType,
      size,
    );
  }

  placementAt(ev: { clientX: number; clientY: number }, shapeType: ShapeType, size: Vec3): Vec3 {
    // -- ED-A snap: the pointer ray lands the shape flush on the surface under it (src/app/edit/surfaceDrop.ts) --
    return dropPoseForShape(this.app, ev, shapeType, size).position;
  }
}
