/**
 * The Path tool (ED-23): draw a new path point by point with a live rubber band, insert points by clicking the curve
 * of the selected path, pick control points (the gizmo moves the active one), remove them with Delete.
 *
 * Drawing is held in a *draft* (a view-only `PathView` that is not in the document), so the whole session is exactly
 * one undo step: `store.add` at the end. Enter or a double-click finishes the path; Escape cancels the draft and leaves no trace.
 * (Leaving the tool or starting a simulation finishes a draft that has two points.)
 *
 * The tool listens to the viewport by itself (pointer move, double click, keys) because the shared input controller
 * only forwards the primary press. Listeners are installed once per app, on first use.
 */
import { Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from 'three';
import type { Vec3 } from '../../core/math';
import { qrotInv } from '../../core/math';
import {
  canAddPoint,
  closestOnPolylineToRay,
  curveHitFrom,
  GROUND_LIFT,
  insertPoint,
  snapToGrid,
  type RayCurveHit,
} from '../../model/edit/pathEdit';
import { createPath } from '../../model/factory';
import { localToWorld, PathCurve } from '../../model/path';
import type { PathEntity } from '../../model/types';
import type { App } from '../app';
import type { InputController } from '../input';
import { removeActivePoint } from './pathOps';

export const PATH_TOOL = 'path';
const DRAFT_ID = '__draft_path__';
/** Chords per control segment used to pick the curve. */
const PICK_SAMPLES = 24;
/** Click tolerance around the curve and the handles, in screen pixels. */
const PICK_PX = 9;
/** Two presses this close in space (px) and time (ms) are a double click. */
const DOUBLE_PX = 6;
const DOUBLE_MS = 400;

// ---- snapping ----------------------------------------------------------------------------------

/**
 * Where a point the user aims at really goes: the grid snap preference applied to a world position. This is the one
 * place to extend with surface / vertex snapping. `onSurface` marks a point that sits on a body (the grid would pull
 * it off the surface, so it is kept); `vertical` also snaps the height (the Shift raise mode).
 */
export function snapPoint(app: App, p: Vec3, opts: { onSurface?: boolean; vertical?: boolean } = {}): Vec3 {
  const prefs = app.prefs.value;
  if (!prefs.snap || opts.onSurface) return [p[0], p[1], p[2]];
  return snapToGrid(p, prefs.snapGrid, { x: !opts.vertical, y: !!opts.vertical, z: !opts.vertical });
}

// ---- state --------------------------------------------------------------------------------------

interface ToolState {
  /** Points placed so far in the current drawing (world = path frame, the new path sits at the origin). */
  placed: Vec3[];
  /** The rubber-band end following the pointer, or null. */
  preview: Vec3 | null;
  lastPress: { x: number; y: number; t: number } | null;
  /** Curve point under the pointer on the selected path (the spot a click inserts at). */
  insertHit: { id: string; hit: RayCurveHit } | null;
  marker: Mesh | null;
}

const states = new WeakMap<App, ToolState>();
const installed = new WeakSet<App>();
/** Sampled curve of an immutable path entity, reused while it is unchanged. */
const sampled = new WeakMap<PathEntity, { curve: PathCurve; poly: Vec3[] }>();

function stateOf(app: App): ToolState {
  let s = states.get(app);
  if (!s) {
    s = { placed: [], preview: null, lastPress: null, insertHit: null, marker: null };
    states.set(app, s);
  }
  return s;
}

export const isDrawing = (app: App): boolean => stateOf(app).placed.length > 0;
export const draftPointCount = (app: App): number => stateOf(app).placed.length;

const isTyping = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return (
    !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
  );
};

const inPathTool = (app: App): boolean => app.prefs.value.tool === PATH_TOOL;

function samplesOf(p: PathEntity): { curve: PathCurve; poly: Vec3[] } {
  let c = sampled.get(p);
  if (!c) {
    const curve = new PathCurve({ points: p.points, closed: p.closed, tension: p.tension });
    c = { curve, poly: curve.polyline(PICK_SAMPLES) };
    sampled.set(p, c);
  }
  return c;
}

// ---- tool hint ----------------------------------------------------------------------------------

