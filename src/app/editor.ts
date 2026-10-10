/**
 * Editor commands — the verbs of the construction workflow (add, connect, duplicate, delete,
 * transform …). They operate on the SceneStore and, when a simulation is live, route pose
 * changes to the live world instead of the document.
 */
import { qconj, qmul, qrot, qrotInv, vadd, vlen, vnorm, vsub, type Quat, type Vec3 } from '../core/math';
import { scaleParts } from '../model/compound';
import { LIMITS } from '../model/limits';
import {
  createBody,
  createGroup,
  createJoint,
  createLight,
  createPath,
  createSoft,
  LIGHT_LABELS,
  SOFT_LABELS,
} from '../model/factory';
import { descendantIds, childIndex, groupTransformPatches, topLevel } from '../model/groups';
import { MATERIAL_PRESETS } from '../model/materials';
import { makeShapeSpec, shapeDef, shapeLabel } from '../model/shapeRegistry';
import { normalizeSize } from '../model/shapes';
import { cloneEntities, type SceneStore } from '../model/store';
import type {
  BodyEntity,
  Entity,
  GroupEntity,
  JointEntity,
  JointType,
  LightEntity,
  LightType,
  PathEntity,
  PosedEntity,
  ShapeType,
  SoftEntity,
  SoftType,
} from '../model/types';
import { isBody, isGroup, isLight, isPath, isPosed, isSoft, parentOf } from '../model/types';
import type { GizmoUpdate } from '../render/gizmo';
import type { SimController } from './simController';

const SPAWN_MATERIALS = ['plastic', 'wood', 'rubber', 'steel', 'ceramic', 'aluminum', 'concrete'];

export interface JointEndpoint {
  /** Body id, or null for the world. */
  body: string | null;
  /** Anchor point in world space. */
  point: Vec3;
}

export class Editor {
  private clipboard: Entity[] = [];
  private spawnCounter = 0;

  constructor(
    readonly store: SceneStore,
    readonly sim: SimController,
  ) {}

  // ---- creation ----------------------------------------------------------------------------

  /** Add a primitive resting on the ground (or at an explicit position). */
  addShape(type: ShapeType, at?: Vec3, over: Partial<BodyEntity> = {}): BodyEntity {
    const shape = makeShapeSpec(type);
    const material = SPAWN_MATERIALS[this.spawnCounter++ % SPAWN_MATERIALS.length];
    const pos: Vec3 = at ?? [0, shape.size[1] / 2, 0];
    const body = createBody({
      name: this.store.uniqueName(shapeLabel(type)),
      shape,
      position: pos,
      material,
      ...over,
    });
    this.store.add([body], `Add ${shapeLabel(type)}`);
    return body;
  }

  /** Add a soft body (jelly, balloon, cloth, cable) at a position, or in front of the view. */
  addSoft(type: SoftType, at?: Vec3, over: Partial<SoftEntity> = {}): SoftEntity {
    const proto = createSoft(type);
    const h =
      type === 'jelly'
        ? proto.size[1] / 2 + 0.06
        : type === 'balloon'
          ? proto.size[0] / 2 + 0.05
          : type === 'cloth'
            ? 2.2
            : 2.2;
    const pos: Vec3 = at ?? [0, h, 0];
    const soft = createSoft(type, { name: this.store.uniqueName(SOFT_LABELS[type]), position: pos, ...over });
    this.store.add([soft], `Add ${SOFT_LABELS[type]}`);
    return soft;
  }

  /** Create a joint between two endpoints, deriving local anchors from current poses. */
  addJoint(
    type: JointType,
    a: JointEndpoint,
    b: JointEndpoint,
    axisWorld?: Vec3,
    over: Partial<JointEntity> = {},
  ): JointEntity | null {
    if (a.body && a.body === b.body) return null;
    const poseA = a.body ? this.sim.poseOf(a.body) : null;
    const poseB = b.body ? this.sim.poseOf(b.body) : null;
    if ((a.body && !poseA) || (b.body && !poseB)) return null;
    const anchorA: Vec3 = poseA ? qrotInv(poseA.rotation, vsub(a.point, poseA.position)) : a.point;
    const anchorB: Vec3 = poseB ? qrotInv(poseB.rotation, vsub(b.point, poseB.position)) : b.point;
    const ax = axisWorld ?? this.defaultAxis(type, a.body, b.body);
    const axis: Vec3 = poseA ? qrotInv(poseA.rotation, ax) : ax;
    const dist = vlen(vsub(a.point, b.point));
    const spring = { restLength: Math.max(0.1, dist), stiffness: 500, damping: 15, breakForce: 0 };
    const joint = createJoint({
      type,
      bodyA: a.body,
      bodyB: b.body,
      anchorA,
      anchorB,
      axis,
      name: this.store.uniqueName(
        type === 'fixed' ? 'Weld' : type === 'ball' ? 'Ball joint' : type[0].toUpperCase() + type.slice(1),
      ),
      ropeLength: Math.max(0.2, dist),
      spring,
      ...over,
    });
    if (type === 'slider')
      joint.motor = {
        ...joint.motor,
        targetVelocity: 1,
        targetPosition: 0.5,
        stiffness: 6000,
        damping: 400,
        maxForce: 8000,
      };
    this.store.add([joint], `Add ${joint.name}`);
    return joint;
  }

