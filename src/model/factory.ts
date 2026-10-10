import { qident, type Quat, type Vec3 } from '../core/math';
import { materialFromPreset } from './materials';
import { SCENE_FORMAT, SCENE_VERSION } from './migrations';
import { makeShapeSpec, shapeLabel } from './shapeRegistry';
import type {
  BodyEntity,
  BoundsSettings,
  CollisionSpec,
  EnvironmentSettings,
  GroundSettings,
  JointEntity,
  JointType,
  MaterialSpec,
  MotorSpec,
  SceneDocument,
  SceneSettings,
  ShapeSpec,
  ShapeType,
  SoftEntity,
  SoftType,
  UnitsSettings,
} from './types';

let counter = 0;
/** Short, collision-resistant id. */
export function uid(prefix: string): string {
  counter = (counter + 1) % 1679616;
  const r = Math.floor(Math.random() * 46656)
    .toString(36)
    .padStart(3, '0');
  return `${prefix}_${Date.now().toString(36).slice(-4)}${counter.toString(36)}${r}`;
}

export const DEFAULT_GRAVITY: Vec3 = [0, -9.81, 0];

export function defaultGround(): GroundSettings {
  return { enabled: true, friction: 0.8, restitution: 0.1, halfSize: 60, color: '#2b3038' };
}

/** Group 0, colliding with every group. */
export const ALL_GROUPS = 0xffff;
export const DEFAULT_LAYER = 'default';
export const defaultCollision = (): CollisionSpec => ({ group: 0, mask: ALL_GROUPS });

export function defaultEnvironment(): EnvironmentSettings {
  return { sky: 'studio', timeOfDay: 12, fog: { enabled: false, color: '#9db4cc', density: 0.01 }, exposure: 1 };
}

export function defaultBounds(): BoundsSettings {
  return { enabled: false, min: [-100, -50, -100], max: [100, 100, 100], policy: 'kill' };
}

export function defaultUnits(): UnitsSettings {
  return { length: 'm', mass: 'kg', angle: 'deg' };
}

export function defaultSettings(): SceneSettings {
  return {
    gravity: [...DEFAULT_GRAVITY],
    ground: defaultGround(),
    physicsHz: 120,
    solverIterations: 6,
    airDrag: 0,
    seed: 1,
    substeps: 1,
    environment: defaultEnvironment(),
    bounds: defaultBounds(),
    units: defaultUnits(),
  };
}

export function newDocument(name = 'Untitled scene'): SceneDocument {
  return { format: SCENE_FORMAT, version: SCENE_VERSION, name, settings: defaultSettings(), entities: [], assets: {} };
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
  const shape: ShapeSpec = makeShapeSpec(type, init.shape?.size, init.shape?.params);
  const matInit = init.material;
  const material =
    typeof matInit === 'string'
      ? materialFromPreset(matInit)
      : materialFromPreset(matInit?.preset ?? 'plastic', matInit ?? {});
  const { name, position, rotation, bodyType, shape: _s, material: _m, ...rest } = init;
  return {
    kind: 'body',
    id: uid('b'),
    name: name ?? shapeLabel(type),
    shape,
    position: position ? ([...position] as Vec3) : [0, 0, 0],
    rotation: rotation ? ([...rotation] as Quat) : qident(),
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
    collision: defaultCollision(),
    drag: { linear2: 0, angular2: 0 },
    inertiaScale: 1,
    tags: [],
    layer: DEFAULT_LAYER,
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
    anchorB: anchorB ? ([...anchorB] as Vec3) : ([...anchorA] as Vec3),
    axis: axis ? ([...axis] as Vec3) : [0, 0, 1],
    limit: { enabled: false, min: -Math.PI / 2, max: Math.PI / 2 },
    motor: defaultMotor(),
    spring: { restLength: 1, stiffness: 400, damping: 12, breakForce: 0 },
    ropeLength: 2,
    collideConnected: false,
    hidden: false,
    ...(rest as Partial<JointEntity>),
  };
}

// ---- soft bodies -------------------------------------------------------------------------------

export const SOFT_LABELS: Record<SoftType, string> = {
  jelly: 'Jelly',
  balloon: 'Balloon',
  cloth: 'Cloth',
  cable: 'Cable',
};

export function softDefaults(type: SoftType): Omit<SoftEntity, 'kind' | 'id' | 'name' | 'position' | 'rotation'> {
  const base = {
    gravityScale: 1,
    linearDamping: 0.05,
    tearStrain: 0,
    selfCollide: false,
    locked: false,
    hidden: false,
  };
  switch (type) {
    case 'jelly':
      return {
        ...base,
        type,
        size: [1, 1, 1],
        resolution: 5,
        mass: 20,
        stiffness: 12,
        damping: 0.15,
        pin: 'none',
        color: '#ff6fae',
        roughness: 0.25,
        opacity: 0.92,
      };
    case 'balloon':
      return {
        ...base,
        type,
        size: [1, 1, 1],
        resolution: 2,
        mass: 1.2,
        stiffness: 25,
        damping: 0.2,
        pin: 'none',
        color: '#4fc3f7',
        roughness: 0.2,
        opacity: 0.9,
      };
    case 'cloth':
      return {
        ...base,
        type,
        size: [2.4, 0, 2.4],
        resolution: 16,
        mass: 1.2,
        stiffness: 40,
        damping: 0.3,
        pin: 'none',
        color: '#ff9d4d',
        roughness: 0.85,
        opacity: 1,
      };
    case 'cable':
      return {
        ...base,
        type,
        size: [3, 0, 0],
        resolution: 24,
        mass: 1.2,
        stiffness: 60,
        damping: 0.3,
        pin: 'ends',
        color: '#d7a86e',
        roughness: 0.7,
        opacity: 1,
      };
  }
}

export function createSoft(type: SoftType, over: Partial<SoftEntity> = {}): SoftEntity {
  return {
    kind: 'soft',
    id: uid('s'),
    name: SOFT_LABELS[type],
    position: [0, 1, 0],
    rotation: qident(),
    ...softDefaults(type),
    ...over,
  };
}
