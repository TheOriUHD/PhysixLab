/**
 * The camera rig: owns the camera mode (orbit, fly, first person, third person, chase, top-down, orbit around a
 * point), the projection (perspective / orthographic and the front / side / top / iso presets), the lens, the shake,
 * and the transitions between all of them. `update(dt)` runs once per frame, after the simulation poses are in.
 *
 * Orbit-based modes leave the camera to OrbitControls. Driven modes set `viewport.externalCamera` so the viewport
 * stops running the controls and the tween, and write the pose themselves; the orbit target is kept one
 * metre-stick ahead of the camera so the shadow frustum, the view helper and the ground grid keep working.
 */
import { Box3, Euler, Quaternion, Raycaster, Vector3 } from 'three';
import { Emitter } from '../../core/events';
import type { Quat, Vec3 } from '../../core/math';
import type { CameraBookmark } from '../../model/types';
import type { App } from '../app';
import { inputMap } from '../input/inputMap';
import { cameraModes } from './modes';
import { ViewManager } from './views';
import { Minimap } from './minimap';
import { ShotPlayer, registerShotRecorder, shotRecorders, webmRecorder } from './shotPlayer';
import {
  chasePose,
  easeInOut,
  firstPersonPose,
  flyStep,
  lookBy,
  newFollow,
  newPose,
  thirdPersonPose,
  type FlyState,
  type FollowState,
  type Pose,
  type Subject,
} from './poses';
import { loadCameraSettings, reducedMotion, saveCameraSettings, type CameraSettings } from './settings';

export type ViewPreset = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

const PRESET_DIR: Record<ViewPreset, [number, number, number]> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  top: [0, 1, 0.0001],
  bottom: [0, -1, -0.0001],
  iso: [0.62, 0.55, 0.78],
};

/** The distance an orthographic camera sits from its target (nothing is clipped by it: the scene is all in front). */
const ORTHO_DISTANCE = 120;

export interface RigEvents extends Record<string, unknown> {
  change: undefined;
}

export class CameraRig extends Emitter<RigEvents> {
  mode = 'orbit';
  settings: CameraSettings = loadCameraSettings();
  /** Body the first / third person and chase cameras follow; null = the first selected body. */
  pinned: string | null = null;
  /** Orbit-around-a-point pivot. */
  pivot = new Vector3(0, 1, 0);
  /** Active view preset of an orthographic front / side / top view (null = free). */
  preset: ViewPreset | null = null;

  readonly fly: FlyState = { position: new Vector3(), yaw: 0, pitch: 0, velocity: new Vector3() };
  readonly follow: FollowState = newFollow();
  readonly look = { yaw: 0, pitch: 0 };

  private desired = newPose();
  private subjectCache: Subject = {
    position: new Vector3(),
    quaternion: new Quaternion(),
    velocity: new Vector3(),
    top: 0.5,
  };
  private subjectTop = new Map<string, { top: number; at: number }>();
  private blend = { t: 1, from: newPose() };
  private shakeAmp = 0;
  private shakePhase = [Math.random() * 100, Math.random() * 100, Math.random() * 100];
  private lastDriven = false;
  private ray = new Raycaster();
  private box = new Box3();
  private frame = 0;
  private looking = false;
  private lastPointer: [number, number] = [0, 0];
  private tmpV = new Vector3();
  private tmpQ = new Quaternion();
  private tmpE = new Euler();
  /** -- shots: preview, scrub, loop, record -- */
  readonly player: ShotPlayer;
  /** -- split screen and picture-in-picture -- */
  readonly views: ViewManager;
  /** -- the minimap overlay -- */
  readonly minimap: Minimap;
  /** An externally supplied pose (cinematic playback, bookmarks played back) overrides the mode while set. */
  override: ((dt: number, out: Pose) => boolean) | null = null;
  // ── NAV: drive / play mode hooks ──
  /** Which drag looks around in a driven mode: the secondary button only, or the primary button and touch too. */
  dragLook: 'secondary' | 'any' = 'secondary';
  /** After a look-around drag the view eases back behind the subject (the immersive modes do it each frame). */
  lookReturn = false;
  /** Look behind whatever is held (drive mode's own key). */
  lookBack = false;
  /** Is a look-around drag in progress? */
  get isLooking(): boolean {
    return this.looking;
  }
  // ── /NAV ──

