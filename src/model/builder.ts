/** Tiny builder DSL shared by the example scenes and the prefab library. */
import { DEG, qfromAxisAngle, qrotInv, vsub, type Quat, type Vec3 } from '../core/math';
import { createBody, createJoint, createSoft, newDocument } from './factory';
import type {
  BodyEntity,
  Entity,
  JointEntity,
  JointType,
  MaterialSpec,
  MotorSpec,
  SceneDocument,
  ShapeType,
  SoftEntity,
  SoftType,
} from './types';

export type BodyOpts = Omit<Partial<BodyEntity>, 'material'> & { material?: string | Partial<MaterialSpec> };

export class Builder {
  doc = newDocument();

  constructor(name: string) {
    this.doc.name = name;
  }

  body(name: string, type: ShapeType, size: Vec3, position: Vec3, o: BodyOpts = {}): BodyEntity {
    const { material, ...rest } = o;
    const b = createBody({
      name,
      shape: { type, size, ...(type === 'prism' ? { sides: 6 } : {}) },
      position,
      material: material ?? 'plastic',
      ...rest,
    });
    this.doc.entities.push(b);
    return b;
  }

  soft(name: string, type: SoftType, position: Vec3, over: Partial<SoftEntity> = {}): SoftEntity {
    const s = createSoft(type, { name, position, ...over });
    this.doc.entities.push(s);
    return s;
  }

  /** Joint at a world point; `axis` is a world-space axis (hinge / slider). */
  joint(
    type: JointType,
    a: BodyEntity | null,
    b: BodyEntity | null,
    point: Vec3,
    axis: Vec3 = [0, 0, 1],
    o: Partial<JointEntity> = {},
  ): JointEntity {
    const anchorA = a ? qrotInv(a.rotation, vsub(point, a.position)) : point;
    const anchorB = b ? qrotInv(b.rotation, vsub(point, b.position)) : point;
    const ax = a ? qrotInv(a.rotation, axis) : axis;
    const j = createJoint({ type, bodyA: a?.id ?? null, bodyB: b?.id ?? null, anchorA, anchorB, axis: ax, ...o });
    this.doc.entities.push(j);
    return j;
  }

  /** Spring / rope between two world points (rest length / rope length = their distance by default). */
  tether(
    type: 'spring' | 'rope',
    a: BodyEntity | null,
    pa: Vec3,
    b: BodyEntity | null,
    pb: Vec3,
    o: Partial<JointEntity> = {},
  ): JointEntity {
    const anchorA = a ? qrotInv(a.rotation, vsub(pa, a.position)) : pa;
    const anchorB = b ? qrotInv(b.rotation, vsub(pb, b.position)) : pb;
    const len = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
    const j = createJoint({
      type,
      bodyA: a?.id ?? null,
      bodyB: b?.id ?? null,
      anchorA,
      anchorB,
      ropeLength: len,
      spring: { restLength: len, stiffness: 500, damping: 15, breakForce: 0 },
      ...o,
    });
    this.doc.entities.push(j);
    return j;
  }

  done(): SceneDocument {
    return this.doc;
  }
}

export const rotY = (deg: number): Quat => qfromAxisAngle([0, 1, 0], deg * DEG);
export const rotZ = (deg: number): Quat => qfromAxisAngle([0, 0, 1], deg * DEG);
export const rotX = (deg: number): Quat => qfromAxisAngle([1, 0, 0], deg * DEG);
export const noKeys = { keyPos: '', keyNeg: '' };
export const idleMotor = (): MotorSpec => ({
  mode: 'off',
  targetVelocity: 0,
  targetPosition: 0,
  stiffness: 0,
  damping: 0,
  maxForce: 0,
  ...noKeys,
  slewRate: 1,
  brake: false,
});

export function translateEntities(list: Entity[], d: Vec3): Entity[] {
  return list.map((e) => {
    if (e.kind !== 'joint')
      return { ...e, position: [e.position[0] + d[0], e.position[1] + d[1], e.position[2] + d[2]] as Vec3 };
    return {
      ...e,
      anchorA: e.bodyA ? e.anchorA : ([e.anchorA[0] + d[0], e.anchorA[1] + d[1], e.anchorA[2] + d[2]] as Vec3),
      anchorB: e.bodyB ? e.anchorB : ([e.anchorB[0] + d[0], e.anchorB[1] + d[1], e.anchorB[2] + d[2]] as Vec3),
    };
  });
}
