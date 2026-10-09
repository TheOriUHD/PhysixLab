import { qident, type Quat, type Vec3 } from '../core/math';
import { materialFromPreset } from './materials';
import { defaultSize, SHAPE_LABELS } from './shapes';
import type {
  BodyEntity, GroundSettings, JointEntity, JointType, MaterialSpec, MotorSpec, SceneDocument,
  SceneSettings, ShapeSpec, ShapeType,
} from './types';

let counter = 0;
/** Short, collision-resistant id. */
export function uid(prefix: string): string {
  counter = (counter + 1) % 1679616;
  const r = Math.floor(Math.random() * 46656).toString(36).padStart(3, '0');
  return `${prefix}_${Date.now().toString(36).slice(-4)}${counter.toString(36)}${r}`;
}

export const DEFAULT_GRAVITY: Vec3 = [0, -9.81, 0];

export function defaultGround(): GroundSettings {
  return { enabled: true, friction: 0.8, restitution: 0.1, halfSize: 60, color: '#2b3038' };
}

export function defaultSettings(): SceneSettings {
  return {
    gravity: [...DEFAULT_GRAVITY],
    ground: defaultGround(),
    physicsHz: 120,
    solverIterations: 6,
    airDrag: 0,
  };
}

export function newDocument(name = 'Untitled scene'): SceneDocument {
  return { format: 'physicslab-scene', version: 1, name, settings: defaultSettings(), entities: [] };
}

export interface BodyInit {
  name?: string;
  shape?: Partial<ShapeSpec> & { type: ShapeType };
  position?: Vec3;
  rotation?: Quat;
  bodyType?: BodyEntity['bodyType'];
  material?: string | Partial<MaterialSpec>;
  [k: string]: unknown;
}

export function createBody(init: BodyInit): BodyEntity {
  const type = init.shape?.type ?? 'box';
  const shape: ShapeSpec = {
    type,
    size: init.shape?.size ? [...init.shape.size] as Vec3 : defaultSize(type),
    ...(type === 'prism' ? { sides: init.shape?.sides ?? 6 } : {}),
  };
  const matInit = init.material;
  const material =
    typeof matInit === 'string'
      ? materialFromPreset(matInit)
      : materialFromPreset(matInit?.preset ?? 'plastic', matInit ?? {});
  const { name, position, rotation, bodyType, shape: _s, material: _m, ...rest } = init;
  return {
    kind: 'body',
    id: uid('b'),
    name: name ?? SHAPE_LABELS[type],
    shape,
    position: position ? [...position] as Vec3 : [0, 0, 0],
    rotation: rotation ? [...rotation] as Quat : qident(),
    bodyType: bodyType ?? 'dynamic',
    material,
    linearDamping: 0.01,
    angularDamping: 0.02,
    gravityScale: 1,
    ccd: false,
    canSleep: true,
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    lockPosition: [false, false, false],
    lockRotation: [false, false, false],
    thrust: null,
    ghost: false,
    locked: false,
    hidden: false,
    ...(rest as Partial<BodyEntity>),
  };
}

export function defaultMotor(): MotorSpec {
  return {
    mode: 'off',
    targetVelocity: 6,
    targetPosition: 0,
    stiffness: 4000,
    damping: 200,
    maxForce: 5000,
    keyPos: '',
    keyNeg: '',
    slewRate: 4,
    brake: true,
  };
}

export interface JointInit {
  type: JointType;
  name?: string;
  bodyA: string | null;
  bodyB: string | null;
  anchorA: Vec3;
  anchorB?: Vec3;
  axis?: Vec3;
  [k: string]: unknown;
}

const JOINT_LABELS: Record<JointType, string> = {
  fixed: 'Weld',
  hinge: 'Hinge',
  slider: 'Slider',
  ball: 'Ball joint',
  spring: 'Spring',
  rope: 'Rope',
};
export const JOINT_TYPE_LABELS = JOINT_LABELS;

export function createJoint(init: JointInit): JointEntity {
  const { name, type, bodyA, bodyB, anchorA, anchorB, axis, ...rest } = init;
  return {
    kind: 'joint',
    id: uid('j'),
    name: name ?? JOINT_LABELS[type],
    type,
    bodyA,
    bodyB,
    anchorA: [...anchorA] as Vec3,
    anchorB: anchorB ? [...anchorB] as Vec3 : [...anchorA] as Vec3,
    axis: axis ? [...axis] as Vec3 : [0, 0, 1],
    limit: { enabled: false, min: -Math.PI / 2, max: Math.PI / 2 },
    motor: defaultMotor(),
    spring: { restLength: 1, stiffness: 400, damping: 12, breakForce: 0 },
    ropeLength: 2,
    collideConnected: false,
    hidden: false,
    ...(rest as Partial<JointEntity>),
  };
}
