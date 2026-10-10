/**
 * Immersive modes (`app.immersive`): Drive and Play.
 *
 * Both put the user *in* the scene instead of in front of an editor: the panels, toolbars, gizmos and outlines go,
 * picking and editor shortcuts are locked, and the input context becomes `drive` / `play` so every key has one
 * clear meaning. Esc or Tab leaves and restores the camera, the selection, the panels and the simulation state.
 *
 *   Drive   the selected vehicle's assembly (or the only / nearest vehicle) with a velocity-aware chase camera
 *           (C cycles chase / cockpit / orbit), look-behind, drag to look around, R to reset or flip upright, P to
 *           pause, a speedometer (and gear / rpm when the powertrain publishes them).
 *   Play    a free camera plus grabbing: fly around the running scene and throw things about.
 */
import { Quaternion, Vector3 } from 'three';
import { Emitter } from '../../core/events';
import type { App } from '../app';
import { assignDriveKeys, type DriveAction } from '../input/contexts';
import { findVehicle, type VehicleAdapter } from './vehicle';

export type ImmersiveKind = 'none' | 'drive' | 'play';
export type DriveCamera = 'chase' | 'cockpit' | 'orbit';

const CAMERA_MODE: Record<DriveCamera, string> = { chase: 'chase', cockpit: 'fp', orbit: 'tp' };
const CAMERA_ORDER: DriveCamera[] = ['chase', 'cockpit', 'orbit'];
export const DRIVE_CAMERA_LABEL: Record<DriveCamera, string> = { chase: 'Chase', cockpit: 'Cockpit', orbit: 'Orbit' };

export interface DriveHud {
  name: string;
  /** Speed in km/h. */
  speed: number;
  /** Engine speed (rpm) when a component publishes it. */
  rpm: number | null;
  /** Gear (-1 reverse, 0 neutral) when a gearbox publishes it. */
  gear: number | null;
  paused: boolean;
  tilted: boolean;
  camera: DriveCamera;
}

interface Saved {
  selection: string[];
  simMode: 'edit' | 'paused' | 'running';
  cameraMode: string;
  pinned: string | null;
  ortho: boolean;
  view: { position: [number, number, number]; target: [number, number, number] };
  tool: string;
  joints: boolean;
  viewHelper: boolean;
}

const HIDDEN = 'imm-hidden';

const _q = new Quaternion();
const _q2 = new Quaternion();
const _v = new Vector3();
const _up = new Vector3(0, 1, 0);

export class ImmersiveMode extends Emitter<{ change: undefined }> {
  kind: ImmersiveKind = 'none';
  vehicle: VehicleAdapter | null = null;
  driveCamera: DriveCamera = 'chase';
  /** The key assignment of the drive utility actions (avoids the vehicle's own keys). */
  driveKeys: ReadonlyMap<string, DriveAction> = new Map();
  readonly hud: DriveHud = { name: '', speed: 0, rpm: null, gear: null, paused: false, tilted: false, camera: 'chase' };
  private saved: Saved | null = null;
  private hidden: Element[] = [];
  private lookBackHeld = false;
  private engineId: string | null = null;
  private gearboxId: string | null = null;

  constructor(private app: App) {
    super();
    app.on('frame', ({ dt }) => this.update(dt));
  }

  get active(): boolean {
    return this.kind !== 'none';
  }

  // ---- entering and leaving --------------------------------------------------------------------

  /** Drive the selected vehicle (or the only / nearest one). Returns false, with a toast, when there is none. */
  enterDrive(): boolean {
    const app = this.app;
    if (this.active) return false;
    const choice = findVehicle({
      entities: app.store.all(),
      selection: app.store.selection,
      near: [app.viewport.controls.target.x, app.viewport.controls.target.y, app.viewport.controls.target.z],
    });
    if (!choice.vehicle) {
      app.toast(choice.reason ?? 'No vehicle to drive', 'warn');
      return false;
    }
    const v = choice.vehicle;
    this.begin();
    this.vehicle = v;
    this.kind = 'drive';
    this.driveKeys = assignDriveKeys(new Set(v.controls.map((c) => c.code)));
    this.findComponents(v);
    const rig = app.cameraRig;
    rig.pin(v.chassisId);
    this.driveCamera = 'chase';
    rig.setMode('chase');
    rig.dragLook = 'any';
    rig.lookReturn = true;
    this.lockUi();
    app.setHint(null);
    app.toast(`Driving ${v.name}`, 'success');
    this.emit('change', undefined);
    return true;
  }

  /** Play mode: a free camera plus grabbing, no vehicle. */
  enterPlay(): boolean {
    const app = this.app;
    if (this.active) return false;
    this.begin();
    this.kind = 'play';
    this.vehicle = null;
    const rig = app.cameraRig;
    rig.setMode('fly');
    rig.dragLook = 'secondary'; // the primary button grabs
    rig.lookReturn = false;
    app.setTool('select');
    this.lockUi();
    app.setHint(null);
    this.emit('change', undefined);
    return true;
  }

