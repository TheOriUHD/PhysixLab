/**
 * Pointer + keyboard input for the viewport: selection, drag-moving, grabbing bodies in a
 * running simulation and the pointer behaviour of the joint / measure / blast / shoot tools. Which tool receives the
 * pointer, and what every key does, is decided by the registries (`./registry`), not here.
 */
import { Plane, Vector3, type Camera } from 'three';
import { edTools } from './edTools';
import { vadd, type Vec3 } from '../core/math';
import { topLevel } from '../model/groups';
import { isGroup, isLight, isPosed } from '../model/types';
import type { App } from './app';
import { JointHandles } from './jointHandles';
import { jointToolOf } from './jointTool';
import { runCommand } from './registry/commands';
import { keymap, shouldPreventDefault } from './registry/keymap';
import { toolForMode } from './registry/tools';
// -- ED-A snap --
import { applyObjectSnap, endObjectSnap, showGridSnap } from './edit/snapDrag';
import { effectiveModes, invertKey } from './edit/snapScene';

type Gesture =
  | { kind: 'none' }
  | { kind: 'marquee'; x0: number; y0: number; additive: boolean; moved: boolean }
  | {
      kind: 'dragMove';
      ids: string[];
      starts: Map<string, Vec3>;
      p0: Vector3;
      plane: 'ground' | 'vertical';
      startClient: [number, number];
      moved: boolean;
      primary: string;
    }
  // -- ED-B: grab keeps its depth plane, kind of target and the keys being held --
  | { kind: 'grab'; plane: Plane; id: string; soft: boolean; spinKeys: Set<string> }
  // -- ED-B: a tool that keeps going after the press (held gust, charging throw, paint stroke) --
  | { kind: 'custom'; move(e: PointerEvent): void; up(e: PointerEvent): void; cancel?(): void };

const isTyping = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
};

export class InputController {
  private g: Gesture = { kind: 'none' };
  private marquee: HTMLElement;
  private pointer = { x: 0, y: 0, inside: false };
  // ── JT-20/21: draggable handles of the selected joint, and the joint tool (anchor snapping, chain) ──
  readonly jointHandles: JointHandles;
  // -- CM-A touch: fingers currently down on the canvas; a second one abandons the one-finger gesture --
  private touchIds = new Set<number>();

