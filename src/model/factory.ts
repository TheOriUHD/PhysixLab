import { qident, qnorm, type Quat, type Vec3 } from '../core/math';
import { materialFromPreset } from './materials';
import { SCENE_FORMAT, SCENE_VERSION } from './migrations';
import { makeShapeSpec, shapeLabel } from './shapeRegistry';
import { defaultParams, type JointParams } from './jointParams';
import type {
  BodyEntity,
  BoundsSettings,
  CollisionSpec,
  EnvironmentSettings,
  GroundSettings,
  GroupEntity,
  JointEntity,
  JointType,
  LightEntity,
  LightType,
  MaterialSpec,
  MotorSpec,
  PathEntity,
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
  return { enabled: true, friction: 0.8, restitution: 0.1, halfSize: 60, color: '#2b3038', type: 'grid', horizonBlend: 0.5 };
}

/** Group 0, colliding with every group. */
export const ALL_GROUPS = 0xffff;
export const DEFAULT_LAYER = 'default';
export const defaultCollision = (): CollisionSpec => ({ group: 0, mask: ALL_GROUPS });

export function defaultEnvironment(): EnvironmentSettings {
  return {
    sky: 'studio',
    timeOfDay: 12,
    fog: { enabled: false, color: '#9db4cc', density: 0.01, type: 'exp', near: 30, far: 200, height: 0, falloff: 0.15 },
    exposure: 1,
    toneMapping: 'aces',
    sun: { azimuth: 220, elevation: 55, intensity: 1, turbidity: 6, rayleigh: 1.5 },
    cycle: { enabled: false, hoursPerSecond: 0.5 },
    hdri: { assetId: null, showBackground: true, backgroundBlur: 0, rotation: 0, intensity: 1 },
  };
}

export function defaultBounds(): BoundsSettings {
  return {
    enabled: false,
    min: [-100, -50, -100],
    max: [100, 100, 100],
    policy: 'kill',
    // -- ZN-34
    edges: { nx: 'kill', px: 'kill', ny: 'kill', py: 'kill', nz: 'kill', pz: 'kill' },
    soft: { margin: 3, stiffness: 40, damping: 4 },
    respawn: { to: 'checkpoint', delay: 0, penaltySeconds: 0, penaltyPoints: 0, max: 0, wholeGroups: false },
  };
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
    selectionSets: [], // -- UI-A --
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
    components: [],
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
  // -- JT-A --
  conetwist: 'Cone-twist',
  sixdof: '6-DOF joint',
  pulley: 'Pulley',
  rack: 'Rack and pinion',
  gear: 'Gear pair',
  belt: 'Belt / chain drive',
  universal: 'Universal joint',
  screw: 'Screw',
  winch: 'Winch',
  softweld: 'Soft weld',
};
export const JOINT_TYPE_LABELS = JOINT_LABELS;

/** Defaults for a new joint's `params`, tuned per type. */
function jointParamsFor(type: JointType): JointParams {
  const p = defaultParams();
  if (type === 'sixdof') for (const d of p.dof) d.mode = 'locked';
  if (type === 'winch') p.loadRating = 0;
  if (type === 'belt') p.reverse = false; // an open belt turns both pulleys the same way
  return p;
}

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
    params: jointParamsFor(type),
    hidden: false,
    components: [],
    ...(rest as Partial<JointEntity>),
  };
}

// ---- soft bodies -------------------------------------------------------------------------------

export const SOFT_LABELS: Record<SoftType, string> = {
  jelly: 'Jelly',
  balloon: 'Balloon',
  cloth: 'Cloth',
  cable: 'Cable',
  mesh: 'Soft mesh',
  tyre: 'Soft tyre',
};

export function softDefaults(type: SoftType): Omit<SoftEntity, 'kind' | 'id' | 'name' | 'position' | 'rotation'> {
  const base = {
    gravityScale: 1,
    linearDamping: 0.05,
    tearStrain: 0,
    selfCollide: false,
    locked: false,
    hidden: false,
    // -- SF --
    attachments: [],
    volumeFactor: 1,
    volumePreserve: false,
    leakRate: 0,
    poisson: 0.3,
    plasticYield: 0,
    friction: 0.8,
    particleRadius: 0,
    shape: { type: 'sphere', size: [1, 1, 1] } as ShapeSpec,
    cell: 0.2,
    pneumatic: true,
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
        volumePreserve: true,
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
    case 'mesh':
      return {
        ...base,
        type,
        size: [1, 1, 1],
        resolution: 5,
        mass: 8,
        stiffness: 12,
        damping: 0.15,
        pin: 'none',
        color: '#7be0a0',
        roughness: 0.3,
        opacity: 0.94,
      };
    case 'tyre':
      return {
        ...base,
        type,
        size: [0.8, 0.26, 0.2],
        resolution: 24,
        mass: 6,
        stiffness: 400,
        damping: 0.25,
        pin: 'none',
        volumePreserve: true,
        volumeFactor: 1.3,
        friction: 1.4,
        color: '#2b2f36',
        roughness: 0.85,
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

// ── FB-6: groups, lights, paths ────────────────────────────────────────────────────────────────────────

export function createGroup(over: Partial<GroupEntity> = {}): GroupEntity {
  return {
    kind: 'group',
    id: uid('g'),
    name: 'Group',
    position: [0, 0, 0],
    rotation: qident(),
    locked: false,
    hidden: false,
    ...over,
  };
}

export const LIGHT_TYPES: readonly LightType[] = ['point', 'spot', 'directional', 'area'];
export const LIGHT_LABELS: Record<LightType, string> = {
  point: 'Point light',
  spot: 'Spot light',
  directional: 'Directional light',
  area: 'Area light',
};

/** Rotation that turns the light's −Z axis straight down (−Y). */
export const LIGHT_DOWN: Quat = qnorm([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);

/** Physical defaults per kind: point / spot in candela, directional in lux, area in nits. */
export function lightDefaults(type: LightType): Omit<LightEntity, 'kind' | 'id' | 'name' | 'position' | 'rotation'> {
  const base = {
    lightType: type,
    color: '#fff1d6',
    range: 0,
    angle: Math.PI / 5,
    penumbra: 0.35,
    size: [2, 2] as [number, number],
    castShadow: false,
    enabled: true,
    locked: false,
    hidden: false,
  };
  switch (type) {
    case 'point':
      return { ...base, intensity: 40 };
    case 'spot':
      return { ...base, intensity: 120, castShadow: true };
    case 'directional':
      return { ...base, intensity: 1.5 };
    case 'area':
      return { ...base, intensity: 6 };
  }
}

export function createLight(type: LightType = 'point', over: Partial<LightEntity> = {}): LightEntity {
  return {
    kind: 'light',
    id: uid('l'),
    name: LIGHT_LABELS[type],
    position: [0, type === 'directional' ? 6 : 3, 0],
    rotation: type === 'point' ? qident() : [...LIGHT_DOWN],
    ...lightDefaults(type),
    ...over,
  };
}

/** A gentle S-bend, 6 m long, lying on the ground plane's local x axis. */
export function defaultPathPoints(): Vec3[] {
  return [
    [-3, 0, 0],
    [-1, 0, 1.2],
    [1, 0, -1.2],
    [3, 0, 0],
  ];
}

export function createPath(over: Partial<PathEntity> = {}): PathEntity {
  return {
    kind: 'path',
    id: uid('p'),
    name: 'Path',
    position: [0, 0.05, 0],
    rotation: qident(),
    points: defaultPathPoints(),
    closed: false,
    tension: 0,
    color: '#5ec8ff',
    locked: false,
    hidden: false,
    ...over,
  };
}
