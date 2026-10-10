/**
 * Transform gizmo glue: which selected entities the gizmo drives, when it is active, how a drag is
 * grouped into one undo step, and how a joint's anchor / axis is edited through it.
 */
import { Quaternion, Vector3 } from 'three';
import type { Vec3 } from '../core/math';
import type { JointEntity } from '../model/types';
import { Gizmo, type GizmoItem, type GizmoUpdate } from '../render/gizmo';
import type { App } from './app';
import type { PathPointRef } from './appTypes';
import { ComHandle } from './comHandle'; // -- JT-B
// -- ED-A hierarchy: scale gizmo on groups --
import { endScaleGroupDrag } from './edit/groupOps';

export class GizmoController {
  readonly gizmo: Gizmo;
  /** Which end of a selected spring / rope the gizmo moves. */
  jointEnd: 'A' | 'B' = 'A';
  /** The path control point the gizmo is editing (FB-6), or null. */
  pathPoint: PathPointRef | null = null;
  private undoOpen = false;
  /** JT-B: the centre-of-mass handle of a body (JT-33). */
  readonly com: ComHandle;

  constructor(private app: App) {
    const { viewport } = app;
    this.com = new ComHandle(app);
    this.gizmo = new Gizmo(
      viewport.camera,
      viewport.dom,
      {
        dragStart: () => this.onStart(),
        change: (u) => this.onChange(u),
        dragEnd: () => this.onEnd(),
      },
      (o) => viewport.scene.add(o),
    );
    this.gizmo.controls.addEventListener('dragging-changed', (e) => {
      viewport.controls.enabled = !(e as unknown as { value: boolean }).value;
    });
  }

  updateMode(): void {
    const k = this.app.prefs.value.gizmo;
    if (k !== 'none') this.gizmo.setMode(k);
    this.gizmo.setEnabled(this.active());
    this.refresh();
  }

  /** Edit one control point of a path with the gizmo (null = back to the whole entity). Selects the path. */
  setPathPoint(ref: PathPointRef | null): void {
    const { app } = this;
    this.pathPoint = ref;
    if (ref && !(app.store.selection.length === 1 && app.store.selection[0] === ref.id)) {
      app.store.setSelection([ref.id]); // the selection handler clears nothing: it sees the same path
    }
    app.pathViews.setActivePoint(ref?.id ?? null, ref?.index ?? -1);
    this.refresh();
    app.emit('pathPoint', undefined);
  }

  setJointEnd(end: 'A' | 'B'): void {
    this.jointEnd = end;
    this.refresh();
    this.app.emit('jointEnd', end);
  }

