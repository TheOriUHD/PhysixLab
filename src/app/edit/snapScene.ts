/**
 * Glue between the pure snapper (`src/model/edit/snap.ts`) and the running app: the snap modes in effect (with the
 * Ctrl inversion), the camera projection, the scene's snappable objects, and the one-call feature snap used by
 * viewport dragging, the gizmo and palette drops.
 */
import { Vector3 } from 'three';
import type { Quat, Vec3 } from '../../core/math';
import { featuresOfShape } from '../../model/edit/shapeSupport';
import {
  resolveFeatureSnap,
  type FeatureModes,
  type Projector,
  type SnapHit,
  type SnapObject,
} from '../../model/edit/snap';
import type { App } from '../app';

/** Screen radius (pixels) within which a feature is picked up. */
export const SNAP_RADIUS_PX = 14;

export interface SnapModes extends FeatureModes {
  grid: boolean;
  surface: boolean;
  alignNormal: boolean;
}

/**
 * The snap switches in effect. Holding Ctrl (or ⌘) inverts snapping for as long as it is held: with any snap on, every
 * snap is suspended; with all of them off, grid and surface snapping are switched on. (`invert` is false for events
 * that have no modifier.)
 */
export function effectiveModes(app: App, invert = false): SnapModes {
  const p = app.prefs.value;
  const anyOn = p.snap || p.snapVertex || p.snapEdge || p.snapFace || p.snapBounds || p.snapSurface;
  if (invert) {
    return {
      grid: !anyOn,
      vertex: false,
      edge: false,
      face: false,
      bounds: false,
      surface: !anyOn,
      alignNormal: p.snapAlignNormal,
    };
  }
  return {
    grid: p.snap,
    vertex: p.snapVertex,
    edge: p.snapEdge,
    face: p.snapFace,
    bounds: p.snapBounds,
    surface: p.snapSurface,
    alignNormal: p.snapAlignNormal,
  };
}

export const invertKey = (e: { ctrlKey?: boolean; metaKey?: boolean }): boolean => !!(e.ctrlKey || e.metaKey);

/** Anything but the grid: do the object snaps need the scene at all? */
export const anyFeatureMode = (m: FeatureModes): boolean => m.vertex || m.edge || m.face || m.bounds;

const tmp = new Vector3();

/** World point → pixels of the viewport (false when behind the camera). */
export function makeProjector(app: App): Projector {
  const rect = app.viewport.dom.getBoundingClientRect();
  const cam = app.camera;
  return (p, out) => {
    tmp.set(p[0], p[1], p[2]).project(cam);
    if (tmp.z > 1 || tmp.z < -1) return false;
    out[0] = ((tmp.x + 1) / 2) * rect.width;
    out[1] = ((1 - tmp.y) / 2) * rect.height;
    return true;
  };
}

/** World size of one screen pixel at a distance from the camera. */
export function worldPerPixel(app: App, at: Vec3): number {
  const rect = app.viewport.dom.getBoundingClientRect();
  const d = app.camera.position.distanceTo(tmp.set(at[0], at[1], at[2]));
  return (2 * d * Math.tan((app.camera.fov * Math.PI) / 360)) / Math.max(1, rect.height);
}

/** A body as a snappable object at an explicit pose (or null for hidden / unknown bodies). */
export function snapObjectOf(app: App, id: string, position?: Vec3, rotation?: Quat): SnapObject | null {
  const b = app.store.body(id);
  if (!b) return null;
  const pose = app.sim.poseOf(id);
  return {
    id,
    position: position ?? pose?.position ?? b.position,
    rotation: rotation ?? pose?.rotation ?? b.rotation,
    shape: featuresOfShape(b.shape, !!b.parts?.length),
  };
}

/**
 * The visible bodies near `around` (within `reach` metres of their centre), except `exclude`: the candidates a dragged
 * object can snap to. Prefiltered here so a big scene never builds objects for far-away bodies.
 */
export function nearbySnapObjects(app: App, around: Vec3, reach: number, exclude: ReadonlySet<string>): SnapObject[] {
  const out: SnapObject[] = [];
  for (const b of app.store.bodies()) {
    if (b.hidden || exclude.has(b.id)) continue;
    const pose = app.sim.poseOf(b.id);
    const p = pose?.position ?? b.position;
    const r = Math.hypot(b.shape.size[0], b.shape.size[1], b.shape.size[2]) / 2;
    if (Math.hypot(p[0] - around[0], p[1] - around[1], p[2] - around[2]) > reach + r) continue;
    const o = snapObjectOf(app, b.id, p, pose?.rotation);
    if (o) out.push(o);
  }
  return out;
}

/**
 * Best vertex / edge / face / bounds snap for objects at their proposed poses, with everything in `exclude` (normally
 * the moving objects themselves) ignored as candidates.
 */
export function featureSnapFor(
  app: App,
  moving: SnapObject[],
  modes: FeatureModes,
  exclude: ReadonlySet<string>,
): SnapHit | null {
  if (!moving.length || !anyFeatureMode(modes)) return null;
  const c: Vec3 = [0, 0, 0];
  for (const m of moving) {
    c[0] += m.position[0] / moving.length;
    c[1] += m.position[1] / moving.length;
    c[2] += m.position[2] / moving.length;
  }
  const worldReach = SNAP_RADIUS_PX * worldPerPixel(app, c) * 1.6 + 0.05;
  let movingReach = 0;
  for (const m of moving) {
    const b = app.store.body(m.id);
    if (b)
      movingReach = Math.max(
        movingReach,
        Math.hypot(...b.shape.size) / 2 + Math.hypot(m.position[0] - c[0], m.position[1] - c[1], m.position[2] - c[2]),
      );
  }
  const others = nearbySnapObjects(app, c, worldReach + movingReach + 1, exclude);
  if (!others.length) return null;
  return resolveFeatureSnap({
    moving,
    others,
    modes,
    project: makeProjector(app),
    radiusPx: SNAP_RADIUS_PX,
    worldReach,
  });
}
