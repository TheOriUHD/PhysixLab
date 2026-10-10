/**
 * Touch gestures on the viewport canvas. One finger belongs to the active tool (`InputController`: select, marquee,
 * drag-move, gizmo …); this class adds everything that needs time or several fingers:
 *
 *   long press (500 ms, ≤ 10 px of drift)  opens the viewport context menu and cancels the one-finger gesture
 *   two fingers                            pinch = zoom, drag = orbit (or pan, a setting) — OrbitControls' touch mode
 *   two fingers, "move with two fingers"   drag moves the selected objects on the ground plane, pinch still zooms
 *   three fingers                          drag = pan
 *
 * The listeners run in the capture phase, before `InputController` and OrbitControls, so the camera mapping can be
 * chosen when the second finger lands. While the transform gizmo is being dragged, extra fingers are swallowed so
 * they cannot corrupt that drag.
 */
import { TOUCH, Vector3 } from 'three';
import { vadd, type Vec3 } from '../../core/math';
import { topLevel } from '../../model/groups';
import { isPosed } from '../../model/types';
import type { App } from '../app';
import type { InputController } from '../input';
import {
  FingerSet,
  LongPress,
  classifyTwoFinger,
  panShift,
  pinchDistance,
  snapMove,
  type TwoFingerKind,
} from './gestures';

type Mode = 'idle' | 'one' | 'two-camera' | 'two-move' | 'pan';

const tmpR = new Vector3();
const tmpU = new Vector3();
const tmpO = new Vector3();

export class TouchGestures {
  private readonly fingers = new FingerSet();
  private readonly press = new LongPress(500, 10);
  private delay = 500;
  private evalFrame = 0;
  private pressTimer = 0;
  private downEvent: PointerEvent | null = null;
  private mode: Mode = 'idle';
  private ignored = new Set<number>();
  private readonly c0 = { x: 0, y: 0 };
  private readonly prev = { x: 0, y: 0 };
  private readonly cur = { x: 0, y: 0 };
  private spread0 = 0;
  private prevSpread = 0;
  private kind: TwoFingerKind = 'undecided';
  private move: {
    ids: string[];
    starts: Map<string, Vec3>;
    p0: Vector3;
    primary: string;
    began: boolean;
  } | null = null;
  private readonly off: (() => void)[] = [];

