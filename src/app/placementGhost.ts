/**
 * Ghost placement: dragging a library tile (a shape, a soft body, a prefab, a zone, a light …) into the viewport — or
 * clicking it to arm placement — shows a translucent GHOST of the real thing that follows the pointer and rests on
 * the surface under it. The real object is created only when the user lets go (or clicks) over the viewport, as one
 * undoable command; Esc, a right click or letting go over a panel cancels without a trace.
 *
 *   drag    press a tile, move into the viewport (the ghost appears), release to place. Touch: long-press, then drag.
 *   armed   click a tile (or press a shape's number key): the ghost follows the cursor; click places it, Shift+click
 *           places and stays armed for the next one, Enter places it where it is (the view centre when the pointer is
 *           off the viewport), Esc cancels.
 *
 * While a ghost is active: Q / E (or R, Shift+R) turn it by 15° (Shift: 1°), [ and ] (or Page Up / Down) lower and
 * raise it, X toggles "align to the surface normal", holding Alt suspends snapping (Ctrl inverts it), and every other
 * plain letter key is swallowed so the tool shortcuts (W / E / R …) do not fire behind the ghost.
 *
 * Interface for the controls legend / input-context package: `app.placement.ghost` has `active`, `handleKey(e)` (true
 * when the key was consumed; ALL placement keys are handled there), `cancel()` and `legendEntries()`. This class also
 * listens for keys itself while a ghost is active; a key event handed to `handleKey` twice is only applied once.
 *
 * The pose maths is `surfaceDropPose` (the same as dropping a shape in the editor: flush on the surface, optional
 * normal alignment, the snap settings) plus the user's turn and height; the visuals are `GhostView`.
 */
import { Vector3 } from 'three';
import { Emitter } from '../core/events';
import { qrot, type Quat, type Vec3 } from '../core/math';
import {
  OVERLAP_TOLERANCE,
  boxOfBounds,
  footprintRadius,
  formatPoint,
  formatSize,
  liftAlong,
  liftStep,
  obbPenetration,
  placementViolation,
  stepAngle,
  stepLift,
  worldAabb,
  yawQuat,
  type Obb,
} from '../model/edit/placeMath';
import { buildGhostGeometry } from '../render/ghostGeometry';
import { GhostView, type GhostTint } from '../render/placementGhostView';
import type { App } from './app';
import { surfaceDropPose } from './edit/surfaceDrop';
import type { Placeable } from './placeables';

export type PlaceMode = 'drag' | 'armed';

export interface LegendEntry {
  keys: string;
  action: string;
}

/** What the HUD shows: a snapshot, cheap to compare. */
export interface PlacementHud {
  mode: PlaceMode;
  label: string;
  icon: string;
  yawDeg: number;
  lift: number;
  /** Whether the ghost is turned onto the surface normal (the X toggle, else the preference). */
  align: boolean;
  /** The pointer is over the viewport (otherwise a drag would be cancelled on release). */
  overViewport: boolean;
  /** Why the spot is refused (red), or null. */
  reason: string | null;
  /** Something questionable about the spot that is still allowed (amber), or null. */
  warning: string | null;
  multi: boolean;
}

interface Session {
  placeable: Placeable;
  mode: PlaceMode;
  view: GhostView;
  /** Drag: the pointer that owns it. */
  pointerId: number | null;
  /** Armed: the left press that is waiting for its release. */
  down: { id: number; x: number; y: number; alt: boolean } | null;
  /** Armed: a right press (a camera orbit, or a cancel when it does not move). */
  right: { id: number; x: number; y: number } | null;
  /** Keep placing after the next placement. */
  multi: boolean;
  /** Extent for the label. */
  extent: Vec3 | null;
  /** Local box of the placeable. */
  box: { min: Vec3; max: Vec3 };
  label: string;
  wheel: number;
  /** Remove the session's own listeners. */
  off: (() => void)[];
}