  /** Common start: remember what to restore, start the simulation, clear the selection. */
  private begin(): void {
    const app = this.app;
    const vp = app.viewport;
    this.saved = {
      selection: [...app.store.selection],
      simMode: app.sim.mode,
      cameraMode: app.cameraRig.mode,
      pinned: app.cameraRig.pinned,
      ortho: app.camera.ortho,
      view: vp.getView(),
      tool: app.prefs.value.tool,
      joints: app.joints.visible,
      viewHelper: vp.viewHelperVisible,
    };
    if (app.camera.ortho) app.cameraRig.setOrtho(false);
    if (app.sim.mode !== 'running') app.sim.play();
    app.cancelJointDraft();
    app.clearMeasure();
    app.store.setSelection([]);
    app.hoverId = null;
    app.input.clearKeys();
  }

  private lockUi(): void {
    const app = this.app;
    this.hideChrome();
    document.body.classList.add('immersive', `immersive-${this.kind}`);
    app.joints.visible = false;
    app.viewport.viewHelperVisible = false;
    app.viewport.needsRender = true;
    app.contexts.invalidate();
  }

  exit(): void {
    if (!this.active) return;
    const app = this.app;
    const s = this.saved;
    this.kind = 'none';
    this.vehicle = null;
    this.lookBackHeld = false;
    this.saved = null;
    document.body.classList.remove('immersive', 'immersive-drive', 'immersive-play');
    for (const el of this.hidden) el.classList.remove(HIDDEN);
    this.hidden = [];
    const rig = app.cameraRig;
    rig.dragLook = 'secondary';
    rig.lookReturn = false;
    rig.lookBack = false;
    if (s) {
      app.joints.visible = s.joints;
      app.viewport.viewHelperVisible = s.viewHelper;
      rig.pin(s.pinned);
      rig.setMode(s.cameraMode);
      if (s.ortho) rig.setOrtho(true);
      else rig.glide(new Vector3(...s.view.position), new Vector3(...s.view.target));
      app.setTool(s.tool);
      app.store.setSelection(s.selection.filter((id) => !!app.store.get(id)));
      if (s.simMode === 'edit') app.sim.reset();
      else if (s.simMode === 'paused') app.sim.pause();
    }
    app.updateToolHint();
    app.viewport.needsRender = true;
    app.contexts.invalidate();
    this.emit('change', undefined);
  }

  toggleDrive(): void {
    if (this.kind === 'drive') this.exit();
    else if (!this.active) this.enterDrive();
  }

  togglePlay(): void {
    if (this.kind === 'play') this.exit();
    else if (!this.active) this.enterPlay();
  }

  /**
   * Hide everything that is not the viewport, its ancestors or something marked `data-immersive` (the HUD, the
   * legend, the touch controls) — done generically so panels added by other packages go too.
   */
  private hideChrome(): void {
    const keep = new Set<Element>();
    for (let n: Element | null = this.app.viewport.container; n; n = n.parentElement) keep.add(n);
    const host = this.app.viewport.container;
    const hideChildren = (parent: Element) => {
      for (const child of Array.from(parent.children)) {
        if (keep.has(child)) {
          if (child !== host) hideChildren(child);
          continue;
        }
        if (
          child.hasAttribute('data-immersive') ||
          child.hasAttribute('data-qol') ||
          child.classList.contains('toasts') ||
          child.tagName === 'SCRIPT' ||
          child.tagName === 'STYLE' ||
          child.classList.contains(HIDDEN)
        )
          continue;
        child.classList.add(HIDDEN);
        this.hidden.push(child);
      }
    };
    hideChildren(document.body);
  }

  // ---- the vehicle -----------------------------------------------------------------------------

  private findComponents(v: VehicleAdapter): void {
    this.engineId = this.gearboxId = null;
    for (const id of v.componentOwners) {
      const e = this.app.store.get(id);
      const comps = e && (e.kind === 'body' || e.kind === 'joint') ? e.components : [];
      for (const c of comps) {
        if (!c.enabled) continue;
        if (c.type === 'engine' && !this.engineId) this.engineId = c.id;
        if (c.type === 'gearbox' && !this.gearboxId) this.gearboxId = c.id;
      }
    }
  }

