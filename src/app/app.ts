/**
 * App — wires the document store, the simulation controller, the renderer and the editor
 * commands together. UI panels talk to this class; this class never builds panel DOM.
 *
 * `App` is the façade (`window.physicslab`): it owns the long-lived objects and the event wiring and
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
import type { Vec3 } from '../core/math';
import type { BodyEntity, Entity, JointType, LightType, SceneDocument, ShapeType, SoftType } from '../model/types';
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
import { MeasureTool } from './measureTool';
import { Persistence } from './persistence';
import { Placement } from './placement';
import { PrefsStore, type GizmoKind, type ToolId } from './prefs';
import { PrefsSync } from './prefsSync';
import { Projectiles } from './projectiles';
import { SceneCommands } from './sceneCommands';
import { SimController } from './simController';
import { ViewSync } from './viewSync';

export type { Shell, ToastKind } from './appTypes';

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

  constructor(readonly shell: Shell) {
    super();
    this.sim = new SimController(this.store);
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
    this.componentFx = new ComponentFx(this.viewport.helpers, {
      bodies: () => this.store.bodies(),
      joints: () => this.store.joints(),
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
    this.placement = new Placement(this);
    this.cameraControl = new CameraControl(this);
    this.commands = new SceneCommands(this);
    this.projectiles = new Projectiles(this);
    this.frameLoop = new FrameLoop(this);

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

  addShape(type: ShapeType, at?: Vec3): BodyEntity {
    return this.commands.addShape(type, at);
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

  insertPrefab(id: string): void {
    this.commands.insertPrefab(id);
  }

  loadDocument(doc: SceneDocument, view?: 'frame'): void {
    this.commands.loadDocument(doc, view);
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

  shoot(origin: Vector3, dir: Vector3): void {
    this.projectiles.shoot(origin, dir);
  }

  blast(at: Vector3): void {
    this.projectiles.blast(at);
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

  liveJoint(id: string): { value: number; speed: number; force: number; broken: boolean } | null {
    const arr = this.sim.client.jointOf(id);
    if (!arr) return null;
    return { value: arr[0], speed: arr[1], force: arr[2], broken: arr[3] > 0 };
  }
}
