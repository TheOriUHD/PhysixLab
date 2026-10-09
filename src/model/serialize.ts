import { clamp, type Quat, type Vec3 } from '../core/math';
import { createBody, createJoint, defaultSettings } from './factory';
import { normalizeSize } from './shapes';
import type {
  BodyEntity, Entity, JointEntity, JointType, SceneDocument, SceneSettings, ShapeType,
} from './types';

const SHAPES: ShapeType[] = ['box', 'sphere', 'cylinder', 'capsule', 'cone', 'wedge', 'prism', 'icosahedron'];
const JOINTS: JointType[] = ['fixed', 'hinge', 'slider', 'ball', 'spring', 'rope'];

const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const bool = (x: unknown, d: boolean): boolean => (typeof x === 'boolean' ? x : d);
const str = (x: unknown, d: string): string => (typeof x === 'string' ? x : d);
function vec3(x: unknown, d: Vec3): Vec3 {
  if (Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return [x[0], x[1], x[2]];
  }
  return [...d] as Vec3;
}
function bool3(x: unknown): [boolean, boolean, boolean] {
  if (Array.isArray(x) && x.length === 3) return [!!x[0], !!x[1], !!x[2]];
  return [false, false, false];
}
function quat(x: unknown): Quat {
  if (Array.isArray(x) && x.length === 4 && x.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    const l = Math.hypot(x[0], x[1], x[2], x[3]);
    if (l > 1e-9) return [x[0] / l, x[1] / l, x[2] / l, x[3] / l];
  }
  return [0, 0, 0, 1];
}

function sanitizeBody(raw: any): BodyEntity {
  const type: ShapeType = SHAPES.includes(raw?.shape?.type) ? raw.shape.type : 'box';
  const base = createBody({ shape: { type } });
  const mat = raw?.material ?? {};
  const bodyType = ['dynamic', 'static', 'kinematic'].includes(raw?.bodyType) ? raw.bodyType : 'dynamic';
  const thrust = raw?.thrust && typeof raw.thrust === 'object'
    ? {
        force: vec3(raw.thrust.force, [0, 0, 0]),
        torque: vec3(raw.thrust.torque, [0, 0, 0]),
        mode: raw.thrust.mode === 'key' ? ('key' as const) : ('always' as const),
        key: str(raw.thrust.key, ''),
      }
    : null;
  return {
    ...base,
    id: str(raw?.id, base.id),
    name: str(raw?.name, base.name),
    shape: {
      type,
      size: normalizeSize(type, vec3(raw?.shape?.size, base.shape.size)),
      ...(type === 'prism' ? { sides: clamp(Math.round(num(raw?.shape?.sides, 6)), 3, 32) } : {}),
    },
    position: vec3(raw?.position, [0, 0, 0]),
    rotation: quat(raw?.rotation),
    bodyType,
    material: {
      preset: str(mat.preset, 'custom'),
      density: Math.max(1, num(mat.density, base.material.density)),
      friction: Math.max(0, num(mat.friction, base.material.friction)),
      restitution: clamp(num(mat.restitution, base.material.restitution), 0, 1.5),
      color: str(mat.color, base.material.color),
      metalness: clamp(num(mat.metalness, base.material.metalness), 0, 1),
      roughness: clamp(num(mat.roughness, base.material.roughness), 0, 1),
      opacity: clamp(num(mat.opacity, 1), 0.05, 1),
    },
    linearDamping: Math.max(0, num(raw?.linearDamping, base.linearDamping)),
    angularDamping: Math.max(0, num(raw?.angularDamping, base.angularDamping)),
    gravityScale: num(raw?.gravityScale, 1),
    ccd: bool(raw?.ccd, false),
    canSleep: bool(raw?.canSleep, true),
    velocity: vec3(raw?.velocity, [0, 0, 0]),
    angularVelocity: vec3(raw?.angularVelocity, [0, 0, 0]),
    lockPosition: bool3(raw?.lockPosition),
    lockRotation: bool3(raw?.lockRotation),
    thrust,
    ghost: bool(raw?.ghost, false),
    locked: bool(raw?.locked, false),
    hidden: bool(raw?.hidden, false),
  };
}

