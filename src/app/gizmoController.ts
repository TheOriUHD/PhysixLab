/**
 * Transform gizmo glue: which selected entities the gizmo drives, when it is active, how a drag is
 * grouped into one undo step, and how a joint's anchor / axis is edited through it.
 */
import { Quaternion, Vector3 } from 'three';
import type { Vec3 } from '../core/math';
import type { JointEntity } from '../model/types';
import { Gizmo, type GizmoItem, type GizmoUpdate } from '../render/gizmo';
import type { App } from './app';

export class GizmoController {
  readonly gizmo: Gizmo;
  /** Which end of a selected spring / rope the gizmo moves. */
  jointEnd: 'A' | 'B' = 'A';
  private undoOpen = false;

  constructor(private app: App) {
    const { viewport } = app;
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

  setJointEnd(end: 'A' | 'B'): void {
    this.jointEnd = end;
    this.refresh();
    this.app.emit('jointEnd', end);
  }

  private items(): GizmoItem[] {
    const { app } = this;
    const items: GizmoItem[] = [];
    const sel = app.store.selection;
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
    for (const id of sel) {
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
    return prefs.value.gizmo !== 'none' && prefs.value.tool === 'select' && sim.mode !== 'running';
  }

  refresh(): void {
    if (this.gizmo.isDragging) return;
    this.gizmo.setEnabled(this.active());
    const items = this.active() ? this.items() : [];
    // A joint can only be translated or rotated (axis) — scale makes no sense.
    const joint = items.length === 1 && !!this.app.store.joint(items[0].id);
    if (joint && this.gizmo.mode === 'scale') this.gizmo.setMode('translate');
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