  /** Axis chosen when a joint is created: cylinders get their own axle, otherwise the horizontal axis facing the camera. */
  defaultAxis(type: JointType, bodyA: string | null, bodyB: string | null): Vec3 {
    for (const id of [bodyA, bodyB]) {
      const b = id ? this.store.body(id) : undefined;
      if (b && shapeDef(b.shape.type).axial && (type === 'hinge' || type === 'slider')) {
        const pose = this.sim.poseOf(b.id);
        return qrot(pose?.rotation ?? b.rotation, [0, 1, 0]);
      }
    }
    return type === 'slider' ? [0, 1, 0] : (this.cameraHorizontalAxis?.() ?? [0, 0, 1]);
  }

  /** Injected by the app: horizontal world axis most aligned with the camera's viewing direction. */
  cameraHorizontalAxis: (() => Vec3) | null = null;

  // ---- editing -----------------------------------------------------------------------------

  /**
   * Apply gizmo output. While simulating, poses go to the live world and are not saved. Members of a moved group
   * are carried by the group (their own updates would move them twice), and a group moves through
   * `transformGroup`, which carries everything below it.
   */
  applyGizmo(updates: GizmoUpdate[]): void {
    if (this.sim.active) {
      for (const u of updates) if (this.store.body(u.id)) this.sim.teleport(u.id, u.position, u.rotation);
      return;
    }
    const roots = new Set(
      topLevel(
        (id) => this.store.get(id),
        updates.map((u) => u.id),
      ),
    );
    const patches: [string, Partial<Entity>][] = [];
    for (const u of updates) {
      if (!roots.has(u.id)) continue;
      const e = this.store.get(u.id);
      if (isGroup(e)) {
        this.store.transformGroup(u.id, { position: u.position, rotation: u.rotation }, 'Move group');
        continue;
      }
      if (isLight(e) || isPath(e)) {
        patches.push([u.id, { position: u.position, rotation: u.rotation }]);
        continue;
      }
      if (isSoft(e)) {
        const patch: Partial<SoftEntity> = { position: u.position, rotation: u.rotation };
        if (u.scale) patch.size = softSizeFromScale(e, u.scale);
        patches.push([u.id, patch]);
        continue;
      }
      if (!isBody(e)) continue;
      const patch: Partial<BodyEntity> = { position: u.position, rotation: u.rotation };
      if (u.scale) {
        const size = normalizeSize(e.shape.type, u.scale, e.shape.size, e.shape.params);
        patch.shape = { ...e.shape, size };
        // A compound body's parts follow the resize, so scaling the body scales what is drawn and collides.
        if (e.parts?.length) {
          const f = size.map((v, i) => v / e.shape.size[i]) as Vec3;
          patch.parts = scaleParts(e.parts, f);
        }
      }
      patches.push([u.id, patch]);
    }
    this.store.updateMany(patches, 'Transform');
  }

  /** Set an entity's pose from an inspector field. */
  setPose(id: string, position: Vec3, rotation: Quat): void {
    const e = this.store.get(id);
    if (isGroup(e)) {
      // A group's members are document poses: moving the group while a simulation owns them would be meaningless.
      if (!this.sim.active) this.store.transformGroup(id, { position, rotation }, 'Transform');
    } else if (isLight(e) || isPath(e)) this.store.update(id, { position, rotation }, 'Transform');
    else if (this.sim.active && !this.store.soft(id)) this.sim.teleport(id, position, rotation);
    else if (!this.sim.active) this.store.update(id, { position, rotation }, 'Transform');
  }