/** The last computed pose and verdict. */
export interface GhostPose {
  position: Vec3;
  rotation: Quat;
  /** The surface point touched and its normal. */
  contact: Vec3;
  normal: Vec3;
  where: 'surface' | 'ground' | 'view';
  reason: string | null;
  warning: string | null;
}

const LABEL_KEY = 'placement-ghost';
const UP: Vec3 = [0, 1, 0];
const WHEEL_STEP = 40;
const isTyping = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
};

export class PlacementGhost extends Emitter<{ change: undefined }> {
  private session: Session | null = null;
  /** The pose last computed for the active ghost (null when none). */
  pose: GhostPose | null = null;
  yawDeg = 0;
  lift = 0;
  /** The X toggle; null follows the preference "Align to surface normal". */
  alignOverride: boolean | null = null;

  private pointer = { x: 0, y: 0, known: false, inView: false };
  private mods = { alt: false, ctrl: false, shift: false };
  private overlapCache: { revision: number; list: SolidBox[] } | null = null;
  private lastCam = new Float32Array(16);
  private dirty = false;
  private raf = 0;
  private hudKey = '';
  private wasActive = false;
  private handled = new WeakMap<KeyboardEvent, boolean>();
  private labelTint: GhostTint | null = null;
  private labelAt = new Vector3();