  constructor(
    private app: App,
    private input: InputController,
  ) {
    const dom = app.viewport.dom;
    const on = <K extends 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel'>(
      type: K,
      fn: (e: PointerEvent) => void,
    ) => {
      const h = (e: PointerEvent) => {
        if (e.pointerType === 'touch') fn(e);
      };
      dom.addEventListener(type, h, true);
      this.off.push(() => dom.removeEventListener(type, h, true));
    };
    on('pointerdown', (e) => this.onDown(e));
    on('pointermove', (e) => this.onMove(e));
    on('pointerup', (e) => this.onUp(e));
    on('pointercancel', (e) => this.onUp(e));
    // The camera mapping follows the settings.
    this.applyMapping();
    const onBlur = () => this.reset();
    window.addEventListener('blur', onBlur);
    this.off.push(() => window.removeEventListener('blur', onBlur));
    this.off.push(
      app.prefs.on('change', (k) => {
        if (k.includes('input')) this.applyMapping();
      }),
    );
  }

  /** Forget every finger (focus lost, a pointer-up never arrived): the next touch starts a clean gesture. */
  private reset(): void {
    window.clearTimeout(this.pressTimer);
    cancelAnimationFrame(this.evalFrame);
    this.evalFrame = 0;
    this.press.cancel();
    this.endMove();
    this.fingers.clear();
    this.ignored.clear();
    this.mode = 'idle';
    this.downEvent = null;
    this.applyMapping();
  }

  dispose(): void {
    window.clearTimeout(this.pressTimer);
    cancelAnimationFrame(this.evalFrame);
    for (const f of this.off) f();
    this.off.length = 0;
  }

  private get cfg() {
    return this.app.input.settings.touch;
  }

  /** One finger never orbits (it selects); two fingers orbit / pan + pinch unless the move mode takes them over. */
  private applyMapping(): void {
    const controls = this.app.viewport.controls;
    controls.touches.ONE = null;
    controls.touches.TWO = this.cfg.twoFingerDrag === 'pan' ? TOUCH.DOLLY_PAN : TOUCH.DOLLY_ROTATE;
  }

  private canMoveSelection(): boolean {
    const a = this.app;
    return this.cfg.moveWithTwoFingers && !a.sim.active && this.movableSelection().length > 0;
  }

  private movableSelection(): string[] {
    const store = this.app.store;
    return topLevel(
      (id) => store.get(id),
      store.selection.filter((id) => {
        const x = store.get(id);
        return isPosed(x) && !x.locked;
      }),
    );
  }

  // ---- events --------------------------------------------------------------------------------

  private onDown(e: PointerEvent): void {
    // A primary touch starts a new sequence: any finger still remembered is stale (its pointer-up got lost).
    if (e.isPrimary && this.fingers.count > 0) this.reset();
    if (this.app.gizmo.isDragging && this.fingers.count >= 1) {
      // A gizmo handle is being dragged by the first finger: further fingers must not reach it.
      this.ignored.add(e.pointerId);
      e.stopImmediatePropagation();
      return;
    }
    this.fingers.down(e.pointerId, e.clientX, e.clientY);
    const n = this.fingers.count;
    if (n === 1) {
      this.mode = 'one';
      this.downEvent = e;
      this.delay = this.cfg.longPressMs;
      this.press.delay = this.delay;
      this.press.begin(e.pointerId, e.clientX, e.clientY, performance.now());
      window.clearTimeout(this.pressTimer);
      this.pressTimer = window.setTimeout(() => this.onPressTimer(), this.delay);
      return;
    }
    this.press.cancel();
    window.clearTimeout(this.pressTimer);
    this.fingers.centroid(this.prev);
    this.prevSpread = this.fingers.spread();
    if (n === 2) {
      this.c0.x = this.prev.x;
      this.c0.y = this.prev.y;
      this.spread0 = this.prevSpread;
      this.kind = 'undecided';
      if (this.canMoveSelection()) {
        this.mode = 'two-move';
        this.app.viewport.controls.touches.TWO = null; // OrbitControls stays out of it
        this.beginMove();
      } else {
        this.endMove();
        this.mode = 'two-camera';
        this.applyMapping();
      }
    } else {
      this.endMove();
      this.mode = 'pan'; // three or more fingers
    }
  }

  private onMove(e: PointerEvent): void {
    if (this.ignored.has(e.pointerId)) {
      e.stopImmediatePropagation();
      return;
    }
    if (!this.fingers.move(e.pointerId, e.clientX, e.clientY)) return;
    if (!this.press.move(e.pointerId, e.clientX, e.clientY)) window.clearTimeout(this.pressTimer);
    // Fingers report one after the other: judge the hand once per frame, when all of them have moved.
    if ((this.mode === 'pan' || this.mode === 'two-move') && !this.evalFrame) {
      this.evalFrame = requestAnimationFrame(() => {
        this.evalFrame = 0;
        if (this.mode === 'pan') this.doPan();
        else if (this.mode === 'two-move') this.doTwoMove();
      });
    }
  }

  private onUp(e: PointerEvent): void {
    if (this.ignored.delete(e.pointerId)) {
      e.stopImmediatePropagation();
      return;
    }
    if (!this.fingers.has(e.pointerId)) return;
    this.fingers.up(e.pointerId);
    this.press.cancel();
    window.clearTimeout(this.pressTimer);
    const n = this.fingers.count;
    if (n < 2) {
      cancelAnimationFrame(this.evalFrame);
      this.evalFrame = 0;
      this.endMove();
    }
    if (n === 0) {
      this.mode = 'idle';
      this.downEvent = null;
      this.applyMapping();
    } else if (n === 1) {
      this.mode = 'idle'; // the finger left over after a multi-finger gesture does nothing until it is lifted
    }
    this.fingers.centroid(this.prev);
    this.prevSpread = this.fingers.spread();
  }

  // ---- long press ----------------------------------------------------------------------------

  private onPressTimer(): void {
    // The browser delivers a pointer-up that happened during a long frame at the start of the next frame, ahead of
    // animation callbacks: firing from one means a lift that is already queued can still cancel the press.
    requestAnimationFrame(() => this.firePress());
  }

  private firePress(): void {
    const app = this.app;
    if (!this.press.fire(performance.now()) || this.mode !== 'one' || !this.downEvent) return;
    // Holding a physics grab or a gizmo handle still is not a request for a menu.
    if (this.input.gestureKind === 'grab' || app.gizmo.isDragging) return;
    this.input.cancelGesture();
    navigator.vibrate?.(12);
    this.input.onContextMenu?.(this.downEvent);
  }

  // ---- three fingers: pan --------------------------------------------------------------------

  private doPan(): void {
    this.fingers.centroid(this.cur);
    const dx = this.cur.x - this.prev.x;
    const dy = this.cur.y - this.prev.y;
    this.prev.x = this.cur.x;
    this.prev.y = this.cur.y;
    if (dx === 0 && dy === 0) return;
    const vp = this.app.viewport;
    if (!vp.controls.enabled || !vp.controls.enablePan) return; // a camera mode may own the pose (fly, orbit point …)
    const cam = vp.camera;
    const target = vp.controls.target;
    tmpR.setFromMatrixColumn(cam.matrixWorld, 0);
    tmpU.setFromMatrixColumn(cam.matrixWorld, 1);
    const dist = tmpO.copy(cam.position).sub(target).length();
    const rect = vp.dom.getBoundingClientRect();
    const s = panShift(dx, dy, dist, cam.fov, rect.height, [tmpR.x, tmpR.y, tmpR.z], [tmpU.x, tmpU.y, tmpU.z]);
    cam.position.x += s[0];
    cam.position.y += s[1];
    cam.position.z += s[2];
    target.x += s[0];
    target.y += s[1];
    target.z += s[2];
    vp.needsRender = true;
  }

  // ---- two fingers: move the selection / zoom ------------------------------------------------

  private beginMove(): void {
    const store = this.app.store;
    const ids = this.movableSelection();
    const starts = new Map<string, Vec3>();
    for (const id of ids) {
      const x = store.get(id);
      if (isPosed(x)) starts.set(id, x.position);
    }
    const primary = ids[0];
    const start = starts.get(primary);
    if (!start) {
      this.move = null;
      return;
    }
    const p0 = this.app.picker.groundPoint({ clientX: this.c0.x, clientY: this.c0.y }, start[1]);
    this.move = { ids, starts, p0: p0 ?? new Vector3(start[0], start[1], start[2]), primary, began: false };
    if (!p0) this.move = null;
  }

  private endMove(): void {
    if (this.move?.began) this.app.store.end();
    this.move = null;
  }

  private doTwoMove(): void {
    if (this.fingers.count !== 2) return;
    this.fingers.centroid(this.cur);
    const spread = this.fingers.spread();
    if (this.kind === 'undecided') {
      this.kind = classifyTwoFinger(Math.hypot(this.cur.x - this.c0.x, this.cur.y - this.c0.y), spread - this.spread0);
      this.prevSpread = spread;
      if (this.kind === 'undecided') return;
    }
    if (this.kind === 'pinch') {
      this.dolly(this.prevSpread > 0 ? spread / this.prevSpread : 1);
      this.prevSpread = spread;
      return;
    }
    const m = this.move;
    if (!m) return;
    const app = this.app;
    const cur = app.picker.groundPoint({ clientX: this.cur.x, clientY: this.cur.y }, m.p0.y);
    if (!cur) return;
    if (!m.began) {
      m.began = true;
      app.store.begin(m.ids.length > 1 ? `Move ${m.ids.length} objects` : 'Move');
    }
    let delta: Vec3 = [cur.x - m.p0.x, 0, cur.z - m.p0.z];
    if (app.prefs.value.snap) delta = snapMove(m.starts.get(m.primary)!, delta, app.prefs.value.snapGrid);
    app.editor.moveTo(new Map(m.ids.map((id) => [id, vadd(m.starts.get(id)!, delta)])));
  }

  /** Dolly the camera towards / away from its target (the camera-side of a pinch while OrbitControls is off). */
  private dolly(scale: number): void {
    const vp = this.app.viewport;
    if (!vp.controls.enabled || !vp.controls.enableZoom) return;
    const cam = vp.camera;
    const target = vp.controls.target;
    const off = tmpO.copy(cam.position).sub(target);
    const d = off.length();
    if (d < 1e-6) return;
    const nd = pinchDistance(d, scale, vp.controls.minDistance, vp.controls.maxDistance);
    off.multiplyScalar(nd / d);
    cam.position.copy(target).add(off);
    vp.needsRender = true;
  }
}
