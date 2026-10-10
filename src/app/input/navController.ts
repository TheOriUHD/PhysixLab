/**
 * NavController — the one handler of camera navigation input (`app.nav`). It replaces the orbit controls' wheel
 * handling and adds what they lack, so there is no second competing handler:
 *
 *   wheel          mouse notch → zoom towards the cursor; trackpad swipe → orbit / pan; pinch (Ctrl + wheel) → zoom
 *   gestures       Safari's gesturestart / change / end (pinch, rotate) → zoom, turn
 *   pointer        Alt / Option + drag orbits, Space + drag pans (by choosing the orbit controls' left-button mapping)
 *   keyboard       arrows orbit, Shift + arrows pan, + / − zoom, Alt + 1 3 7 9 5 for the orthographic views
 *   touch          the touch controller feeds one-finger orbit, two-finger pan, pinch and twist through the same moves
 *
 * Moves are collected as pending amounts and applied per frame with a short ease (Settings › Navigation › Smooth
 * motion), so a wheel notch glides instead of jumping. The browser's own page zoom, back-swipe and overscroll are
 * prevented on the canvas. The orbit controls still own mouse drags (right = orbit, middle = pan) and damping.
 */
import { MOUSE } from 'three';
import type { App } from '../app';
import { runCommand } from '../registry/commands';
import {
  OPEN_LIMITS,
  dragToAngles,
  dragVerb,
  keyIntent,
  leftButtonMapping,
  orbitBy,
  panByPixels,
  takeShare,
  viewKeyPreset,
  wheelIntent,
  zoomBy,
  type Intent,
  type Mods,
  type NavLimits,
} from './navScheme';
import { DEFAULT_NAV, type NavSettings } from './navSettings';
import { platform, type PointerKind } from './platform';

const modsOf = (e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): Mods => ({
  shift: e.shiftKey,
  alt: e.altKey,
  ctrl: e.ctrlKey,
  meta: e.metaKey,
});

/** The pending camera move: amounts still to be applied (pixels of drag, ln of the distance scale, radians). */
interface Pending {
  ox: number;
  oy: number;
  px: number;
  py: number;
  zoom: number;
  twist: number;
  cursor: { x: number; y: number } | null;
}

const KEY_CODES = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Equal',
  'Minus',
  'NumpadAdd',
  'NumpadSubtract',
  'PageUp',
  'PageDown',
]);

export class NavController {
  private pending: Pending = { ox: 0, oy: 0, px: 0, py: 0, zoom: 0, twist: 0, cursor: null };
  /** Navigation keys currently held, with the modifiers of the latest press. */
  private held = new Map<string, Mods>();
  /** When the held keys were last integrated (performance.now(); 0 = none held). */
  private keyT = 0;
  private pointer = { x: 0, y: 0 };
  private space = false;
  private spaceMoved = false;
  /** While true the wheel belongs to someone else (a held body: scroll pushes / pulls it). */
  blockWheel: (() => boolean) | null = null;
  private readonly lim: NavLimits = { ...OPEN_LIMITS };

  constructor(private app: App) {
    const dom = app.viewport.dom;
    window.addEventListener('wheel', (e) => this.onWheel(e), { capture: true, passive: false });
    // Safari reports a trackpad pinch / rotation as gesture events (the page would zoom without this).
    for (const type of ['gesturestart', 'gesturechange', 'gestureend'] as const)
      dom.addEventListener(type, (e) => this.onGesture(type, e as GestureEventLike), { passive: false });
    document.addEventListener(
      'gesturestart',
      (e) => {
        if (e.target === dom) e.preventDefault();
      },
      { passive: false },
    );
    dom.addEventListener('pointerdown', (e) => this.onPointerDown(e), true);
    dom.addEventListener('pointermove', (e) => {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
    });
    // The wheel of an Alt-less laptop must never leave the canvas for the page: no scrolling, no history swipes.
    dom.style.touchAction = 'none';
    dom.style.overscrollBehavior = 'none';
    window.addEventListener('blur', () => this.releaseAll());
  }

  get settings(): NavSettings {
    return this.app.input.settings.nav ?? DEFAULT_NAV;
  }

  /** The scheme in force: the user's override, else what the wheel events and the OS say. */
  get device(): PointerKind {
    return platform().pointer(this.settings.device);
  }

  // ---- limits ----------------------------------------------------------------------------------

  /** What the orbit controls allow right now (a camera mode may restrict them), or null when the camera is driven. */
  private limits(): NavLimits | null {
    const vp = this.app.viewport;
    const c = vp.controls;
    if (vp.externalCamera || !c.enabled) return null;
    const l = this.lim;
    l.enableRotate = c.enableRotate;
    l.enablePan = c.enablePan;
    l.enableZoom = c.enableZoom;
    l.minPolarAngle = c.minPolarAngle;
    l.maxPolarAngle = c.maxPolarAngle;
    l.minDistance = c.minDistance;
    l.maxDistance = c.maxDistance;
    l.minZoom = c.minZoom;
    l.maxZoom = c.maxZoom;
    l.zoomToCursor = c.zoomToCursor && this.settings.zoomToCursor;
    return l;
  }

