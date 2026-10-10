/**
 * ED-1 — app side of the selection tools: the lasso and paint (brush) gestures, the overlay drawn while they run, the
 * projection of the scene's bodies to screen samples, and the selection operations behind the Select commands
 * (similar, invert, group children, connected, grow, shrink, filter). The decisions live in `model/edit/selection.ts`.
 *
 * Modifiers (both tools): nothing replaces the selection, Shift adds, Ctrl / Cmd subtracts. A click without a drag
 * picks the single body under the pointer with the same modifiers.
 */
import { Quaternion, Vector3 } from 'three';
import {
  brushHits,
  combineSelection,
  connectedByJoints,
  filterEntities,
  groupChildren,
  growByJoints,
  invertSelection,
  lassoHits,
  modeFromModifiers,
  selectSimilar,
  shrinkByJoints,
  type EntityFilter,
  type ScreenPt,
  type ScreenTarget,
  type SelectMode,
  type SimilarCriteria,
} from '../../model/edit/selection';
import { isBody, isGroup, isLight, isPath, isSoft } from '../../model/types';
import type { App } from '../app';

// ── brush radius ──────────────────────────────────────────────────────────────────────────────────────────────

export const BRUSH_MIN = 6;
export const BRUSH_MAX = 240;
const BRUSH_KEY = 'physicslab:ed-select:brush';
let brushRadius = (() => {
  try {
    const v = Number(localStorage.getItem(BRUSH_KEY));
    return Number.isFinite(v) && v >= BRUSH_MIN && v <= BRUSH_MAX ? v : 36;
  } catch {
    return 36;
  }
})();
const brushListeners = new Set<() => void>();

export const getBrushRadius = (): number => brushRadius;
export function setBrushRadius(r: number): void {
  const next = Math.round(Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, r)));
  if (next === brushRadius) return;
  brushRadius = next;
  try {
    localStorage.setItem(BRUSH_KEY, String(next));
  } catch {
    /* per-viewer convenience only */
  }
  for (const f of brushListeners) f();
}
export const onBrushRadius = (f: () => void): (() => void) => {
  brushListeners.add(f);
  return () => brushListeners.delete(f);
};

// ── projection ────────────────────────────────────────────────────────────────────────────────────────────────

/** Fraction of the bounding-box corner distance at which the extra samples sit (inside the box, near its surface). */
const CORNER_FRACTION = 0.7;
const CORNERS: readonly [number, number, number][] = [
  [-1, -1, -1],
  [1, -1, -1],
  [-1, 1, -1],
  [1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [-1, 1, 1],
  [1, 1, 1],
];

/**
 * Screen-space samples of every selectable thing: each visible body (its centre and eight points inside its bounding
 * box, taken from the live view pose, so it works during a simulation), plus the anchors of soft bodies, groups,
 * lights and paths (editor-only helpers, not while simulating). Hidden and sleeping-off views are skipped; locked
 * ones are included (locking only prevents moving).
 */
export function collectTargets(app: App): ScreenTarget[] {
  const rect = app.viewport.dom.getBoundingClientRect();
  const cam = app.camera;
  const v = new Vector3();
  const q = new Quaternion();
  const out: ScreenTarget[] = [];
  const project = (x: number, y: number, z: number): ScreenPt | null => {
    v.set(x, y, z).project(cam);
    if (v.z > 1) return null;
    return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height];
  };
  for (const [id, view] of app.bodies.views) {
    if (view.def.hidden || view.state === 2) continue;
    const samples: ScreenPt[] = [];
    const c = project(view.position.x, view.position.y, view.position.z);
    if (c) samples.push(c);
    q.copy(view.mesh.quaternion);
    const s = view.def.shape.size;
    for (const [sx, sy, sz] of CORNERS) {
      v.set(sx * s[0] * 0.5 * CORNER_FRACTION, sy * s[1] * 0.5 * CORNER_FRACTION, sz * s[2] * 0.5 * CORNER_FRACTION)
        .applyQuaternion(q)
        .add(view.position);
      const p = project(v.x, v.y, v.z);
      if (p) samples.push(p);
    }
    if (samples.length) out.push({ id, samples });
  }
  if (!app.sim.active) {
    for (const e of app.store.all()) {
      if (e.hidden || !(isSoft(e) || isGroup(e) || isLight(e) || isPath(e))) continue;
      const p = project(e.position[0], e.position[1], e.position[2]);
      if (p) out.push({ id: e.id, samples: [p] });
    }
  }
  return out;
}

