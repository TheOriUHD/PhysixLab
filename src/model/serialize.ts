import { clamp, type Vec3 } from '../core/math';
import { SceneFormatError, warn, type LoadReport } from './errors';
import {
  createBody,
  createJoint,
  createSoft,
  defaultBounds,
  defaultEnvironment,
  defaultSettings,
  defaultUnits,
  softDefaults,
} from './factory';
import { LIMITS, formatBytes, formatCount } from './limits';
import { pruneAssets, remapAssetRefs } from './assets';
import { sanitizeAssetMap } from './sanitize/assets';
import { repairParents, sanitizeBodyFields } from './sanitize/bodyFields';
import { sanitizeParts } from './sanitize/parts';
import { SCENE_FORMAT, SCENE_VERSION, migrateDocument } from './migrations';
import {
  bool,
  bool3,
  hexColor,
  idStr,
  int,
  nameStr,
  num,
  oneOf,
  position3,
  quat,
  str,
  vec3,
} from './sanitize/primitives';
import { sanitizeShapeSpec } from './shapeRegistry';
import type {
  BodyEntity,
  BoundsSettings,
  EnvironmentSettings,
  Entity,
  JointEntity,
  JointType,
  SceneDocument,
  SceneSettings,
  SkyPreset,
  SoftEntity,
  SoftPin,
  SoftType,
  UnitsSettings,
} from './types';
import { isBody } from './types';

const SOFTS: SoftType[] = ['jelly', 'balloon', 'cloth', 'cable'];
const PINS: SoftPin[] = ['none', 'edge', 'corners', 'corners4', 'one-end', 'ends'];
const JOINTS: JointType[] = ['fixed', 'hinge', 'slider', 'ball', 'spring', 'rope'];
const SKIES: SkyPreset[] = ['studio', 'day', 'sunset', 'night', 'overcast'];

function sanitizeBody(raw: any, report?: LoadReport): BodyEntity {
  const name = nameStr(raw?.name, '');
  const shape = sanitizeShapeSpec(raw?.shape, report, name ? `"${name}"` : 'an object');
  const base = createBody({ shape });
  const mat = raw?.material ?? {};
  const bodyType = ['dynamic', 'static', 'kinematic'].includes(raw?.bodyType) ? raw.bodyType : 'dynamic';
  const thrust =
    raw?.thrust && typeof raw.thrust === 'object'
      ? {
          force: vec3(raw.thrust.force, [0, 0, 0]),
          torque: vec3(raw.thrust.torque, [0, 0, 0]),
          mode: raw.thrust.mode === 'key' ? ('key' as const) : ('always' as const),
          key: str(raw.thrust.key, ''),
        }
      : null;
  return {
    ...base,
    id: idStr(raw?.id, base.id),
    name: nameStr(raw?.name, base.name),
    shape,
    position: position3(raw?.position, [0, 0, 0]),
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
    ...sanitizeBodyFields(raw ?? {}),
    ...sanitizeCompound(raw ?? {}, report, name ? `"${name}"` : 'an object'),
  };
}

