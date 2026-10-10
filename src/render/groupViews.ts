/**
 * Group views: a group is drawn as a dashed box around everything below it plus a small diamond with axes at its pivot
 * (the diamond is the click target; the transform gizmo attaches to it). Groups exist only in the document, so the
 * helpers are hidden while a simulation owns the poses of the members.
 *
 * The box is recomputed lazily: `markDirty()` on any document change, and the next `update()` rebuilds the boxes of
 * the groups that are shown.
 */
import {
  BufferGeometry,
  Box3,
  Color,
  Float32BufferAttribute,
  Group,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  Vector3,
  type Object3D,
} from 'three';
import type { GroupEntity } from '../model/types';

const NEUTRAL = new Color('#9fb0c8');
const SELECTED = new Color('#5ec8ff');
const PAD = 0.1;
const EMPTY_HALF = 0.35;

/** The 12 edges of a box as line-segment vertices. */
function boxEdges(min: Vector3, max: Vector3): Float32Array {
  const c = [
    [min.x, min.y, min.z],
    [max.x, min.y, min.z],
    [max.x, max.y, min.z],
    [min.x, max.y, min.z],
    [min.x, min.y, max.z],
    [max.x, min.y, max.z],
    [max.x, max.y, max.z],
    [min.x, max.y, max.z],
  ];
  const edges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  const out = new Float32Array(edges.length * 3);
  edges.forEach((ci, i) => out.set(c[ci], i * 3));
  return out;
}

const diamond = new OctahedronGeometry(0.14);

export class GroupView {
  readonly root = new Group();
  readonly bounds: LineSegments;
  readonly pivot: Mesh;
  private readonly boundsMat = new LineDashedMaterial({
    dashSize: 0.18,
    gapSize: 0.12,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
  });
  private readonly pivotMat = new MeshBasicMaterial({ depthTest: false, transparent: true });
  selected = false;
  /** World-space box of the members as last computed (null while the group is empty). */
  box: Box3 | null = null;

  constructor(public def: GroupEntity) {
    this.bounds = new LineSegments(new BufferGeometry(), this.boundsMat);
    this.bounds.frustumCulled = false;
    this.bounds.renderOrder = 997;
    this.bounds.userData.entityId = def.id;
    this.pivot = new Mesh(diamond, this.pivotMat);
    this.pivot.renderOrder = 997;
    this.pivot.userData.entityId = def.id;
    this.root.add(this.bounds, this.pivot);
    this.apply(def);
  }

  apply(def: GroupEntity): void {
    this.def = def;
    this.pivot.position.set(...def.position);
    this.pivot.quaternion.set(...def.rotation);
    this.bounds.userData.entityId = def.id;
    this.pivot.userData.entityId = def.id;
    this.refreshState();
  }

  refreshState(): void {
    const c = this.selected ? SELECTED : NEUTRAL;
    this.boundsMat.color.copy(c);
    this.pivotMat.color.copy(c);
    this.boundsMat.opacity = this.selected ? 1 : 0.6;
    this.pivotMat.opacity = this.selected ? 1 : 0.8;
  }

  /** Rebuild the dashed box around `box` (or a small cube at the pivot for an empty group). */
  setBounds(box: Box3 | null): void {
    this.box = box;
    const min = new Vector3();
    const max = new Vector3();
    if (box && !box.isEmpty()) {
      min.copy(box.min).addScalar(-PAD);
      max.copy(box.max).addScalar(PAD);
    } else {
      const p = this.def.position;
      min.set(p[0] - EMPTY_HALF, p[1] - EMPTY_HALF, p[2] - EMPTY_HALF);
      max.set(p[0] + EMPTY_HALF, p[1] + EMPTY_HALF, p[2] + EMPTY_HALF);
    }
    this.bounds.geometry.dispose();
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(boxEdges(min, max), 3));
    this.bounds.geometry = g;
    this.bounds.computeLineDistances();
  }

  dispose(): void {
    this.bounds.geometry.dispose();
    this.boundsMat.dispose();
    this.pivotMat.dispose();
  }
}

export class GroupViews {
  readonly views = new Map<string, GroupView>();
  private dirty = true;
  /** Hidden while a simulation owns the members' poses. */
  visible = true;

  constructor(readonly group: Group) {}

  get(id: string): GroupView | undefined {
    return this.views.get(id);
  }

  add(def: GroupEntity): GroupView {
    this.remove(def.id);
    const v = new GroupView(def);
    this.views.set(def.id, v);
    this.group.add(v.root);
    this.dirty = true;
    return v;
  }

  update(def: GroupEntity): void {
    const v = this.views.get(def.id);
    if (!v) this.add(def);
    else v.apply(def);
    this.dirty = true;
  }

  remove(id: string): void {
    const v = this.views.get(id);
    if (!v) return;
    this.group.remove(v.root);
    v.dispose();
    this.views.delete(id);
    this.dirty = true;
  }

  clear(): void {
    for (const id of [...this.views.keys()]) this.remove(id);
  }

  /** Something in the document changed: member boxes must be recomputed. */
  markDirty(): void {
    this.dirty = true;
  }

  setSelected(ids: Set<string>): void {
    for (const v of this.views.values()) {
      const s = ids.has(v.def.id);
      if (s !== v.selected) {
        v.selected = s;
        v.refreshState();
      }
    }
  }

  /**
   * Per frame: show / hide the helpers and, when the document changed, recompute the boxes.
   * `boundsOf(id, box)` grows `box` by what the entity with that id occupies (called for every descendant).
   * `descendants(id)` lists the ids below a group.
   */
  tick(
    simulating: boolean,
    descendants: (groupId: string) => string[],
    boundsOf: (id: string, box: Box3) => void,
  ): void {
    for (const v of this.views.values()) v.root.visible = this.visible && !simulating && !v.def.hidden;
    if (!this.dirty || simulating) return;
    this.dirty = false;
    const box = new Box3();
    for (const v of this.views.values()) {
      box.makeEmpty();
      for (const id of descendants(v.def.id)) boundsOf(id, box);
      v.setBounds(box.isEmpty() ? null : box.clone());
    }
  }

  /** Click targets: the pivot diamonds and the box edges of visible groups. */
  pickables(): Object3D[] {
    const out: Object3D[] = [];
    if (!this.visible) return out;
    for (const v of this.views.values()) if (v.root.visible) out.push(v.pivot, v.bounds);
    return out;
  }
}