// ── overlay ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Select mode from the modifier keys of a pointer or keyboard event. */
const modeOf = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): SelectMode =>
  modeFromModifiers({ shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey });

const SVG_NS = 'http://www.w3.org/2000/svg';

class Overlay {
  readonly svg: SVGSVGElement;
  private fill: SVGPolygonElement;
  private line: SVGPolylineElement;
  readonly ring: HTMLElement;
  private stage: HTMLElement;

  constructor(app: App) {
    this.stage = app.shell.stage;
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'ed-lasso');
    this.fill = document.createElementNS(SVG_NS, 'polygon');
    this.line = document.createElementNS(SVG_NS, 'polyline');
    this.svg.append(this.fill, this.line);
    this.ring = document.createElement('div');
    this.ring.className = 'ed-brush-ring';
    this.stage.append(this.svg, this.ring);
  }

  drawLasso(points: readonly ScreenPt[], mode: SelectMode): void {
    const r = this.stage.getBoundingClientRect();
    const pts = points.map(([x, y]) => `${(x - r.left).toFixed(1)},${(y - r.top).toFixed(1)}`).join(' ');
    this.fill.setAttribute('points', pts);
    this.line.setAttribute('points', pts);
    this.svg.dataset.mode = mode;
    this.svg.style.display = 'block';
  }
  clearLasso(): void {
    this.svg.style.display = 'none';
    this.fill.setAttribute('points', '');
    this.line.setAttribute('points', '');
  }
  placeRing(clientX: number, clientY: number, mode: SelectMode | null): void {
    const r = this.stage.getBoundingClientRect();
    const d = brushRadius * 2;
    Object.assign(this.ring.style, {
      display: 'block',
      width: `${d}px`,
      height: `${d}px`,
      left: `${clientX - r.left - brushRadius}px`,
      top: `${clientY - r.top - brushRadius}px`,
    });
    if (mode) this.ring.dataset.mode = mode;
  }
  hideRing(): void {
    this.ring.style.display = 'none';
  }
}

const overlays = new WeakMap<App, Overlay>();
function overlayOf(app: App): Overlay {
  let o = overlays.get(app);
  if (!o) {
    o = new Overlay(app);
    overlays.set(app, o);
    installBrushRing(app, o);
  }
  return o;
}

export const LASSO_MODE = 'lasso';
export const PAINT_MODE = 'paintselect';

/** The brush ring follows the pointer whenever the paint tool is the active mode (also between strokes). */
function installBrushRing(app: App, o: Overlay): void {
  const dom = app.viewport.dom;
  let last: { clientX: number; clientY: number } | null = null;
  let mods = { shiftKey: false, ctrlKey: false, metaKey: false };
  const refresh = () => {
    if (app.prefs.value.tool !== PAINT_MODE || !last) o.hideRing();
    else o.placeRing(last.clientX, last.clientY, modeOf(mods));
  };
  dom.addEventListener('pointermove', (e) => {
    last = e;
    mods = e;
    refresh();
  });
  dom.addEventListener('pointerleave', () => {
    last = null;
    refresh();
  });
  app.prefs.on('change', refresh);
  onBrushRadius(refresh);
  const onKey = (e: KeyboardEvent) => {
    mods = e;
    if (last) refresh();
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
}

/** Make sure the overlay (and so the brush ring) exists; called when a selection tool is activated. */
export function prepareSelectOverlay(app: App): void {
  overlayOf(app);
}

// ── applying a selection ──────────────────────────────────────────────────────────────────────────────────────

/** Replace the store's selection with `ids` that still exist and are not hidden. */
export function setSelectionIds(app: App, ids: readonly string[]): void {
  const store = app.store;
  app.store.setSelection(
    ids.filter((id) => {
      const e = store.get(id);
      return !!e && !e.hidden;
    }),
  );
}

function applyPicked(app: App, base: readonly string[], picked: readonly string[], mode: SelectMode): void {
  setSelectionIds(app, combineSelection(base, picked, mode));
}

// ── gestures ──────────────────────────────────────────────────────────────────────────────────────────────────

const MOVE_PX = 4;

function clickPick(app: App, e: PointerEvent, base: readonly string[], mode: SelectMode): void {
  const hit = app.pickEntity(e);
  applyPicked(app, base, hit ? [hit.entityId] : [], mode);
}

/** Run a pointer gesture on the viewport until release / cancel (Escape or pointercancel). */
function track(
  app: App,
  start: PointerEvent,
  handlers: {
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent, moved: boolean) => void;
    cancel: () => void;
  },
): void {
  const dom = app.viewport.dom;
  let moved = false;
  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== start.pointerId) return;
    if (!moved && Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) >= MOVE_PX) moved = true;
    handlers.move(e);
  };
  const end = () => {
    dom.removeEventListener('pointermove', onMove);
    dom.removeEventListener('pointerup', onUp);
    dom.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== start.pointerId) return;
    end();
    handlers.up(e, moved);
  };
  const onCancel = () => {
    end();
    handlers.cancel();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onCancel();
  };
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', onUp);
  dom.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);
}

