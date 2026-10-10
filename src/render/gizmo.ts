/**
 * Transform gizmo wrapper (translate / rotate / scale) that supports multi-selection by
 * driving a pivot object, and reports the resulting per-entity transforms to the editor.
 */
import { Euler, Object3D, Quaternion, Vector3, type PerspectiveCamera } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

export interface GizmoItem {
  id: string;
  position: Vector3;
  quaternion: Quaternion;
  size: Vector3;
  // -- ED-A arrange: pivot this item turns/scales about in individual-pivot mode (default: its own position) --
  pivot?: Vector3;
}

export interface GizmoUpdate {
  id: string;
  position: [number, number, number];
  rotation: [number, number, number, number];
  /** Present only in scale mode (single selection). */
  scale?: [number, number, number];
}

export interface GizmoCallbacks {
  dragStart(): void;
  change(updates: GizmoUpdate[]): void;
  dragEnd(): void;
}

export class Gizmo {
  readonly controls: TransformControls;
  readonly pivot = new Object3D();
  private items: GizmoItem[] = [];
  private start: GizmoItem[] = [];
  private startPivot = { p: new Vector3(), q: new Quaternion() };
  private dragging = false;
  private applying = false;
  // -- ED-A arrange: pivot policy (handle position override, per-item pivots) --
  private handleAt: Vector3 | null = null;
  private individual = false;
  mode: GizmoMode = 'translate';
  space: 'world' | 'local' = 'world';

  constructor(
    camera: PerspectiveCamera,
    dom: HTMLElement,
    private cb: GizmoCallbacks,
    add: (o: Object3D) => void,
  ) {
    this.controls = new TransformControls(camera, dom);
    this.controls.size = 0.85;
    add(this.pivot);
    add(this.controls.getHelper());
    this.controls.addEventListener('dragging-changed', (e) => {
      const on = !!(e as unknown as { value: boolean }).value;
      if (on) this.beginDrag();
      else this.endDrag();
    });
    this.controls.addEventListener('objectChange', () => this.onChange());
  }

  get isDragging(): boolean {
    return this.dragging;
  }
  get hovering(): boolean {
    return (this.controls as unknown as { axis: string | null }).axis !== null;
  }

  setMode(m: GizmoMode): void {
    this.mode = m;
    this.controls.setMode(m);
    this.refreshSpace();
  }

  setSpace(s: 'world' | 'local'): void {
    this.space = s;
    this.refreshSpace();
  }

  private refreshSpace(): void {
    // Scaling only makes sense in the object's own axes.
    this.controls.setSpace(this.mode === 'scale' ? 'local' : this.space);
    this.syncPivot();
  }

  // -- ED-A arrange: where the handle sits and whether items transform about their own pivots --
  setPivotPolicy(handle: Vector3 | null, individual: boolean): void {
    this.handleAt = handle;
    this.individual = individual;
    this.syncPivot();
  }

  setSnaps(translate: number, rotateDeg: number, scale: number): void {
    this.controls.setTranslationSnap(translate > 0 ? translate : null);
    this.controls.setRotationSnap(rotateDeg > 0 ? (rotateDeg * Math.PI) / 180 : null);
    this.controls.setScaleSnap(scale > 0 ? scale : null);
  }

  /** Attach to a set of entities (empty = detach). `enabledMode` hides the gizmo if null. */
  setItems(items: GizmoItem[]): void {
    this.items = items;
    if (this.dragging) return;
    if (!items.length) {
      this.controls.detach();
      this.pivot.visible = false;
      return;
    }
    this.pivot.visible = true;
    this.syncPivot();
    this.controls.attach(this.pivot);
  }

  /** Update the items' transforms from outside (e.g. numeric edits, undo) without dragging. */
  refresh(items: GizmoItem[]): void {
    if (this.dragging) return;
    this.items = items;
    this.syncPivot();
  }

  private syncPivot(): void {
    if (!this.items.length || this.dragging) return;
    const c = new Vector3();
    for (const it of this.items) c.add(it.position);
    c.divideScalar(this.items.length);
    this.pivot.position.copy(this.handleAt ?? c);
    // -- ED-A arrange: local space also works for a multi-selection (the active = last item's axes) --
    const useLocal = this.space === 'local' || this.mode === 'scale';
    if (useLocal) this.pivot.quaternion.copy(this.items[this.items.length - 1].quaternion);
    else this.pivot.quaternion.identity();
    this.pivot.scale.set(1, 1, 1);
  }

  setEnabled(on: boolean): void {
    this.controls.enabled = on;
    this.controls.getHelper().visible = on && this.items.length > 0;
  }

  private beginDrag(): void {
    this.dragging = true;
    this.start = this.items.map((i) => ({
      id: i.id,
      position: i.position.clone(),
      quaternion: i.quaternion.clone(),
      size: i.size.clone(),
      pivot: i.pivot?.clone(),
    }));
    this.startPivot.p.copy(this.pivot.position);
    this.startPivot.q.copy(this.pivot.quaternion);
    this.cb.dragStart();
  }

  private endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.pivot.scale.set(1, 1, 1);
    this.cb.dragEnd();
  }

  private onChange(): void {
    if (!this.dragging || this.applying) return;
    const out: GizmoUpdate[] = [];
    const dq = this.pivot.quaternion.clone().multiply(this.startPivot.q.clone().invert());
    const dp = this.pivot.position.clone().sub(this.startPivot.p);
    for (const s of this.start) {
      let pos: Vector3, rot: Quaternion;
      // -- ED-A arrange: rotation/scale are centred on the shared pivot, or on each item's own pivot --
      const centre = this.individual ? (s.pivot ?? s.position) : this.startPivot.p;
      if (this.mode === 'rotate') {
        pos = s.position.clone().sub(centre).applyQuaternion(dq).add(centre);
        rot = dq.clone().multiply(s.quaternion);
      } else if (this.mode === 'scale') {
        // Offsets from the pivot grow along the handle's axes; sizes grow below.
        const q = this.startPivot.q;
        pos = s.position
          .clone()
          .sub(centre)
          .applyQuaternion(q.clone().invert())
          .multiply(this.pivot.scale)
          .applyQuaternion(q)
          .add(centre);
        rot = s.quaternion.clone();
      } else {
        pos = s.position.clone().add(dp);
        rot = s.quaternion.clone();
      }
      const u: GizmoUpdate = { id: s.id, position: [pos.x, pos.y, pos.z], rotation: [rot.x, rot.y, rot.z, rot.w] };
      if (this.mode === 'scale') {
        u.scale = [s.size.x * this.pivot.scale.x, s.size.y * this.pivot.scale.y, s.size.z * this.pivot.scale.z];
      }
      out.push(u);
    }
    this.cb.change(out);
  }

  dispose(): void {
    this.controls.dispose();
  }
}

export const eulerOf = (q: Quaternion): Euler => new Euler().setFromQuaternion(q);
