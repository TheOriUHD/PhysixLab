/**
 * Pointer + keyboard input for the viewport: selection, drag-moving, grabbing bodies in a
 * running simulation and the pointer behaviour of the joint / measure / blast / shoot tools. Which tool receives the
 * pointer, and what every key does, is decided by the registries (`./registry`), not here.
 */
import { Plane, Vector3, type Camera } from 'three';
import { vadd, type Vec3 } from '../core/math';
import { topLevel } from '../model/groups';
import { isGroup, isLight, isPosed } from '../model/types';
import type { App } from './app';
import { runCommand } from './registry/commands';
import { keymap, shouldPreventDefault } from './registry/keymap';
import { toolForMode } from './registry/tools';

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
  | { kind: 'grab'; plane: Plane; id: string };

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

  constructor(private app: App) {
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
    });
    dom.addEventListener('dblclick', (e) => this.onDouble(e));
    // Capture phase for the shortcuts that work inside text fields (see `onKeyDownCapture`).
    window.addEventListener('keydown', (e) => this.onKeyDownCapture(e), true);
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => this.app.input.clearKeys());
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
    const tool = this.app.prefs.value.tool;
    if (tool !== 'select' && tool !== 'joint') {
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
      const handle = app.pathViews.pickPoint(e, this.cam, app.viewport.dom.getBoundingClientRect());
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
          app.sim.client.op({ op: 'grabSoft', id, index: idx, target: [hit.point.x, hit.point.y, hit.point.z] });
          this.g = { kind: 'grab', plane, id };
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
        });
        this.g = { kind: 'grab', plane, id };
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

  /** Pointer press of the tool of the same name (called through the tool registry). */
  downJoint(e: PointerEvent): void {
    const app = this.app;
    const hit = app.pickEntity(e, { joints: false });
    const ground = app.picker.groundPoint(e, 0);
    const type = app.prefs.value.jointType;
    let end: { body: string | null; point: Vector3 } | null = null;
    if (hit && app.store.soft(hit.entityId)) {
      app.toast('Joints can’t attach to soft bodies — they can only be pinned in space', 'warn');
      return;
    }
    if (hit) end = { body: hit.entityId, point: hit.point };
    else if (ground && ground.distanceTo(this.cam.position) < 400) end = { body: null, point: ground };
    if (!end) return;

    if (!app.jointDraft) {
      app.jointDraft = end;
      app.effects.ping(end.point, 0xffb347);
      app.setHint(
        `<b>${type}</b> — now click the second body, or empty ground to attach to the world · <kbd>Esc</kbd> cancels`,
      );
      return;
    }
    const a = app.jointDraft;
    if (a.body && a.body === end.body) {
      app.toast('Pick two different bodies', 'warn');
      return;
    }
    if (!a.body && !end.body) {
      app.toast('At least one end must be a body', 'warn');
      return;
    }
    const j = app.editor.addJoint(
      type,
      { body: a.body, point: [a.point.x, a.point.y, a.point.z] },
      { body: end.body, point: [end.point.x, end.point.y, end.point.z] },
    );
    app.cancelJointDraft();
    if (j) {
      app.effects.ping(end.point, 0x5be3a1);
      if (!e.shiftKey) app.setTool('select');
      app.toast(`${j.name} added — select it to edit limits, motors and springs`, 'success');
    }
    app.updateToolHint();
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
    const hit = this.app.pickEntity(e, { joints: false });
    const p = hit?.point ?? this.app.picker.groundPoint(e, 0);
    if (p) this.app.blast(p);
  }

  /** Pointer press of the tool of the same name (called through the tool registry). */
  downShoot(e: PointerEvent): void {
    const dir = this.app.picker.rayDirection(e);
    this.app.shoot(this.cam.position.clone(), dir);
  }

  private onMove(e: PointerEvent): void {
    const app = this.app;
    this.pointer = { x: e.clientX, y: e.clientY, inside: true };
    const g = this.g;

    if (app.jointDraft) {
      const hit = app.pickEntity(e, { joints: false });
      const p = hit?.point ?? app.picker.groundPoint(e, 0);
      if (p) app.setMeasureLine(app.jointDraft.point, p);
    } else if (app.prefs.value.tool === 'measure' && app.measure && !app.measure.b) {
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
        const p = app.picker.cameraPlanePoint(e, g.plane.coplanarPoint(new Vector3()));
        if (p) app.sim.client.op({ op: 'grabMove', target: [p.x, p.y, p.z] });
        break;
      }
    }
  }

  private moveMarquee(e: PointerEvent, g: Extract<Gesture, { kind: 'marquee' }>): void {
    const dx = e.clientX - g.x0,
      dy = e.clientY - g.y0;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
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
      if (Math.hypot(e.clientX - g.startClient[0], e.clientY - g.startClient[1]) < 5) return;
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
    let d = delta;
    if (app.prefs.value.snap) {
      const s = app.prefs.value.snapGrid;
      const snapped = vadd(base, delta).map((v) => Math.round(v / s) * s) as Vec3;
      d = [
        vertical ? 0 : snapped[0] - base[0],
        vertical ? snapped[1] - base[1] : 0,
        vertical ? 0 : snapped[2] - base[2],
      ];
    }
    app.editor.moveTo(new Map(g.ids.map((id) => [id, vadd(g.starts.get(id)!, d)])));
  }

  private onUp(e: PointerEvent): void {
    const app = this.app;
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
        break;
      case 'grab':
        app.sim.client.op({ op: 'release' });
        break;
      case 'none':
        break;
    }
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
    if (!typing) app.input.keyDown(e, forward); // -- CM-A --
    if (forward && (e.code.startsWith('Arrow') || e.code === 'Space')) e.preventDefault();
    // Every other key is a command's shortcut (src/app/registry/commands.ts); nothing here binds keys.
    const cmd = keymap.find(e);
    if (!cmd || cmd.allowWhileTyping || typing) return; // allowWhileTyping ones already ran in the capture phase
    const ran = runCommand(cmd.id, app, 'shortcut', e);
    if (shouldPreventDefault(cmd, ran)) e.preventDefault();
  }
}