  constructor(private app: App) {
    this.jointHandles = new JointHandles(app);
    const dom = app.viewport.dom;
    this.marquee = document.createElement('div');
    this.marquee.className = 'marquee';
    app.shell.stage.appendChild(this.marquee);

    dom.addEventListener('pointerdown', (e) => this.onDown(e));
    dom.addEventListener('pointermove', (e) => this.onMove(e));
    dom.addEventListener('pointerup', (e) => this.onUp(e));
    dom.addEventListener('pointercancel', (e) => this.onUp(e));
    dom.addEventListener('pointerleave', () => {
      this.pointer.inside = false;
      this.setHover(null);
      jointToolOf(app).hideMarker();
    });
    dom.addEventListener('dblclick', (e) => this.onDouble(e));
    // -- ED-B: scroll depth and held-body keys; capture phase so the camera and the tool shortcuts never see them --
    window.addEventListener('wheel', (e) => this.onWheel(e), { capture: true, passive: false });
    window.addEventListener('keydown', (e) => this.onGrabKey(e, true), true);
    window.addEventListener('keyup', (e) => this.onGrabKey(e, false), true);
    // Capture phase for the shortcuts that work inside text fields (see `onKeyDownCapture`).
    window.addEventListener('keydown', (e) => this.onKeyDownCapture(e), true);
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => {
      this.app.input.clearKeys();
      if (this.g.kind === 'custom') {
        this.g.cancel?.();
        this.g = { kind: 'none' };
      }
    });
  }

  private get cam(): Camera {
    return this.app.camera;
  }

  // ---- hover ---------------------------------------------------------------------------------

  private setHover(id: string | null): void {
    if (this.app.hoverId === id) return;
    this.app.hoverId = id;
  }

  private updateHover(e: PointerEvent): void {
    if (this.g.kind !== 'none' || this.app.gizmo.isDragging) return;
    // -- ghost placement: the surface under a ghost is not "hovered" (the glow would hide the ghost) --
    if (this.app.placement.ghost.active) {
      this.setHover(null);
      return;
    }
    const tool = this.app.prefs.value.tool;
    if (tool === 'joint') return; // the joint tool sets its own hover (jointTool.hover)
    if (tool !== 'select') {
      this.setHover(null);
      return;
    }
    const hit = this.app.pickEntity(e, { joints: tool === 'select' });
    this.setHover(hit && this.app.store.body(hit.entityId) ? hit.entityId : null);
    const dom = this.app.viewport.dom;
    const grabbable =
      this.app.sim.active && hit && this.app.store.body(hit.entityId)?.bodyType === 'dynamic' && tool === 'select';
    dom.classList.toggle('can-grab', !!grabbable);
  }

  // ---- pointer -------------------------------------------------------------------------------

  private onDown(e: PointerEvent): void {
    const app = this.app;
    const dom = app.viewport.dom;
    dom.focus({ preventScroll: true });
    // -- CM-A touch: a second finger belongs to the camera (pinch / orbit / pan), never to a one-finger tool --
    if (e.pointerType === 'touch') {
      if (e.isPrimary) this.touchIds.clear(); // a new touch sequence: ids left over from a lost pointer-up are stale
      this.touchIds.add(e.pointerId);
      if (this.touchIds.size > 1) {
        this.cancelGesture();
        return;
      }
    }
    if (e.button === 2) {
      this.rightDown = [e.clientX, e.clientY];
      return;
    }
    if (e.button !== 0) return;
    if (app.viewport.handleViewHelperClick(e)) return;
    if (e.altKey) return; // orbit emulation
    if (app.gizmo.controls.enabled && app.gizmo.hovering) return;

    dom.setPointerCapture(e.pointerId);
    // Which tool handles the pointer is the registry's business (src/app/registry/tools.ts).
    toolForMode(app.prefs.value.tool)?.pointerDown?.(app, e, this);
  }

  /** Pointer press of the tool of the same name (called through the tool registry). */
  downSelect(e: PointerEvent): void {
    const app = this.app;
    const store = app.store;
    // A control handle of the selected path comes first: clicking one hands it to the gizmo.
    if (!app.sim.active) {
      const handle = app.pathViews.pickPoint(
        e,
        this.cam,
        app.viewport.dom.getBoundingClientRect(),
        e.pointerType === 'touch' ? 26 : 12, // -- CM-A touch: fingers are fat --
      );
      if (handle) {
        app.setPathPoint(handle.id, handle.index);
        return;
      }
    }
    const hit = app.pickEntity(e);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!hit) {
      this.g = { kind: 'marquee', x0: e.clientX, y0: e.clientY, additive, moved: false };
      return;
    }
    const id = hit.entityId;
    if (hit.end) app.setJointEnd(hit.end);
    if (additive) store.toggleSelection(id);
    else if (!store.selection.includes(id)) store.setSelection([id]);
    const soft = store.soft(id);
    if (soft) {
      if (app.sim.active) {
        // Drag the nearest particle: the lattice follows, so cloth drapes and jelly wobbles.
        const idx = app.softParticleAt(id, hit.point);
        if (idx >= 0) {
          const n = this.cam.getWorldDirection(new Vector3()).negate();
          const plane = new Plane().setFromNormalAndCoplanarPoint(n, hit.point);
          app.sim.client.op({
            op: 'grabSoft',
            id,
            index: idx,
            target: [hit.point.x, hit.point.y, hit.point.z],
            strength: app.prefs.value.grabStrength,
          });
          this.g = { kind: 'grab', plane, id, soft: true, spinKeys: new Set() };
          app.viewport.dom.classList.add('grabbing');
        }
        return;
      }
      if (soft.locked) return;
      this.beginDragMove(e, hit.point, id);
      return;
    }
    const body = store.body(id);
    if (!isPosed(store.get(id))) return;

    if (app.sim.active) {
      if (body?.bodyType === 'dynamic') {
        const n = this.cam.getWorldDirection(new Vector3()).negate();
        const plane = new Plane().setFromNormalAndCoplanarPoint(n, hit.point);
        app.sim.client.op({
          op: 'grab',
          id,
          point: [hit.point.x, hit.point.y, hit.point.z],
          target: [hit.point.x, hit.point.y, hit.point.z],
          strength: app.prefs.value.grabStrength,
        });
        this.g = { kind: 'grab', plane, id, soft: false, spinKeys: new Set() };
        this.rHeld = false;
        app.viewport.dom.classList.add('grabbing');
      }
      return;
    }
    if (store.get(id) && (store.get(id) as { locked?: boolean }).locked) return;
    this.beginDragMove(e, hit.point, id);
  }

  /** Start dragging the selection on the ground (or vertical) plane; members of a selected group ride along with it. */
  private beginDragMove(e: PointerEvent, point: Vector3, primary: string): void {
    const store = this.app.store;
    const movable = (s: string) => {
      const x = store.get(s);
      return isPosed(x) && !x.locked ? x : undefined;
    };
    const ids = topLevel(
      (id) => store.get(id),
      store.selection.filter((s) => movable(s)),
    );
    const starts = new Map<string, Vec3>(ids.map((s) => [s, movable(s)!.position]));
    if (!starts.has(primary)) return;
    this.g = {
      kind: 'dragMove',
      ids,
      starts,
      p0: point.clone(),
      plane: e.shiftKey ? 'vertical' : 'ground',
      startClient: [e.clientX, e.clientY],
      moved: false,
      primary,
    };
  }

  /** Pointer press of the tool of the same name (called through the tool registry). Placement lives in `jointTool.ts`. */
  downJoint(e: PointerEvent): void {
    jointToolOf(this.app).press(e);
  }

  /** Pointer press of the tool of the same name (called through the tool registry). */
  downMeasure(e: PointerEvent): void {
    const app = this.app;
    const hit = app.pickEntity(e, { joints: false });
    const p = hit?.point ?? app.picker.groundPoint(e, 0);
    if (!p) return;
    if (!app.measure || app.measure.b) {
      app.clearMeasure();
      app.measure = { a: p.clone(), b: null };
      app.labels.set('measure-a', p, '●', 'accent');
      app.setHint('Click the second point');
    } else {
      app.measure.b = p.clone();
      app.setMeasureLine(app.measure.a, p);
      app.labels.remove('measure-a');
      app.setHint('Click again to start a new measurement · <kbd>Esc</kbd> clears');
    }
    app.effects.ping(p);
  }

  /** Pointer press of the tool of the same name (called through the tool registry). */
  downBlast(e: PointerEvent): void {
    edTools(this.app).blastDown(e, this);
  }

  /** Pointer press of the paint tool (ED-42). */
  downPaint(e: PointerEvent): void {
    edTools(this.app).paintDown(e, this);
  }

  /** Pointer press of the pin tool (ED-43). */
  downPin(e: PointerEvent): void {
    edTools(this.app).pinDown(e);
  }

  /** Let a tool own the pointer until it is released (`move` / `up` get the events; `cancel` on blur or Esc). */
  beginCustom(g: { move(e: PointerEvent): void; up(e: PointerEvent): void; cancel?(): void }): void {
    this.g = { kind: 'custom', ...g };
  }

  /** Pointer press of the tool of the same name (called through the tool registry). */
  downShoot(e: PointerEvent): void {
    edTools(this.app).throwDown(e, this);
  }

  private onMove(e: PointerEvent): void {
    const app = this.app;
    if (e.pointerType === 'touch' && this.touchIds.size > 1) return; // -- CM-A touch: camera gesture in progress --
    this.pointer = { x: e.clientX, y: e.clientY, inside: true };
    const g = this.g;

    const tool = app.prefs.value.tool;
    if (tool === 'joint') {
      // Snap marker + rubber band from the first anchor (the tool also sets the hover highlight).
      if (g.kind === 'none') jointToolOf(app).hover(e);
    } else if (tool === 'measure' && app.measure && !app.measure.b) {
      const hit = app.pickEntity(e, { joints: false });
      const p = hit?.point ?? app.picker.groundPoint(e, 0);
      if (p) {
        app.setMeasureLine(app.measure.a, p);
        app.measure.b = null;
        app.labels.set(
          'measure',
          app.measure.a.clone().add(p).multiplyScalar(0.5),
          `${p.distanceTo(app.measure.a).toFixed(3)} m`,
          'accent',
        );
      }
    }

    switch (g.kind) {
      case 'none':
        this.updateHover(e);
        break;
      case 'marquee':
        this.moveMarquee(e, g);
        break;
      case 'dragMove':
        this.moveDrag(e, g);
        break;
      case 'grab': {
        if (this.rHeld && !g.soft) {
          this.rotateHeld(e);
          break;
        }
        this.moveGrabTarget(e, g);
        break;
      }
      case 'custom':
        g.move(e);
        break;
    }
  }

  // ---- grab upgrades (ED-45) -----------------------------------------------------------------

  /** True while R is held during a grab: pointer movement turns the held body instead of moving it. */
  private rHeld = false;
  private spinTimer: ReturnType<typeof setTimeout> | null = null;

  private moveGrabTarget(e: { clientX: number; clientY: number }, g: Extract<Gesture, { kind: 'grab' }>): void {
    const p = this.app.picker.cameraPlanePoint(e, g.plane.coplanarPoint(new Vector3()));
    if (p) this.app.sim.client.op({ op: 'grabMove', target: [p.x, p.y, p.z] });
  }

  /** Angular velocity (world) the held body is asked to spin at: Q / E about the view's up axis, plus the R-drag. */
  private spinFrom(keys: Set<string>, extra: Vec3 = [0, 0, 0]): Vec3 {
    const up = this.cam.up;
    const rate = (keys.has('KeyE') ? 3 : 0) - (keys.has('KeyQ') ? 3 : 0);
    return [up.x * rate + extra[0], up.y * rate + extra[1], up.z * rate + extra[2]];
  }

  private rotateHeld(e: PointerEvent): void {
    const g = this.g;
    if (g.kind !== 'grab') return;
    const dx = e.movementX,
      dy = e.movementY;
    const right = new Vector3().setFromMatrixColumn(this.cam.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(this.cam.matrixWorld, 1);
    // A drag across the screen turns the body about the matching view axis (about 0.25 rad per 10 px).
    const w = up.multiplyScalar(dx * 0.35).add(right.multiplyScalar(dy * 0.35));
    this.app.sim.client.op({ op: 'grabSpin', angvel: this.spinFrom(g.spinKeys, [w.x, w.y, w.z]) });
    if (this.spinTimer) clearTimeout(this.spinTimer);
    this.spinTimer = setTimeout(() => {
      const cur = this.g;
      if (cur.kind === 'grab') this.app.sim.client.op({ op: 'grabSpin', angvel: this.spinFrom(cur.spinKeys) });
    }, 70);
  }

  /** Wheel while holding a body: push it away from / pull it towards the camera. */
  private onWheel(e: WheelEvent): void {
    const g = this.g;
    if (g.kind !== 'grab' || (e.target !== this.app.viewport.dom && !this.app.viewport.dom.contains(e.target as Node)))
      return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const point = g.plane.coplanarPoint(new Vector3());
    const dist = point.distanceTo(this.cam.position);
    const away = -Math.sign(e.deltaY) * Math.max(0.15, dist * 0.08);
    const toCamera = g.plane.normal.clone();
    // Never pull the plane through the camera, never push it out of the scene.
    const next = point.clone().addScaledVector(toCamera, -away);
    const nd = next.distanceTo(this.cam.position);
    if (nd < 1 || nd > 200) return;
    g.plane.setFromNormalAndCoplanarPoint(toCamera, next);
    this.moveGrabTarget({ clientX: this.pointer.x, clientY: this.pointer.y }, g);
  }

  /** Keys while holding a body: Q / E spin it, R + drag turns it, F freezes / unfreezes it in place. */
  private onGrabKey(e: KeyboardEvent, down: boolean): void {
    const g = this.g;
    if (g.kind !== 'grab' || g.soft || isTyping(e.target)) {
      if (!down && e.code === 'KeyR') this.rHeld = false;
      return;
    }
    if (e.code === 'KeyR') {
      this.rHeld = down;
    } else if (e.code === 'KeyQ' || e.code === 'KeyE') {
      if (down) g.spinKeys.add(e.code);
      else g.spinKeys.delete(e.code);
      this.app.sim.client.op({ op: 'grabSpin', angvel: this.spinFrom(g.spinKeys) });
    } else if (e.code === 'KeyF' && down && !e.repeat) {
      this.app.sim.client.op({ op: 'grabFreeze' });
      this.app.toast('Toggled freeze on the held body — grab it and press F again to release it', 'info');
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  private moveMarquee(e: PointerEvent, g: Extract<Gesture, { kind: 'marquee' }>): void {
    const dx = e.clientX - g.x0,
      dy = e.clientY - g.y0;
    if (!g.moved && Math.hypot(dx, dy) < (e.pointerType === 'touch' ? 10 : 4)) return;
    g.moved = true;
    const r = this.app.shell.stage.getBoundingClientRect();
    const x = Math.min(e.clientX, g.x0) - r.left,
      y = Math.min(e.clientY, g.y0) - r.top;
    Object.assign(this.marquee.style, {
      display: 'block',
      left: `${x}px`,
      top: `${y}px`,
      width: `${Math.abs(dx)}px`,
      height: `${Math.abs(dy)}px`,
    });
  }

  private moveDrag(e: PointerEvent, g: Extract<Gesture, { kind: 'dragMove' }>): void {
    const app = this.app;
    if (!g.moved) {
      if (Math.hypot(e.clientX - g.startClient[0], e.clientY - g.startClient[1]) < (e.pointerType === 'touch' ? 10 : 5))
        return;
      g.moved = true;
      app.store.begin(g.ids.length > 1 ? `Move ${g.ids.length} objects` : 'Move');
      app.viewport.dom.classList.add('grabbing');
    }
    const vertical = e.shiftKey;
    const cur = vertical ? app.picker.verticalPoint(e, g.p0) : app.picker.groundPoint(e, g.p0.y);
    if (!cur) return;
    const delta: Vec3 = [cur.x - g.p0.x, cur.y - g.p0.y, cur.z - g.p0.z];
    if (!vertical) delta[1] = 0;
    else {
      delta[0] = 0;
      delta[2] = 0;
    }
    const base = g.starts.get(g.primary)!;
    // -- ED-A snap: vertex / edge / face / bounds / surface snapping (src/app/edit/snapDrag.ts) --
    if (applyObjectSnap(app, e, { ids: g.ids, starts: g.starts, primary: g.primary, delta, vertical })) return;
    // -- /ED-A snap --
    let d = delta;
    // -- ED-A snap: Ctrl suspends the grid too (or turns it on when all snapping is off) --
    const gridOn = effectiveModes(app, invertKey(e)).grid;
    if (gridOn) {
      const s = app.prefs.value.snapGrid;
      const snapped = vadd(base, delta).map((v) => Math.round(v / s) * s) as Vec3;
      d = [
        vertical ? 0 : snapped[0] - base[0],
        vertical ? snapped[1] - base[1] : 0,
        vertical ? 0 : snapped[2] - base[2],
      ];
    }
    app.editor.moveTo(new Map(g.ids.map((id) => [id, vadd(g.starts.get(id)!, d)])));
    // -- ED-A snap: marker for the grid snap --
    if (gridOn) showGridSnap(app, vadd(base, d));
  }

  private onUp(e: PointerEvent): void {
    const app = this.app;
    this.touchIds.delete(e.pointerId); // -- CM-A touch --
    const g = this.g;
    this.g = { kind: 'none' };
    app.viewport.dom.classList.remove('grabbing');
    if (app.viewport.dom.hasPointerCapture(e.pointerId)) app.viewport.dom.releasePointerCapture(e.pointerId);

    if (e.button === 2 && this.rightDown) {
      const moved = Math.hypot(e.clientX - this.rightDown[0], e.clientY - this.rightDown[1]) > 4;
      this.rightDown = null;
      if (!moved) this.onContextMenu?.(e);
      return;
    }

    switch (g.kind) {
      case 'marquee':
        this.finishMarquee(e, g);
        break;
      case 'dragMove':
        if (g.moved) app.store.end();
        endObjectSnap(app); // -- ED-A snap --
        break;
      case 'grab':
        app.sim.client.op({ op: 'release', throwScale: app.prefs.value.grabThrow });
        this.rHeld = false;
        break;
      case 'custom':
        g.up(e);
        break;
      case 'none':
        break;
    }
  }

  // -- CM-A touch: gesture hand-over --
  /** Kind of the one-pointer gesture in progress (`none` when idle). */
  get gestureKind(): Gesture['kind'] {
    return this.g.kind;
  }

  /**
   * Abandon the gesture in progress without applying it: the marquee disappears (selection untouched), a drag-move is
   * rolled back (no undo or redo step is left), a physics grab is released, a tool's own gesture is cancelled. Called
   * when a second finger lands or a long press takes over.
   */
  cancelGesture(): void {
    const app = this.app;
    const g = this.g;
    this.g = { kind: 'none' };
    this.marquee.style.display = 'none';
    app.viewport.dom.classList.remove('grabbing');
    if (g.kind === 'dragMove') {
      if (g.moved) app.store.cancelBatch();
      endObjectSnap(app);
    } else if (g.kind === 'grab') {
      app.sim.client.op({ op: 'release' });
      this.rHeld = false;
    } else if (g.kind === 'custom') g.cancel?.();
  }

  /** Set by the UI to show the viewport context menu. */
  onContextMenu: ((e: PointerEvent) => void) | null = null;
  private rightDown: [number, number] | null = null;

  private finishMarquee(e: PointerEvent, g: Extract<Gesture, { kind: 'marquee' }>): void {
    const app = this.app;
    this.marquee.style.display = 'none';
    if (!g.moved) {
      if (!g.additive) app.store.setSelection([]);
      return;
    }
    const rect = app.viewport.dom.getBoundingClientRect();
    const x0 = Math.min(e.clientX, g.x0),
      x1 = Math.max(e.clientX, g.x0);
    const y0 = Math.min(e.clientY, g.y0),
      y1 = Math.max(e.clientY, g.y0);
    const picked: string[] = [];
    const tmp = new Vector3();
    /** Does the world point project inside the rectangle on screen? */
    const inside = (x: number, y: number, z: number): boolean => {
      tmp.set(x, y, z).project(this.cam);
      if (tmp.z > 1) return false;
      const sx = rect.left + ((tmp.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - tmp.y) / 2) * rect.height;
      return sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1;
    };
    for (const [id, v] of app.bodies.views) {
      if (v.def.hidden || v.state === 2) continue;
      if (inside(v.position.x, v.position.y, v.position.z)) picked.push(id);
    }
    // Groups (their pivot diamond) and lights (their icon) are boxed by their anchor too; they are only drawn in the editor.
    if (!app.sim.active) {
      for (const ent of app.store.all()) {
        if (
          (isGroup(ent) || isLight(ent)) &&
          !ent.hidden &&
          inside(ent.position[0], ent.position[1], ent.position[2])
        ) {
          picked.push(ent.id);
        }
      }
    }
    const base = g.additive ? app.store.selection : [];
    app.store.setSelection([...new Set([...base, ...picked])]);
  }

  private onDouble(e: MouseEvent): void {
    // -- CM-A: in the orbit-point camera a double-click picks the new centre --
    if (this.app.cameraRig.mode === 'point') {
      const p = this.app.pickEntity(e)?.point ?? this.app.picker.groundPoint(e, 0);
      if (p) this.app.cameraRig.setPivot(p);
      return;
    }
    // Double-click ends a joint chain instead of framing the view.
    if (this.app.prefs.value.tool === 'joint' && jointToolOf(this.app).finish()) return;
    const hit = this.app.pickEntity(e);
    if (hit) {
      this.app.store.setSelection([hit.entityId]);
      this.app.frameSelection();
    } else this.app.frameAll();
  }

  // ---- keyboard ------------------------------------------------------------------------------

  private onKeyUp(e: KeyboardEvent): void {
    this.app.input.keyUp(e); // -- CM-A: the hub owns the simulation key set --
  }

  /**
   * Shortcuts that must work while a text field has focus (`CommandDef.allowWhileTyping`: the palette key). Many fields
   * (scene name, number fields, filters) stop their key events from bubbling so that typing never reaches the
   * shortcuts, so these are handled on the way down, before any field sees the event.
   */
  private onKeyDownCapture(e: KeyboardEvent): void {
    const cmd = keymap.find(e);
    if (!cmd?.allowWhileTyping) return;
    const ran = runCommand(cmd.id, this.app, 'shortcut', e);
    if (shouldPreventDefault(cmd, ran)) e.preventDefault();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const app = this.app;
    const typing = isTyping(e.target);
    // Forward keys to the running simulation (motor / thruster bindings).
    const forward = !typing && app.sim.active && !e.ctrlKey && !e.metaKey && !e.altKey;
    // -- CM-A: the fly / chase camera owns its keys while it runs --
    const swallowed = !typing && app.cameraRig.swallows(e);
    if (!typing) app.input.keyDown(e, forward && !swallowed);
    if (swallowed) {
      e.preventDefault();
      return;
    }
    if (forward && (e.code.startsWith('Arrow') || e.code === 'Space')) e.preventDefault();
    // Enter ends the joint chain being drawn.
    if (!typing && e.key === 'Enter' && app.prefs.value.tool === 'joint' && jointToolOf(app).finish()) {
      e.preventDefault();
      return;
    }
    // Every other key is a command's shortcut (src/app/registry/commands.ts); nothing here binds keys.
    const cmd = keymap.find(e);
    if (!cmd || cmd.allowWhileTyping || typing) return; // allowWhileTyping ones already ran in the capture phase
    const ran = runCommand(cmd.id, app, 'shortcut', e);
    if (shouldPreventDefault(cmd, ran)) e.preventDefault();
  }
}
