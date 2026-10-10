/**
 * App — wires the document store, the simulation controller, the renderer and the editor
 * commands together. UI panels talk to this class; this class never builds panel DOM.
 *
 * `App` is the façade (`window.physixlab`): it owns the long-lived objects and the event wiring and
 * forwards the high-level commands to small collaborators, each in its own module:
 *
 *   prefsSync       preferences → renderer / simulation / gizmo, tool hints
 *   viewSync        document → views, selection outline, ephemeral views, layout reconcile
 *   gizmoController transform gizmo: items, undo grouping, joint anchor / axis editing
 *   measureTool     measure + joint-draft annotations
 *   placement       picking and "where does a new object go"
 *   cameraControl   frame selection / all, follow the selected body
 *   commands        add shape / soft body / prefab, load scene / template, new scene
 *   projectiles     shoot, blast, soft-particle lookup
 *   frameLoop       the per-frame update
 */
import { Color, Vector3 } from 'three';
import { Emitter } from '../core/events';
import type { Quat, Vec3 } from '../core/math';
import type {
  BodyEntity,
  Entity,
  JointEntity,
  JointType,
  LightType,
  SceneDocument,
  ShapeType,
  SoftType,
} from '../model/types';
import { isBody } from '../model/types';
import { componentDef } from '../model/componentRegistry';
import { SceneStore } from '../model/store';
import { BodyViews } from '../render/bodyViews';
import { SoftViews } from '../render/softViews';
import { Effects } from '../render/effects';
import { ComponentFx } from '../render/componentFx'; // -- CP: flames, blades and gauges of the powered parts
import type { Gizmo } from '../render/gizmo';
import { GroupViews } from '../render/groupViews';
import { JointViews } from '../render/jointViews';
import { LightViews } from '../render/lightViews';
import { PathViews } from '../render/pathViews';
import { Overlays } from '../render/overlays';
import { Picker, type PickHit } from '../render/picking';
import { Viewport } from '../render/viewport';
import { Labels } from '../ui/labels';
import type { AppEvents, JointDraft, Measurement, PathPointRef, Shell, ToastKind } from './appTypes';
import { CameraControl } from './cameraControl';
import { Editor } from './editor';
import { FrameLoop } from './frameLoop';
import { GizmoController } from './gizmoController';
import { InputHub } from './input/hub'; // -- CM-A --
import { CameraRig } from './camera/rig'; // -- CM-A --
// -- NAV: navigation controller, input contexts, drive / play mode --
import { NavController } from './input/navController';
import { InputContexts } from './input/contextManager';
import { ImmersiveMode } from './drive/immersive';
import { MeasureTool } from './measureTool';
import { Persistence } from './persistence';
import { Placement } from './placement';
import { PrefsStore, type GizmoKind, type ToolId } from './prefs';
import { VisualsSync } from './visualsSync';
import { PrefsSync } from './prefsSync';
import { Projectiles } from './projectiles';
import { SceneCommands } from './sceneCommands';
import { SimController } from './simController';
import { ViewSync } from './viewSync';
// ── FX: contact feed and particle effects ──
import type { Fx } from '../render/fx';
import { ContactFeed } from './contactFeed';
import { FxDirector } from './fx/fxDirector';
import { DamageDirector } from './damageDirector'; // -- VZ-B
// ── FX: sound ──
import type { AudioEngine } from '../audio/engine';
import { AudioDirector } from './audio/audioDirector';
import { ZoneBridge } from './zones'; // -- ZN
import { ZoneViews } from '../render/zoneViews'; // -- ZN

import type { SceneSource } from './appTypes';
export type { Shell, ToastKind, SceneSource } from './appTypes';

export class App extends Emitter<AppEvents> {
  readonly store = new SceneStore();
  readonly prefs = new PrefsStore();
  readonly sim: SimController;
  readonly editor: Editor;
  readonly persistence: Persistence;
  readonly viewport: Viewport;
  readonly bodies: BodyViews;
  readonly softs: SoftViews;
  readonly joints: JointViews;
  // ── FB-6: group / light / path views ──
  readonly groupViews: GroupViews;
  readonly lightViews: LightViews;
  readonly pathViews: PathViews;
  readonly overlays: Overlays;
  readonly picker: Picker;
  readonly gizmo: Gizmo;
  readonly effects: Effects;
  // ── FX: the contact-event feed, the effects director and its particle system (`app.fx.emit(type, position)`) ──
  readonly contacts: ContactFeed;
  readonly fxDirector: FxDirector;
  readonly damage: DamageDirector; // -- VZ-B: impact damage visuals (VZ-41)
  readonly fx: Fx;
  // ── FX: the sound engine (`app.audio.playEvent('explosion', [x, y, z])`) and the director that feeds it ──
  readonly audioDirector: AudioDirector;
  readonly audio: AudioEngine;
  readonly componentFx: ComponentFx; // -- CP
  readonly labels = new Labels();
  hoverId: string | null = null;