function sanitizeJoint(raw: any): JointEntity {
  const type: JointType = JOINTS.includes(raw?.type) ? raw.type : 'ball';
  const anchorA = vec3(raw?.anchorA, [0, 0, 0]);
  const base = createJoint({ type, bodyA: null, bodyB: null, anchorA });
  const m = raw?.motor ?? {};
  const l = raw?.limit ?? {};
  const s = raw?.spring ?? {};
  return {
    ...base,
    id: str(raw?.id, base.id),
    name: str(raw?.name, base.name),
    bodyA: typeof raw?.bodyA === 'string' ? raw.bodyA : null,
    bodyB: typeof raw?.bodyB === 'string' ? raw.bodyB : null,
    anchorA,
    anchorB: vec3(raw?.anchorB, anchorA),
    axis: vec3(raw?.axis, [0, 0, 1]),
    limit: {
      enabled: bool(l.enabled, false),
      min: num(l.min, base.limit.min),
      max: num(l.max, base.limit.max),
    },
    motor: {
      ...base.motor,
      mode: ['off', 'velocity', 'position'].includes(m.mode) ? m.mode : 'off',
      targetVelocity: num(m.targetVelocity, base.motor.targetVelocity),
      targetPosition: num(m.targetPosition, base.motor.targetPosition),
      stiffness: Math.max(0, num(m.stiffness, base.motor.stiffness)),
      damping: Math.max(0, num(m.damping, base.motor.damping)),
      maxForce: Math.max(0, num(m.maxForce, base.motor.maxForce)),
      keyPos: str(m.keyPos, ''),
      keyNeg: str(m.keyNeg, ''),
      slewRate: Math.max(0, num(m.slewRate, base.motor.slewRate)),
      brake: bool(m.brake, true),
    },
    spring: {
      restLength: Math.max(0, num(s.restLength, base.spring.restLength)),
      stiffness: Math.max(0, num(s.stiffness, base.spring.stiffness)),
      damping: Math.max(0, num(s.damping, base.spring.damping)),
      breakForce: Math.max(0, num(s.breakForce, 0)),
    },
    ropeLength: Math.max(0.01, num(raw?.ropeLength, base.ropeLength)),
    collideConnected: bool(raw?.collideConnected, false),
    hidden: bool(raw?.hidden, false),
  };
}

function sanitizeSettings(raw: any): SceneSettings {
  const d = defaultSettings();
  const g = raw?.ground ?? {};
  return {
    gravity: vec3(raw?.gravity, d.gravity),
    ground: {
      enabled: bool(g.enabled, d.ground.enabled),
      friction: Math.max(0, num(g.friction, d.ground.friction)),
      restitution: clamp(num(g.restitution, d.ground.restitution), 0, 1.5),
      halfSize: clamp(num(g.halfSize, d.ground.halfSize), 5, 2000),
      color: str(g.color, d.ground.color),
    },
    physicsHz: [60, 120, 240, 480].includes(raw?.physicsHz) ? raw.physicsHz : d.physicsHz,
    solverIterations: clamp(Math.round(num(raw?.solverIterations, d.solverIterations)), 1, 32),
    airDrag: Math.max(0, num(raw?.airDrag, 0)),
  };
}

/** Validate + upgrade arbitrary parsed JSON into a well-formed SceneDocument. Throws on garbage. */
export function sanitizeDocument(raw: any): SceneDocument {
  if (!raw || typeof raw !== 'object' || raw.format !== 'physicslab-scene' || !Array.isArray(raw.entities)) {
    throw new Error('Not a PhysicsLab scene file.');
  }
  const entities: Entity[] = [];
  const seen = new Set<string>();
  for (const r of raw.entities) {
    if (!r || typeof r !== 'object') continue;
    const e = r.kind === 'joint' ? sanitizeJoint(r) : r.kind === 'body' ? sanitizeBody(r) : null;
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    entities.push(e);
  }
  // Drop joints that reference bodies that do not exist.
  const bodyIds = new Set(entities.filter((e) => e.kind === 'body').map((e) => e.id));
  const clean = entities.filter(
    (e) => e.kind === 'body' || ((e.bodyA === null || bodyIds.has(e.bodyA)) && (e.bodyB === null || bodyIds.has(e.bodyB))),
  );
  return {
    format: 'physicslab-scene',
    version: 1,
    name: str(raw.name, 'Untitled scene'),
    settings: sanitizeSettings(raw.settings),
    entities: clean,
  };
}

export function serializeDocument(doc: SceneDocument): string {
  return JSON.stringify(doc);
}

export function parseDocument(text: string): SceneDocument {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('File is not valid JSON.'); }
  return sanitizeDocument(raw);
}