  private items(): GizmoItem[] {
    const { app } = this;
    const items: GizmoItem[] = [];
    const sel = app.store.selection;
    const comItem = this.com.item(); // -- JT-B: the COM handle replaces the body's own gizmo --
    if (comItem) return [comItem];
    if (sel.length === 1 && app.store.joint(sel[0])) {
      const j = app.store.joint(sel[0])!;
      const f = app.joints.frameOf(j, { a: new Vector3(), b: new Vector3(), axis: new Vector3() });
      if (f) {
        const pos = this.jointEnd === 'B' && (j.type === 'spring' || j.type === 'rope') ? f.b : f.a;
        const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), f.axis);
        items.push({ id: j.id, position: pos.clone(), quaternion: q, size: new Vector3(1, 1, 1) });
      }
      return items;
    }
    // A control point of the selected path: translate only, in the path's own axes.
    const ap = this.pathPoint;
    if (ap && sel.length === 1 && sel[0] === ap.id) {
      const path = app.store.path(ap.id);
      const view = app.pathViews.get(ap.id);
      if (path && view && !path.locked && !path.hidden && path.points[ap.index]) {
        items.push({
          id: `${ap.id}#${ap.index}`,
          position: view.pointWorld(ap.index),
          quaternion: new Quaternion(...path.rotation),
          size: new Vector3(1, 1, 1),
        });
        return items;
      }
    }
    for (const id of sel) {
      const aux = app.store.group(id) ?? app.store.light(id) ?? app.store.path(id);
      if (aux) {
        // Groups, lights and paths live in the document only: no gizmo while a simulation is running or when locked.
        if (!aux.locked && !aux.hidden && !app.sim.active) {
          items.push({
            id,
            position: new Vector3(...aux.position),
            quaternion: new Quaternion(...aux.rotation),
            size: new Vector3(1, 1, 1),
          });
        }
        continue;
      }
      const sf = app.store.soft(id);
      if (sf) {
        // Soft bodies are positioned in the editor only; once simulating their particles are free.
        if (!sf.locked && !sf.hidden && !app.sim.active) {
          items.push({
            id,
            position: new Vector3(...sf.position),
            quaternion: new Quaternion(...sf.rotation),
            size: new Vector3(...sf.size),
          });
        }
        continue;
      }
      const b = app.store.body(id);
      if (!b || b.locked || b.hidden) continue;
      const pose = app.sim.poseOf(id);
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
  private active(): boolean {
    const { prefs, sim } = this.app;
    // -- ED-A path: the Path tool shows the gizmo only on the active control point --
    if (prefs.value.tool === 'path') return this.pathPoint !== null && sim.mode !== 'running';
    return prefs.value.gizmo !== 'none' && prefs.value.tool === 'select' && sim.mode !== 'running';
  }

  refresh(): void {
    if (this.gizmo.isDragging) return;
    this.gizmo.setEnabled(this.active());
    const items = this.active() ? this.items() : [];
    // A joint can only be translated or rotated (axis) — scale makes no sense.
    const joint = items.length === 1 && !!this.app.store.joint(items[0].id);
    if (joint && this.gizmo.mode === 'scale') this.gizmo.setMode('translate');
    // A path control point can only be translated; lights, paths and groups have no size to scale.
    const point = items.length === 1 && items[0].id.includes('#');
    if (point && this.gizmo.mode !== 'translate') this.gizmo.setMode('translate');
    if (items.length === 1 && items[0].id.endsWith('@com') && this.gizmo.mode !== 'translate')
      this.gizmo.setMode('translate'); // -- JT-B
    const posedOnly =
      items.length > 0 &&
      items.every(
        (i) =>
          !!this.app.store.get(i.id) &&
          !this.app.store.body(i.id) &&
          !this.app.store.group(i.id) && // ED-A hierarchy: a group scales its members
          !this.app.store.soft(i.id) &&
          !this.app.store.joint(i.id),
      );
    if (posedOnly && this.gizmo.mode === 'scale') this.gizmo.setMode('translate');
    this.gizmo.setItems(items);
    this.gizmo.refresh(items);
  }

  /** While simulating, follow the live poses (unless the user is dragging). */
  keepInSync(): void {
    if (this.gizmo.isDragging) return;
    const items = this.items();
    if (items.length) this.gizmo.refresh(items);
  }

  private onStart(): void {
    const { app } = this;
    if (!app.sim.active) {
      app.store.begin(this.gizmo.mode === 'translate' ? 'Move' : this.gizmo.mode === 'rotate' ? 'Rotate' : 'Scale');
      this.undoOpen = true;
    }
  }

  private onChange(updates: GizmoUpdate[]): void {
    const { app } = this;
    if (updates.length === 1 && this.com.apply(updates[0])) return; // -- JT-B --
    if (updates.length === 1 && updates[0].id.includes('#')) {
      const [id, index] = updates[0].id.split('#');
      app.editor.movePathPoint(id, Number(index), updates[0].position);
      return;
    }
    const jointUpdate = updates.length === 1 ? app.store.joint(updates[0].id) : undefined;
    if (jointUpdate) {
      this.moveJoint(jointUpdate, updates[0]);
      return;
    }
    app.editor.applyGizmo(updates);
    // Immediate visual feedback (document updates also reach the views through events).
    if (app.sim.active) {
      for (const u of updates) {
        const v = app.bodies.get(u.id);
        if (v) {
          v.mesh.position.set(...u.position);
          v.mesh.quaternion.set(...u.rotation);
          v.position.copy(v.mesh.position);
        }
      }
    }
  }

  private onEnd(): void {
    // -- ED-A hierarchy: say so when a non-uniform group scale could not be exact for turned members --
    if (endScaleGroupDrag()) {
      this.app.toast(
        'Some members are turned against the group’s axes, so this non-uniform scale is approximate for them. Use a uniform scale to keep shapes exact.',
        'warn',
      );
    }
    if (this.undoOpen) {
      this.app.store.end();
      this.undoOpen = false;
    }
    this.refresh();
  }

  /** Joint edits are structural, so they apply to both the document and a live world. */
  private moveJoint(j: JointEntity, u: GizmoUpdate): void {
    const { app } = this;
    const frame = app.joints.frameOf(j, { a: new Vector3(), b: new Vector3(), axis: new Vector3() });
    if (!frame) return;
    const world = new Vector3(...u.position);
    if (this.gizmo.mode === 'translate') {
      const end = this.jointEnd === 'B' && (j.type === 'spring' || j.type === 'rope') ? 'B' : 'A';
      const body = end === 'A' ? j.bodyA : j.bodyB;
      let local: Vec3 = [world.x, world.y, world.z];
      if (body) {
        const v = app.bodies.get(body);
        if (v) {
          const l = world.clone().sub(v.mesh.position).applyQuaternion(v.mesh.quaternion.clone().invert());
          local = [l.x, l.y, l.z];
        }
      }
      app.store.update(j.id, end === 'A' ? { anchorA: local } : { anchorB: local }, 'Move joint');
    } else if (this.gizmo.mode === 'rotate') {
      const axisWorld = new Vector3(0, 1, 0).applyQuaternion(new Quaternion(...u.rotation));
      let local: Vec3 = [axisWorld.x, axisWorld.y, axisWorld.z];
      if (j.bodyA) {
        const v = app.bodies.get(j.bodyA);
        if (v) {
          const l = axisWorld.clone().applyQuaternion(v.mesh.quaternion.clone().invert());
          local = [l.x, l.y, l.z];
        }
      }
      app.store.update(j.id, { axis: local }, 'Rotate joint axis');
    }
  }
}