  /**
   * Move entities to absolute positions in one edit (viewport drag): a group carries its members, everything else
   * just moves. Entries whose ancestor group is moving too are ignored.
   */
  moveTo(targets: Map<string, Vec3>, label = 'Move'): void {
    const roots = new Set(topLevel((id) => this.store.get(id), [...targets.keys()]));
    const patches: [string, Partial<Entity>][] = [];
    for (const [id, position] of targets) {
      if (!roots.has(id)) continue;
      if (this.store.group(id)) this.store.transformGroup(id, { position }, label);
      else patches.push([id, { position }]);
    }
    if (patches.length) this.store.updateMany(patches, label);
  }

  translate(ids: string[], delta: Vec3): void {
    if (this.sim.active) {
      for (const id of ids) {
        const p = this.sim.poseOf(id);
        if (p) this.sim.teleport(id, vadd(p.position, delta), p.rotation);
      }
      return;
    }
    const targets = new Map<string, Vec3>();
    for (const id of ids) {
      const e = this.store.get(id);
      if (isPosed(e) && !e.locked) targets.set(id, vadd(e.position, delta));
    }
    this.moveTo(targets);
  }

  deleteSelection(): void {
    const ids = [...this.store.selection];
    if (ids.length) this.store.remove(ids, ids.length > 1 ? `Delete ${ids.length} objects` : 'Delete');
  }

  duplicateSelection(): void {
    const ids = this.store.selection.filter((id) => this.store.has(id));
    if (!ids.length) return;
    const copies = this.store.clone(ids, [0.6, 0, 0.6]);
    if (!copies.length) return;
    // Give copies fresh names.
    const renamed = copies.map((c) => ({ ...c, name: this.nameForCopy(c.name) }));
    this.store.add(renamed, 'Duplicate', false);
    // Select the copies that are not inside another copy (a copied group brings its members).
    this.store.setSelection(
      topLevel(
        (id) => this.store.get(id),
        renamed.map((c) => c.id),
      ),
    );
  }

  private nameForCopy(base: string): string {
    return this.store.uniqueName(base.replace(/ \d+$/, ''));
  }

  copy(): void {
    const ids = this.store.selection;
    this.clipboard = this.store.clone(ids, [0, 0, 0]);
  }

  paste(at?: Vec3): void {
    if (!this.clipboard.length) return;
    // Re-clone with new ids on every paste and shift away from the originals.
    const bodies = this.clipboard.filter(isBody);
    const center: Vec3 = bodies.length
      ? [
          bodies.reduce((s, b) => s + b.position[0], 0) / bodies.length,
          bodies.reduce((s, b) => s + b.position[1], 0) / bodies.length,
          bodies.reduce((s, b) => s + b.position[2], 0) / bodies.length,
        ]
      : [0, 0, 0];
    const offset: Vec3 = at ? [at[0] - center[0], 0, at[2] - center[2]] : [0.8, 0, 0.8];
    const copies = cloneEntities(
      this.clipboard,
      this.clipboard.map((e) => e.id),
      offset,
    ).map((c) => ({ ...c, name: this.nameForCopy(c.name) }));
    this.store.add(copies, 'Paste');
  }

  selectAll(): void {
    this.store.setSelection(this.store.all().map((e) => e.id));
  }

  setBodyType(ids: string[], bodyType: BodyEntity['bodyType']): void {
    this.store.updateMany(
      ids.filter((id) => this.store.body(id)).map((id) => [id, { bodyType }]),
      'Change body type',
    );
  }

  /**
   * Lock / hide entities (all of them end up with the same value). Toggling a group applies to everything below it
   * too — "hide this group" hides what is in it.
   */
  toggleFlag(ids: string[], flag: 'locked' | 'hidden'): void {
    const has = (e: Entity): boolean => flag === 'hidden' || isPosed(e);
    const direct = ids.map((id) => this.store.get(id)).filter((e): e is Entity => !!e && has(e));
    if (!direct.length) return;
    const get = (e: Entity) => (e as unknown as Record<string, boolean>)[flag];
    const value = !direct.every(get);
    const targets = new Map<string, Entity>(direct.map((e) => [e.id, e]));
    for (const e of direct)
      if (isGroup(e)) for (const d of this.store.descendants(e.id)) if (has(d)) targets.set(d.id, d);
    this.store.updateMany(
      [...targets.keys()].map((id) => [id, { [flag]: value }]),
      value ? (flag === 'locked' ? 'Lock' : 'Hide') : flag === 'locked' ? 'Unlock' : 'Show',
    );
  }