  /** Is the chassis tilted past the point where a flip is the better reset? */
  private tilted(): boolean {
    const v = this.vehicle;
    const pose = v && this.app.sim.poseOf(v.chassisId);
    if (!pose) return false;
    _q.set(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]);
    return _v.copy(_up).applyQuaternion(_q).y < 0.5;
  }

  /**
   * Reset: a tilted vehicle is flipped upright where it stands (yaw kept, lifted a little); an upright one goes back
   * to its start pose. Every body of the assembly is moved together so the joints never stretch.
   */
  resetVehicle(): void {
    const v = this.vehicle;
    const app = this.app;
    if (!v) return;
    const chassis = app.sim.poseOf(v.chassisId);
    if (!chassis) return;
    if (this.tilted()) {
      _q.set(chassis.rotation[0], chassis.rotation[1], chassis.rotation[2], chassis.rotation[3]);
      // The rotation that brings the chassis' up axis back to the world's, keeping the heading as far as possible.
      _q2.setFromUnitVectors(_v.copy(_up).applyQuaternion(_q), _up);
      const pivot = new Vector3(chassis.position[0], chassis.position[1], chassis.position[2]);
      for (const id of v.bodyIds) {
        const p = app.sim.poseOf(id);
        if (!p) continue;
        const pos = new Vector3(p.position[0], p.position[1], p.position[2]).sub(pivot).applyQuaternion(_q2).add(pivot);
        pos.y += 0.5;
        const rot = new Quaternion(p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3]).premultiply(_q2);
        app.sim.teleport(id, [pos.x, pos.y, pos.z], [rot.x, rot.y, rot.z, rot.w]);
      }
      app.toast('Flipped upright — press again to go back to the start', 'info');
      return;
    }
    for (const id of v.bodyIds) {
      const start = v.startPose(id);
      if (start) app.sim.teleport(id, start.position, start.rotation);
    }
    app.cameraRig.follow.initialised = false;
    app.toast('Back at the start', 'info');
  }

  // ---- cameras ---------------------------------------------------------------------------------

  setDriveCamera(c: DriveCamera): void {
    if (this.kind !== 'drive') return;
    const rig = this.app.cameraRig;
    this.driveCamera = c;
    rig.setMode(CAMERA_MODE[c]);
    rig.lookReturn = c !== 'orbit';
    this.hud.camera = c;
  }

  cycleCamera(): void {
    const i = CAMERA_ORDER.indexOf(this.driveCamera);
    const next = CAMERA_ORDER[(i + 1) % CAMERA_ORDER.length];
    this.setDriveCamera(next);
    this.app.toast(`Camera: ${DRIVE_CAMERA_LABEL[next]}`, 'info');
  }

  // ---- keys ------------------------------------------------------------------------------------

  /** A key the immersive context owns. Returns true when it was used. */
  handleKey(e: KeyboardEvent, down: boolean): boolean {
    if (this.kind === 'play') {
      if (down && (e.code === 'Escape' || e.code === 'Tab')) {
        this.exit();
        return true;
      }
      return false;
    }
    const act = this.driveKeys.get(e.code);
    if (!act) return false;
    if (act === 'lookBehind') {
      this.lookBackHeld = down;
      this.app.cameraRig.lookBack = down;
      return true;
    }
    if (!down || e.repeat) return true;
    switch (act) {
      case 'exit':
        this.exit();
        break;
      case 'reset':
        this.resetVehicle();
        break;
      case 'pause':
        this.app.sim.toggle();
        break;
      case 'camera':
        this.cycleCamera();
        break;
    }
    return true;
  }

  // ---- per frame -------------------------------------------------------------------------------

  private update(dt: number): void {
    if (this.kind === 'none') return;
    const app = this.app;
    // The simulation ended under us (reset button on a pad, a scene load): there is nothing left to drive.
    if (!app.sim.active) {
      this.exit();
      return;
    }
    const rig = app.cameraRig;
    // A drag looks around; when let go the view eases back behind the vehicle.
    if (rig.lookReturn && !rig.isLooking) {
      const k = 1 - Math.exp(-dt * 3.5);
      rig.follow.yawOffset -= rig.follow.yawOffset * k;
      if (this.driveCamera === 'cockpit') {
        const targetYaw = this.lookBackHeld ? Math.PI : 0;
        rig.look.yaw += (targetYaw - rig.look.yaw) * k * 2;
        rig.look.pitch -= rig.look.pitch * k;
      }
    }
    const v = this.vehicle;
    if (!v) return;
    const h = this.hud;
    h.name = v.name;
    h.camera = this.driveCamera;
    h.paused = app.sim.mode === 'paused';
    if (!app.store.body(v.chassisId)) {
      app.toast('The vehicle was removed', 'warn');
      this.exit();
      return;
    }
    const vel = app.sim.velocityOf(v.chassisId);
    h.speed = vel ? Math.hypot(vel.linear[0], vel.linear[1], vel.linear[2]) * 3.6 : 0;
    h.tilted = this.tilted();
    const client = app.sim.client;
    const eng = this.engineId ? client.stateOf(this.engineId) : null;
    h.rpm = eng ? eng[0] : null;
    const gear = this.gearboxId ? client.stateOf(this.gearboxId) : null;
    h.gear = gear ? Math.round(gear[0]) : null;
  }
}