  // Collaborators (see the module comment). They are internal wiring: UI code should use the App methods below.
  readonly gizmos: GizmoController;
  readonly viewSync: ViewSync;
  readonly prefsSync: PrefsSync;
  readonly measureTool: MeasureTool;
  readonly placement: Placement;
  readonly cameraControl: CameraControl;
  readonly commands: SceneCommands;
  readonly projectiles: Projectiles;
  readonly frameLoop: FrameLoop;
  // -- ZN: zones, races, world bounds (events and state as an API; the volumes drawn in the viewport)
  readonly zones: ZoneBridge;
  readonly zoneViews: ZoneViews;
  /** -- CM-A: keyboard / gamepad / touch → simulation keys and analog axes -- */
  readonly input: InputHub;
  /** -- CM-A: camera modes, projection, bookmarks, shake -- */
  readonly cameraRig: CameraRig;
  // -- NAV: camera navigation (wheel, trackpad, gestures, keys), the input contexts, drive / play mode --
  readonly nav: NavController;
  readonly contexts: InputContexts;
  readonly immersive: ImmersiveMode;

  constructor(readonly shell: Shell) {
    super();
    this.sim = new SimController(this.store);
    this.sim.softEconomy = this.prefs.value.softEconomy; // -- SF --
    this.contacts = new ContactFeed(this.sim); // ── FX ──
    this.editor = new Editor(this.store, this.sim);
    this.persistence = new Persistence(this.store);

    this.viewport = new Viewport(shell.viewportHost);
    this.bodies = new BodyViews(this.viewport.bodies);
    this.softs = new SoftViews(this.viewport.softs);
    this.joints = new JointViews(this.viewport.joints, this.bodies);
    this.groupViews = new GroupViews(this.viewport.groups);
    this.lightViews = new LightViews(this.viewport.lights);
    this.pathViews = new PathViews(this.viewport.paths);
    this.overlays = new Overlays(this.viewport.overlays);
    this.effects = new Effects(this.viewport.helpers);
    // -- CP: the powered parts' flames, blades and gauges read the document, the live poses and the published numbers
    // (only the owners that carry components are looked at; the lists are rebuilt after any change of the document)
    let fxOwners: { bodies: BodyEntity[]; joints: JointEntity[] } | null = null;
    this.store.on('change', () => (fxOwners = null));
    const owners = () =>
      (fxOwners ??= {
        bodies: this.store.bodies().filter((b) => b.components.length > 0),
        joints: this.store.joints().filter((j) => j.components.length > 0),
      });
    this.componentFx = new ComponentFx(this.viewport.helpers, {
      bodies: () => owners().bodies,
      joints: () => owners().joints,
      pose: (id) => this.sim.poseOf(id),
      values: (id) => (this.sim.client.active ? this.sim.client.stateOf(id) : null),
      live: () => this.sim.client.active && this.sim.client.frameNo > 0,
      selected: (id) => this.store.selection.includes(id),
    });
    this.picker = new Picker(this.viewport.dom, this.viewport.camera);

    this.gizmos = new GizmoController(this);
    this.gizmo = this.gizmos.gizmo;
    this.viewSync = new ViewSync(this);
    this.prefsSync = new PrefsSync(this);
    new VisualsSync(this); // -- VZ-A --
    this.placement = new Placement(this);
    this.cameraControl = new CameraControl(this);
    this.commands = new SceneCommands(this);
    this.projectiles = new Projectiles(this);
    this.frameLoop = new FrameLoop(this);
    // ── FX: after the viewport, the store, the preferences and the simulation exist ──
    this.fxDirector = new FxDirector(this);
    this.damage = new DamageDirector(this); // -- VZ-B
    this.fx = this.fxDirector.fx;
    this.audioDirector = new AudioDirector(this); // ── FX: after the store, the preferences, the simulation and the camera exist ──
    this.audio = this.audioDirector.engine;
    this.zones = new ZoneBridge(this); // -- ZN
    this.zoneViews = new ZoneViews(this); // -- ZN
    this.input = new InputHub(this); // -- CM-A --
    this.cameraRig = new CameraRig(this); // -- CM-A --
    this.nav = new NavController(this); // -- NAV --
    this.immersive = new ImmersiveMode(this); // -- NAV --
    this.contexts = new InputContexts(this); // -- NAV --

    shell.stage.appendChild(this.labels.layer);
    this.measureTool = new MeasureTool(this);

    this.editor.cameraHorizontalAxis = () => {
      const d = this.viewport.camera.getWorldDirection(new Vector3());
      return Math.abs(d.x) > Math.abs(d.z) ? [1, 0, 0] : [0, 0, 1];
    };

    // ---- wiring -----------------------------------------------------------------------------
    this.store.on('change', (c) => this.viewSync.onStoreChange(c));
    this.store.on('selection', () => this.viewSync.onSelectionChanged());
    this.sim.on('mode', () => this.onModeChanged());
    this.sim.on('layout', () => this.viewSync.reconcile());
    this.sim.on('broken', ({ id }) => {
      const j = this.store.joint(id);
      this.toast(`${j?.name ?? 'A joint'} broke!`, 'warn');
      // -- JT-B: a burst of sparks where the joint failed (the audio director plays the snap) --
      if (j) {
        const f = this.joints.frameOf(j, { a: new Vector3(), b: new Vector3(), axis: new Vector3() });
        if (f) this.fx.emit('spark.hot', [f.a.x, f.a.y, f.a.z], { count: 36 });
      }
    });
    // A component that threw is switched off by the worker; tell the user which one and why.
    this.sim.client.on('event', (ev) => {
      if (ev.kind !== 'component' || ev.name !== 'error') return;
      const owner = this.store.get(ev.owner);
      const label = componentDef(ev.type)?.label ?? ev.type;
      const message = (ev.data as { message?: string } | undefined)?.message ?? 'unknown error';
      this.toast(`${label} on ${owner?.name ?? 'an object'} stopped: ${message}`, 'warn');
    });
    this.sim.client.on('error', (m) => {
      console.error('[physics worker]', m);
      this.toast('Physics error — see console. The simulation was reset.', 'error');
      this.sim.reset();
    });
    this.prefs.on('change', (keys) => this.prefsSync.onChanged(keys));
    this.persistence.onError = (m) => this.toast(m, 'warn');

    this.viewport.onFrame = (dt) => this.frameLoop.tick(dt);
    this.viewport.resize();
    this.prefsSync.applyAll();
    this.viewSync.rebuildAll();
  }

