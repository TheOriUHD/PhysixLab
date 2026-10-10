/**
 * Path editing operations on the document (ED-23): the commands behind reverse / close / respace / subdivide /
 * simplify / flatten / snap, removing the active control point and "path through selection". Free functions of
 * `(app, ...)` so the commands, the inspector buttons, the path tool and the tests share one code path. Every
 * operation is ONE undo step, skips locked and hidden paths, and does nothing while a simulation is running.
 */
import type { Vec3 } from '../../core/math';
import {
  canClose,
  flatten,
  minPoints,
  pointsThrough,
  removePoint,
  resample,
  reversePoints,
  simplify,
  snapPointsToGrid,
  subdivide,
} from '../../model/edit/pathEdit';
import type { PathEntity } from '../../model/types';
import { isPath, isPosed } from '../../model/types';
import { createPath } from '../../model/factory';
import type { App } from '../app';

/** Selected paths that can be edited right now (not locked, not hidden, simulation stopped). */
export function editablePaths(app: App): PathEntity[] {
  if (app.sim.active) return [];
  const out: PathEntity[] = [];
  for (const id of app.store.selection) {
    const e = app.store.get(id);
    if (isPath(e) && !e.locked && !e.hidden) out.push(e);
  }
  return out;
}

export const hasEditablePath = (app: App): boolean => editablePaths(app).length > 0;

/** Apply `fn` to every editable selected path in one undo step; `fn` returns the patch or null to skip. */
export function editPaths(
  app: App,
  label: string,
  fn: (p: PathEntity) => Partial<PathEntity> | null,
  whySkipped?: string,
): number {
  const targets = editablePaths(app);
  if (!targets.length) {
    app.toast('Select an unlocked path first', 'warn');
    return 0;
  }
  let done = 0;
  app.store.transact(label, () => {
    for (const p of targets) {
      const patch = fn(p);
      if (patch) {
        app.store.update(p.id, patch, label);
        done++;
      }
    }
  });
  if (!done && whySkipped) app.toast(whySkipped, 'warn');
  return done;
}

export const reversePaths = (app: App): number =>
  editPaths(app, 'Reverse path', (p) => ({ points: reversePoints(p.points, p.closed) }));

export function toggleClosed(app: App): number {
  return editPaths(
    app,
    'Close or open path',
    (p) => {
      if (!p.closed && !canClose(p.points.length)) return null;
      return { closed: !p.closed };
    },
    'A closed path needs at least three points',
  );
}

/** Respace the control points evenly by arc length; `count` defaults to the current number of points. */
export const resamplePaths = (app: App, count?: number): number =>
  editPaths(app, 'Respace path points', (p) => ({
    points: resample(p, count ?? p.points.length),
  }));

export const subdividePaths = (app: App): number =>
  editPaths(
    app,
    'Subdivide path',
    (p) => {
      const pts = subdivide(p);
      return pts ? { points: pts } : null;
    },
    'The path would exceed the point limit',
  );

export const simplifyPaths = (app: App, tolerance = 0.05): number =>
  editPaths(
    app,
    'Simplify path',
    (p) => {
      const pts = simplify(p.points, p.closed, tolerance);
      return pts.length < p.points.length ? { points: pts } : null;
    },
    `No point is within ${tolerance} m of the line through its neighbours`,
  );

export const flattenPaths = (app: App): number =>
  editPaths(app, 'Flatten path to ground', (p) => ({ points: flatten(p.points, p) }));

export const snapPathsToGrid = (app: App): number =>
  editPaths(app, 'Snap path points to grid', (p) => ({
    points: snapPointsToGrid(p.points, p, app.prefs.value.snapGrid),
  }));

/** Remove the control point the gizmo is on (or `index` of path `id`); toasts when the path is at its minimum. */
export function removeActivePoint(app: App, id?: string, index?: number): boolean {
  const ref = app.pathPoint;
  const pid = id ?? ref?.id;
  const i = index ?? ref?.index ?? -1;
  const p = pid ? app.store.path(pid) : undefined;
  if (!p || i < 0 || app.sim.active) return false;
  if (p.locked) {
    app.toast(`${p.name} is locked`, 'warn');
    return false;
  }
  const pts = removePoint(p.points, p.closed, i);
  if (!pts) {
    app.toast(`A ${p.closed ? 'closed ' : ''}path keeps at least ${minPoints(p.closed)} points`, 'warn');
    return false;
  }
  app.store.update(p.id, { points: pts }, 'Remove path point');
  app.setPathPoint(p.id, Math.min(i, pts.length - 1));
  return true;
}

/** A new path through the positions of the selected objects, in selection order. Returns it, or null. */
export function pathThroughSelection(app: App): PathEntity | null {
  const store = app.store;
  const positions: Vec3[] = [];
  for (const id of store.selection) {
    const e = store.get(id);
    if (isPosed(e) && !isPath(e)) positions.push(e.position);
  }
  const pts = pointsThrough(positions);
  if (!pts) {
    app.toast('Select at least two objects at different positions to run a path through them', 'warn');
    return null;
  }
  const path = createPath({ name: store.uniqueName('Path'), position: [0, 0, 0], points: pts });
  store.add([path], 'Path through selection');
  return path;
}