  /** Write the current simulated poses into the document (becomes the new starting layout). */
  captureLivePose(): number {
    if (!this.sim.active) return 0;
    const patches: [string, Partial<Entity>][] = [];
    for (const b of this.store.bodies()) {
      const p = this.sim.poseOf(b.id);
      if (p && b.bodyType !== 'static') patches.push([b.id, { position: p.position, rotation: p.rotation }]);
    }
    // Joint frames are body-relative, so they follow automatically.
    this.store.updateMany(patches, 'Capture simulation state');
    return patches.length;
  }

  /** Rotate the selection 90° about world Y around its centre (quick alignment helper). */
  rotateSelection90(): void {
    const q: Quat = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    const roots = topLevel((id) => this.store.get(id), this.store.selection)
      .map((id) => this.store.get(id))
      .filter((e): e is PosedEntity => isPosed(e) && !e.locked);
    if (!roots.length) return;
    const cx = roots.reduce((s, b) => s + b.position[0], 0) / roots.length;
    const cz = roots.reduce((s, b) => s + b.position[2], 0) / roots.length;
    const patches: [string, Partial<Entity>][] = [];
    for (const e of roots) {
      const rel = qrot(q, [e.position[0] - cx, 0, e.position[2] - cz]);
      const position: Vec3 = [cx + rel[0], e.position[1], cz + rel[2]];
      const rotation = qmul(q, e.rotation);
      if (isGroup(e)) patches.push(...groupTransformPatches(this.store.all(), e.id, { position, rotation }));
      else patches.push([e.id, { position, rotation }]);
    }
    this.store.updateMany(patches, 'Rotate 90°');
  }

  // ---- groups, lights, paths (FB-6) --------------------------------------------------------

  /** Add an empty group at `at`, or — with a selection — a group around it (see `groupSelection`). */
  addGroup(at: Vec3 = [0, 0, 0]): GroupEntity {
    const g = createGroup({ name: this.store.uniqueName('Group'), position: at });
    this.store.add([g], 'Add group');
    return g;
  }

  addLight(type: LightType, at?: Vec3, over: Partial<LightEntity> = {}): LightEntity {
    const proto = createLight(type);
    const light = createLight(type, {
      name: this.store.uniqueName(LIGHT_LABELS[type]),
      position: at ?? proto.position,
      ...over,
    });
    this.store.add([light], `Add ${LIGHT_LABELS[type].toLowerCase()}`);
    return light;
  }

  addPath(at?: Vec3, over: Partial<PathEntity> = {}): PathEntity {
    const proto = createPath();
    const path = createPath({ name: this.store.uniqueName('Path'), position: at ?? proto.position, ...over });
    this.store.add([path], 'Add path');
    return path;
  }

  /**
   * Put the selected entities (the top-level ones: a selected group already carries its members) into a new group
   * whose pivot is their centre. The new group sits under the members' common parent, if they share one. One undo step.
   * Returns the group, or null when nothing groupable is selected.
   */
  groupSelection(ids: string[] = this.store.selection): GroupEntity | null {
    const members = topLevel((id) => this.store.get(id), ids)
      .map((id) => this.store.get(id))
      .filter((e): e is PosedEntity => isPosed(e));
    if (!members.length) return null;
    const c = members.reduce<Vec3>((a, e) => vadd(a, e.position), [0, 0, 0]);
    const parents = new Set(members.map((m) => m.parent));
    const parent = parents.size === 1 ? [...parents][0] : undefined;
    const g = createGroup({
      name: this.store.uniqueName('Group'),
      position: [c[0] / members.length, c[1] / members.length, c[2] / members.length],
      ...(parent !== undefined ? { parent } : {}),
    });
    this.store.transact('Group', () => {
      this.store.add([g], 'Group', false);
      this.store.updateMany(
        members.map((m) => [m.id, { parent: g.id }]),
        'Group',
      );
    });
    this.store.setSelection([g.id]);
    return g;
  }

  /** Dissolve the selected groups: their members move up to the group's own parent. One undo step. */
  ungroup(ids: string[] = this.store.selection): number {
    const groups = ids.map((id) => this.store.group(id)).filter((g): g is GroupEntity => !!g);
    if (!groups.length) return 0;
    const freed: string[] = [];
    this.store.transact('Ungroup', () => {
      for (const g of groups) {
        const kids = this.store.children(g.id);
        // Re-parent to the grandparent first; removing the group then releases whatever is left.
        if (g.parent !== undefined && this.store.has(g.parent) && !groups.some((o) => o.id === g.parent)) {
          this.store.updateMany(
            kids.map((k) => [k.id, { parent: g.parent }]),
            'Ungroup',
          );
        }
        freed.push(...kids.map((k) => k.id));
      }
      this.store.remove(
        groups.map((g) => g.id),
        'Ungroup',
      );
    });
    this.store.setSelection(freed.filter((id) => this.store.has(id)));
    return groups.length;
  }