  start(): void {
    this.viewport.start();
  }

  toast(text: string, kind: ToastKind = 'info'): void {
    this.emit('toast', { text, kind });
  }

  setHint(text: string | null): void {
    this.emit('hint', text);
  }

  get camera() {
    return this.viewport.camera;
  }

  get framesPerSecond(): number {
    return this.frameLoop.fps;
  }

  /** Body colours are recomputed on the next frame. */
  invalidateColors(): void {
    this.frameLoop.invalidateColors();
  }

  private onModeChanged(): void {
    this.gizmos.refresh();
    this.prefsSync.updateToolHint();
    this.invalidateColors();
  }

  // ------------------------------------------------------------------------------------------
  // tools, hints, gizmo
  // ------------------------------------------------------------------------------------------

  /** Tool-specific hint line; the input controller overrides it while a gesture is in progress. */
  updateToolHint(): void {
    this.prefsSync.updateToolHint();
  }

  startJointTool(type: JointType): void {
    this.prefs.set({ tool: 'joint', jointType: type });
    this.cancelJointDraft();
    this.updateToolHint();
  }

  setTool(tool: ToolId): void {
    this.prefs.set({ tool });
  }

  setGizmo(kind: GizmoKind): void {
    this.prefs.set({ gizmo: kind, tool: 'select' });
  }

  refreshGizmo(): void {
    this.gizmos.refresh();
  }

  /** Which end of a selected spring / rope the gizmo moves. */
  get jointEnd(): 'A' | 'B' {
    return this.gizmos.jointEnd;
  }
  set jointEnd(end: 'A' | 'B') {
    this.gizmos.jointEnd = end;
  }

  setJointEnd(end: 'A' | 'B'): void {
    this.gizmos.setJointEnd(end);
  }

  // ------------------------------------------------------------------------------------------
  // joint tool draft and measuring
  // ------------------------------------------------------------------------------------------

  get jointDraft(): JointDraft | null {
    return this.measureTool.jointDraft;
  }
  set jointDraft(d: JointDraft | null) {
    this.measureTool.jointDraft = d;
  }

  cancelJointDraft(): void {
    this.measureTool.cancelJointDraft();
  }

  /** Active measurement, if any. */
  get measure(): Measurement | null {
    return this.measureTool.measure;
  }
  set measure(m: Measurement | null) {
    this.measureTool.measure = m;
  }

  clearMeasure(): void {
    this.measureTool.clear();
  }

  setMeasureLine(a: Vector3, b: Vector3): void {
    this.measureTool.setLine(a, b);
  }