/** `parts` and `meshId` — only present on the entity when set. */
function sanitizeCompound(
  raw: any,
  report: LoadReport | undefined,
  owner: string,
): Pick<BodyEntity, 'parts' | 'meshId'> {
  const out: Pick<BodyEntity, 'parts' | 'meshId'> = {};
  const parts = sanitizeParts(raw.parts, report, owner);
  if (parts) out.parts = parts;
  if (typeof raw.meshId === 'string' && raw.meshId) out.meshId = idStr(raw.meshId, '');
  return out;
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
    id: idStr(raw?.id, base.id),
    name: nameStr(raw?.name, base.name),
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

function sanitizeSoft(raw: any): SoftEntity {
  const type: SoftType = SOFTS.includes(raw?.type) ? raw.type : 'jelly';
  const base = createSoft(type);
  const d = softDefaults(type);
  const size = vec3(raw?.size, d.size).map((v, i) => (v <= 0 && d.size[i] === 0 ? 0 : Math.max(0.05, v))) as Vec3;
  const maxRes = type === 'jelly' ? 10 : type === 'balloon' ? 3 : type === 'cloth' ? 40 : 100;
  const minRes = type === 'balloon' ? 1 : type === 'cable' ? 4 : type === 'cloth' ? 4 : 3;
  return {
    ...base,
    id: idStr(raw?.id, base.id),
    name: nameStr(raw?.name, base.name),
    position: position3(raw?.position, [0, 1, 0]),
    rotation: quat(raw?.rotation),
    size,
    resolution: clamp(Math.round(num(raw?.resolution, d.resolution)), minRes, maxRes),
    mass: Math.max(0.01, num(raw?.mass, d.mass)),
    stiffness: clamp(num(raw?.stiffness, d.stiffness), 1, 400),
    damping: clamp(num(raw?.damping, d.damping), 0, 2),
    pin: PINS.includes(raw?.pin) ? raw.pin : 'none',
    tearStrain: Math.max(0, num(raw?.tearStrain, 0)),
    selfCollide: bool(raw?.selfCollide, false),
    gravityScale: num(raw?.gravityScale, 1),
    linearDamping: Math.max(0, num(raw?.linearDamping, d.linearDamping)),
    color: str(raw?.color, d.color),
    roughness: clamp(num(raw?.roughness, d.roughness), 0, 1),
    opacity: clamp(num(raw?.opacity, d.opacity), 0.05, 1),
    locked: bool(raw?.locked, false),
    hidden: bool(raw?.hidden, false),
  };
}

function sanitizeEnvironment(raw: any): EnvironmentSettings {
  const d = defaultEnvironment();
  const f = raw?.fog ?? {};
  return {
    sky: oneOf(raw?.sky, SKIES, d.sky),
    timeOfDay: clamp(num(raw?.timeOfDay, d.timeOfDay), 0, 24),
    fog: {
      enabled: bool(f.enabled, d.fog.enabled),
      color: hexColor(f.color, d.fog.color),
      density: clamp(num(f.density, d.fog.density), 0, 1),
    },
    exposure: clamp(num(raw?.exposure, d.exposure), 0.1, 8),
  };
}

function sanitizeBounds(raw: any): BoundsSettings {
  const d = defaultBounds();
  const lo = position3(raw?.min, d.min);
  const hi = position3(raw?.max, d.max);
  // Opposite corners may arrive in any order; a degenerate (zero-thickness) axis is opened up by a metre.
  const min = lo.map((v, i) => Math.min(v, hi[i])) as BoundsSettings['min'];
  const max = lo.map((v, i) => Math.max(v, hi[i])) as BoundsSettings['max'];
  for (let i = 0; i < 3; i++) if (max[i] - min[i] < 1e-3) max[i] = min[i] + 1;
  return {
    enabled: bool(raw?.enabled, d.enabled),
    min,
    max,
    policy: oneOf(raw?.policy, ['kill', 'respawn'], d.policy),
  };
}

function sanitizeUnits(raw: any): UnitsSettings {
  const d = defaultUnits();
  return {
    length: oneOf(raw?.length, ['m', 'cm', 'ft', 'in'], d.length),
    mass: oneOf(raw?.mass, ['kg', 'g', 'lb'], d.mass),
    angle: oneOf(raw?.angle, ['deg', 'rad'], d.angle),
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
    seed: Math.floor(clamp(num(raw?.seed, d.seed), 0, 0xffffffff)),
    substeps: int(raw?.substeps, d.substeps, 1, 16),
    environment: sanitizeEnvironment(raw?.environment),
    bounds: sanitizeBounds(raw?.bounds),
    units: sanitizeUnits(raw?.units),
  };
}

/**
 * Validate + upgrade arbitrary parsed JSON into a well-formed SceneDocument. This is the single entry for
 * every way a scene reaches the app (file, autosave, library, share link, templates in tests).
 *
 * It runs the migration chain, enforces the size limits in `limits.ts` (throwing a `SceneFormatError` with
 * a user-facing message) and repairs everything else: unknown fields dropped, missing fields defaulted,
 * bad numbers clamped, joints referring to missing bodies removed. Pass a `report` to learn what was repaired.
 */
export function sanitizeDocument(input: any, report?: LoadReport): SceneDocument {
  const raw = migrateDocument(input) as any;
  if (raw.entities.length > LIMITS.maxEntities) {
    throw new SceneFormatError(
      'limit',
      `This scene has ${formatCount(raw.entities.length)} objects; PhysicsLab opens scenes of up to ${formatCount(LIMITS.maxEntities)}. Split it into several scenes.`,
    );
  }
  const entities: Entity[] = [];
  const seen = new Set<string>();
  for (const r of raw.entities) {
    if (!r || typeof r !== 'object') continue;
    const e =
      r.kind === 'joint'
        ? sanitizeJoint(r)
        : r.kind === 'body'
          ? sanitizeBody(r, report)
          : r.kind === 'soft'
            ? sanitizeSoft(r)
            : null;
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    entities.push(e);
  }
  // Drop group links that point nowhere (or loop).
  const parentsFixed = repairParents(entities.filter(isBody));
  if (parentsFixed) warn(report, `${parentsFixed} grouping link(s) pointed at missing objects and were removed.`);
  // Drop joints that reference bodies that do not exist.
  const bodyIds = new Set(entities.filter((e) => e.kind === 'body').map((e) => e.id));
  const clean = entities.filter(
    (e) =>
      e.kind !== 'joint' || ((e.bodyA === null || bodyIds.has(e.bodyA)) && (e.bodyB === null || bodyIds.has(e.bodyB))),
  );
  // Assets: validated, de-duplicated, and every entity reference repaired to match (merged twins follow the
  // kept asset; references to missing or wrong-kind assets are dropped).
  const { assets, remap } = sanitizeAssetMap(raw.assets, report);
  let droppedRefs = 0;
  const linked = remapAssetRefs(clean, (id, kind) => {
    const target = remap.get(id) ?? id;
    if (assets[target]?.kind === kind) return target;
    droppedRefs++;
    return undefined;
  });
  if (droppedRefs) warn(report, `${droppedRefs} reference(s) to missing or unusable assets were removed.`);
  return pruneAssets({
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    name: nameStr(raw.name, 'Untitled scene'),
    settings: sanitizeSettings(raw.settings),
    entities: linked,
    assets,
  });
}

/**
 * The scene as JSON text — what files, the autosave, the library and share links hold. Assets that nothing
 * references are left out (garbage collection on save). `indent` pretty-prints for human-readable exports.
 */
export function serializeDocument(doc: SceneDocument, indent?: number): string {
  return JSON.stringify(pruneAssets(doc), null, indent);
}

export function parseDocument(text: string, report?: LoadReport): SceneDocument {
  if (text.length > LIMITS.maxDocumentChars) {
    throw new SceneFormatError(
      'limit',
      `This file is ${formatBytes(text.length)}; PhysicsLab opens scene files of up to ${formatBytes(LIMITS.maxDocumentChars)}.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SceneFormatError('invalid-json', 'File is not valid JSON.');
  }
  return sanitizeDocument(raw, report);
}