  constructor(private app: App) {
    super();
    if (typeof window === 'undefined') return;
    const w = window;
    w.addEventListener('pointermove', (e) => this.onMove(e), { capture: true, passive: true });
    w.addEventListener('pointerdown', (e) => this.onDown(e), true);
    w.addEventListener('pointerup', (e) => this.onUp(e), true);
    w.addEventListener('pointercancel', (e) => this.onPointerCancel(e), true);
    w.addEventListener('keydown', (e) => this.onKeyDown(e), true);
    w.addEventListener('keyup', (e) => this.onKeyUp(e), true);
    w.addEventListener('blur', () => this.cancel());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.cancel();
    });
    // The ghost must never outlive the thing it was made for: a new document, a started simulation, another tool.
    app.store.on('change', (c) => {
      if (!this.session) return;
      if (c.type === 'reset') this.cancel();
      else this.dirty = true;
    });
    this.wasActive = app.sim.active;
    app.sim.on('mode', () => {
      const now = app.sim.active;
      if (now !== this.wasActive) this.cancel();
      this.wasActive = now;
    });
    app.prefs.on('change', (keys) => {
      if (this.session && keys.includes('tool')) this.cancel();
    });
  }

  // ── the interface other packages use ─────────────────────────────────────────────────────────────

  /** A ghost is showing or waiting to be placed. */
  get active(): boolean {
    return this.session !== null;
  }

  get mode(): PlaceMode | null {
    return this.session?.mode ?? null;
  }

  get placeable(): Placeable | null {
    return this.session?.placeable ?? null;
  }

  /** The three.js objects of the ghost (for tests), 0 when none. */
  get objectCount(): number {
    return this.session?.view.objectCount ?? 0;
  }

  /** Tint of the ghost now (`ok` cyan, `warn` amber, `bad` red). */
  get tint(): GhostTint | null {
    return this.session?.view.tinted ?? null;
  }

  /** Is the ghost drawn (it is hidden while a dragged tile is over a panel)? */
  get visible(): boolean {
    return !!this.session?.view.visible;
  }

  /** End placement without creating anything. */
  cancel(): void {
    this.end();
  }

  /**
   * Handle a key while a ghost is active. Returns true when the key was consumed (the caller must then not run any
   * other shortcut for it). Keys: Esc cancel · Q / E / R (Shift) turn · [ ] / Page Up / Down lower and raise · X align ·
   * Enter place · other plain letters are swallowed (so W / E / R tool keys do not fire behind the ghost).
   */
  handleKey(e: KeyboardEvent): boolean {
    const s = this.session;
    if (!s) return false;
    const seen = this.handled.get(e);
    if (seen !== undefined) return seen;
    const r = this.applyKey(e, s);
    this.handled.set(e, r);
    return r;
  }

  /** The keys that work now, for a legend: `{ keys, action }` rows in the order they matter. */
  legendEntries(): LegendEntry[] {
    const s = this.session;
    if (!s) return [];
    const out: LegendEntry[] = [];
    if (s.mode === 'drag') out.push({ keys: 'Release', action: 'Place here' });
    else {
      out.push({ keys: 'Click', action: 'Place here' });
      out.push({ keys: 'Shift+Click', action: 'Place several' });
      out.push({ keys: 'Enter', action: 'Place at the ghost' });
    }
    if (s.placeable.rotatable) {
      out.push({ keys: 'Q / E', action: 'Rotate 15°' });
      out.push({ keys: 'Shift+Q / E', action: 'Rotate 1°' });
      out.push({ keys: 'R / Shift+R', action: 'Rotate 15° either way' });
    }
    out.push({ keys: '[ / ]', action: 'Lower / raise' });
    out.push({ keys: 'X', action: 'Align to surface' });
    out.push({ keys: 'Alt', action: 'Hold for no snapping' });
    out.push({ keys: s.mode === 'drag' ? 'Esc / Right-click' : 'Esc', action: 'Cancel' });
    return out;
  }

  // ── starting and ending ──────────────────────────────────────────────────────────────────────────

  /** Click-to-place: arm `p`, the ghost follows the pointer over the viewport (at the view centre until it comes). */
  arm(p: Placeable): void {
    this.begin(p, 'armed', null);
  }

  /** Tile drag: the pointer `e` pressed a tile and moved. The ghost follows it until release. */
  beginDrag(p: Placeable, e: PointerEvent): void {
    this.begin(p, 'drag', e);
  }

  /** Is `p` the placeable being armed or dragged? (For the tile highlight.) */
  isPlacing(id: string): boolean {
    return this.session?.placeable.id === id;
  }

  /** The HUD snapshot, or null. */
  hud(): PlacementHud | null {
    const s = this.session;
    if (!s) return null;
    return {
      mode: s.mode,
      label: s.placeable.label,
      icon: s.placeable.icon,
      yawDeg: this.yawDeg,
      lift: this.lift,
      align: this.align(),
      overViewport: this.pointer.inView,
      reason: this.pose?.reason ?? null,
      warning: this.pose?.warning ?? null,
      multi: s.multi,
    };
  }

  /** Place the real thing at the ghost (Enter, the HUD button). Keeps placing when `keep` is set. */
  placeNow(keep = false): boolean {
    const s = this.session;
    if (!s) return false;
    this.refresh();
    return this.place(keep || s.multi);
  }

  private begin(p: Placeable, mode: PlaceMode, e: PointerEvent | null): void {
    const { app } = this;
    this.end(false);
    this.yawDeg = 0;
    this.lift = 0;
    this.alignOverride = null;
    const box = boxOfBounds(p.bounds());
    const geo = buildGhostGeometry(p.entities());
    const view = new GhostView(app.viewport.helpers, geo, footprintRadius(box.min, box.max));
    const session: Session = {
      placeable: p,
      mode,
      view,
      pointerId: e ? e.pointerId : null,
      down: null,
      right: null,
      multi: false,
      extent: p.extent(),
      box,
      label: p.label,
      wheel: 0,
      off: [],
    };
    this.session = session;
    this.pose = null;
    if (e) this.track(e);
    else if (this.pointer.known) this.pointer.inView = this.overViewport(this.pointer.x, this.pointer.y);
    else this.pointer.inView = false;
    // wheel: a non-passive listener, only while a ghost is active
    const wheel = (ev: WheelEvent): void => this.onWheel(ev);
    window.addEventListener('wheel', wheel, { capture: true, passive: false });
    session.off.push(() => window.removeEventListener('wheel', wheel, true));
    app.viewport.dom.classList.add('placing');
    this.dirty = true;
    this.refresh();
    this.snapshotCamera();
    this.raf = requestAnimationFrame(this.tick);
    this.emitHud(true);
  }

  private end(notify = true): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.pose = null;
    cancelAnimationFrame(this.raf);
    for (const f of s.off) f();
    s.view.dispose();
    this.app.labels.remove(LABEL_KEY);
    this.labelTint = null;
    this.app.viewport.dom.classList.remove('placing');
    this.app.viewport.needsRender = true;
    if (notify) this.emitHud(true);
  }

  // ── the pose ─────────────────────────────────────────────────────────────────────────────────────

  private align(): boolean {
    return this.alignOverride ?? this.app.prefs.value.snapAlignNormal;
  }

  private overViewport(x: number, y: number): boolean {
    const el = document.elementFromPoint(x, y);
    if (!el) return false;
    const dom = this.app.viewport.dom;
    return el === dom || (el instanceof HTMLCanvasElement && !!dom.parentElement?.contains(el));
  }

  private track(e: PointerEvent): void {
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.known = true;
    this.mods.alt = e.altKey;
    this.mods.ctrl = e.ctrlKey || e.metaKey;
    this.mods.shift = e.shiftKey;
    if (this.session) this.pointer.inView = this.overViewport(e.clientX, e.clientY);
  }

  /** Recompute the pose for the pointer (or the view centre) and move everything that shows it. O(1) per call. */
  private refresh(): void {
    const s = this.session;
    if (!s) return;
    const { app } = this;
    const p = s.placeable;
    const rect = app.viewport.dom.getBoundingClientRect();
    // a dragged tile over a panel hides the ghost (release there cancels); an armed ghost waits at the view centre
    const centred = !this.pointer.inView;
    const x = centred ? rect.left + rect.width / 2 : this.pointer.x;
    const y = centred ? rect.top + rect.height * 0.6 : this.pointer.y;
    const aligned = this.align();
    const drop = surfaceDropPose(app, x, y, p.bounds(), {
      rotation: p.rotatable ? yawQuat(this.yawDeg) : undefined,
      alignNormal: this.alignOverride ?? undefined,
      invert: this.mods.ctrl,
      noSnap: this.mods.alt,
    });
    const up: Vec3 = aligned && drop.where === 'surface' ? drop.normal : UP;
    const off = p.hover + this.lift;
    const position = off === 0 ? drop.position : liftAlong(drop.position, up, off);
    const box = worldAabb(s.box.min, s.box.max, position, drop.rotation);
    const centre: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];

    let reason: string | null = null;
    let warning: string | null = null;
    if (drop.where === 'view') reason = 'Aim at the ground or an object';
    reason ??= placementViolation(centre, app.store.settings.bounds);
    reason ??= p.blocked?.(app) ?? null;
    if (!reason) {
      if (app.store.settings.ground.enabled && box.min[1] < -0.02) warning = 'Sunk into the ground';
      else if (p.kind === 'shape') warning = this.overlapWarning(position, drop.rotation, s.box);
    }

    this.pose = {
      position,
      rotation: drop.rotation,
      contact: drop.point,
      normal: up,
      where: drop.where,
      reason,
      warning,
    };
    const view = s.view;
    view.setPose(position, drop.rotation);
    view.setContact(drop.point, up, Math.max(0, off));
    view.setVisible(s.mode === 'armed' || this.pointer.inView);
    view.setDim(centred);
    const tint: GhostTint = reason ? 'bad' : warning ? 'warn' : 'ok';
    view.setTint(tint);

    // the label above the ghost: name, size, position, and what is wrong with the spot
    const size = s.extent ? formatSize([0, 0, 0], s.extent) : '';
    const parts = [s.label, size, formatPoint(position)].filter(Boolean);
    let text = parts.join('  ·  ');
    if (reason) text += `  ·  ✕ ${reason}`;
    else if (warning) text += `  ·  ⚠ ${warning}`;
    if (this.labelTint !== tint) {
      app.labels.remove(LABEL_KEY);
      this.labelTint = tint;
    }
    app.labels.set(LABEL_KEY, this.labelAt.set(centre[0], box.max[1] + 0.12, centre[2]), text, `place-label ${tint}`);
    app.viewport.needsRender = true;
    this.emitHud(false);
  }

  private solids(): SolidBox[] {
    const { app } = this;
    const rev = app.store.revision;
    if (this.overlapCache?.revision === rev) return this.overlapCache.list;
    const list: SolidBox[] = [];
    for (const b of app.store.bodies()) {
      if (b.hidden || (b.bodyType !== 'static' && !b.locked)) continue;
      const h: Vec3 = [b.shape.size[0] / 2, b.shape.size[1] / 2, b.shape.size[2] / 2];
      list.push({ name: b.name, obb: { c: b.position, q: b.rotation, h }, r: Math.hypot(h[0], h[1], h[2]) });
      if (list.length >= 3000) break;
    }
    this.overlapCache = { revision: rev, list };
    return list;
  }

  /** "Overlaps X" when the ghost's box sinks into a static or locked body (allowed, but worth a warning). */
  private overlapWarning(position: Vec3, rotation: Quat, box: { min: Vec3; max: Vec3 }): string | null {
    const h: Vec3 = [(box.max[0] - box.min[0]) / 2, (box.max[1] - box.min[1]) / 2, (box.max[2] - box.min[2]) / 2];
    const mid: Vec3 = [(box.max[0] + box.min[0]) / 2, (box.max[1] + box.min[1]) / 2, (box.max[2] + box.min[2]) / 2];
    const cw = qrot(rotation, mid); // centre of the local box, turned into the world
    const ghost: Obb = { c: [position[0] + cw[0], position[1] + cw[1], position[2] + cw[2]], q: rotation, h };
    const reach = Math.hypot(h[0], h[1], h[2]);
    for (const s of this.solids()) {
      const dx = s.obb.c[0] - ghost.c[0];
      const dy = s.obb.c[1] - ghost.c[1];
      const dz = s.obb.c[2] - ghost.c[2];
      if (dx * dx + dy * dy + dz * dz > (reach + s.r) * (reach + s.r)) continue;
      if (obbPenetration(ghost, s.obb) > OVERLAP_TOLERANCE) return `Overlaps ${s.name}`;
    }
    return null;
  }

  private readonly tick = (): void => {
    const s = this.session;
    if (!s) return;
    const m = this.app.camera.matrixWorld.elements;
    let moved = this.dirty || this.app.sim.active;
    for (let i = 0; i < 16 && !moved; i++) if (Math.abs(m[i] - this.lastCam[i]) > 1e-6) moved = true;
    if (moved) {
      this.dirty = false;
      this.snapshotCamera();
      this.refresh();
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private snapshotCamera(): void {
    const m = this.app.camera.matrixWorld.elements;
    for (let i = 0; i < 16; i++) this.lastCam[i] = m[i];
  }

  private emitHud(force: boolean): void {
    const h = this.hud();
    const key = h ? JSON.stringify(h) : '';
    if (!force && key === this.hudKey) return;
    this.hudKey = key;
    this.emit('change', undefined);
  }

  // ── placing ──────────────────────────────────────────────────────────────────────────────────────

  /** Create the real thing at the current pose. Returns false (and says why) when the spot is refused. */
  private place(keep: boolean): boolean {
    const s = this.session;
    const pose = this.pose;
    if (!s || !pose) return false;
    const { app } = this;
    if (pose.reason) {
      app.toast(pose.reason, 'warn');
      return false;
    }
    try {
      s.placeable.commit(app, { position: pose.position, rotation: pose.rotation });
    } catch (err) {
      app.toast(err instanceof Error ? err.message : 'Could not place that', 'error');
      return false;
    }
    // where it landed: a ring that opens from the marker
    const box = s.box;
    const r = footprintRadius(box.min, box.max);
    app.effects.ping(new Vector3(pose.contact[0], pose.contact[1], pose.contact[2]), 0x3ddcff, Math.max(0.8, r * 2.2));
    if (keep) {
      s.multi = true;
      this.dirty = true;
      this.refresh();
      this.emitHud(true);
    } else this.end();
    return true;
  }

  // ── input ────────────────────────────────────────────────────────────────────────────────────────

  private onMove(e: PointerEvent): void {
    this.mods.alt = e.altKey;
    this.mods.ctrl = e.ctrlKey || e.metaKey;
    this.mods.shift = e.shiftKey;
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.known = true;
    const s = this.session;
    if (!s) return;
    if (s.mode === 'drag') {
      if (e.pointerId !== s.pointerId) return;
      // a second button pressed while dragging cancels (a pointer event with another button, not a pointerdown)
      if (e.pointerType === 'mouse' && (e.buttons & 2) !== 0) {
        this.cancel();
        return;
      }
    }
    this.pointer.inView = this.overViewport(e.clientX, e.clientY);
    this.refresh();
  }

  /** Is `t` part of the placement UI (a tile, the HUD), where a press must not end an armed placement? */
  private isPlacementUi(t: EventTarget | null): boolean {
    const el = t instanceof Element ? t : null;
    return !!el?.closest('[data-placeable], .place-hud');
  }

  private onDown(e: PointerEvent): void {
    const s = this.session;
    if (!s) return;
    this.track(e);
    if (s.mode === 'drag') {
      if (e.button === 2) this.cancel();
      return;
    }
    if (this.isPlacementUi(e.target)) return;
    const dom = this.app.viewport.dom;
    if (e.target !== dom) {
      this.cancel(); // pressed on a panel, a menu or the toolbox: the placement is over
      return;
    }
    if (e.pointerType === 'touch' && !e.isPrimary) {
      s.down = null; // a second finger belongs to the camera
      return;
    }
    if (e.button === 0) {
      if (e.altKey) {
        // Alt + drag orbits the camera; an Alt click without moving places with snapping off
        s.down = { id: e.pointerId, x: e.clientX, y: e.clientY, alt: true };
        return;
      }
      s.down = { id: e.pointerId, x: e.clientX, y: e.clientY, alt: false };
      e.preventDefault();
      e.stopImmediatePropagation();
      dom.focus({ preventScroll: true });
      this.refresh();
    } else if (e.button === 2) {
      s.right = { id: e.pointerId, x: e.clientX, y: e.clientY }; // the camera orbits; a click without moving cancels
    }
  }

  private onUp(e: PointerEvent): void {
    const s = this.session;
    if (!s) return;
    this.track(e);
    if (s.mode === 'drag') {
      if (e.pointerId !== s.pointerId || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if (!this.pointer.inView) {
        this.cancel(); // let go over a panel: nothing happens
        return;
      }
      this.refresh();
      this.place(e.shiftKey);
      return;
    }
    if (s.right && e.pointerId === s.right.id && e.button === 2) {
      const moved = Math.hypot(e.clientX - s.right.x, e.clientY - s.right.y) > 5;
      s.right = null;
      if (!moved) {
        e.stopImmediatePropagation(); // no context menu
        this.cancel();
      }
      return;
    }
    const d = s.down;
    if (d && e.pointerId === d.id && e.button === 0) {
      s.down = null;
      const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5;
      if (d.alt) {
        if (moved || !this.pointer.inView) return;
      } else e.stopImmediatePropagation();
      if (!this.pointer.inView) return;
      this.refresh();
      this.place(e.shiftKey);
    }
  }

  private onPointerCancel(e: PointerEvent): void {
    const s = this.session;
    if (!s) return;
    if (s.mode === 'drag' && e.pointerId === s.pointerId) this.cancel();
    else if (s.down && s.down.id === e.pointerId) s.down = null;
  }

  private onWheel(e: WheelEvent): void {
    const s = this.session;
    if (!s) return;
    // while dragging the wheel raises and lowers; when armed it keeps zooming the camera unless Shift is held
    if (s.mode === 'armed' && !e.shiftKey) return;
    const d = e.deltaY || e.deltaX;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    s.wheel += d;
    while (Math.abs(s.wheel) >= WHEEL_STEP) {
      const dir = s.wheel < 0 ? 1 : -1;
      s.wheel += dir * WHEEL_STEP;
      this.raise(dir, false);
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.session) return;
    this.setMods(e);
    if (this.handleKey(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (!this.session) return;
    this.setMods(e);
  }

  private setMods(e: KeyboardEvent): void {
    const m = this.mods;
    const before = `${m.alt}${m.ctrl}${m.shift}`;
    m.alt = e.altKey;
    m.ctrl = e.ctrlKey || e.metaKey;
    m.shift = e.shiftKey;
    if (before !== `${m.alt}${m.ctrl}${m.shift}`) this.refresh(); // Alt turns snapping off right away
  }

  private applyKey(e: KeyboardEvent, s: Session): boolean {
    // Esc ends the placement even from a text field (the search box that armed it); every other key is typing there
    if (e.code === 'Escape' && !e.ctrlKey && !e.metaKey) {
      this.cancel();
      return true;
    }
    if (isTyping(e.target)) return false;
    // modifier keys on their own, and every Ctrl / ⌘ chord (undo, copy …), are not ours
    if (e.key === 'Alt' || e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') return false;
    if (e.ctrlKey || e.metaKey) return false;
    switch (e.code) {
      case 'Escape':
        this.cancel();
        return true;
      case 'KeyQ':
        this.turn(-1, e.shiftKey, s);
        return true;
      case 'KeyE':
        this.turn(1, e.shiftKey, s);
        return true;
      case 'KeyR':
        this.turn(e.shiftKey ? -1 : 1, false, s);
        return true;
      case 'BracketLeft':
      case 'PageDown':
      case 'NumpadSubtract':
        this.raise(-1, e.shiftKey);
        return true;
      case 'BracketRight':
      case 'PageUp':
      case 'NumpadAdd':
        this.raise(1, e.shiftKey);
        return true;
      case 'KeyX':
        this.alignOverride = !this.align();
        this.dirty = true;
        this.refresh();
        this.emitHud(true);
        return true;
      case 'Enter':
      case 'NumpadEnter':
        if (!e.repeat) this.placeNow(e.shiftKey);
        return true;
      default:
        // plain letters belong to the tool shortcuts (W / E / R …), which must not fire behind a ghost
        return /^Key[A-Z]$/.test(e.code) && !e.altKey;
    }
  }

  private turn(dir: 1 | -1, fine: boolean, s: Session): void {
    if (!s.placeable.rotatable) {
      this.app.toast(`${s.label} cannot be turned`, 'info');
      return;
    }
    this.yawDeg = stepAngle(this.yawDeg, dir, fine);
    this.dirty = true;
    this.refresh();
    this.emitHud(true);
  }

  private raise(dir: 1 | -1, fine: boolean): void {
    const p = this.app.prefs.value;
    this.lift = stepLift(this.lift, dir, liftStep(p.snapGrid, p.snap, fine));
    this.dirty = true;
    this.refresh();
    this.emitHud(true);
  }
}

interface SolidBox {
  name: string;
  obb: Obb;
  /** Radius of the bounding sphere. */
  r: number;
}