  // ------------------------------------------------------------------------------------------
  // picking and placement
  // ------------------------------------------------------------------------------------------

  /** Pick a body or joint under the pointer. */
  pickEntity(
    ev: { clientX: number; clientY: number },
    opts: { bodies?: boolean; joints?: boolean } = {},
  ): PickHit | null {
    return this.placement.pickEntity(ev, opts);
  }

  /** Point where something new should be placed when the user clicks "add" (centre of the view). */
  viewCenterPlacement(shapeType: ShapeType, size: Vec3): Vec3 {
    return this.placement.viewCenterPlacement(shapeType, size);
  }

  placementAt(ev: { clientX: number; clientY: number }, shapeType: ShapeType, size: Vec3): Vec3 {
    return this.placement.placementAt(ev, shapeType, size);
  }

  // ------------------------------------------------------------------------------------------
  // high level commands used by the UI
  // ------------------------------------------------------------------------------------------

  addShape(type: ShapeType, at?: Vec3, rotation?: Quat): BodyEntity {
    return this.commands.addShape(type, at, rotation);
  }

  addSoft(type: SoftType): void {
    this.commands.addSoft(type);
  }

  // ── FB-6 ──
  addLight(type: LightType): void {
    this.commands.addLight(type);
  }

  addPath(): void {
    this.commands.addPath();
  }

  addGroup(): void {
    this.commands.addGroup();
  }

  /** The path control point the gizmo is editing (a path must be the only selection), or null. */
  get pathPoint(): PathPointRef | null {
    return this.gizmos.pathPoint;
  }

  setPathPoint(id: string | null, index = -1): void {
    this.gizmos.setPathPoint(id === null ? null : { id, index });
  }

  /** `drop` (ED-A snap): where the prefab goes; without it the view target is used. */
  insertPrefab(id: string, drop?: { position: Vec3; rotation?: Quat }): void {
    this.commands.insertPrefab(id, drop);
  }

  loadDocument(doc: SceneDocument, view?: 'frame', source?: SceneSource): void {
    this.commands.loadDocument(doc, view, source);
  }

  loadTemplate(id: string): void {
    this.commands.loadTemplate(id);
  }

  loadMap(id: string): void {
    this.commands.loadMap(id);
  }

  newScene(): void {
    this.commands.newScene();
  }

  frameSelection(): void {
    this.cameraControl.frameSelection();
  }

  frameAll(keepDirection = true): void {
    this.cameraControl.frameAll(keepDirection);
  }

  // -- ED-B: charge power, blast options --
  shoot(origin: Vector3, dir: Vector3, power = 1): void {
    this.projectiles.shoot(origin, dir, power);
  }

  /** Launch speed and flight parameters of the next shot at `power`× charge (for the aim preview). */
  shotSetup(power = 1): ReturnType<Projectiles['shotSetup']> {
    return this.projectiles.shotSetup(power);
  }

  blast(at: Vector3, dir?: Vector3, scale = 1, quiet = false): void {
    this.projectiles.blast(at, dir, scale, quiet);
  }

  /** Index (within the entity's particle block) of the soft particle closest to a world point. */
  softParticleAt(id: string, point: Vector3): number {
    return this.projectiles.softParticleAt(id, point);
  }

  /** Colour of a body for UI swatches. */
  colorOf(e: Entity): string {
    return isBody(e) ? e.material.color : new Color().set('#ffb347').getStyle();
  }

  // ------------------------------------------------------------------------------------------
  // live readouts for the inspector
  // ------------------------------------------------------------------------------------------

  /** Net force readout helpers for the inspector. */
  liveBody(id: string): { vel: Vec3; ang: Vec3; force: Vec3; ke: number; mass: number; state: number } | null {
    const v = this.sim.velocityOf(id);
    if (!v) return null;
    return {
      vel: v.linear,
      ang: v.angular,
      force: v.force,
      ke: v.ke,
      mass: this.sim.client.info.mass[id] ?? 0,
      state: v.state,
    };
  }

  /** JT-B: when an open joint inspector last asked for live load estimates (ms). */
  loadWatchStamp = 0;

  liveJoint(id: string): {
    value: number;
    speed: number;
    force: number;
    broken: boolean;
    load: number;
    torque: number;
    ratio: number;
    damage: number;
    exact: boolean;
  } | null {
    const arr = this.sim.client.jointOf(id);
    if (!arr) return null;
    return {
      value: arr[0],
      speed: arr[1],
      force: arr[2],
      broken: arr[3] > 0,
      load: arr[4],
      torque: arr[5],
      ratio: arr[6],
      damage: arr[7],
      exact: arr[8] > 0,
    };
  }
}
