/**
 * Editor commands — the verbs of the construction workflow (add, connect, duplicate, delete,
 * transform …). They operate on the SceneStore and, when a simulation is live, route pose
 * changes to the live world instead of the document.
 */
import {
  qconj, qmul, qrot, qrotInv, vadd, vlen, vnorm, vsub, type Quat, type Vec3,
} from '../core/math';
import { createBody, createJoint } from '../model/factory';
import { MATERIAL_PRESETS } from '../model/materials';
import { defaultSize, normalizeSize, SHAPE_LABELS } from '../model/shapes';
import { cloneEntities, type SceneStore } from '../model/store';
import type { BodyEntity, Entity, JointEntity, JointType, ShapeType } from '../model/types';
import { isBody } from '../model/types';
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

  constructor(readonly store: SceneStore, readonly sim: SimController) {}

  // ---- creation ----------------------------------------------------------------------------

  /** Add a primitive resting on the ground (or at an explicit position). */
  addShape(type: ShapeType, at?: Vec3, over: Partial<BodyEntity> = {}): BodyEntity {
    const size = defaultSize(type);
    const material = SPAWN_MATERIALS[this.spawnCounter++ % SPAWN_MATERIALS.length];
    const pos: Vec3 = at ?? [0, size[1] / 2, 0];
    const body = createBody({
      name: this.store.uniqueName(SHAPE_LABELS[type]),
      shape: { type, size, ...(type === 'prism' ? { sides: 6 } : {}) },
      position: pos,
      material,
      ...over,
    });
    this.store.add([body], `Add ${SHAPE_LABELS[type]}`);
    return body;
  }

  /** Create a joint between two endpoints, deriving local anchors from current poses. */
  addJoint(type: JointType, a: JointEndpoint, b: JointEndpoint, axisWorld?: Vec3, over: Partial<JointEntity> = {}): JointEntity | null {
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
      type, bodyA: a.body, bodyB: b.body, anchorA, anchorB, axis,
      name: this.store.uniqueName(type === 'fixed' ? 'Weld' : type === 'ball' ? 'Ball joint' : type[0].toUpperCase() + type.slice(1)),
      ropeLength: Math.max(0.2, dist),
      spring,
      ...over,
    });
    if (type === 'slider') joint.motor = { ...joint.motor, targetVelocity: 1, targetPosition: 0.5, stiffness: 6000, damping: 400, maxForce: 8000 };
    this.store.add([joint], `Add ${joint.name}`);
    return joint;
  }

  /** Axis chosen when a joint is created: cylinders get their own axle, otherwise the horizontal axis facing the camera. */
  defaultAxis(type: JointType, bodyA: string | null, bodyB: string | null): Vec3 {
    for (const id of [bodyA, bodyB]) {
      const b = id ? this.store.body(id) : undefined;
      if (b && (b.shape.type === 'cylinder' || b.shape.type === 'cone' || b.shape.type === 'capsule') && (type === 'hinge' || type === 'slider')) {
        const pose = this.sim.poseOf(b.id);
        return qrot(pose?.rotation ?? b.rotation, [0, 1, 0]);
      }
    }
    return type === 'slider' ? [0, 1, 0] : this.cameraHorizontalAxis?.() ?? [0, 0, 1];
  }

  /** Injected by the app: horizontal world axis most aligned with the camera's viewing direction. */
  cameraHorizontalAxis: (() => Vec3) | null = null;

  // ---- editing -----------------------------------------------------------------------------

  /** Apply gizmo output. While simulating, poses go to the live world and are not saved. */
  applyGizmo(updates: GizmoUpdate[]): void {
    if (this.sim.active) {
      for (const u of updates) this.sim.teleport(u.id, u.position, u.rotation);
      return;
    }
    const patches: [string, Partial<Entity>][] = [];
    for (const u of updates) {
      const e = this.store.get(u.id);
      if (!isBody(e)) continue;
      const patch: Partial<BodyEntity> = { position: u.position, rotation: u.rotation };
      if (u.scale) patch.shape = { ...e.shape, size: normalizeSize(e.shape.type, u.scale, e.shape.size) };
      patches.push([u.id, patch]);
    }
    this.store.updateMany(patches, 'Transform');
  }

  /** Set a body's pose from an inspector field. */
  setPose(id: string, position: Vec3, rotation: Quat): void {
    if (this.sim.active) this.sim.teleport(id, position, rotation);
    else this.store.update(id, { position, rotation } as Partial<BodyEntity>, 'Transform');
  }

  translate(ids: string[], delta: Vec3): void {
    if (this.sim.active) {
      for (const id of ids) {
        const p = this.sim.poseOf(id);
        if (p) this.sim.teleport(id, vadd(p.position, delta), p.rotation);
      }
      return;
    }
    const patches: [string, Partial<Entity>][] = [];
    for (const id of ids) {
      const e = this.store.body(id);
      if (e && !e.locked) patches.push([id, { position: vadd(e.position, delta) } as Partial<BodyEntity>]);
    }
    this.store.updateMany(patches, 'Move');
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
    const renamed = copies.map((c) => ({ ...c, name: this.nameForCopy(c.name) } as Entity));
    this.store.add(renamed, 'Duplicate');
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
    const copies = cloneEntities(this.clipboard, this.clipboard.map((e) => e.id), offset).map((c) => ({ ...c, name: this.nameForCopy(c.name) } as Entity));
    this.store.add(copies, 'Paste');
  }

  selectAll(): void {
    this.store.setSelection(this.store.all().map((e) => e.id));
  }

  setBodyType(ids: string[], bodyType: BodyEntity['bodyType']): void {
    this.store.updateMany(ids.filter((id) => this.store.body(id)).map((id) => [id, { bodyType } as Partial<BodyEntity>]), 'Change body type');
  }

  toggleFlag(ids: string[], flag: 'locked' | 'hidden'): void {
    const es = ids.map((id) => this.store.get(id)).filter((e): e is Entity => !!e && (flag === 'hidden' || isBody(e)));
    if (!es.length) return;
    const value = !es.every((e) => (e as unknown as Record<string, boolean>)[flag]);
    this.store.updateMany(es.map((e) => [e.id, { [flag]: value } as Partial<Entity>]), value ? (flag === 'locked' ? 'Lock' : 'Hide') : flag === 'locked' ? 'Unlock' : 'Show');
  }

  /** Write the current simulated poses into the document (becomes the new starting layout). */
  captureLivePose(): number {
    if (!this.sim.active) return 0;
    const patches: [string, Partial<Entity>][] = [];
    for (const b of this.store.bodies()) {
      const p = this.sim.poseOf(b.id);
      if (p && b.bodyType !== 'static') patches.push([b.id, { position: p.position, rotation: p.rotation } as Partial<BodyEntity>]);
    }
    // Joint frames are body-relative, so they follow automatically.
    this.store.updateMany(patches, 'Capture simulation state');
    return patches.length;
  }

  /** Rotate the selection 90° about world Y (quick alignment helper). */
  rotateSelection90(): void {
    const q: Quat = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    const bodies = this.store.selectedBodies();
    if (!bodies.length) return;
    const cx = bodies.reduce((s, b) => s + b.position[0], 0) / bodies.length;
    const cz = bodies.reduce((s, b) => s + b.position[2], 0) / bodies.length;
    this.store.updateMany(
      bodies.map((b) => {
        const rel = qrot(q, [b.position[0] - cx, 0, b.position[2] - cz]);
        const pos: Vec3 = [cx + rel[0], b.position[1], cz + rel[2]];
        return [b.id, { position: pos, rotation: qmul(q, b.rotation) } as Partial<BodyEntity>];
      }),
      'Rotate 90°',
    );
  }

  /** Axis (world) → vector helpers used by the joint inspector. */
  worldAxisToLocal(bodyId: string | null, axis: Vec3): Vec3 {
    const pose = bodyId ? this.sim.poseOf(bodyId) ?? (this.store.body(bodyId) ? { rotation: this.store.body(bodyId)!.rotation } : null) : null;
    if (!pose) return vnorm(axis);
    return vnorm(qrot(qconj(pose.rotation), axis));
  }

  nextPreset(): string {
    return MATERIAL_PRESETS[this.spawnCounter % MATERIAL_PRESETS.length].id;
  }
}