export function pathToolHint(app: App): string {
  const s = stateOf(app);
  if (app.sim.active) return 'Stop the simulation to edit paths';
  if (s.placed.length) {
    return `<b>Click</b> to add points (${s.placed.length}) · <b>Shift</b> raise · <kbd>Backspace</kbd> undo point · <kbd>Enter</kbd> / double-click finish · <kbd>Esc</kbd> cancel`;
  }
  return '<b>Click</b> to start a path · click the curve to insert a point · <kbd>Del</kbd> removes a point · <kbd>Shift+C</kbd> loop';
}

// ---- the draft ----------------------------------------------------------------------------------

function showDraft(app: App): void {
  const s = stateOf(app);
  const pts = s.preview ? [...s.placed, s.preview] : s.placed;
  if (pts.length < 2) {
    app.pathViews.remove(DRAFT_ID);
    return;
  }
  const def = createPath({ id: DRAFT_ID, name: 'Draft', position: [0, 0, 0], points: pts, closed: false });
  app.pathViews.update(def);
  const v = app.pathViews.get(DRAFT_ID);
  if (v) {
    v.selected = true;
    v.refreshState();
  }
}

function clearDraft(app: App): void {
  const s = stateOf(app);
  s.placed = [];
  s.preview = null;
  s.lastPress = null;
  app.pathViews.remove(DRAFT_ID);
}

/** Turn the draft into a real path (one undo step). With fewer than two points nothing is created. */
export function finishDraft(app: App, close = false): PathEntity | null {
  const s = stateOf(app);
  const pts = s.placed.map((p) => [p[0], p[1], p[2]] as Vec3);
  clearDraft(app);
  app.updateToolHint();
  if (pts.length < 2) return null;
  const path = createPath({
    name: app.store.uniqueName('Path'),
    position: [0, 0, 0],
    points: pts,
    closed: close && pts.length >= 3,
  });
  app.store.add([path], 'Draw path');
  app.setPathPoint(null);
  app.toast(`${path.name} added with ${pts.length} points — click its curve to insert more`, 'success');
  return path;
}

export function cancelDraft(app: App): void {
  clearDraft(app);
  app.updateToolHint();
}

/** Remove the last placed point of the draft; the draft vanishes with its last point. */
export function undoDraftPoint(app: App): void {
  const s = stateOf(app);
  s.placed.pop();
  if (!s.placed.length) clearDraft(app);
  else showDraft(app);
  app.updateToolHint();
}

// ---- aiming -------------------------------------------------------------------------------------

/** World point under the pointer: a body's surface, else the ground (or the height of the last placed point). */
function aim(app: App, e: PointerEvent, last: Vec3 | null): Vec3 | null {
  const hit = app.pickEntity(e, { joints: false });
  const blocking = hit && !app.store.path(hit.entityId);
  if (e.shiftKey && last) {
    const v = app.picker.verticalPoint(e, new Vector3(...last));
    if (v) return snapPoint(app, [last[0], v.y, last[2]], { vertical: true });
  }
  if (blocking) return snapPoint(app, [hit.point.x, hit.point.y, hit.point.z], { onSurface: true });
  const g = app.picker.groundPoint(e, last ? last[1] : GROUND_LIFT);
  if (!g || g.distanceTo(app.camera.position) > 400) return null;
  return snapPoint(app, [g.x, g.y, g.z]);
}

/** Angle (radians) one screen pixel subtends. */
const pixelAngle = (app: App): number =>
  (app.camera.fov * Math.PI) / 180 / Math.max(1, app.viewport.dom.getBoundingClientRect().height);

/** The curve of a path under the pointer (within PICK_PX), as a hit in the path's own frame. */
function pickCurve(app: App, e: PointerEvent, path: PathEntity): RayCurveHit | null {
  const o = app.picker.rayOrigin(e);
  const d = app.picker.rayDirection(e);
  const lo = qrotInv(path.rotation, [o.x - path.position[0], o.y - path.position[1], o.z - path.position[2]]);
  const ld = qrotInv(path.rotation, [d.x, d.y, d.z]);
  const { curve, poly } = samplesOf(path);
  return curveHitFrom(curve, PICK_SAMPLES, closestOnPolylineToRay(poly, lo, ld, PICK_PX * pixelAngle(app)));
}