  /**
   * Put entities under `parentId` (a group), or take them out of their group with `null`. Members keep their world
   * pose. Refuses to create a cycle (a group inside itself or one of its descendants). One undo step.
   */
  setParent(ids: string[], parentId: string | null): boolean {
    const target = parentId === null ? null : this.store.get(parentId);
    if (parentId !== null && !target) return false;
    const index = childIndex(this.store.all());
    const patches: [string, Partial<Entity>][] = [];
    for (const id of ids) {
      const e = this.store.get(id);
      if (!isPosed(e) || e.id === parentId) continue;
      if (parentId !== null && descendantIds(index, id).includes(parentId)) continue; // would loop
      if (parentOf(e) === (parentId ?? undefined)) continue;
      patches.push([id, { parent: parentId ?? undefined }]);
    }
    if (!patches.length) return false;
    this.store.updateMany(patches, parentId === null ? 'Remove from group' : 'Move into group');
    return true;
  }

  /** Move control point `index` of a path to a world position (converted into the path's frame). */
  movePathPoint(id: string, index: number, world: Vec3): void {
    const path = this.store.path(id);
    if (!path || !path.points[index]) return;
    const local = qrotInv(path.rotation, vsub(world, path.position));
    const points = path.points.map((p, i) => (i === index ? local : p));
    this.store.update(id, { points }, 'Move path point');
  }

  /** Insert a control point after `index` (halfway to the next one; beyond the end it continues the last direction). */
  insertPathPoint(id: string, index: number): number {
    const path = this.store.path(id);
    if (!path || path.points.length >= LIMITS.maxPathPoints) return -1;
    const pts = path.points;
    const i = Math.max(0, Math.min(pts.length - 1, index));
    const a = pts[i];
    const b = pts[i + 1] ?? (path.closed ? pts[0] : undefined);
    const p: Vec3 = b
      ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
      : vadd(a, vnorm(vsub(a, pts[i - 1] ?? [a[0] - 1, a[1], a[2]]), [1, 0, 0]));
    const points = [...pts.slice(0, i + 1), p, ...pts.slice(i + 1)];
    this.store.update(id, { points }, 'Add path point');
    return i + 1;
  }

  /** Remove control point `index`; a path keeps at least two points (three while it is closed). */
  removePathPoint(id: string, index: number): boolean {
    const path = this.store.path(id);
    if (!path || !path.points[index]) return false;
    if (path.points.length <= (path.closed ? 3 : 2)) return false;
    this.store.update(id, { points: path.points.filter((_, i) => i !== index) }, 'Remove path point');
    return true;
  }

  /** Axis (world) → vector helpers used by the joint inspector. */
  worldAxisToLocal(bodyId: string | null, axis: Vec3): Vec3 {
    const pose = bodyId
      ? (this.sim.poseOf(bodyId) ?? (this.store.body(bodyId) ? { rotation: this.store.body(bodyId)!.rotation } : null))
      : null;
    if (!pose) return vnorm(axis);
    return vnorm(qrot(qconj(pose.rotation), axis));
  }

  nextPreset(): string {
    return MATERIAL_PRESETS[this.spawnCounter % MATERIAL_PRESETS.length].id;
  }
}

/** Map a gizmo scale (new size) onto the dimensions a soft body actually has. */
function softSizeFromScale(e: SoftEntity, s: Vec3): Vec3 {
  const m = (v: number) => Math.max(0.1, v);
  switch (e.type) {
    case 'jelly':
      return [m(s[0]), m(s[1]), m(s[2])];
    case 'balloon': {
      // Uniform: follow whichever axis the user dragged the most.
      const k = [0, 1, 2].reduce(
        (best, i) => (Math.abs(s[i] - e.size[0]) > Math.abs(s[best] - e.size[0]) ? i : best),
        0,
      );
      const d = m(s[k]);
      return [d, d, d];
    }
    case 'cloth':
      return [m(s[0]), 0, m(s[2])];
    case 'cable':
      return [m(s[0]), 0, 0];
  }
}
