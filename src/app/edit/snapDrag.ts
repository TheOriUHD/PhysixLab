/**
 * Object snapping while the selection is dragged in the viewport (ED-14), called from `InputController.moveDrag`:
 *
 *   1. vertex / edge / face / bounds of nearby objects (a handle of the dragged objects is pulled onto the closest
 *      feature within `SNAP_RADIUS_PX` on screen),
 *   2. otherwise surface: with the pointer over another object (or, after the drag has been on a surface, over the
 *      ground) the primary body is put flush on that surface; with "Align to surface normal" it also turns its up axis
 *      onto the normal,
 *   3. otherwise the caller's grid snap.
 *
 * Holding Ctrl (⌘) inverts every snap switch while it is held. Shift (vertical drag) switches the surface snap off.
 * Everything runs inside the caller's undo step.
 */
import type { Quat, Vec3 } from '../../core/math';
import { vadd } from '../../core/math';
import { supportOfShape } from '../../model/edit/shapeSupport';
import { surfacePlacement } from '../../model/edit/snap';
import { isBody, isGroup } from '../../model/types';
import type { App } from '../app';
import { hideSnap, showSnap } from './snapIndicator';
import { anyFeatureMode, effectiveModes, featureSnapFor, invertKey, snapObjectOf } from './snapScene';

export interface DragContext {
  /** Top-level dragged entities and where each one started. */
  ids: string[];
  starts: Map<string, Vec3>;
  primary: string;
  /** Unsnapped translation of this pointer move. */
  delta: Vec3;
  vertical: boolean;
}

/** Per-drag memory, reset when the drag ends. */
const memory = new WeakMap<App, { usedSurface: boolean; startRotation: Quat | null; primary: string }>();

function mem(app: App, primary: string) {
  let m = memory.get(app);
  if (!m || m.primary !== primary) {
    m = { usedSurface: false, startRotation: null, primary };
    memory.set(app, m);
  }
  return m;
}

/** All bodies that move with the drag: dragged bodies and the members of dragged groups. */
function movingBodyIds(app: App, ids: string[]): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const e = app.store.get(id);
    if (isBody(e)) out.add(id);
    else if (isGroup(e)) for (const d of app.store.descendants(id)) if (isBody(d)) out.add(d.id);
  }
  return out;
}

/**
 * Try to snap the drag. Applies the move itself and returns true when a feature or surface snap took over; returns
 * false (after hiding the marker) when the caller should apply its own grid logic.
 */
export function applyObjectSnap(app: App, e: PointerEvent, ctx: DragContext): boolean {
  if (app.sim.active) return false;
  const modes = effectiveModes(app, invertKey(e));
  const m = mem(app, ctx.primary);
  const movingIds = movingBodyIds(app, ctx.ids);
  const primaryBody = app.store.body(ctx.primary);

  // 1. features of nearby objects
  if (anyFeatureMode(modes) && movingIds.size) {
    const applied = appliedDelta(app, ctx);
    const step: Vec3 = [ctx.delta[0] - applied[0], ctx.delta[1] - applied[1], ctx.delta[2] - applied[2]];
    const moving = [];
    for (const id of movingIds) {
      const b = app.store.body(id);
      if (!b) continue;
      const o = snapObjectOf(app, id, vadd(b.position, step), b.rotation);
      if (o) moving.push(o);
    }
    const hit = featureSnapFor(app, moving, modes, movingIds);
    if (hit) {
      commit(app, ctx, vadd(ctx.delta, hit.delta), null);
      showSnap(app, hit.kind, hit.point);
      return true;
    }
  }

  // 2. flush on the surface under the pointer
  if (modes.surface && !ctx.vertical && primaryBody && !primaryBody.locked) {
    const surface = surfaceUnderPointer(app, e, movingIds, m.usedSurface);
    if (surface) {
      m.usedSurface = true;
      m.startRotation ??= primaryBody.rotation;
      const single = ctx.ids.length === 1;
      const align = modes.alignNormal && single && surface.kind === 'surface';
      const place = surfacePlacement(
        supportOfShape(primaryBody.shape, !!primaryBody.parts?.length),
        m.startRotation,
        surface.point,
        surface.normal,
        align,
        0.002,
      );
      const start = ctx.starts.get(ctx.primary)!;
      const delta: Vec3 = [place.position[0] - start[0], place.position[1] - start[1], place.position[2] - start[2]];
      commit(app, ctx, delta, single ? { id: ctx.primary, rotation: place.rotation } : null);
      showSnap(app, 'surface', surface.point, surface.kind === 'ground' ? 'Ground' : 'Surface');
      return true;
    }
  }
  hideSnap(app);
  return false;
}