/** Lasso tool: draw a freehand outline; on release everything whose projected samples fall inside is selected. */
export function beginLasso(app: App, e: PointerEvent): void {
  const o = overlayOf(app);
  const mode = modeOf(e);
  const base = [...app.store.selection];
  const pts: ScreenPt[] = [[e.clientX, e.clientY]];
  track(app, e, {
    move(ev) {
      const last = pts[pts.length - 1];
      if (Math.hypot(ev.clientX - last[0], ev.clientY - last[1]) < 3) return;
      pts.push([ev.clientX, ev.clientY]);
      o.drawLasso(pts, mode);
    },
    up(ev, moved) {
      o.clearLasso();
      if (!moved || pts.length < 3) {
        clickPick(app, ev, base, mode);
        return;
      }
      applyPicked(app, base, lassoHits(collectTargets(app), pts), mode);
    },
    cancel: () => o.clearLasso(),
  });
}

/** Paint tool: drag a circular brush; every body it touches is selected (or deselected with Ctrl / Cmd) as you go. */
export function beginPaint(app: App, e: PointerEvent): void {
  const o = overlayOf(app);
  const mode = modeOf(e);
  const base = [...app.store.selection];
  const painted = new Set<string>();
  const targets = collectTargets(app);
  const dab = (x: number, y: number) => {
    for (const id of brushHits(targets, x, y, brushRadius)) painted.add(id);
    applyPicked(app, base, [...painted], mode);
  };
  // A press on empty space with the replace mode clears the selection first; painting then builds a new one.
  if (mode === 'replace') app.store.setSelection([]);
  dab(e.clientX, e.clientY);
  o.placeRing(e.clientX, e.clientY, mode);
  track(app, e, {
    move(ev) {
      o.placeRing(ev.clientX, ev.clientY, mode);
      dab(ev.clientX, ev.clientY);
    },
    up: () => undefined,
    cancel: () => setSelectionIds(app, base),
  });
}

// ── commands ──────────────────────────────────────────────────────────────────────────────────────────────────

const entities = (app: App) => app.store.all();

export function selectSimilarCmd(app: App, criteria: SimilarCriteria): number {
  const ids = selectSimilar(entities(app), app.store.selection, criteria);
  setSelectionIds(app, ids);
  return app.store.selection.length;
}

export function invertSelectionCmd(app: App): number {
  setSelectionIds(app, invertSelection(entities(app), app.store.selection));
  return app.store.selection.length;
}

export function selectGroupChildrenCmd(app: App): number {
  const ids = groupChildren(entities(app), app.store.selection);
  if (ids.length) setSelectionIds(app, ids);
  return ids.length;
}

export function selectConnectedCmd(app: App): number {
  setSelectionIds(app, connectedByJoints(entities(app), app.store.selection));
  return app.store.selection.length;
}

export function growSelectionCmd(app: App): number {
  setSelectionIds(app, growByJoints(entities(app), app.store.selection));
  return app.store.selection.length;
}

export function shrinkSelectionCmd(app: App): number {
  setSelectionIds(app, shrinkByJoints(entities(app), app.store.selection));
  return app.store.selection.length;
}

/** Apply a filter to the scene with a mode; returns how many entities matched. */
export function selectByFilter(app: App, filter: EntityFilter, mode: SelectMode): number {
  const ids = filterEntities(entities(app), filter);
  applyPicked(app, app.store.selection, ids, mode);
  return ids.length;
}

/** Number of entities a filter matches right now (live count in the panel). */
export const countFilter = (app: App, filter: EntityFilter): number => filterEntities(entities(app), filter).length;

export const hasBodiesSelected = (app: App): boolean => app.store.selection.some((id) => isBody(app.store.get(id)));