  constructor(readonly app: App) {
    super();
    this.player = new ShotPlayer(app, this);
    this.views = new ViewManager(app, this);
    this.minimap = new Minimap(app);
    if (!shotRecorders.has('webm')) registerShotRecorder(webmRecorder);
    const dom = app.viewport.dom;
    dom.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    dom.addEventListener('pointermove', (e) => this.onPointerMove(e));
    const end = (e: PointerEvent) => {
      if (this.looking) {
        this.looking = false;
        if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
      }
    };
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);
    dom.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.applyLens();
    // Impacts and blasts shake the view a little (scaled by distance and the user's shake setting).
    app.contacts.acquire('camera-shake', { minImpulse: 40, pairInterval: 0.15, maxPerFrame: 8 }, (ev) => {
      const d = this.app.camera.position.distanceTo(this.tmpV.set(ev.point[0], ev.point[1], ev.point[2]));
      this.shake(Math.min(1, ev.impulse / 900) * Math.max(0, 1 - d / 35) * 0.6);
    });
  }

  // ---- settings ------------------------------------------------------------------------------

  update_settings(patch: Partial<CameraSettings>): void {
    this.settings = { ...this.settings, ...patch };
    saveCameraSettings(this.settings);
    if ('fov' in patch) this.applyLens();
    this.emit('change', undefined);
  }

  get motionReduced(): boolean {
    return reducedMotion(this.settings);
  }

  private applyLens(): void {
    const cam = this.app.camera;
    if (cam.fov !== this.settings.fov) {
      cam.fov = this.settings.fov;
      cam.updateProjectionMatrix();
      this.app.viewport.needsRender = true;
    }
  }

  setFov(v: number): void {
    this.update_settings({ fov: Math.max(10, Math.min(110, v)) });
  }

  // ---- subject -------------------------------------------------------------------------------

  /** The body body-following cameras use: the pinned one if it still exists, else the first selected body. */
  subjectId(): string | null {
    const { store } = this.app;
    if (this.pinned && store.body(this.pinned)) return this.pinned;
    return store.selection.find((id) => !!store.body(id)) ?? null;
  }

  pin(id: string | null): void {
    this.pinned = id;
    this.follow.initialised = false;
    this.emit('change', undefined);
  }

  private readSubject(id: string): Subject | null {
    const pose = this.app.sim.poseOf(id);
    if (!pose) return null;
    const s = this.subjectCache;
    s.position.set(pose.position[0], pose.position[1], pose.position[2]);
    s.quaternion.set(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]);
    const v = this.app.sim.velocityOf(id);
    if (v) s.velocity.set(v.linear[0], v.linear[1], v.linear[2]);
    else s.velocity.set(0, 0, 0);
    const cached = this.subjectTop.get(id);
    if (!cached || this.frame - cached.at > 120) {
      const view = this.app.bodies.get(id);
      let top = 0.5;
      if (view) {
        this.box.setFromObject(view.mesh);
        if (!this.box.isEmpty()) top = Math.max(0.15, (this.box.max.y - this.box.min.y) / 2);
      }
      this.subjectTop.set(id, { top, at: this.frame });
    }
    s.top = this.subjectTop.get(id)?.top ?? 0.5;
    return s;
  }

  /** The state of any body (for the split-screen and picture-in-picture cameras); valid until the next call. */
  subjectState(id: string): Subject | null {
    return this.readSubject(id);
  }

  /** Subject of a driven mode for this frame, or null when there is none. */
  currentSubject(): Subject | null {
    const id = this.subjectId();
    return id ? this.readSubject(id) : null;
  }

  // ---- modes ---------------------------------------------------------------------------------

  /** Switch camera mode; returns false (with a toast) when the mode needs a body and there is none. */
  setMode(id: string): boolean {
    const def = cameraModes.get(id);
    if (!def) return false;
    if (id === this.mode) return true;
    if (def.needsSubject && !this.subjectId()) {
      this.app.toast(`${def.label} camera: select a body first (or pin one in the Camera panel)`, 'warn');
      return false;
    }
    const cam = this.app.camera;
    const prev = cameraModes.get(this.mode);
    // Remember where the camera is so a driven mode can glide from here.
    this.blend.from.position.copy(cam.position);
    this.blend.from.quaternion.copy(cam.quaternion);
    this.blend.from.fov = cam.fov;
    this.blend.t = this.motionReduced || this.settings.transition <= 0 ? 1 : 0;
    prev?.exit?.(this, id);
    const from = this.mode;
    this.mode = id;
    this.preset = null;
    this.app.viewport.setViewPlane(null);
    this.follow.initialised = false;
    this.look.yaw = this.look.pitch = 0;
    this.follow.yawOffset = 0;
    this.syncControls();
    def.enter?.(this, from);
    this.emit('change', undefined);
    return true;
  }

  cycleMode(dir: 1 | -1 = 1): void {
    const list = cameraModes.list();
    const i = list.findIndex((m) => m.id === this.mode);
    for (let k = 1; k <= list.length; k++) {
      const m = list[(i + dir * k + list.length * 2) % list.length];
      if (this.setMode(m.id)) return;
    }
  }

  /** Whether the viewport's orbit controls are in charge. */
  get driven(): boolean {
    return !!cameraModes.get(this.mode)?.driven;
  }

  syncControls(): void {
    const vp = this.app.viewport;
    const c = vp.controls;
    const driven = this.driven || !!this.override;
    vp.externalCamera = driven;
    if (driven) vp.cancelTween();
    c.enabled = !driven;
    if (!driven) {
      c.enableRotate = true;
      c.enablePan = true;
      c.minPolarAngle = 0;
      c.maxPolarAngle = this.app.camera.ortho ? Math.PI : Math.PI * 0.499;
    }
  }

  /** Make the orbit target sit `dist` metres in front of the camera (orbit modes take over from a driven pose). */
  retarget(dist = 10): void {
    const cam = this.app.camera;
    const f = this.tmpV.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this.app.viewport.controls.target.copy(cam.position).addScaledVector(f, dist);
  }

  // ---- frame ---------------------------------------------------------------------------------

  update(dt: number): void {
    this.frame++;
    const vp = this.app.viewport;
    const cam = this.app.camera;
    const def = cameraModes.get(this.mode);
    let drove = false;

    if (this.override) {
      if (this.override(dt, this.desired)) {
        this.apply(this.desired, 1);
        vp.externalCamera = true;
        drove = true;
      } else this.override = null;
    }
    if (!drove && def?.driven) {
      vp.externalCamera = true;
      const pose = this.desired;
      if (def.pose?.(this, dt, pose)) {
        if (this.blend.t < 1) {
          this.blend.t = Math.min(1, this.blend.t + dt / Math.max(0.05, this.settings.transition));
        }
        this.apply(pose, easeInOut(this.blend.t));
        drove = true;
      } else {
        this.app.toast('The camera subject is gone — back to the orbit camera', 'warn');
        this.setMode('orbit');
      }
    }
    if (this.lastDriven && !drove) {
      this.syncControls();
      this.retarget();
    }
    this.lastDriven = drove;
    if (drove) vp.cancelTween();
    else vp.externalCamera = false;

    this.autoNearFar();
    this.applyShake(dt);
    cam.updateMatrixWorld();
    this.views.update(dt);
    this.minimap.update();
  }

  /** Write a pose to the camera, blended from where the camera was when the mode started (`k` 0…1). */
  private apply(pose: Pose, k: number): void {
    const cam = this.app.camera;
    const from = this.blend.from;
    if (k < 1) {
      cam.position.lerpVectors(from.position, pose.position, k);
      cam.quaternion.slerpQuaternions(from.quaternion, pose.quaternion, k);
    } else {
      cam.position.copy(pose.position);
      cam.quaternion.copy(pose.quaternion);
    }
    const fov = k < 1 ? from.fov + (pose.fov - from.fov) * k : pose.fov;
    if (Math.abs(cam.fov - fov) > 1e-3) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    this.retarget();
  }

  private autoNearFar(): void {
    const cam = this.app.camera;
    if (cam.ortho) return;
    const want = this.settings.autoNearFar
      ? Math.min(1.2, Math.max(0.05, cam.position.distanceTo(this.app.viewport.controls.target) * 0.012))
      : 0.05;
    if (Math.abs(cam.near - want) / want > 0.15) {
      cam.near = want;
      cam.updateProjectionMatrix();
    }
  }

  // ---- shake ---------------------------------------------------------------------------------

  /** Add camera shake (0…1). Ignored when motion is reduced or the shake setting is 0. */
  shake(amount: number): void {
    if (this.motionReduced || this.settings.shake <= 0) return;
    this.shakeAmp = Math.min(1.5, this.shakeAmp + amount * this.settings.shake);
  }

  /** Shake for an event at a world point: strongest within its `radius`, fading out to four times that. */
  shakeAt(at: Vector3, strength: number, radius: number): void {
    const d = this.app.camera.position.distanceTo(at);
    const fall = Math.max(0, 1 - Math.max(0, d - radius) / (radius * 3));
    this.shake(Math.min(1, strength / 120) * fall);
  }

  private applyShake(dt: number): void {
    if (this.shakeAmp < 0.002) {
      this.shakeAmp = 0;
      return;
    }
    const cam = this.app.camera;
    const t = performance.now() / 1000;
    const a = this.shakeAmp;
    const n = (i: number, f: number) =>
      Math.sin(t * f + this.shakePhase[i]) + 0.5 * Math.sin(t * f * 2.3 + this.shakePhase[i] * 1.7);
    // Rotation only: the orbit controls re-aim the camera each frame, so it never accumulates.
    this.tmpE.set(n(0, 41) * 0.012 * a, n(1, 37) * 0.012 * a, n(2, 29) * 0.01 * a, 'YXZ');
    cam.quaternion.multiply(this.tmpQ.setFromEuler(this.tmpE));
    if (this.driven) cam.position.addScaledVector(this.tmpV.set(n(0, 33), n(1, 47), n(2, 39)), 0.03 * a);
    this.shakeAmp *= Math.exp(-dt * 5);
    this.app.viewport.needsRender = true;
  }

  // ---- input ---------------------------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    if (!this.driven) return;
    // -- NAV: in drive mode the primary button / a finger looks around too (picking is off there) --
    const primary = this.dragLook === 'any' && e.isPrimary && (e.button === 0 || e.pointerType === 'touch');
    if (e.button !== 2 && !primary) return;
    this.looking = true;
    this.lastPointer = [e.clientX, e.clientY];
    this.app.viewport.dom.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.looking) return;
    const dx = e.clientX - this.lastPointer[0];
    const dy = e.clientY - this.lastPointer[1];
    this.lastPointer = [e.clientX, e.clientY];
    if (this.mode === 'fly') lookBy(this.fly, dx, dy);
    else if (this.mode === 'fp') lookBy(this.look, dx, dy);
    else {
      this.follow.yawOffset -= dx * 0.0045;
      this.follow.pitch = Math.max(-0.2, Math.min(1.3, this.follow.pitch + dy * 0.003));
    }
  }

  private onWheel(e: WheelEvent): void {
    if (!this.driven) return;
    e.preventDefault();
    const k = Math.exp(-e.deltaY * 0.0015);
    if (this.mode === 'fly')
      this.update_settings({ flySpeed: Math.max(0.5, Math.min(200, this.settings.flySpeed * k)) });
    else if (this.mode === 'tp')
      this.update_settings({ tpDistance: Math.max(1, Math.min(60, this.settings.tpDistance / k)) });
    else if (this.mode === 'chase')
      this.update_settings({ chaseDistance: Math.max(1, Math.min(80, this.settings.chaseDistance / k)) });
  }

  /** Does the running camera mode own this key (so commands and the simulation must not see it)? */
  swallows(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (this.mode === 'fly') return inputMap.ownsKey(e, 'fly');
    if (this.mode === 'chase') return inputMap.ownsKey(e, 'chase');
    return false;
  }

  // ---- projection and view presets -----------------------------------------------------------

  get ortho(): boolean {
    return this.app.camera.ortho;
  }

  /** Switch projection keeping what is on screen the same size at the orbit target. */
  setOrtho(on: boolean): void {
    const vp = this.app.viewport;
    const cam = this.app.camera;
    if (cam.ortho === on) return;
    if (this.driven) this.setMode('orbit');
    const c = vp.controls;
    const dir = this.tmpV.copy(cam.position).sub(c.target);
    const dist = Math.max(0.4, dir.length());
    dir.normalize();
    if (on) {
      const size = 2 * dist * Math.tan((cam.fov * Math.PI) / 360);
      vp.setProjection(true, size);
      cam.position.copy(c.target).addScaledVector(dir, Math.max(ORTHO_DISTANCE, dist));
      c.maxDistance = ORTHO_DISTANCE * 4;
      c.minDistance = 1;
    } else {
      const d = cam.orthoSize / Math.max(1e-6, cam.zoom) / 2 / Math.tan((cam.fov * Math.PI) / 360);
      vp.setProjection(false);
      cam.position.copy(c.target).addScaledVector(dir, Math.min(400, Math.max(0.6, d)));
      c.maxDistance = 400;
      c.minDistance = 0.4;
      this.preset = null;
      vp.setViewPlane(null);
    }
    this.syncControls();
    c.update();
    this.emit('change', undefined);
  }

  /** Look at the orbit target from a standard direction in an orthographic view (switches to orthographic). */
  viewPreset(p: ViewPreset): void {
    if (this.driven) this.setMode('orbit');
    const vp = this.app.viewport;
    const cam = this.app.camera;
    const c = vp.controls;
    const target = c.target.clone();
    if (!cam.ortho) {
      const dist = Math.max(0.4, cam.position.distanceTo(target));
      this.setOrtho(true);
      void dist;
    }
    this.preset = p;
    const d = PRESET_DIR[p];
    const dir = new Vector3(d[0], d[1], d[2]).normalize();
    const pos = target.clone().addScaledVector(dir, ORTHO_DISTANCE);
    this.syncControls();
    this.glide(pos, target);
    vp.setViewPlane(p === 'front' || p === 'back' ? 'xy' : p === 'left' || p === 'right' ? 'zy' : null);
    this.emit('change', undefined);
  }

  setOrthoSize(size: number): void {
    const cam = this.app.camera;
    if (!cam.ortho) return;
    cam.zoom = 1;
    cam.orthoSize = Math.max(0.2, Math.min(4000, size));
    cam.updateProjectionMatrix();
    this.app.viewport.needsRender = true;
    this.emit('change', undefined);
  }

  /** Move the camera (instantly when motion is reduced). */
  glide(pos: Vector3, target: Vector3, dur = 0.45): void {
    const vp = this.app.viewport;
    if (this.motionReduced || this.settings.transition <= 0)
      vp.setView({ position: [pos.x, pos.y, pos.z], target: [target.x, target.y, target.z] });
    else vp.flyTo(pos, target, dur);
  }

  /** Orbit-point camera: move the centre to `p`, keeping the camera where it is. */
  setPivot(p: Vector3): void {
    this.pivot.copy(p);
    this.glide(this.app.camera.position.clone(), p.clone());
    this.app.effects.ping(p, 0x5ec8ff);
  }

  // ---- bookmarks -----------------------------------------------------------------------------

  /** The current view as a bookmark (without thumbnail). */
  currentView(): Omit<CameraBookmark, 'id' | 'name' | 'thumb'> {
    const vp = this.app.viewport;
    const v = vp.getView();
    const cam = this.app.camera;
    return {
      position: v.position,
      target: v.target,
      fov: this.settings.fov,
      ortho: cam.ortho,
      orthoSize: cam.orthoSize / Math.max(1e-6, cam.zoom),
    };
  }

  recall(b: Pick<CameraBookmark, 'position' | 'target' | 'fov' | 'ortho' | 'orthoSize'>): void {
    if (this.driven) this.setMode('orbit');
    if (b.fov !== this.settings.fov) this.setFov(b.fov);
    if (b.ortho !== this.app.camera.ortho) this.setOrtho(b.ortho);
    if (b.ortho) this.setOrthoSize(b.orthoSize);
    this.preset = null;
    this.app.viewport.setViewPlane(null);
    this.glide(new Vector3(...b.position), new Vector3(...b.target));
  }

  // ---- helpers for modes ---------------------------------------------------------------------

  /** Clear distance from `from` along `dir` before a body other than the subject is hit (spring-arm probe). */
  probe = (from: Vector3, dir: Vector3, max: number): number => {
    const id = this.subjectId();
    this.ray.set(from, dir);
    this.ray.near = 0;
    this.ray.far = max;
    const hits = this.ray.intersectObjects(this.app.bodies.pickables(), false);
    for (const h of hits) {
      const ids = h.instanceId !== undefined ? (h.object.userData.instanceIds as string[] | undefined) : undefined;
      const hitId = ids ? ids[h.instanceId!] : (h.object.userData.entityId as string | undefined);
      if (hitId && hitId === id) continue;
      return h.distance;
    }
    return max;
  };

  /** For tests and the UI: orientation as Euler-ish yaw / pitch of the camera. */
  get cameraQuat(): Quat {
    const q = this.app.camera.quaternion;
    return [q.x, q.y, q.z, q.w];
  }

  flyPosition(): Vec3 {
    const p = this.app.camera.position;
    return [p.x, p.y, p.z];
  }

  /** Helpers used by the built-in modes. */
  stepFly(dt: number, out: Pose): boolean {
    const hub = this.app.input;
    const held = (id: string) => (hub.held(id) ? 1 : 0);
    const pad = hub.pad.connected && !this.app.sim.active ? hub.combined : null;
    flyStep(
      this.fly,
      {
        forward: held('camera.fly.forward') - held('camera.fly.back') + (pad ? pad.LY : 0),
        right: held('camera.fly.right') - held('camera.fly.left') + (pad ? pad.LX : 0),
        up: held('camera.fly.up') - held('camera.fly.down') + (pad ? pad.RT - pad.LT : 0),
        boost: hub.held('camera.fly.boost') || !!pad?.buttons.LS,
      },
      this.settings.flySpeed,
      dt,
    );
    if (pad) lookBy(this.fly, pad.RX * 420 * dt, -pad.RY * 420 * dt, 0.0035);
    out.position.copy(this.fly.position);
    // lookBy keeps yaw as a heading; the pose quaternion is rebuilt from it
    this.tmpE.set(this.fly.pitch, this.fly.yaw + Math.PI, 0, 'YXZ');
    out.quaternion.setFromEuler(this.tmpE);
    out.fov = this.settings.fov;
    return true;
  }

  stepFirstPerson(out: Pose): boolean {
    const s = this.currentSubject();
    if (!s) return false;
    firstPersonPose(s, this.settings.forwardAxis, this.look, this.settings.fov, out);
    return true;
  }

  stepThirdPerson(dt: number, out: Pose): boolean {
    const s = this.currentSubject();
    if (!s) return false;
    thirdPersonPose(
      this.follow,
      s,
      this.settings.forwardAxis,
      { distance: this.settings.tpDistance, height: this.settings.tpHeight },
      this.probe,
      this.settings.fov,
      dt,
      out,
    );
    return true;
  }

  stepChase(dt: number, out: Pose): boolean {
    const s = this.currentSubject();
    if (!s) return false;
    chasePose(
      this.follow,
      s,
      this.settings.forwardAxis,
      { distance: this.settings.chaseDistance, height: this.settings.chaseHeight },
      this.app.input.held('camera.chase.lookBehind') || this.lookBack,
      this.settings.fov,
      dt,
      out,
    );
    return true;
  }
}