/** Translation already applied to the dragged set (current primary position minus its start). */
function appliedDelta(app: App, ctx: DragContext): Vec3 {
  const cur = app.store.get(ctx.primary);
  const start = ctx.starts.get(ctx.primary);
  if (!cur || !start || !('position' in cur)) return [0, 0, 0];
  return [cur.position[0] - start[0], cur.position[1] - start[1], cur.position[2] - start[2]];
}

function commit(app: App, ctx: DragContext, delta: Vec3, turn: { id: string; rotation: Quat } | null): void {
  app.editor.moveTo(new Map(ctx.ids.map((id) => [id, vadd(ctx.starts.get(id)!, delta)])));
  if (turn) {
    const b = app.store.body(turn.id);
    if (b && b.rotation.some((v, i) => Math.abs(v - turn.rotation[i]) > 1e-9)) {
      app.store.updateMany([[turn.id, { rotation: turn.rotation }]], 'Move');
    }
  }
}

interface SurfaceHit {
  kind: 'surface' | 'ground';
  point: Vec3;
  normal: Vec3;
}

/** The nearest solid surface under the pointer that is not part of the drag; the ground only after a surface snap. */
function surfaceUnderPointer(
  app: App,
  e: PointerEvent,
  moving: ReadonlySet<string>,
  groundToo: boolean,
): SurfaceHit | null {
  const targets = app.bodies.pickables().filter((mesh) => !moving.has(mesh.userData.entityId as string));
  const hit = app.picker.pick(e, targets);
  const g = groundToo ? app.picker.groundPoint(e, 0) : null;
  const groundDist = g ? app.camera.position.distanceTo(g) : Infinity;
  if (hit?.normal && hit.distance < groundDist) {
    return {
      kind: 'surface',
      point: [hit.point.x, hit.point.y, hit.point.z],
      normal: [hit.normal.x, hit.normal.y, hit.normal.z],
    };
  }
  if (g && groundDist < 400) return { kind: 'ground', point: [g.x, 0, g.z], normal: [0, 1, 0] };
  return null;
}

/** The drag ended (or was cancelled): forget the per-drag memory and remove the marker. */
export function endObjectSnap(app: App): void {
  memory.delete(app);
  hideSnap(app);
}

/** Marker for the grid snap (the caller applies the rounding): shown at the snapped centre of the primary object. */
export function showGridSnap(app: App, at: Vec3): void {
  showSnap(app, 'grid', at);
}

// ── gizmo ───────────────────────────────────────────────────────────────────────────────────────────

let ctrlHeld = false;
let keysInstalled = false;
function installKeys(): void {
  if (keysInstalled) return;
  keysInstalled = true;
  const set = (e: KeyboardEvent) => (ctrlHeld = e.ctrlKey || e.metaKey);
  window.addEventListener('keydown', set, true);
  window.addEventListener('keyup', set, true);
  window.addEventListener('blur', () => (ctrlHeld = false));
}

/**
 * Feature snapping for the translate gizmo: the gizmo's own result is shifted so that a vertex, edge midpoint, face
 * centre or bounds point of the dragged bodies lands on one of a nearby object. (The grid is the gizmo's own
 * translation snap; the surface snap needs a pointer ray and is only available when dragging in the viewport.)
 * Mutates `updates`. Returns true when a snap was applied.
 */
export function snapGizmoUpdates(
  app: App,
  updates: { id: string; position: Vec3; rotation: Quat }[],
  mode: 'translate' | 'rotate' | 'scale',
): boolean {
  installKeys();
  if (mode !== 'translate' || app.sim.active) {
    hideSnap(app);
    return false;
  }
  const modes = effectiveModes(app, ctrlHeld);
  if (!anyFeatureMode(modes)) {
    hideSnap(app);
    return false;
  }
  const moving = [];
  const ids = new Set<string>();
  for (const u of updates) {
    ids.add(u.id);
    for (const d of app.store.descendants(u.id)) ids.add(d.id);
  }
  for (const u of updates) {
    if (!app.store.body(u.id)) continue;
    const o = snapObjectOf(app, u.id, u.position, u.rotation);
    if (o) moving.push(o);
  }
  const hit = featureSnapFor(app, moving, modes, ids);
  if (!hit) {
    hideSnap(app);
    return false;
  }
  for (const u of updates) u.position = vadd(u.position, hit.delta);
  showSnap(app, hit.kind, hit.point);
  return true;
}