  /** Does the camera currently respond to navigation input (not driven by a rig mode)? */
  get active(): boolean {
    return this.limits() !== null;
  }

  // ---- wheel and gestures ----------------------------------------------------------------------

  private ndc(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.app.viewport.dom.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / Math.max(1, r.width)) * 2 - 1,
      y: -(((clientY - r.top) / Math.max(1, r.height)) * 2 - 1),
    };
  }

  private onWheel(e: WheelEvent): void {
    const dom = this.app.viewport.dom;
    if (e.target !== dom) return;
    // Page zoom (Ctrl + wheel) and history swipes must never reach the browser from the canvas.
    e.preventDefault();
    const p = platform();
    const kind = p.noteWheel(e, e.timeStamp);
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    if (this.blockWheel?.()) return; // a held body: the input controller turns the wheel into depth
    if (!this.limits()) return; // a driven camera mode reads the wheel itself
    const dev = this.device;
    const intent = wheelIntent(dev === 'touch' ? 'mouse' : dev, kind, e, modsOf(e), this.settings);
    if (intent.verb === 'none') return;
    e.stopImmediatePropagation();
    this.push(intent, e.clientX, e.clientY);
  }

  private onGesture(type: 'gesturestart' | 'gesturechange' | 'gestureend', e: GestureEventLike): void {
    e.preventDefault();
    const g = platform().gestures;
    if (type === 'gesturestart') {
      g.start();
      return;
    }
    if (type === 'gestureend') {
      g.end();
      return;
    }
    if (!this.limits()) return;
    const { factor, rotation } = g.change(e.scale, e.rotation ?? 0);
    const cx = e.clientX ?? this.pointer.x;
    const cy = e.clientY ?? this.pointer.y;
    this.pinch(factor, cx, cy);
    if (rotation !== 0 && this.settings.touchTwist) this.twist((rotation * Math.PI) / 180);
  }

  /** Queue a move (also the entry point of the touch controller and the tests). */
  push(intent: Intent, clientX = this.pointer.x, clientY = this.pointer.y): void {
    const p = this.pending;
    switch (intent.verb) {
      case 'orbit':
        p.ox += intent.x;
        p.oy += intent.y;
        break;
      case 'pan':
        p.px += intent.x;
        p.py += intent.y;
        break;
      case 'zoom':
        p.zoom += intent.y;
        p.cursor = this.ndc(clientX, clientY);
        break;
      case 'none':
        return;
    }
    this.app.viewport.needsRender = true;
  }

  /** Turn the view about the vertical axis (touch twist), radians; positive = counter-clockwise seen from above. */
  twist(radians: number): void {
    this.pending.twist += radians;
    this.app.viewport.needsRender = true;
  }

  /** Orbit by a drag of (dx, dy) pixels — used for one-finger touch orbit. */
  dragOrbit(dx: number, dy: number): void {
    this.push({ verb: 'orbit', x: dx, y: dy });
  }

  /** Zoom by a pinch factor (>1 = fingers apart = closer) towards a client position. */
  pinch(factor: number, clientX: number, clientY: number): void {
    if (!(factor > 0) || factor === 1) return;
    this.push({ verb: 'zoom', x: 0, y: -Math.log(factor) }, clientX, clientY);
  }

  // ---- pointer drags -----------------------------------------------------------------------------

  /** The left-button drag verb for a pointer event (Alt / Space modifiers), or null when the tool owns the drag. */
  private leftVerb(e: PointerEvent): ReturnType<typeof dragVerb> {
    return dragVerb(this.device, { ...modsOf(e), button: e.button, pointerType: e.pointerType, space: this.space });
  }

  /** Does this pointer press start a camera drag (so the selection / tool code must stay out of it)? */
  claimsDrag(e: PointerEvent): boolean {
    return e.button === 0 && this.leftVerb(e) !== null;
  }

  private onPointerDown(e: PointerEvent): void {
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    platform().notePointer(e.pointerType, e.timeStamp);
    if (e.button !== 0) return;
    const verb = this.leftVerb(e);
    const m = leftButtonMapping(verb, modsOf(e));
    this.app.viewport.controls.mouseButtons.LEFT = m === 'rotate' ? MOUSE.ROTATE : m === 'pan' ? MOUSE.PAN : null;
    if (verb && this.space) this.spaceMoved = true;
  }

  // ---- keyboard --------------------------------------------------------------------------------

  /** Space is held and may become a pan modifier; the key's own action (play / pause) waits for its release. */
  get spaceHeld(): boolean {
    return this.space;
  }

  /** Space went down: returns true when Space + drag should be allowed (the pointer is over the canvas). */
  spaceDown(): void {
    if (this.space) return;
    this.space = true;
    this.spaceMoved = false;
    this.app.viewport.dom.classList.add('nav-pan');
  }

  /** Space went up: true when it was used for a pan (so it must not also toggle the simulation). */
  spaceUp(): boolean {
    const used = this.spaceMoved;
    this.space = false;
    this.spaceMoved = false;
    this.app.viewport.dom.classList.remove('nav-pan');
    return used;
  }

  /** A navigation key went down; returns true when it was handled. */
  keyDown(e: KeyboardEvent, nudgeOwnsArrows: boolean): boolean {
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const v = viewKeyPreset(e.code);
      if (v) {
        runCommand(v === 'projection' ? 'camera.projection' : `camera.view.${v}`, this.app, 'shortcut', e);
        return true;
      }
    }
    if (!KEY_CODES.has(e.code) || !this.settings.keyboardNav) return false;
    const intent = keyIntent(e.code, modsOf(e), nudgeOwnsArrows);
    if (!intent) return false;
    if (!this.held.size) this.keyT = performance.now();
    this.held.set(e.code, modsOf(e));
    this.app.viewport.needsRender = true;
    return true;
  }

  keyUp(e: KeyboardEvent): void {
    this.held.delete(e.code);
  }

  private releaseAll(): void {
    this.held.clear();
    if (this.space) this.spaceUp();
  }

  // ---- per frame ---------------------------------------------------------------------------------

  /** Apply the pending moves and the held keys. Called once per frame before the camera rig. */
  update(dt: number): void {
    const p = this.pending;
    const idle = !this.held.size && !p.ox && !p.oy && !p.px && !p.py && !p.zoom && !p.twist;
    if (idle) return;
    const lim = this.limits();
    if (!lim) {
      this.clearPending();
      this.held.clear();
      return;
    }
    const s = this.settings;
    // Held keys add their per-second amounts for the time that really passed (frames can be slow: the app clamps `dt`).
    const now = performance.now();
    const kdt = this.keyT ? Math.min(0.25, (now - this.keyT) / 1000) : dt;
    this.keyT = this.held.size ? now : 0;
    for (const [code, mods] of this.held) {
      const k = keyIntent(code, mods, false);
      if (!k) continue;
      if (k.verb === 'orbit') {
        p.ox += k.x * kdt;
        p.oy += k.y * kdt;
      } else if (k.verb === 'pan') {
        p.px += k.x * kdt;
        p.py += k.y * kdt;
      } else if (k.verb === 'zoom') {
        p.zoom += k.y * kdt;
        p.cursor = null;
      }
    }
    const share = takeShare(s.smooth, dt);
    const vp = this.app.viewport;
    const cam = vp.camera;
    const target = vp.controls.target;
    const h = vp.dom.clientHeight || 600;
    let moved = false;
    if (p.ox || p.oy) {
      const tx = p.ox * share;
      const ty = p.oy * share;
      p.ox -= tx;
      p.oy -= ty;
      const [az, pol] = dragToAngles(tx, ty, h, s);
      moved = orbitBy(cam, target, az, pol, lim) || moved;
      if (Math.abs(p.ox) < 0.05) p.ox = 0;
      if (Math.abs(p.oy) < 0.05) p.oy = 0;
    }
    if (p.twist) {
      const t = p.twist * share;
      p.twist -= t;
      moved = orbitBy(cam, target, -t, 0, lim) || moved;
      if (Math.abs(p.twist) < 1e-4) p.twist = 0;
    }
    if (p.px || p.py) {
      const tx = p.px * share;
      const ty = p.py * share;
      p.px -= tx;
      p.py -= ty;
      const pk = s.panSpeed * (s.invertPan ? -1 : 1);
      moved = panByPixels(cam, target, tx * pk, ty * pk, h, lim) || moved;
      if (Math.abs(p.px) < 0.05) p.px = 0;
      if (Math.abs(p.py) < 0.05) p.py = 0;
    }
    if (p.zoom) {
      const z = p.zoom * share;
      p.zoom -= z;
      moved = zoomBy(cam, target, z * s.zoomSpeed * (s.invertZoom ? -1 : 1), p.cursor, lim) || moved;
      if (Math.abs(p.zoom) < 1e-4) {
        p.zoom = 0;
        p.cursor = null;
      }
    }
    if (moved) {
      vp.cancelTween();
      cam.updateMatrixWorld();
      vp.needsRender = true;
    } else if (!this.held.size) {
      // Pending moves the limits refuse (a zoom past the end stop) must not linger.
      if (!lim.enableRotate) p.ox = p.oy = p.twist = 0;
      if (!lim.enablePan) p.px = p.py = 0;
      if (!lim.enableZoom) p.zoom = 0;
    }
  }

  private clearPending(): void {
    const p = this.pending;
    p.ox = p.oy = p.px = p.py = p.zoom = p.twist = 0;
    p.cursor = null;
  }

  /** Drop anything queued (a scene load, a camera mode change). */
  cancel(): void {
    this.clearPending();
  }

  /** Test hook: is anything still queued? */
  get busy(): boolean {
    const p = this.pending;
    return !!(p.ox || p.oy || p.px || p.py || p.zoom || p.twist || this.held.size);
  }
}

/** Safari's non-standard gesture event. */
interface GestureEventLike extends Event {
  scale: number;
  rotation?: number;
  clientX?: number;
  clientY?: number;
}
