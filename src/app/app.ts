/**
 * App — wires the document store, the simulation controller, the renderer and the editor
 * commands together. UI panels talk to this class; this class never builds panel DOM.
 */
import { Box3, Color, LineBasicMaterial, LineSegments, BufferGeometry, Float32BufferAttribute, Quaternion, Vector3 } from 'three';
import { Emitter } from '../core/events';
import { qfromEuler, type Vec3 } from '../core/math';
import { createBody } from '../model/factory';
import { PREFABS } from '../model/prefabs';
import { newDocument } from '../model/factory';
import { cloneEntities, SceneStore } from '../model/store';
import { TEMPLATE_BY_ID } from '../model/templates';
import { translateEntities } from '../model/builder';
import type { BodyEntity, Entity, JointEntity, JointType, SceneDocument, ShapeType } from '../model/types';
import { isBody, isJoint } from '../model/types';
import { halfHeight } from '../model/shapes';
import { BodyViews } from '../render/bodyViews';
import { Effects } from '../render/effects';
import { Gizmo, type GizmoItem, type GizmoUpdate } from '../render/gizmo';
import { JointViews } from '../render/jointViews';
import { Overlays } from '../render/overlays';
import { Picker, type PickHit } from '../render/picking';
import { Viewport } from '../render/viewport';
import { Labels } from '../ui/labels';
import { Editor } from './editor';
import { Persistence } from './persistence';
import { PrefsStore, type GizmoKind, type ToolId } from './prefs';
import { SimController } from './simController';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

interface AppEvents extends Record<string, unknown> {
  toast: { text: string; kind: ToastKind };
  hint: string | null;
  frame: { dt: number };
  view: undefined;
  scene: undefined;
  jointEnd: 'A' | 'B';
}

export interface Shell {
  viewportHost: HTMLElement;
  stage: HTMLElement;
}

export class App extends Emitter<AppEvents> {
  readonly store = new SceneStore();
  readonly prefs = new PrefsStore();
  readonly sim: SimController;
  readonly editor: Editor;
  readonly persistence: Persistence;
  readonly viewport: Viewport;
  readonly bodies: BodyViews;
  readonly joints: JointViews;
  readonly overlays: Overlays;
  readonly picker: Picker;
  readonly gizmo: Gizmo;
  readonly effects: Effects;
  readonly labels = new Labels();
  /** Which end of a selected spring / rope the gizmo moves. */
  jointEnd: 'A' | 'B' = 'A';
  hoverId: string | null = null;
  /** Active measurement, if any. */
  measure: { a: Vector3; b: Vector3 | null } | null = null;
  private measureLine: LineSegments;
  private lastLayout = -1;
  private fps = 60;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private followOffset: Vector3 | null = null;
  private dirtyColors = true;