function setMarker(app: App, at: Vec3 | null): void {
  const s = stateOf(app);
  if (!at) {
    if (s.marker) s.marker.visible = false;
    return;
  }
  if (!s.marker) {
    s.marker = new Mesh(
      new SphereGeometry(1, 14, 10),
      new MeshBasicMaterial({ color: 0xffb347, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    s.marker.renderOrder = 999;
    s.marker.raycast = () => undefined;
    app.viewport.scene.add(s.marker);
  }
  s.marker.visible = true;
  s.marker.position.set(...at);
  s.marker.scale.setScalar(Math.max(0.02, app.camera.position.distanceTo(s.marker.position) * pixelAngle(app) * 5));
}

function disposeMarker(app: App): void {
  const s = stateOf(app);
  if (!s.marker) return;
  app.viewport.scene.remove(s.marker);
  s.marker.geometry.dispose();
  (s.marker.material as MeshBasicMaterial).dispose();
  s.marker = null;
}

// ---- pointer ------------------------------------------------------------------------------------

/** Registered as the tool's `pointerDown`. */
export function pathToolPointerDown(app: App, e: PointerEvent, _input: InputController): void {
  ensureInstalled(app);
  if (app.sim.active) {
    app.toast('Stop the simulation to edit paths', 'warn');
    return;
  }
  const s = stateOf(app);
  const now = e.timeStamp;
  const dbl =
    !!s.lastPress &&
    now - s.lastPress.t < DOUBLE_MS &&
    Math.hypot(e.clientX - s.lastPress.x, e.clientY - s.lastPress.y) < DOUBLE_PX;
  s.lastPress = { x: e.clientX, y: e.clientY, t: now };

  // ---- drawing: every press appends; a double press, or the first point again, finishes ----
  if (s.placed.length) {
    if (dbl) {
      finishDraft(app);
      return;
    }
    if (s.placed.length >= 3 && nearScreen(app, e, s.placed[0])) {
      finishDraft(app, true);
      return;
    }
    const p = aim(app, e, s.placed[s.placed.length - 1]);
    if (!p) return;
    if (!canAddPoint(s.placed.length)) {
      app.toast('Path point limit reached — press Enter to finish', 'warn');
      return;
    }
    s.placed.push(p);
    s.preview = null;
    showDraft(app);
    app.effects.ping(new Vector3(...p), 0x5ec8ff);
    app.updateToolHint();
    return;
  }

  // ---- not drawing: handles first, then the curve, then start a new path ----
  const handle = app.pathViews.pickPoint(e, app.camera, app.viewport.dom.getBoundingClientRect());
  if (handle) {
    app.setPathPoint(handle.id, handle.index);
    return;
  }
  const blocker = app.pickEntity(e, { joints: false });
  const blockDist = blocker && !app.store.path(blocker.entityId) ? blocker.distance : Infinity;
  const selected = app.store.selection.length === 1 ? app.store.path(app.store.selection[0]) : undefined;
  if (selected && !selected.hidden) {
    const hit = pickCurve(app, e, selected);
    if (hit && hit.rayT <= blockDist + 0.05) {
      insertOnCurve(app, selected, hit);
      return;
    }
  }
  // another path under the pointer: select it (a second click inserts)
  let best: { path: PathEntity; ratio: number } | null = null;
  for (const p of app.store.paths()) {
    if (p.hidden || p.id === selected?.id) continue;
    const hit = pickCurve(app, e, p);
    if (hit && hit.rayT <= blockDist + 0.05) {
      const ratio = hit.distance / Math.max(hit.rayT, 1e-6);
      if (!best || ratio < best.ratio) best = { path: p, ratio };
    }
  }
  if (best) {
    app.store.setSelection([best.path.id]);
    app.setPathPoint(null);
    return;
  }
  const p = aim(app, e, null);
  if (!p) return;
  app.setPathPoint(null);
  s.placed = [p];
  s.preview = null;
  app.effects.ping(new Vector3(...p), 0x5be3a1);
  app.updateToolHint();
}

function nearScreen(app: App, e: PointerEvent, world: Vec3): boolean {
  const r = app.viewport.dom.getBoundingClientRect();
  const v = new Vector3(...world).project(app.camera);
  if (v.z > 1) return false;
  const sx = r.left + ((v.x + 1) / 2) * r.width;
  const sy = r.top + ((1 - v.y) / 2) * r.height;
  return Math.hypot(sx - e.clientX, sy - e.clientY) < 12;
}

/** Insert a control point where the curve was clicked and hand it to the gizmo. */
function insertOnCurve(app: App, path: PathEntity, hit: RayCurveHit): void {
  if (path.locked) {
    app.toast(`${path.name} is locked`, 'warn');
    return;
  }
  if (!canAddPoint(path.points.length)) {
    app.toast('Path point limit reached', 'warn');
    return;
  }
  const r = insertPoint(path.points, hit.segment, hit.point);
  app.store.update(path.id, { points: r.points }, 'Insert path point');
  app.setPathPoint(path.id, r.index);
}

function onMove(app: App, e: PointerEvent): void {
  if (!inPathTool(app) || app.sim.active) return;
  const s = stateOf(app);
  if (s.placed.length) {
    const p = aim(app, e, s.placed[s.placed.length - 1]);
    s.preview = p;
    showDraft(app);
    return;
  }
  if (app.gizmo.isDragging || e.buttons) {
    app.pathViews.setHoverPoint(null, -1);
    setMarker(app, null);
    return;
  }
  const handle = app.pathViews.pickPoint(e, app.camera, app.viewport.dom.getBoundingClientRect());
  app.pathViews.setHoverPoint(handle?.id ?? null, handle?.index ?? -1);
  let marker: Vec3 | null = null;
  const sel = app.store.selection.length === 1 ? app.store.path(app.store.selection[0]) : undefined;
  if (!handle && sel && !sel.hidden && !sel.locked) {
    const hit = pickCurve(app, e, sel);
    if (hit) marker = localToWorld(sel.position, sel.rotation, hit.point);
  }
  setMarker(app, marker);
  app.viewport.dom.style.cursor = handle ? 'pointer' : marker ? 'copy' : '';
}

// ---- keys, double click, lifecycle --------------------------------------------------------------

function onKey(app: App, e: KeyboardEvent): void {
  if (!inPathTool(app) || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  const s = stateOf(app);
  const swallow = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  switch (e.key) {
    case 'Enter':
      if (s.placed.length) {
        swallow();
        finishDraft(app);
      }
      break;
    case 'Escape':
      if (s.placed.length) {
        swallow();
        cancelDraft(app);
      }
      break;
    case 'Backspace':
    case 'Delete':
      if (s.placed.length) {
        swallow();
        undoDraftPoint(app);
      } else if (app.pathPoint) {
        swallow();
        removeActivePoint(app);
      }
      break;
  }
}

function ensureInstalled(app: App): void {
  if (installed.has(app)) return;
  installed.add(app);
  const dom = app.viewport.dom;
  dom.addEventListener('pointermove', (e) => onMove(app, e));
  dom.addEventListener('pointerleave', () => {
    app.pathViews.setHoverPoint(null, -1);
    setMarker(app, null);
  });
  // Capture phase: the shortcuts (Delete, Escape) and the double-click "frame" would otherwise run as well.
  window.addEventListener('keydown', (e) => onKey(app, e), true);
  window.addEventListener(
    'dblclick',
    (e) => {
      if (!inPathTool(app) || e.target !== dom) return;
      e.stopImmediatePropagation();
    },
    true,
  );
  // Leaving the tool, starting a simulation or loading another scene ends the drawing.
  app.prefs.on('change', (keys) => {
    if (keys.includes('tool') && !inPathTool(app)) {
      if (isDrawing(app)) finishDraft(app);
      app.pathViews.setHoverPoint(null, -1);
      setMarker(app, null);
      disposeMarker(app);
      dom.style.cursor = '';
    }
  });
  app.sim.on('mode', () => {
    if (isDrawing(app) && app.sim.active) finishDraft(app);
  });
  app.store.on('change', (c) => {
    if (c.type === 'reset' && isDrawing(app)) cancelDraft(app);
  });
}

/** Called when the tool is chosen. */
export function activatePathTool(app: App): void {
  ensureInstalled(app);
  app.setTool(PATH_TOOL);
}