  constructor(readonly shell: Shell) {
    super();
    this.sim = new SimController(this.store);
    this.editor = new Editor(this.store, this.sim);
    this.persistence = new Persistence(this.store);

    this.viewport = new Viewport(shell.viewportHost);
    this.bodies = new BodyViews(this.viewport.bodies);
    this.joints = new JointViews(this.viewport.joints, this.bodies);
    this.overlays = new Overlays(this.viewport.overlays);
    this.effects = new Effects(this.viewport.helpers);
    this.picker = new Picker(this.viewport.dom, this.viewport.camera);

    this.gizmo = new Gizmo(
      this.viewport.camera,
      this.viewport.dom,
      {
        dragStart: () => this.onGizmoStart(),
        change: (u) => this.onGizmoChange(u),
        dragEnd: () => this.onGizmoEnd(),
      },
      (o) => this.viewport.scene.add(o),
    );
    this.gizmo.controls.addEventListener('dragging-changed', (e) => {
      this.viewport.controls.enabled = !(e as unknown as { value: boolean }).value;
    });

    shell.stage.appendChild(this.labels.layer);
    const mg = new BufferGeometry();
    mg.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3));
    this.measureLine = new LineSegments(mg, new LineBasicMaterial({ color: 0x3ddcff, depthTest: false, transparent: true, toneMapped: false }));
    this.measureLine.visible = false;
    this.measureLine.renderOrder = 997;
    this.measureLine.frustumCulled = false;
    this.viewport.helpers.add(this.measureLine);

    this.editor.cameraHorizontalAxis = () => {
      const d = this.viewport.camera.getWorldDirection(new Vector3());
      return Math.abs(d.x) > Math.abs(d.z) ? [1, 0, 0] : [0, 0, 1];
    };

    // ---- wiring -----------------------------------------------------------------------------
    this.store.on('change', (c) => this.onStoreChange(c));
    this.store.on('selection', () => this.onSelectionChanged());
    this.sim.on('mode', () => this.onModeChanged());
    this.sim.on('layout', () => this.reconcileViews());
    this.sim.on('broken', ({ id }) => {
      const j = this.store.joint(id);
      this.toast(`${j?.name ?? 'A joint'} broke!`, 'warn');
    });
    this.sim.client.on('error', (m) => {
      console.error('[physics worker]', m);
      this.toast('Physics error — see console. The simulation was reset.', 'error');
      this.sim.reset();
    });
    this.prefs.on('change', (keys) => this.onPrefsChanged(keys));
    this.persistence.onError = (m) => this.toast(m, 'warn');

    this.viewport.onFrame = (dt) => this.onFrame(dt);
    this.viewport.resize();
    this.applyAllPrefs();
    this.rebuildAllViews();
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

  get camera() { return this.viewport.camera; }

  // ------------------------------------------------------------------------------------------
  // preferences → renderer
  // ------------------------------------------------------------------------------------------

  private applyAllPrefs(): void {
    const p = this.prefs.value;
    this.viewport.setQuality(p.quality);
    this.bodies.mode = p.colorMode;
    this.joints.visible = p.showJoints;
    this.overlays.options = { ...p.overlays };
    this.sim.timeScale = p.timeScale;
    this.sim.wantContacts = p.overlays.contacts;
    this.gizmo.setSpace(p.space);
    this.applySnaps();
    this.updateGizmoMode();
    this.viewport.dom.classList.toggle('tool-joint', p.tool === 'joint');
  }

  private onPrefsChanged(keys: string[]): void {
    const p = this.prefs.value;
    for (const k of keys) {
      switch (k) {
        case 'quality': this.viewport.setQuality(p.quality); break;
        case 'colorMode': this.bodies.mode = p.colorMode; break;
        case 'showJoints': this.joints.visible = p.showJoints; break;
        case 'overlays':
          this.overlays.options = { ...p.overlays };
          this.sim.wantContacts = p.overlays.contacts;
          if (p.overlays.trails === 'off') this.overlays.clearTrails();
          break;
        case 'timeScale': this.sim.timeScale = p.timeScale; break;
        case 'space': this.gizmo.setSpace(p.space); break;
        case 'snap': case 'snapGrid': case 'snapAngle': this.applySnaps(); break;
        case 'tool': this.onToolChanged(); break;
        case 'gizmo': this.updateGizmoMode(); break;
      }
    }
    this.dirtyColors = true;
  }

  private applySnaps(): void {
    const p = this.prefs.value;
    this.gizmo.setSnaps(p.snap ? p.snapGrid : 0, p.snap ? p.snapAngle : 0, p.snap ? 0.05 : 0);
  }

  private onToolChanged(): void {
    const t = this.prefs.value.tool;
    const cls = this.viewport.dom.classList;
    for (const c of ['select', 'joint', 'measure', 'blast', 'shoot']) cls.toggle(`tool-${c}`, c === t);
    this.cancelJointDraft();
    if (t !== 'measure') this.clearMeasure();
    this.updateGizmoMode();
    this.updateToolHint();
  }

  /** Tool-specific hint line; the input controller overrides it while a gesture is in progress. */
  updateToolHint(): void {
    const t = this.prefs.value.tool;
    const sim = this.sim.active;
    const jt = this.prefs.value.jointType;
    const hints: Record<string, string | null> = {
      select: sim ? '<b>Drag</b> a body to throw it · <b>Right-drag</b> orbit · <b>Middle-drag</b> pan · <b>Scroll</b> zoom' : null,
      joint: `<b>${jt}</b> — click the first body (or the ground to pin it to the world)`,
      measure: 'Click two points to measure the distance between them',
      blast: sim ? 'Click anywhere to set off a blast' : 'Start the simulation, then click to set off blasts',
      shoot: sim ? 'Click to fire a ball along the view ray' : 'Start the simulation, then click to fire balls',
    };
    this.setHint(hints[t] ?? null);
  }

  // ------------------------------------------------------------------------------------------
  // document → views
  // ------------------------------------------------------------------------------------------

  private rebuildAllViews(): void {
    this.bodies.clear();
    this.joints.clear();
    for (const e of this.store.all()) {
      if (isBody(e)) this.bodies.add(e);
    }
    for (const e of this.store.all()) if (isJoint(e)) this.joints.add(e);
    this.viewport.setGround(this.store.settings.ground);
    this.onSelectionChanged();
    this.emit('scene', undefined);
  }

  private onStoreChange(c: import('../model/store').SceneChange): void {
    switch (c.type) {
      case 'reset':
        this.rebuildAllViews();
        break;
      case 'add':
        for (const id of c.ids) {
          const e = this.store.get(id);
          if (isBody(e)) this.bodies.add(e);
        }
        for (const id of c.ids) {
          const e = this.store.get(id);
          if (isJoint(e)) this.joints.add(e);
        }
        break;
      case 'remove':
        for (const e of c.removed) {
          if (isBody(e)) this.bodies.remove(e.id);
          else this.joints.remove(e.id);
        }
        break;
      case 'update':
        for (const id of c.ids) {
          const e = this.store.get(id);
          if (isBody(e)) {
            this.bodies.update(e);
            const view = this.bodies.get(id);
            // Document poses only drive the view when no live world owns the body.
            if (view && !(this.sim.client.active && this.sim.client.bodyIndex.has(id))) view.setPoseFromDef(e);
          } else if (isJoint(e)) this.joints.update(e);
        }
        break;
      case 'settings':
        if (c.keys.has('ground')) this.viewport.setGround(this.store.settings.ground);
        break;
    }
    this.dirtyColors = true;
    this.refreshGizmo();
  }

  /** Create / remove views for simulation-only bodies and reset states after a layout change. */
  private reconcileViews(): void {
    // Remove ephemeral views no longer present.
    for (const [id] of [...this.bodies.views]) {
      if (!this.store.has(id) && !this.sim.ephemeral.has(id)) this.bodies.remove(id);
    }
    for (const [id, def] of this.sim.ephemeral) if (!this.bodies.get(id)) this.bodies.add(def);
    if (!this.sim.active) {
      this.bodies.resetStates();
      for (const e of this.store.bodies()) {
        const v = this.bodies.get(e.id);
        if (v) v.setPoseFromDef(e);
      }
      this.overlays.hideAll();
      this.overlays.clearTrails();
    }
    this.refreshGizmo();
  }

  // ------------------------------------------------------------------------------------------
  // selection / gizmo
  // ------------------------------------------------------------------------------------------

  private onSelectionChanged(): void {
    const ids = new Set(this.store.selection);
    const meshes = [];
    for (const id of ids) {
      const v = this.bodies.get(id);
      if (v) meshes.push(v.mesh);
    }
    this.viewport.setOutlineTargets(meshes);
    this.joints.setSelected(ids);
    this.jointEnd = 'A';
    this.refreshGizmo();
    this.dirtyColors = true;
  }

  private updateGizmoMode(): void {
    const k = this.prefs.value.gizmo;
    if (k !== 'none') this.gizmo.setMode(k);
    this.gizmo.setEnabled(this.gizmoActive());
    this.refreshGizmo();
  }

  private gizmoItems(): GizmoItem[] {
    const items: GizmoItem[] = [];
    const sel = this.store.selection;
    if (sel.length === 1 && this.store.joint(sel[0])) {
      const j = this.store.joint(sel[0])!;
      const f = this.joints.frameOf(j, { a: new Vector3(), b: new Vector3(), axis: new Vector3() });
      if (f) {
        const pos = this.jointEnd === 'B' && (j.type === 'spring' || j.type === 'rope') ? f.b : f.a;
        const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), f.axis);
        items.push({ id: j.id, position: pos.clone(), quaternion: q, size: new Vector3(1, 1, 1) });
      }
      return items;
    }
    for (const id of sel) {
      const b = this.store.body(id);
      if (!b || b.locked || b.hidden) continue;
      const pose = this.sim.poseOf(id);
      if (!pose) continue;
      items.push({
        id,
        position: new Vector3(...pose.position),
        quaternion: new Quaternion(...pose.rotation),
        size: new Vector3(...b.shape.size),
      });
    }
    return items;
  }

  /** The gizmo edits poses, so it is hidden while the simulation is running (grabbing takes over). */
  private gizmoActive(): boolean {
    return this.prefs.value.gizmo !== 'none' && this.prefs.value.tool === 'select' && this.sim.mode !== 'running';
  }

  refreshGizmo(): void {
    if (this.gizmo.isDragging) return;
    this.gizmo.setEnabled(this.gizmoActive());
    const items = this.gizmoActive() ? this.gizmoItems() : [];
    // A joint can only be translated or rotated (axis) — scale makes no sense.
    const joint = items.length === 1 && !!this.store.joint(items[0].id);
    if (joint && this.gizmo.mode === 'scale') this.gizmo.setMode('translate');
    this.gizmo.setItems(items);
    this.gizmo.refresh(items);
  }

  private gizmoUndoOpen = false;

  private onGizmoStart(): void {
    if (!this.sim.active) {
      this.store.begin(this.gizmo.mode === 'translate' ? 'Move' : this.gizmo.mode === 'rotate' ? 'Rotate' : 'Scale');
      this.gizmoUndoOpen = true;
    }
  }

  private onGizmoChange(updates: GizmoUpdate[]): void {
    const jointUpdate = updates.length === 1 ? this.store.joint(updates[0].id) : undefined;
    if (jointUpdate) {
      this.moveJointWithGizmo(jointUpdate, updates[0]);
      return;
    }
    this.editor.applyGizmo(updates);
    // Immediate visual feedback (document updates also reach the views through events).
    if (this.sim.active) {
      for (const u of updates) {
        const v = this.bodies.get(u.id);
        if (v) {
          v.mesh.position.set(...u.position);
          v.mesh.quaternion.set(...u.rotation);
          v.position.copy(v.mesh.position);
        }
      }
    }
  }

  private onGizmoEnd(): void {
    if (this.gizmoUndoOpen) {
      this.store.end();
      this.gizmoUndoOpen = false;
    }
    this.refreshGizmo();
  }

  private moveJointWithGizmo(j: JointEntity, u: GizmoUpdate): void {
    const frame = this.joints.frameOf(j, { a: new Vector3(), b: new Vector3(), axis: new Vector3() });
    if (!frame) return;
    const world = new Vector3(...u.position);
    if (this.gizmo.mode === 'translate') {
      const end = this.jointEnd === 'B' && (j.type === 'spring' || j.type === 'rope') ? 'B' : 'A';
      const body = end === 'A' ? j.bodyA : j.bodyB;
      let local: Vec3 = [world.x, world.y, world.z];
      if (body) {
        const v = this.bodies.get(body);
        if (v) {
          const l = world.clone().sub(v.mesh.position).applyQuaternion(v.mesh.quaternion.clone().invert());
          local = [l.x, l.y, l.z];
        }
      }
      if (this.sim.active) {
        // keep the document untouched by live pose-only edits; joints are structural so apply
      }
      this.store.update(j.id, end === 'A' ? { anchorA: local } : { anchorB: local }, 'Move joint');
    } else if (this.gizmo.mode === 'rotate') {
      const axisWorld = new Vector3(0, 1, 0).applyQuaternion(new Quaternion(...u.rotation));
      let local: Vec3 = [axisWorld.x, axisWorld.y, axisWorld.z];
      if (j.bodyA) {
        const v = this.bodies.get(j.bodyA);
        if (v) {
          const l = axisWorld.clone().applyQuaternion(v.mesh.quaternion.clone().invert());
          local = [l.x, l.y, l.z];
        }
      }
      this.store.update(j.id, { axis: local }, 'Rotate joint axis');
    }
  }

  setJointEnd(end: 'A' | 'B'): void {
    this.jointEnd = end;
    this.refreshGizmo();
    this.emit('jointEnd', end);
  }

  // ------------------------------------------------------------------------------------------
  // joint tool draft
  // ------------------------------------------------------------------------------------------

  jointDraft: { body: string | null; point: Vector3 } | null = null;

  cancelJointDraft(): void {
    this.jointDraft = null;
    this.measureLine.visible = false;
  }

  // ------------------------------------------------------------------------------------------
  // measuring
  // ------------------------------------------------------------------------------------------

  clearMeasure(): void {
    this.measure = null;
    this.measureLine.visible = false;
    this.labels.remove('measure');
    this.labels.remove('measure-a');
  }

  setMeasureLine(a: Vector3, b: Vector3): void {
    const attr = this.measureLine.geometry.getAttribute('position');
    (attr.array as Float32Array).set([a.x, a.y, a.z, b.x, b.y, b.z]);
    attr.needsUpdate = true;
    this.measureLine.visible = true;
  }

  // ------------------------------------------------------------------------------------------
  // picking helpers
  // ------------------------------------------------------------------------------------------

  /** Pick a body or joint under the pointer. */
  pickEntity(ev: { clientX: number; clientY: number }, opts: { bodies?: boolean; joints?: boolean } = {}): PickHit | null {
    const targets = [];
    if (opts.joints !== false) targets.push(...this.joints.pickables());
    // Joint gizmos draw on top, so give them priority when they are hit.
    if (targets.length) {
      const j = this.picker.pick(ev, targets);
      if (j) {
        const b = opts.bodies !== false ? this.picker.pick(ev, this.bodies.pickables()) : null;
        // Prefer a body only if it is clearly in front of the joint handle.
        if (!b || b.distance > j.distance - 0.15) return j;
        return b;
      }
    }
    if (opts.bodies === false) return null;
    return this.picker.pick(ev, this.bodies.pickables());
  }

  /** Point where something new should be placed when the user clicks "add" (centre of the view). */
  viewCenterPlacement(shapeType: ShapeType, size: Vec3): Vec3 {
    const rect = this.viewport.dom.getBoundingClientRect();
    return this.placementAt({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height * 0.6 }, shapeType, size);
  }

  placementAt(ev: { clientX: number; clientY: number }, shapeType: ShapeType, size: Vec3): Vec3 {
    const hh = halfHeight({ type: shapeType, size });
    let p: Vec3;
    const hit = this.picker.pick(ev, this.bodies.pickables());
    const g = this.picker.groundPoint(ev, 0);
    if (hit && hit.normal && (!g || hit.distance < this.camera.position.distanceTo(g))) {
      const n = hit.normal.clone().normalize();
      const off = n.y > 0.7 ? new Vector3(0, hh + 0.01, 0) : n.clone().multiplyScalar(hh + 0.01);
      p = [hit.point.x + off.x, hit.point.y + off.y, hit.point.z + off.z];
    } else if (g && g.distanceTo(this.camera.position) < 150) {
      p = [g.x, hh + 0.001, g.z];
    } else {
      const t = this.viewport.controls.target;
      p = [t.x, hh + 0.001, t.z];
    }
    if (this.prefs.value.snap) {
      const s = this.prefs.value.snapGrid;
      p = [Math.round(p[0] / s) * s, p[1], Math.round(p[2] / s) * s];
    }
    return p;
  }

  // ------------------------------------------------------------------------------------------
  // high level commands used by the UI
  // ------------------------------------------------------------------------------------------

  addShape(type: ShapeType, at?: Vec3): BodyEntity {
    const body = this.editor.addShape(type, at ?? this.viewCenterPlacement(type, createBody({ shape: { type } }).shape.size));
    this.effects.ping(new Vector3(body.position[0], Math.max(0, body.position[1] - halfHeight(body.shape)), body.position[2]));
    return body;
  }

  startJointTool(type: JointType): void {
    this.prefs.set({ tool: 'joint', jointType: type });
    this.cancelJointDraft();
    this.updateToolHint();
  }

  setTool(tool: ToolId): void { this.prefs.set({ tool }); }
  setGizmo(kind: GizmoKind): void {
    this.prefs.set({ gizmo: kind, tool: 'select' });
  }

  insertPrefab(id: string): void {
    const pf = PREFABS.find((p) => p.id === id);
    if (!pf) return;
    const t = this.viewport.controls.target;
    const snap = this.prefs.value.snap ? 0.5 : 0.01;
    const at: Vec3 = [Math.round(t.x / snap) * snap, 0, Math.round(t.z / snap) * snap];
    const list = translateEntities(pf.build(), at);
    // Re-id so repeated insertions never collide.
    const copies = cloneEntities(list, list.map((e) => e.id), [0, 0, 0]).map((e) => ({ ...e, name: this.store.uniqueName(e.name) } as Entity));
    this.store.add(copies, `Insert ${pf.name}`);
    this.frameSelection();
    this.toast(`${pf.name} inserted`, 'success');
  }

  loadDocument(doc: SceneDocument, view?: 'frame'): void {
    this.sim.reset();
    this.store.load(doc);
    this.persistence.saveNow();
    if (view === 'frame') this.frameAll(false);
  }

  loadTemplate(id: string): void {
    const t = TEMPLATE_BY_ID.get(id);
    if (!t) return;
    this.loadDocument(t.build(), t.view ? undefined : 'frame');
    if (t.view) this.viewport.flyTo(new Vector3(...t.view.position), new Vector3(...t.view.target), 0.6);
    if (t.follow) {
      const b = this.store.bodies().find((x) => x.name === t.follow);
      if (b) this.store.setSelection([b.id]);
      this.prefs.set({ followSelection: true });
    } else this.prefs.set({ followSelection: false });
    this.toast(t.hint, 'info');
  }

  newScene(): void {
    this.loadDocument(newDocument('Untitled scene'));
    this.viewport.setView({ position: [9, 7, 11], target: [0, 1.2, 0] });
  }

  frameSelection(): void {
    const ids = this.store.selection;
    if (!ids.length) { this.frameAll(); return; }
    const box = new Box3();
    let any = false;
    for (const id of ids) {
      const v = this.bodies.get(id);
      if (v) { box.expandByObject(v.mesh); any = true; continue; }
      const j = this.store.joint(id);
      if (j) {
        const f = this.joints.frameOf(j, { a: new Vector3(), b: new Vector3(), axis: new Vector3() });
        if (f) { box.expandByPoint(f.a); box.expandByPoint(f.b); any = true; }
      }
    }
    if (!any) return;
    const c = box.getCenter(new Vector3());
    this.viewport.frame(c, Math.max(0.6, box.getSize(new Vector3()).length() / 2), true);
  }

  frameAll(keepDirection = true): void {
    const box = new Box3();
    let any = false;
    for (const v of this.bodies.views.values()) {
      if (v.def.hidden) continue;
      box.expandByObject(v.mesh);
      any = true;
    }
    if (!any) { this.viewport.flyTo(new Vector3(9, 7, 11), new Vector3(0, 1.2, 0)); return; }
    const c = box.getCenter(new Vector3());
    const r = Math.min(40, Math.max(2.5, box.getSize(new Vector3()).length() / 2));
    this.viewport.frame(c, r, keepDirection);
  }

  /** Colour of a body for UI swatches. */
  colorOf(e: Entity): string {
    return isBody(e) ? e.material.color : new Color().set('#ffb347').getStyle();
  }

  // ------------------------------------------------------------------------------------------
  // modes
  // ------------------------------------------------------------------------------------------

  private onModeChanged(): void {
    this.refreshGizmo();
    this.updateToolHint();
    this.dirtyColors = true;
  }

  // ------------------------------------------------------------------------------------------
  // per-frame
  // ------------------------------------------------------------------------------------------

  get framesPerSecond(): number { return this.fps; }

  private onFrame(dt: number): void {
    // fps estimate
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }

    this.sim.tick();
    const client = this.sim.client;
    const live = client.active && client.frameNo > 0;

    if (live) {
      if (client.layoutNo !== this.lastLayout) {
        this.lastLayout = client.layoutNo;
        this.reconcileViews();
      }
      const poses = client.poses;
      for (const [id, view] of this.bodies.views) {
        const i = client.bodyIndex.get(id);
        if (i !== undefined) this.bodies.setPoseFromFrame(id, poses, i);
        else view.state = 0;
      }
      this.keepGizmoInSync();
    }

    this.bodies.hoverId = this.hoverId;
    if (live || this.dirtyColors || this.bodies.mode !== 'material') {
      const sel = new Set(this.store.selection);
      this.bodies.applyColors(live ? client.poses : null, (id) => client.bodyIndex.get(id), sel);
      this.dirtyColors = false;
    }

    const broken = client.broken;
    this.joints.updateFrame(this.camera, live ? client.joints : null, (id) => client.jointIndex.get(id), broken);

    const grav = Math.hypot(...this.store.settings.gravity);
    this.overlays.update(
      this.camera, this.bodies, live ? client.poses : null, (id) => client.bodyIndex.get(id), client.contacts, client.frameNo,
      new Set(this.store.selection), client.info.mass, client.info.com, grav,
    );
    if (this.overlays.options.trails !== 'off' || live) { /* trails recorded inside update */ }

    this.effects.update(dt);
    this.updateFollow(dt);
    this.updateMeasureLabel();
    const rect = this.viewport.dom.getBoundingClientRect();
    this.labels.update(this.camera, rect.width, rect.height);

    this.emit('frame', { dt });
  }

  private keepGizmoInSync(): void {
    if (this.gizmo.isDragging) return;
    const items = this.gizmoItems();
    if (items.length) this.gizmo.refresh(items);
  }

  private updateFollow(dt: number): void {
    if (!this.prefs.value.followSelection) { this.followOffset = null; return; }
    const id = this.store.selection.find((s) => this.bodies.get(s));
    const v = id ? this.bodies.get(id) : null;
    if (!v) return;
    const c = this.viewport.controls;
    if (!this.followOffset) this.followOffset = c.target.clone().sub(v.position);
    const desired = v.position.clone();
    const delta = desired.clone().sub(c.target).multiplyScalar(1 - Math.exp(-9 * dt));
    c.target.add(delta);
    this.camera.position.add(delta);
  }

  private updateMeasureLabel(): void {
    const m = this.measure;
    if (!m || !m.b) return;
    const d = m.b.clone().sub(m.a);
    const mid = m.a.clone().add(m.b).multiplyScalar(0.5);
    this.labels.set('measure', mid, `${d.length().toFixed(3)} m   Δ ${d.x.toFixed(2)}, ${d.y.toFixed(2)}, ${d.z.toFixed(2)}`, 'accent');
  }

  // ------------------------------------------------------------------------------------------
  // projectiles & blasts
  // ------------------------------------------------------------------------------------------

  shoot(origin: Vector3, dir: Vector3): void {
    if (!this.sim.active) { this.toast('Start the simulation to fire projectiles', 'warn'); return; }
    const p = this.prefs.value;
    const r = p.shootSize;
    const b = createBody({
      name: 'Projectile',
      shape: { type: 'sphere', size: [r * 2, r * 2, r * 2] },
      position: [origin.x + dir.x * 1.2, origin.y + dir.y * 1.2, origin.z + dir.z * 1.2],
      material: { preset: 'steel', color: '#ffb347', metalness: 0.5 },
      velocity: [dir.x * p.shootSpeed, dir.y * p.shootSpeed, dir.z * p.shootSpeed],
      ccd: true,
      rotation: qfromEuler([0, 0, 0]),
    });
    this.sim.spawn(b);
  }

  blast(at: Vector3): void {
    if (!this.sim.active) { this.toast('Start the simulation to set off blasts', 'warn'); return; }
    const p = this.prefs.value;
    this.sim.client.op({ op: 'explode', center: [at.x, at.y, at.z], strength: p.blastStrength, radius: 7 });
    this.effects.shockwave(at, 7);
  }

  /** Net force readout helpers for the inspector. */
  liveBody(id: string): { vel: Vec3; ang: Vec3; force: Vec3; ke: number; mass: number; state: number } | null {
    const v = this.sim.velocityOf(id);
    if (!v) return null;
    return { vel: v.linear, ang: v.angular, force: v.force, ke: v.ke, mass: this.sim.client.info.mass[id] ?? 0, state: v.state };
  }

  liveJoint(id: string): { value: number; speed: number; force: number; broken: boolean } | null {
    const arr = this.sim.client.jointOf(id);
    if (!arr) return null;
    return { value: arr[0], speed: arr[1], force: arr[2], broken: arr[3] > 0 };
  }
}
